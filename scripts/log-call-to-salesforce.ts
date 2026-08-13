/**
 * Log a captured call to Salesforce as a completed Call activity, now.
 *
 * transcript-sync will do this going forward. This exists for the backlog: the
 * Salesforce-only deals whose calls already happened and left no trace on the
 * account beyond a few quietly changed fields.
 *
 *   npx tsx scripts/log-call-to-salesforce.ts --deal Febestparts
 *   npx tsx scripts/log-call-to-salesforce.ts --deal Febestparts --apply
 *   npx tsx scripts/log-call-to-salesforce.ts --all
 *   npx tsx scripts/log-call-to-salesforce.ts --all --apply
 *
 * Dry run by default. Rolldog precedence is respected: a deal whose Rolldog
 * opportunity takes the write already gets its history there and does not need
 * a second copy in Salesforce.
 *
 * Regenerating the recap costs one model call per deal, because the summary is
 * not stored in a reusable shape. Same tradeoff as retry-followup-draft.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { logCallToSalesforce } from "../lib/salesforce-activity";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { resolveSalesforceWriteTarget } from "../lib/salesforce-scope";
import { getFrameworkForDeal } from "../lib/framework";
import { generatePostCallSummary } from "../lib/post-call-summary";
import { formatMeetingTime } from "../lib/graph-time";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const only = arg("--deal")?.toLowerCase() ?? null;
  const all = process.argv.includes("--all");
  const apply = process.argv.includes("--apply");
  if (!only && !all) {
    console.log("\nPass --deal <name> or --all.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rep_email, salesforce_account_id, salesforce_link_confidence, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);

  let deals = ((dealsRes.data ?? []) as Array<Record<string, unknown>>).filter((d) => d.salesforce_account_id);
  if (only) deals = deals.filter((d) => String(d.account ?? "").toLowerCase().includes(only));
  if (deals.length === 0) {
    console.log(only ? `\nNo Salesforce-linked deal matching "${only}".\n` : "\nNo Salesforce-linked deals.\n");
    return;
  }

  console.log("");
  console.log(apply ? "APPLYING." : "Dry run. Nothing will be created.");

  for (const d of deals) {
    const account = String(d.account ?? "?");

    // Rolldog first, same precedence the field write-back uses. Calling
    // resolveWriteTarget rather than restating its rules is the difference
    // between one source of truth and a fourth wrong copy of it.
    const rolldog = resolveWriteTarget(d as never);
    if (rolldog.authorized) {
      console.log(`\n${account}\n  skipped: Rolldog opportunity ${rolldog.opportunityId} already holds this deal's history`);
      continue;
    }

    const sfTarget = resolveSalesforceWriteTarget(d as never);
    if (!sfTarget.authorized) {
      console.log(`\n${account}\n  skipped: ${sfTarget.reason}`);
      continue;
    }

    const callsRes = await db
      .from("calls")
      .select("id, title, scheduled_start, call_date, outcome, has_been_extracted, participants")
      .eq("deal_id", String(d.id))
      .order("scheduled_start", { ascending: false });
    const calls = ((callsRes.data ?? []) as Array<Record<string, unknown>>).filter(
      (c) => c.outcome !== "duplicate" && (c.has_been_extracted === true || c.outcome === "captured"),
    );
    if (calls.length === 0) {
      console.log(`\n${account}\n  skipped: no captured call`);
      continue;
    }
    const call = calls[0];
    const when = (call.scheduled_start as string | null) ?? (call.call_date as string | null);

    const tr = await db.from("transcripts").select("body").eq("call_id", String(call.id)).maybeSingle();
    const body = tr.data?.body ?? "";
    if (body.trim().length < 50) {
      console.log(`\n${account}\n  skipped: no transcript to summarise`);
      continue;
    }
    const framework = await getFrameworkForDeal(String(d.id));
    if (!framework) {
      console.log(`\n${account}\n  skipped: no framework on this deal`);
      continue;
    }

    const fx = await db
      .from("field_extractions")
      .select("framework_field_key, status, answer, evidence, confidence")
      .eq("deal_id", String(d.id));
    const extraction = Object.fromEntries(
      (fx.data ?? []).map((r) => [
        String((r as { framework_field_key: string }).framework_field_key),
        r as unknown as Record<string, unknown>,
      ]),
    );

    const summary = await generatePostCallSummary({
      account,
      stageKey: "SQL1",
      framework,
      extraction: extraction as never,
      transcript: body,
    });

    const people = Array.isArray(call.participants)
      ? (call.participants as Array<{ name?: string | null; email?: string | null }>)
      : [];
    const attendees = people
      .map((p) => (p?.name ?? p?.email ?? "").trim())
      .filter(Boolean)
      .join(", ");

    const res = await logCallToSalesforce({
      tenantSlug: "magaya",
      accountId: sfTarget.accountId,
      accountName: account,
      summary,
      callDate: when,
      meetingTitle: (call.title as string | null) ?? null,
      repEmail: (d.rep_email as string | null) ?? null,
      attendees: attendees || null,
      apply,
    });

    console.log(`\n${account}   account ${sfTarget.accountId}   call ${formatMeetingTime(when)}`);
    if (res.logged) {
      console.log(`  CREATED Task ${res.taskId}${res.ownerResolved ? " (owned by the rep)" : " (owned by the integration user, no Salesforce login matched the rep)"}`);
    } else {
      console.log(`  not created: ${res.reason}${res.alreadyThere ? ` (${res.alreadyThere})` : ""}`);
    }
  }

  console.log("");
  if (!apply) console.log("Re-run with --apply to create the activities.\n");
  else console.log("Each creation is scoped and audited exactly like a field write.\n");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  let cause: unknown = (e as { cause?: unknown })?.cause;
  while (cause) {
    const c = cause as { message?: string; code?: string; cause?: unknown };
    console.error(`  caused by: ${c.code ?? ""} ${c.message ?? String(cause)}`);
    cause = c.cause;
  }
  console.error("");
  process.exit(1);
});
