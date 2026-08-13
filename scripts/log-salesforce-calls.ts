/**
 * Log captured calls to Salesforce as completed Call activities.
 *
 * transcript-sync does this going forward. Every call captured before the
 * feature existed has a Salesforce account with a few silently changed
 * qualification fields and no record that a conversation happened, which is
 * exactly the state that makes a rep distrust the write-back. This backfills
 * them.
 *
 * Only deals where SALESFORCE is the system of record are eligible. Where a
 * Rolldog opportunity exists it already has the note, and duplicating the
 * history into two CRMs is how the two versions start disagreeing.
 *
 * Regenerating the recap costs one model call per call, because the summary is
 * composed at notify time and not stored in a reusable shape. Dry run does not
 * spend it: it reports what is eligible and stops.
 *
 *   npx tsx scripts/log-salesforce-calls.ts --deal Febestparts
 *   npx tsx scripts/log-salesforce-calls.ts --all
 *   npx tsx scripts/log-salesforce-calls.ts --all --apply
 *
 * Idempotent by construction. logCallToSalesforce asks Salesforce whether the
 * integration user already logged a task on that account for that date, so
 * running it twice creates nothing the second time.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { logCallToSalesforce, cleanMeetingTitle } from "../lib/salesforce-activity";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { resolveSalesforceWriteTarget } from "../lib/salesforce-scope";
import { generatePostCallSummary } from "../lib/post-call-summary";
import { getFrameworkForDeal } from "../lib/framework";
import { formatMeetingTime } from "../lib/graph-time";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

/**
 * Outcomes that carry no conversation to log. Same membership every rep and CRO
 * view in lib/ filters on, listed here because none of them exports it. If one
 * of those sets grows a member, this needs the same one.
 */
