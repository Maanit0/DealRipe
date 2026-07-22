/**
 * Backfill call_subtype (and meeting_type if missing) for existing captured
 * calls, by classifying their stored transcripts. Run once after applying the
 * add-call-title-subtype migration. Skips calls that already have a subtype.
 *
 *   npx tsx scripts/backfill-call-subtype.ts            # dry run (prints)
 *   npx tsx scripts/backfill-call-subtype.ts --apply    # write
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { classifyCallSubtype, classifyMeetingType, type MeetingType } from "../lib/meeting-classify";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const [calls, dealsRes] = await Promise.all([
    db
      .from("calls")
      .select("id, deal_id, meeting_type, call_subtype, has_been_extracted, outcome, scheduled_start, call_date")
      .eq("tenant_id", tenantId)
      .eq("has_been_extracted", true)
      .is("call_subtype", null),
    db.from("deals").select("id, account").eq("tenant_id", tenantId),
  ]);
  if (calls.error) {
    console.error(calls.error.message);
    process.exit(1);
  }
  const accountById = new Map(
    ((dealsRes.data ?? []) as Array<{ id: string; account: string }>).map((d) => [d.id, d.account] as const),
  );
  const rows = (calls.data ?? []) as Array<{
    id: string;
    deal_id: string | null;
    meeting_type: string | null;
    call_subtype: string | null;
    outcome: string | null;
    scheduled_start: string | null;
    call_date: string | null;
  }>;
  console.log(`${rows.length} calls without a subtype.\n`);

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—";

  let done = 0;
  for (const c of rows) {
    const label = `${accountById.get(c.deal_id ?? "") ?? "(no deal)"} ${fmt(c.scheduled_start ?? c.call_date)}`.padEnd(28);
    const tr = await db.from("transcripts").select("body").eq("call_id", c.id).maybeSingle();
    const body = tr.data?.body ?? "";
    if (body.trim().length < 50) {
      console.log(`  ${label}  (no transcript, skipped)`);
      continue;
    }
    const meetingType = (c.meeting_type as MeetingType | null) ?? (await classifyMeetingType(body));
    const subtype = await classifyCallSubtype({ transcript: body, meetingType });
    console.log(`  ${label}  ${meetingType} -> ${subtype}`);
    if (apply) {
      const upd = await db
        .from("calls")
        .update({ meeting_type: meetingType, call_subtype: subtype })
        .eq("id", c.id);
      if (upd.error) console.error(`    update failed: ${upd.error.message}`);
      else done += 1;
    }
  }
  console.log(apply ? `\nUpdated ${done} calls.` : `\nDry run. Re-run with --apply to write.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
