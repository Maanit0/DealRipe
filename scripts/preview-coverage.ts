/**
 * Read-only sanity check for the meeting coverage view. Prints, per meeting in a
 * range, the briefing / recap / write-back status the /activity coverage tab
 * shows, plus the raw counts of sent_messages and Rolldog writes found for the
 * deal, so you can tell "genuinely never sent" apart from an attribution gap.
 *
 *   npx tsx scripts/preview-coverage.ts            # last 30 days
 *   npx tsx scripts/preview-coverage.ts --range 7d
 *   npx tsx scripts/preview-coverage.ts --range custom --from 2026-07-01 --to 2026-07-22
 *
 * Writes nothing.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { resolveRange } from "../lib/date-range";
import { getMeetingCoverage } from "../lib/meeting-coverage";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pad(s: string, n: number): string {
  return (s.length > n ? s.slice(0, n - 1) + "…" : s).padEnd(n);
}

async function main(): Promise<void> {
  const range = resolveRange(arg("--range") ?? "30d", arg("--from"), arg("--to"));
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const coverage = await getMeetingCoverage(tenantId, { sinceIso: range.sinceIso, untilIso: range.untilIso });

  // Raw per-deal counts, to spot attribution gaps.
  const dealIds = Array.from(new Set(coverage.map((m) => m.dealId).filter(Boolean))) as string[];
  const [sent, crm] = await Promise.all([
    dealIds.length
      ? db.from("sent_messages").select("deal_id, call_id, kind").eq("tenant_id", tenantId).in("deal_id", dealIds)
      : Promise.resolve({ data: [] as unknown[] }),
    db.from("crm_access_log").select("call_id, opportunity_external_id").eq("tenant_id", tenantId).eq("operation", "write").eq("allowed", true),
  ]);
  const sentByDeal = new Map<string, { b: number; r: number; linked: number }>();
  for (const s of (sent.data ?? []) as Array<{ deal_id: string; call_id: string | null; kind: string }>) {
    const g = sentByDeal.get(s.deal_id) ?? { b: 0, r: 0, linked: 0 };
    if (s.kind === "briefing") g.b++;
    else if (s.kind === "recap") g.r++;
    if (s.call_id) g.linked++;
    sentByDeal.set(s.deal_id, g);
  }

  console.log(`\nCoverage for ${range.key} (${coverage.length} meetings)\n`);
  console.log(pad("Meeting", 26), pad("Type", 14), pad("Briefing", 16), pad("Recap", 16), pad("Write-back", 18));
  console.log("-".repeat(92));
  for (const m of coverage) {
    const raw = m.dealId ? sentByDeal.get(m.dealId) : undefined;
    const rawNote = raw ? ` [deal has ${raw.b}b/${raw.r}r, ${raw.linked} call-linked]` : "";
    // No-show rows report the two no-show steps in the recap/write-back columns.
    const col2 = m.isNoShow ? `ns-followup:${m.noShowFollowup.status}` : m.recap.status;
    const col3 = m.isNoShow
      ? `ns-log:${m.noShowLog.status}`
      : `${m.writeback.status}${m.writeback.missed.length ? ` miss:${m.writeback.missed.join(",")}` : ""}`;
    console.log(
      pad(m.title || m.account || "—", 26),
      pad((m.isNoShow ? "no-show" : m.callSubtype || m.meetingType) || "—", 14),
      pad(`${m.briefing.status}`, 16),
      pad(col2, 18),
      pad(col3, 20),
      rawNote,
    );
  }
  console.log("\nStatuses: on_time / late / early / duplicate / missing / pending / not_expected");
  console.log("If a row shows recap=missing but the deal has >0 r, that's an attribution gap, not a real miss.\n");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
