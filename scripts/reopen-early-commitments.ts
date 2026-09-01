/**
 * Reopen end commitments that were judged before they could have been kept.
 *
 * `runEmailPass` stamped `email_checked_at` whenever the mailbox was read and
 * held nothing, on the reasoning that a read-and-empty mailbox is a real
 * negative with nothing to retry. That is true for a commitment already due and
 * false for one that is not, and the stamp is permanent: the pending filter is
 * `email_checked_at === null`, so a stamped row never comes back.
 *
 * Measured 2026-08-31: 68 of 75 email-checked commitments were checked before
 * the mail that would have settled them existed, and 67 of those carry
 * `followed='no'`. Medovlog is the proof: its 08-27 commitment reads "Nick sends
 * the services list by Friday August 28, Magaya sends the revised proposal by
 * Wednesday September 2", scored 'no', and the deal closed WON on 08-28 with a
 * completed Magaya Quote Agreement in the deal's own mail.
 *
 * `COMMITMENT_SETTLE_DAYS` stops this happening again. This clears the stamp on
 * the rows it already happened to, so the next scoring run reads a mailbox that
 * now contains the evidence.
 *
 * ONLY ROWS WHOSE CALL IS PAST THE SETTLE WINDOW. Reopening a row whose
 * commitment is still not due would just have it stamped again by an older
 * deployment, and there is nothing yet to find either way.
 *
 * It clears a marker. It never changes `followed`: the scorer decides that, and
 * a verdict edited by a script is exactly the drift this codebase warns about.
 *
 * Dry run by default, --apply WRITES.
 *
 *   npx tsx scripts/reopen-early-commitments.ts
 *   npx tsx scripts/reopen-early-commitments.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { COMMITMENT_SETTLE_DAYS } from "../lib/prescription-scoring";
import { supabaseAdmin } from "../lib/supabase";

const APPLY = process.argv.includes("--apply");
/**
 * Reopen every commitment decided by the OUTBOUND-ONLY email pass, not just the
 * ones judged too early.
 *
 * The pass read `mail.outbound` alone until 2026-08-31, so a commitment the
 * CUSTOMER owed could not be evidenced at all and a signature confirmation,
 * written by neither party, was invisible. Every verdict recorded before the
 * inbound fix rests on half the thread.
 */
const OUTBOUND_ERA = process.argv.includes("--outbound-era");

(async () => {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("prescribed_actions")
    .select("id, call_id, deal_id, text, followed, email_checked_at, issued_at")
    .eq("kind", "end_commitment")
    .not("email_checked_at", "is", null);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    id: string; call_id: string | null; text: string; followed: string | null;
    email_checked_at: string; issued_at: string;
  }>;

  const callIds = [...new Set(rows.map((r) => r.call_id).filter((c): c is string => !!c))];
  const { data: calls } = await db.from("calls").select("id, scheduled_start, call_date").in("id", callIds);
  const callAt = new Map(
    ((calls ?? []) as Array<{ id: string; scheduled_start: string | null; call_date: string | null }>)
      .map((c) => [c.id, c.scheduled_start ?? c.call_date]),
  );

  const reopen = rows.filter((r) => {
    if (r.followed === "yes") return false; // already settled in our favour, leave it
    const at = r.call_id ? callAt.get(r.call_id) : null;
    if (!at) return false;
    // NO REQUIREMENT THAT THE CALL IS PAST THE SETTLE WINDOW.
    //
    // An earlier version had one, to avoid reopening a row that a deployment
    // without COMMITMENT_SETTLE_DAYS would simply stamp again. With the settle
    // window in place the scorer leaves such a row open instead, so the guard
    // now does harm: Medovlog's 08-27 commitment is five days old, carries a
    // stamp applied on 08-30, and was therefore skipped and left frozen at 'no'
    // by the very script written to unfreeze it. A stamp that should not exist
    // is worth clearing whether or not the commitment is due yet.
    if (OUTBOUND_ERA) return true;
    // Was it judged before the commitment could plausibly have been kept?
    const checkedDaysAfterCall = (Date.parse(r.email_checked_at) - Date.parse(at)) / 86_400_000;
    return checkedDaysAfterCall < COMMITMENT_SETTLE_DAYS;
  });

  console.log(`${rows.length} email-checked commitments`);
  console.log(`  judged inside the settle window, call now past it: ${reopen.length}`);
  console.log(`  left alone: ${rows.length - reopen.length}\n`);
  for (const r of reopen.slice(0, 12)) {
    const at = r.call_id ? callAt.get(r.call_id) : null;
    const d = at ? Math.round((Date.parse(r.email_checked_at) - Date.parse(at)) / 86_400_000) : NaN;
    console.log(`  checked ${d}d after call, followed=${r.followed} :: ${r.text.replace(/\s+/g, " ").slice(0, 78)}`);
  }
  if (reopen.length > 12) console.log(`  ... and ${reopen.length - 12} more`);

  if (!APPLY) {
    console.log(`\nDry run. --apply clears email_checked_at on ${reopen.length} row(s), then run score-prescriptions.`);
    return;
  }
  let done = 0;
  for (const r of reopen) {
    const { error: e } = await db.from("prescribed_actions").update({ email_checked_at: null }).eq("id", r.id);
    if (e) console.error(`  FAILED ${r.id}: ${e.message}`);
    else done += 1;
  }
  console.log(`\nreopened ${done}. Now run: npx tsx scripts/score-prescriptions.ts`);
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
