/**
 * Full pilot audit: every call DealRipe captured in a window, with its type and
 * whether it got a briefing, a recap, and a Rolldog write-back. Unlike
 * pilot-metrics.ts (which mirrors the Report page and only counts calls that
 * produced a Rolldog write-back), this lists ALL calls, including existing-
 * customer calls that get a recap and flags but no CRM write-back.
 *
 *   npx tsx scripts/pilot-audit.ts               # since 2026-07-14 (covers the Jul 16 start)
 *   npx tsx scripts/pilot-audit.ts 2026-07-16    # since a specific date
 *   npx tsx scripts/pilot-audit.ts 21            # last 21 days
 *
 * Runs on your Mac with .env.local (needs Supabase access).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getActivityLog } from "../lib/activity-log";
import { repName } from "../lib/display-names";
import { callSubtypeLabel } from "../lib/meeting-classify";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function shortDate(iso: string | null): string {
  if (!iso) return "??????";
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" });
  } catch {
    return "??????";
  }
}
const yn = (b: boolean) => (b ? "yes" : " - ");

async function main(): Promise<void> {
  const arg = process.argv[2];
  let since: string;
  if (arg && /^\d+$/.test(arg)) {
    since = new Date(Date.now() - parseInt(arg, 10) * 86_400_000).toISOString().slice(0, 10);
  } else {
    since = arg ?? "2026-07-14";
  }

  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  const dealsRes = await db.from("deals").select("id, account, rep_email").eq("tenant_id", tenantId);
  const dealInfo = new Map(
    ((dealsRes.data ?? []) as Array<{ id: string; account: string; rep_email: string | null }>).map(
      (d) => [d.id, { account: d.account, rep: repName(d.rep_email) }] as const,
    ),
  );

  const callsRes = await db
    .from("calls")
    .select("id, deal_id, scheduled_start, call_date, meeting_type, call_subtype")
    .eq("tenant_id", tenantId);
  type CallRow = { id: string; deal_id: string | null; scheduled_start: string | null; call_date: string | null; meeting_type: string | null; call_subtype: string | null };
  const allCalls = (callsRes.data ?? []) as CallRow[];
  const calls = allCalls
    .map((c) => ({ ...c, when: c.scheduled_start ?? c.call_date }))
    .filter((c) => c.when != null && c.when.slice(0, 10) >= since)
    .sort((a, b) => (a.when! < b.when! ? -1 : 1));

  const inWindowCallIds = new Set(calls.map((c) => c.id));

  // Index the activity log by call.
  const entries = await getActivityLog(tenantId);
  type CallActivity = { briefing: boolean; recap: boolean; noShow: boolean; wroteBack: boolean; fields: string[] };
  const byCall = new Map<string, CallActivity>();
  const fieldPairs = new Set<string>(); // dealId::field, in-window write-backs only
  for (const e of entries) {
    if (!e.callId || !inWindowCallIds.has(e.callId)) continue;
    const rec = byCall.get(e.callId) ?? { briefing: false, recap: false, noShow: false, wroteBack: false, fields: [] };
    if (e.kind === "briefing") rec.briefing = true;
    if (e.kind === "recap") rec.recap = true;
    if (e.kind === "no_show_draft") rec.noShow = true;
    if (e.kind === "rolldog_write") {
      rec.wroteBack = true;
      const fs = (e.fields ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      rec.fields.push(...fs);
      for (const f of fs) fieldPairs.add(`${e.dealId}::${f}`);
    }
    byCall.set(e.callId, rec);
  }

  // ---- Per-call listing ----
  console.log(`\n=== PILOT AUDIT (magaya) — calls since ${since} ===\n`);
  console.log("DATE    ACCOUNT                REP        TYPE            BRIEF RECAP WRITE  FIELDS");
  for (const c of calls) {
    const info = c.deal_id ? dealInfo.get(c.deal_id) : null;
    const acct = (info?.account ?? (c.deal_id ? "(deal)" : "(no deal)")).slice(0, 21).padEnd(22);
    const rep = (info?.rep ?? "-").padEnd(10);
    const type = (callSubtypeLabel(c.call_subtype) ?? c.meeting_type ?? "-").slice(0, 14).padEnd(15);
    const a = byCall.get(c.id) ?? { briefing: false, recap: false, noShow: false, wroteBack: false, fields: [] };
    console.log(
      `${shortDate(c.when).padEnd(7)} ${acct} ${rep} ${type} ${yn(a.briefing).padEnd(5)} ${yn(a.recap || a.noShow).padEnd(5)} ${yn(a.wroteBack).padEnd(6)} ${a.fields.length || ""}`,
    );
  }

  // ---- Totals ----
  const byType = new Map<string, number>();
  for (const c of calls) {
    const t = c.meeting_type ?? "unclassified";
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  const withWrite = calls.filter((c) => byCall.get(c.id)?.wroteBack).length;
  const withRecap = calls.filter((c) => { const a = byCall.get(c.id); return a?.recap || a?.noShow; }).length;
  const withBrief = calls.filter((c) => byCall.get(c.id)?.briefing).length;
  const dealsWritten = new Set(calls.filter((c) => byCall.get(c.id)?.wroteBack && c.deal_id).map((c) => c.deal_id)).size;
  const first = calls[0]?.when ?? null;
  const last = calls[calls.length - 1]?.when ?? null;

  console.log(`\n--- TOTALS (since ${since}) ---`);
  console.log(`  Calls captured           : ${calls.length}   (first ${shortDate(first)}, last ${shortDate(last)})`);
  console.log(`  By type                  : ${[...byType.entries()].map(([t, n]) => `${t} ${n}`).join("  |  ")}`);
  console.log(`  Briefings sent           : ${withBrief}`);
  console.log(`  Recaps / no-show drafts  : ${withRecap}`);
  console.log(`  Calls with Rolldog write : ${withWrite}`);
  console.log(`  Deals written back       : ${dealsWritten}`);
  console.log(`  Qualification fields     : ${fieldPairs.size}`);

  // ---- Per rep ----
  console.log(`\n--- BY REP ---`);
  const reps = new Map<string, { calls: number; recap: number; write: number }>();
  for (const c of calls) {
    const rep = (c.deal_id ? dealInfo.get(c.deal_id)?.rep : null) ?? "Unknown";
    const r = reps.get(rep) ?? { calls: 0, recap: 0, write: 0 };
    r.calls += 1;
    const a = byCall.get(c.id);
    if (a?.recap || a?.noShow) r.recap += 1;
    if (a?.wroteBack) r.write += 1;
    reps.set(rep, r);
  }
  for (const [rep, r] of [...reps.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(`  ${rep.padEnd(10)} ${r.calls} calls   ${r.recap} recaps   ${r.write} write-backs`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
