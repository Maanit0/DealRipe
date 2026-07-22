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

  const calls = await db
    .from("calls")
    .select("id, meeting_type, call_subtype, has_been_extracted, outcome")
    .eq("tenant_id", tenantId)
    .eq("has_been_extracted", true)
    .is("call_subtype", null);
  if (calls.error) {
    console.error(calls.error.message);
    process.exit(1);
  }
  const rows = (calls.data ?? []) as Array<{
    id: string;
    meeting_type: string | null;
    call_subtype: string | null;
    outcome: string | null;
  }>;
  console.log(`${rows.length} calls without a subtype.\n`);

  let done = 0;
  for (const c of rows) {
    const tr = await db.from("transcripts").select("body").eq("call_id", c.id).maybeSingle();
    const body = tr.data?.body ?? "";
    if (body.trim().length < 50) {
      console.log(`  ${c.id}  (no transcript, skipped)`);
      continue;
    }
    const meetingType = (c.meeting_type as MeetingType | null) ?? (await classifyMeetingType(body));
    const subtype = await classifyCallSubtype({ transcript: body, meetingType });
    console.log(`  ${c.id}  ${meetingType} -> ${subtype}`);
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
