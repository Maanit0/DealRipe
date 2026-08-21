/**
 * Generate a recap for a captured call that never had one, and post it as a
 * Salesforce Note.
 *
 * WHY THIS IS A DIFFERENT SCRIPT FROM backfill-recap-notes.ts
 *
 * That one posts the recap that was ALREADY SENT to the rep, and deliberately
 * refuses to regenerate: reformatting something a reader has already seen in
 * their inbox is not worth three LLM passes a call. These twelve calls are the
 * other case. They have no recap at all, all of them 2026-07-16 to 07-22 from
 * before recap-sync existed, and every one has a stored transcript between
 * 12,011 and 81,132 characters. There is nothing to reuse, so generating is the
 * only way they ever get a Note.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   No email. These calls are a month old and a follow-up draft addressed to a
 *   customer about a July conversation is worse than no follow-up.
 *
 *   No sent_messages row. That table means "we sent this to the rep". Nothing
 *   was sent. Writing one would record a delivery that never happened, which is
 *   the exact class of fiction this codebase exists to avoid.
 *
 *   No Salesforce Task and no CRM field write. Those ride the delivery path and
 *   are not reachable from buildRecap.
 *
 * So the entire blast radius is one ContentNote per call, idempotent on its
 * title, exactly as scripts/preview-recap.ts --post-note produces one at a time.
 *
 *   npx tsx scripts/backfill-missing-recaps.ts               dry run, lists the work
 *   npx tsx scripts/backfill-missing-recaps.ts --deal cbxglobal
 *   npx tsx scripts/backfill-missing-recaps.ts --open-only   skip resolved deals
 *   npx tsx scripts/backfill-missing-recaps.ts --limit 2 --apply
 *   npx tsx scripts/backfill-missing-recaps.ts --apply       WRITES, ~3.5 min a call
 *
 * Dry run by default. --apply makes live Anthropic calls AND writes Notes into
 * Magaya's Salesforce.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import type { ExtractionMap } from "../lib/briefing-magaya";
import { loadFramework } from "../lib/framework";
import { formatMeetingTime } from "../lib/graph-time";
import type { MeetingType } from "../lib/meeting-classify";
import { buildRecap } from "../lib/recap-build";
import { renderRecapNote } from "../lib/recap-render";
import { postRecapNote, recapNoteExists } from "../lib/salesforce-note";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type DealRow = {
  id: string;
  account: string;
  stage_key: string | null;
  framework_id: string | null;
  rep_forecast_close_date: string | null;
  salesforce_account_id: string | null;
  salesforce_link_confidence: string | null;
  outcome_label: string | null;
};

type CallRow = {
  id: string;
  deal_id: string;
  title: string | null;
  scheduled_start: string | null;
  call_date: string | null;
  meeting_type: string | null;
};

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const openOnly = process.argv.includes("--open-only");
  const onlyDeal = arg("--deal")?.toLowerCase();
  const limit = Number(arg("--limit") ?? Number.MAX_SAFE_INTEGER);

  const db = supabaseAdmin();
  const tenantId = await resolveTenantId(SLUG);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`${apply ? "GENERATING AND POSTING" : "DRY RUN"}: recaps for captured calls that never had one`);
  console.log(`${"=".repeat(80)}\n`);

  const [callsRes, dealsRes, recapsRes, txRes] = await Promise.all([
    db
      .from("calls")
      .select("id, deal_id, title, scheduled_start, call_date, meeting_type")
      .eq("tenant_id", tenantId)
      .eq("outcome", "captured")
      .order("scheduled_start", { ascending: true }),
    db
      .from("deals")
      .select(
        "id, account, stage_key, framework_id, rep_forecast_close_date, salesforce_account_id, salesforce_link_confidence, outcome_label",
      )
      .eq("tenant_id", tenantId),
    db.from("sent_messages").select("call_id").eq("tenant_id", tenantId).eq("kind", "recap"),
    db.from("transcripts").select("call_id, body").eq("tenant_id", tenantId),
  ]);
  for (const [what, res] of [
    ["calls", callsRes],
    ["deals", dealsRes],
    ["recaps", recapsRes],
    ["transcripts", txRes],
  ] as const) {
    if (res.error) throw new Error(`${what} read failed: ${res.error.message}`);
  }

  const deals = new Map(((dealsRes.data ?? []) as DealRow[]).map((d) => [d.id, d]));
  const transcriptOf = new Map(
    ((txRes.data ?? []) as Array<{ call_id: string; body: string | null }>).map((t) => [t.call_id, t.body ?? ""]),
  );
  const hasRecap = new Set(((recapsRes.data ?? []) as Array<{ call_id: string | null }>).map((r) => r.call_id));

  type Job = { call: CallRow; deal: DealRow; body: string };
  const jobs: Job[] = [];
  const skips: Array<{ label: string; when: string; why: string }> = [];

  for (const call of (callsRes.data ?? []) as CallRow[]) {
    if (hasRecap.has(call.id)) continue;
    const deal = deals.get(call.deal_id);
    const when = (call.scheduled_start ?? call.call_date ?? "?").slice(0, 10);
    const label = deal?.account ?? call.deal_id;
    if (!deal) {
      skips.push({ label, when, why: "deal row not found" });
      continue;
    }
    if (openOnly && deal.outcome_label) {
      skips.push({ label, when, why: `deal is resolved (${deal.outcome_label}) and --open-only was passed` });
      continue;
    }
    // Same fail-closed rule as every other Salesforce write. A link below
    // confirmed may be a different company's record entirely.
    if (deal.salesforce_link_confidence !== "confirmed" || !deal.salesforce_account_id) {
      skips.push({
        label,
        when,
        why: `link confidence '${deal.salesforce_link_confidence ?? "none"}', so no account is safe to write to`,
      });
      continue;
    }
    if (!deal.framework_id) {
      skips.push({ label, when, why: "deal has no framework, so no qualification recap can be built" });
      continue;
    }
    // buildRecap takes fallbackStageKey as a required string. Production hands
    // it deals.stage_key through a loosely typed query, so a null flows in
    // silently there; here the type is honest and the null is caught. Skipping
    // is the right answer over inventing SQL0, which is a real Magaya stage
    // (id 773) and not a synonym for "no stage recorded".
    if (!deal.stage_key) {
      skips.push({ label, when, why: "deal has no stage_key, and a stage is not something to invent" });
      continue;
    }
    if (onlyDeal && !deal.account.toLowerCase().includes(onlyDeal)) continue;
    const body = transcriptOf.get(call.id) ?? "";
    if (body.trim().length < 50) {
      skips.push({
        label,
        when,
        why: transcriptOf.has(call.id)
          ? `stored transcript is only ${body.trim().length} characters, too short to recap`
          : "no transcript is stored, so there is nothing to regenerate from",
      });
      continue;
    }
    jobs.push({ call, deal, body });
  }

  const todo = jobs.slice(0, Math.max(0, limit));
  console.log(`  ${jobs.length} call(s) can be recapped; ${skips.length} cannot\n`);

  let posted = 0;
  let already = 0;
  let failed = 0;
  let general = 0;

  for (const [i, job] of todo.entries()) {
    const when = (job.call.scheduled_start ?? job.call.call_date ?? "?").slice(0, 10);
    const head = `[${i + 1}/${todo.length}] ${when}  ${job.deal.account}`;
    if (!apply) {
      console.log(`  would  ${head}  ${job.body.length} chars${job.deal.outcome_label ? `  (deal ${job.deal.outcome_label})` : ""}`);
      continue;
    }

    const started = Date.now();
    try {
      // ASK BEFORE GENERATING. postRecapNote does this same lookup, but only
      // after a body exists, and a body is three model passes over a full
      // transcript. Re-running this script regenerated nine recaps that already
      // had Notes before discovering it, roughly forty minutes to learn
      // nothing. An 'unknown' lookup is not treated as absent: it skips, since
      // a duplicate recap in front of a customer costs more than a missing one.
      const present = await recapNoteExists({
        tenantSlug: SLUG,
        accountId: job.deal.salesforce_account_id as string,
        account: job.deal.account,
        callAt: job.call.scheduled_start,
      });
      if (present.state === "found") {
        already += 1;
        console.log(`  already ${head}  (${present.id})`);
        continue;
      }
      if (present.state === "unknown") {
        failed += 1;
        console.log(`  FAILED  ${head}: could not check for an existing Note (${present.why})`);
        continue;
      }

      const framework = await loadFramework(tenantId, job.deal.framework_id as string);
      if (!framework) {
        console.log(`  FAILED ${head}: framework load returned null`);
        failed += 1;
        continue;
      }

      // THIS call's extraction, not the deal roll-up. Same reasoning as
      // preview-recap: field_extractions is one row per (deal, field), so what
      // this call established is the rows it last wrote. Reading the roll-up
      // attributes another call's answers to this one.
      const fx = await db
        .from("field_extractions")
        .select("framework_field_key, status, answer, evidence, confidence")
        .eq("deal_id", job.deal.id)
        .eq("last_updated_from_call_id", job.call.id);
      if (fx.error) {
        console.log(`  FAILED ${head}: extraction read: ${fx.error.message}`);
        failed += 1;
        continue;
      }
      const extraction = Object.fromEntries(
        (fx.data ?? []).map((x) => [String((x as { framework_field_key: string }).framework_field_key), x]),
      ) as unknown as ExtractionMap;

      const built = await buildRecap({
        tenantId,
        dealId: job.deal.id,
        account: job.deal.account,
        framework,
        fallbackStageKey: job.deal.stage_key as string,
        closeDate: job.deal.rep_forecast_close_date,
        extraction,
        transcript: job.body,
        callId: job.call.id,
        callAt: job.call.scheduled_start,
        meetingType: (job.call.meeting_type as MeetingType | null) ?? undefined,
      });

      if (built.kind !== "qualification") {
        // A renewal or support call gets the readout and no qualification
        // record, which is the documented routing. Counted as itself rather
        // than as a failure, because it is neither.
        console.log(`  general ${head}: routed as '${built.kind}', which has no Note artifact`);
        general += 1;
        continue;
      }

      const noteBody = renderRecapNote({
        account: built.account,
        callTitle: job.call.title,
        callAt: formatMeetingTime(job.call.scheduled_start ?? undefined),
        stageKey: built.stageKey,
        narrative: built.narrative,
        demoStrategy: built.demoStrategy,
        captured: built.summary.captured,
        stillOpen: built.summary.stillOpen,
        history: built.history,
      });

      const res = await postRecapNote({
        tenantSlug: SLUG,
        accountId: job.deal.salesforce_account_id as string,
        account: built.account,
        callAt: job.call.scheduled_start,
        body: noteBody,
        apply: true,
      });
      const secs = Math.round((Date.now() - started) / 1000);
      if (res.posted) {
        posted += 1;
        console.log(`  posted  ${head}  ${noteBody.length} chars in ${secs}s -> ${res.contentNoteId}`);
      } else if (res.alreadyThere) {
        already += 1;
        console.log(`  already ${head}  (${res.alreadyThere})`);
      } else {
        failed += 1;
        console.log(`  FAILED  ${head}: ${res.reason}`);
      }
    } catch (err) {
      failed += 1;
      console.log(`  FAILED  ${head}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (skips.length > 0) {
    console.log(`\n${"-".repeat(80)}`);
    console.log(`CANNOT RECAP (${skips.length}) - each says why, none is a silent drop`);
    console.log(`${"-".repeat(80)}`);
    const byWhy = new Map<string, typeof skips>();
    for (const s of skips) (byWhy.get(s.why) ?? byWhy.set(s.why, []).get(s.why)!).push(s);
    for (const [why, list] of [...byWhy.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n  ${list.length}x  ${why}`);
      for (const s of list) console.log(`      ${s.when}  ${s.label}`);
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  if (apply) {
    console.log(`posted ${posted}, already present ${already}, general-call ${general}, failed ${failed}`);
  } else {
    console.log(`DRY RUN. Nothing generated, nothing written. ${todo.length} would be attempted.`);
    console.log(`Each is three Anthropic passes over a full transcript, roughly 3.5 minutes.`);
  }
  console.log(`${"=".repeat(80)}\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
