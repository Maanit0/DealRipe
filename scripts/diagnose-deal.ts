/**
 * Why does this deal look the way it does?
 *
 * Written for two questions that the readiness check surfaces but cannot
 * answer. Elif reads "we have our own calls" and 0/27 confirmed, which means a
 * call was captured and extraction produced nothing, and those are very
 * different failures: a bot that never joined, a transcript that never
 * arrived, an extraction that threw, or an extraction that ran honestly and
 * found nothing to confirm. EWI sits at SQL0 with an empty checklist while the
 * rep runs onboarding, which usually means the work moved to a second
 * opportunity nobody linked.
 *
 * So this walks the whole chain for one deal, in the order it actually runs:
 *
 *   deal row -> calls -> bot -> transcript -> extraction -> Rolldog
 *
 * and prints where it stops. Every step distinguishes "did not happen" from
 * "failed", because those look identical in the output today and have opposite
 * fixes.
 *
 *   npx tsx scripts/diagnose-deal.ts --deal "Elif Utsukarci"
 *   npx tsx scripts/diagnose-deal.ts --deal Ewiinc
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { searchOpportunities } from "../lib/rolldog";
import { REP_UID } from "../lib/rolldog-reconcile";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const wanted = arg("--deal");
  if (!wanted) {
    console.error('Usage: --deal "<account name or external id fragment>"');
    process.exit(1);
  }

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const deals = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, stage_key")
    .eq("tenant_id", tenantId)
    .or(`account.ilike.%${wanted}%,external_id.ilike.%${wanted}%`);
  if (deals.error) throw new Error(deals.error.message);
  if (!deals.data?.length) {
    console.log(`\nNo deal matching "${wanted}".\n`);
    return;
  }

  for (const deal of deals.data) {
    console.log("");
    console.log("=".repeat(84));
    console.log(`${deal.account}`);
    console.log("=".repeat(84));
    console.log(`  deal id       ${deal.id}`);
    console.log(`  external id   ${deal.external_id ?? "(none)"}`);
    console.log(`  stage key     ${deal.stage_key ?? "(none)"}`);
    console.log(`  rolldog opp   ${deal.rolldog_opportunity_id ?? "(not linked)"}`);

    // ----- calls, and how far each one got -----
    const calls = await db
      .from("calls")
      .select(
        "id, scheduled_start, call_date, outcome, meeting_type, title, has_been_extracted, recall_bot_id, transcript_id, ingest_error, source",
      )
      .eq("tenant_id", tenantId)
      .eq("deal_id", deal.id)
      .order("scheduled_start", { ascending: true });
    if (calls.error) throw new Error(calls.error.message);

    console.log("");
    console.log(`  CALLS (${calls.data?.length ?? 0})`);
    if (!calls.data?.length) console.log("    none");

    for (const c of calls.data ?? []) {
      const when = formatMeetingTime(c.scheduled_start ?? c.call_date);
      console.log("");
      console.log(`    ${when}  ${(c.title ?? "(untitled)").slice(0, 54)}`);
      console.log(`      outcome     ${c.outcome ?? "(none set)"}${c.meeting_type ? `, ${c.meeting_type}` : ""}`);
      console.log(`      bot         ${c.recall_bot_id ? c.recall_bot_id.slice(0, 12) : "never scheduled"}`);

      // Transcript: present, absent, or present but empty. The third case is
      // the one that silently produces an empty extraction.
      let transcript = "none";
      if (c.transcript_id) {
        const t = await db.from("transcripts").select("body").eq("call_id", c.id).maybeSingle();
        const body = (t.data?.body ?? "") as string;
        transcript = body.length > 0 ? `${body.length} chars` : "row exists but body is EMPTY";
      }
      console.log(`      transcript  ${transcript}`);
      console.log(`      extracted   ${c.has_been_extracted ? "yes" : "NO"}`);
      if (c.ingest_error) console.log(`      error       ${c.ingest_error.slice(0, 160)}`);
    }

    // ----- extraction -----
    const fx = await db
      .from("field_extractions")
      .select("framework_field_key, status, answer, last_updated_from_call_id")
      .eq("tenant_id", tenantId)
      .eq("deal_id", deal.id);
    if (fx.error) throw new Error(fx.error.message);

    const rows = fx.data ?? [];
    const yes = rows.filter((r) => r.status === "Yes");
    const no = rows.filter((r) => r.status === "No");
    console.log("");
    console.log(`  EXTRACTION`);
    console.log(
      `    ${rows.length} rows written, ${yes.length} Yes, ${no.length} No, ${rows.length - yes.length - no.length} Unknown`,
    );
    if (rows.length === 0) {
      console.log("    Nothing was ever written. Extraction did not run, or it threw");
      console.log("    before its first write. Check the per-call error above.");
    } else if (yes.length === 0) {
      console.log("    Extraction ran and confirmed nothing. That is a real answer if the");
      console.log("    call was short or administrative, and a bug if it was a real");
      console.log("    working session. Read the transcript before assuming either.");
    }
    for (const r of yes.slice(0, 10)) {
      console.log(`      ${r.framework_field_key.padEnd(30)} ${String(r.answer ?? "").slice(0, 60)}`);
    }

    // ----- Rolldog: every opportunity for this account, not just the linked one -----
    const ownerToEmail = new Map(Object.entries(REP_UID).map(([email, uid]) => [uid, email]));
    console.log("");
    console.log(`  ROLLDOG OPPORTUNITIES matching "${deal.account}"`);
    try {
      const opps = await searchOpportunities(deal.account, { pageSize: 25 });
      if (opps.length === 0) console.log("    none found");
      for (const o of opps) {
        const owner = ownerToEmail.get(String(o.owner ?? "")) ?? String(o.owner ?? "-");
        const linked = String(o.id) === String(deal.rolldog_opportunity_id) ? "  <- linked" : "";
        console.log(
          `    ${String(o.id).padEnd(8)} ${(o.accountName || "-").slice(0, 26).padEnd(28)} ${(o.stageName || "-").slice(0, 26).padEnd(28)} ${owner.split("@")[0].padEnd(12)}${o.archived ? "ARCHIVED" : ""}${linked}`,
        );
      }
      console.log("");
      console.log("    More than one open opportunity here means the work may have moved");
      console.log("    to a record we are not reading, which is the usual reason a deal");
      console.log("    in onboarding still reports an empty checklist at SQL0.");
    } catch (e) {
      console.log(`    lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