const NO_CONTENT = new Set([
  "no_conversation",
  "no_show",
  "rescheduled",
  "placeholder",
  "capture_failed",
  "duplicate",
  "discarded",
]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type DealRow = {
  id: string;
  account: string;
  external_id: string | null;
  rep_email: string | null;
  salesforce_account_id: string | null;
  salesforce_link_confidence: string | null;
  rolldog_opportunity_id: string | null;
  rolldog_link_confidence: string | null;
};

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
    .select(
      "id, account, external_id, rep_email, salesforce_account_id, salesforce_link_confidence, rolldog_opportunity_id, rolldog_link_confidence",
    )
    .eq("tenant_id", tenantId)
    .not("salesforce_account_id", "is", null);
  if (dealsRes.error) throw new Error(dealsRes.error.message);

  let deals = (dealsRes.data ?? []) as DealRow[];
  if (only) deals = deals.filter((d) => (d.account ?? "").toLowerCase().includes(only));
  if (deals.length === 0) {
    console.log(only ? `\nNo Salesforce-linked deal matching "${only}".\n` : "\nNo Salesforce-linked deals.\n");
    return;
  }

  console.log("");
  console.log(apply ? "APPLYING." : "Dry run. Nothing will be created.");

  let eligible = 0;
  let created = 0;
  let skipped = 0;

  for (const d of deals) {
    // Same precedence rule the field write-back uses, imported rather than
    // restated. A checker that can disagree with production eventually will.
    const rolldog = resolveWriteTarget(d);
    if (rolldog.authorized) {
      console.log(`\n${d.account}\n  skip: Rolldog opportunity ${rolldog.opportunityId} owns this deal's history`);
      skipped++;
      continue;
    }
    const target = resolveSalesforceWriteTarget(d);
    if (!target.authorized) {
      console.log(`\n${d.account}\n  skip: ${target.reason}`);
      skipped++;
      continue;
    }

    const callsRes = await db
      .from("calls")
      .select("id, title, scheduled_start, call_date, outcome, has_been_extracted, participants")
      .eq("deal_id", d.id)
      .order("scheduled_start", { ascending: false });
    // has_been_extracted is NOT evidence that anything was extracted. It is a
    // "stop retrying this row" marker, and transcript-sync sets it to true
    // alongside outcome capture_failed on a bot that never produced media. So a
    // filter that trusts it alone walks a call with no conversation in it all
    // the way to the transcript lookup before noticing. Outcome is the field
    // that carries meaning here.
    //
    // "discarded" is quarantineCall's marker: a meeting we should not have
    // captured, whose transcript was deliberately erased. Pushing one into a
    // customer's CRM is the exact outcome quarantine exists to prevent.
    const calls = (callsRes.data ?? []).filter(
      (c) =>
        !NO_CONTENT.has(String(c.outcome ?? "")) &&
        (c.has_been_extracted === true || c.outcome === "captured"),
    );
    if (calls.length === 0) {
      console.log(`\n${d.account}\n  skip: no captured call`);
      skipped++;
      continue;
    }

    console.log(`\n${d.account}   account ${target.accountId}   ${calls.length} captured call(s)`);
    eligible += calls.length;

    for (const c of calls) {
      const when = c.scheduled_start ?? c.call_date;
      // Show the subject that will actually be written, not the raw calendar
      // title. Printing the input while writing something else makes the log
      // useless for checking what landed.
      const subject = cleanMeetingTitle(c.title ?? "") || `Call with ${d.account}`;
      const label = `${formatMeetingTime(when)}  ${subject}`;

      if (!apply) {
        console.log(`  would log  ${label}`);
        continue;
      }

      const tr = await db.from("transcripts").select("body").eq("call_id", String(c.id)).maybeSingle();
      const body = tr.data?.body ?? "";
      if (body.trim().length < 50) {
        // Reaching here means the outcome claimed a conversation happened and
        // no transcript backs it up, which the outcome filter above should have
        // caught. Worth chasing with scripts/call-status.ts rather than
        // shrugging at, because it is a capture gap the outcome did not record.
        console.log(`  skip       ${label}  (NO TRANSCRIPT ROW despite outcome "${c.outcome}": run call-status.ts on this deal)`);
        skipped++;
        continue;
      }
      const framework = await getFrameworkForDeal(d.id);
      if (!framework) {
        console.log(`  skip       ${label}  (no framework on this deal)`);
        skipped++;
        continue;
      }
      const fx = await db
        .from("field_extractions")
        .select("framework_field_key, status, answer, evidence, confidence")
        .eq("deal_id", d.id);
      const extraction = Object.fromEntries(
        (fx.data ?? []).map((r) => [
          String((r as { framework_field_key: string }).framework_field_key),
          r as unknown as Record<string, unknown>,
        ]),
      );

      const people = Array.isArray(c.participants)
        ? (c.participants as Array<{ name?: string | null; email?: string | null }>)
        : [];
      const attendees = people.map((p) => (p?.name ?? p?.email ?? "").trim()).filter(Boolean).join(", ");

      const summary = await generatePostCallSummary({
        account: d.account,
        stageKey: "SQL1",
        framework,
        extraction: extraction as never,
        transcript: body,
      });

      const res = await logCallToSalesforce({
        tenantSlug: "magaya",
        accountId: target.accountId,
        accountName: d.account,
        summary,
        callDate: when,
        meetingTitle: c.title,
        repEmail: d.rep_email,
        attendees: attendees || null,
        apply: true,
      });

      if (res.logged) {
        created++;
        console.log(`  LOGGED     ${label}  -> Task ${res.taskId}${res.ownerResolved ? "" : "  (owned by the integration user, no Salesforce login matched the rep)"}`);
      } else {
        skipped++;
        console.log(`  skip       ${label}  (${res.reason})`);
      }
    }
  }

  console.log("");
  if (!apply) {
    console.log(`${eligible} call(s) eligible across ${deals.length} deal(s). Re-run with --apply.`);
    console.log(`Each one costs a model call to regenerate its recap.\n`);
  } else {
    console.log(`Created ${created} activity/activities. Skipped ${skipped}.`);
    console.log(`Values are recorded, so Activity shows exactly what was written.\n`);
  }
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
