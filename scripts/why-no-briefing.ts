/**
 * Why did this call never get a briefing?
 *
 * "Briefing never sent" is one label covering several unrelated causes, and
 * they need different fixes:
 *
 *   1. The call row did not exist during the send window. calendar-sync creates
 *      it; if the invite was accepted or the Teams link added late, there was
 *      nothing to brief when the window was open. Nobody is at fault and no code
 *      change helps except widening the grace period.
 *   2. The briefing was generated and then SUPPRESSED, because it failed the
 *      lint twice. That is the system working as designed, and it is also the
 *      one case where a human should look, since a suppressed briefing means we
 *      had something to say and could not say it safely.
 *   3. The deal has no context at all, so there was nothing to write.
 *   4. Something threw.
 *
 * Only the first is visible from the calls row alone. So this reconstructs the
 * window from the real constants, then regenerates the briefing now and runs the
 * real lint over it, which tells you whether a briefing for this deal would pass
 * today.
 *
 *   npx tsx scripts/why-no-briefing.ts --deal Gezairi
 *   npx tsx scripts/why-no-briefing.ts --call <call-uuid>
 *
 * READ ONLY. Regenerating costs one model call and sends nothing.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getDealContext, briefingStateFromContext } from "../lib/deal-context";
import { generateBriefingFromState } from "../lib/generate-briefing";
import { formatMeetingTime } from "../lib/graph-time";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

// Mirrored from lib/briefing-sync.ts. If these drift, this script lies, so they
// are named here explicitly rather than silently re-guessed.
const LEAD_MAX_MINUTES = 35;
const GRACE_AFTER_START_MINUTES = 10;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dealName = arg("--deal")?.toLowerCase() ?? null;
  const callId = arg("--call") ?? null;
  if (!dealName && !callId) {
    console.log("\nUsage: --deal <account> | --call <uuid>\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const deals = await db.from("deals").select("id, account, rep_email").eq("tenant_id", tenantId);
  if (deals.error) throw new Error(deals.error.message);
  const dealById = new Map((deals.data ?? []).map((d) => [d.id, d]));

  let q = db
    .from("calls")
    .select("id, deal_id, title, scheduled_start, created_at, briefing_sent_at, outcome")
    .eq("tenant_id", tenantId);
  if (callId) q = q.eq("id", callId);
  const res = await q.order("scheduled_start", { ascending: false }).limit(200);
  if (res.error) throw new Error(res.error.message);

  const rows = (res.data ?? []).filter((c) => {
    if (callId) return true;
    const d = dealById.get(c.deal_id);
    return (d?.account ?? "").toLowerCase().includes(dealName ?? "");
  });

  if (rows.length === 0) {
    console.log("\nNo matching call.\n");
    return;
  }

  for (const c of rows.slice(0, 4)) {
    const d = dealById.get(c.deal_id);
    const startMs = Date.parse(String(c.scheduled_start ?? ""));
    const createdMs = Date.parse(String(c.created_at ?? ""));
    const windowOpens = startMs - LEAD_MAX_MINUTES * 60_000;
    const windowCloses = startMs + GRACE_AFTER_START_MINUTES * 60_000;

    console.log("");
    console.log(`${formatMeetingTime(c.scheduled_start)}   ${(c.title ?? "").slice(0, 56)}`);
    console.log(`   deal        ${d?.account ?? "?"}   rep ${(d?.rep_email ?? "?").split("@")[0]}`);
    console.log(`   call id     ${c.id}`);
    console.log(`   briefing    ${c.briefing_sent_at ? `sent ${formatMeetingTime(c.briefing_sent_at)}` : "never sent"}`);
    console.log(`   window      ${formatMeetingTime(new Date(windowOpens).toISOString())} to ${formatMeetingTime(new Date(windowCloses).toISOString())} Central`);
    console.log(`   row created ${formatMeetingTime(c.created_at)}`);

    if (Number.isFinite(createdMs) && createdMs > windowCloses) {
      console.log(`   VERDICT     The call row was created AFTER the window closed. There was nothing to brief while the cron could still act. Not a bug in briefing-sync.`);
      continue;
    }
    if (c.briefing_sent_at) {
      console.log(`   VERDICT     A briefing was sent for this row.`);
      continue;
    }

    console.log(`   The row existed during the window, so the send was attempted and did not complete.`);
    console.log(`   Regenerating now to see whether a briefing for this deal is even producible.`);

    const ctx = await getDealContext(tenantId, c.deal_id);
    if (!ctx) {
      console.log(`   VERDICT     Deal context is unavailable, so no briefing could be built.`);
      continue;
    }
    console.log(`   context     ${ctx.confirmed}/${ctx.total} gates, salesforce ${ctx.crmContextStatus}`);

    try {
      const b = await generateBriefingFromState({
        ...briefingStateFromContext(ctx),
        meetingSubject: c.title ?? null,
        meetingDate: String(c.scheduled_start ?? "").slice(0, 10) || null,
      });
      if (!b) {
        // generateBriefingFromState returning null after its own lint retries is
        // the suppression path. This is the answer worth finding.
        console.log(`   VERDICT     SUPPRESSED. Generation returned nothing, which is what happens when a briefing fails the lint twice. We had something to say and could not say it safely.`);
      } else {
        console.log(`   VERDICT     A briefing generates cleanly today, so the failure was transient (a missed cron tick, a Graph or model error at 7:55).`);
        console.log(`   objective   ${b.callObjective}`);
      }
    } catch (e) {
      console.log(`   VERDICT     Generation THREW: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
