/**
 * Recover the prescription ledger from briefings already sent.
 *
 *   npx tsx scripts/backfill-prescriptions.ts                     # dry run
 *   npx tsx scripts/backfill-prescriptions.ts --apply             # writes
 *   npx tsx scripts/backfill-prescriptions.ts --apply --score     # writes, then scores
 *   npx tsx scripts/backfill-prescriptions.ts --days 21 --rep jlopez@magaya.com
 *
 * DRY RUN BY DEFAULT. Nothing is written without --apply.
 *
 * The structured briefing object was never persisted: briefing-sync rendered it
 * and threw it away, so on disk a briefing exists only as prose in
 * sent_messages.body_text. This parses it back out. That is a real loss of
 * fidelity and worth naming rather than hiding:
 *
 *   RECOVERABLE   the three asks, and the end commitment. The text layout in
 *                 lib/emails/pre-call-briefing.ts is stable and machine
 *                 readable.
 *   NOT           targetFields, the framework field ids each question was
 *                 aimed at. The email carries targetLabel ("Budget") and never
 *                 the ids, so every backfilled row gets
 *                 framework_field_keys = null. Null, not empty: we do not know
 *                 what it targeted, which is different from it targeting
 *                 nothing.
 *
 * Everything issued after supabase/add-prescription-ledger.sql is applied is
 * written structurally at issue and does not go through this path.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  parseBriefingEmailText,
  prescriptionsFromBriefingEmail,
  recordPrescriptions,
} from "../lib/prescription-ledger";
import { runPrescriptionScoring } from "../lib/prescription-scoring";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

/** The two reps with the most captured calls. */
const DEFAULT_REPS = ["jlopez@magaya.com", "ebencomo@magaya.com"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

type SentRow = {
  id: string;
  deal_id: string | null;
  call_id: string | null;
  to_email: string;
  subject: string;
  body_text: string;
  sent_at: string;
};

async function main(): Promise<void> {
  const apply = flag("--apply");
  const alsoScore = flag("--score");
  const days = Number(arg("--days") ?? 21);
  const repArg = arg("--rep");
  const allReps = flag("--all");

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // --all means every rep who was actually sent a briefing in the window,
  // read from the archive rather than from a hardcoded list. A rep who
  // onboarded last week has no entry in PILOT_REP_EMAILS and would be silently
  // left out of the ledger by a static list, which is the same shape of bug as
  // reporting an unchecked thing as absent.
  let reps: string[];
  if (repArg) {
    reps = [repArg.trim().toLowerCase()];
  } else if (allReps) {
    const seen = await db
      .from("sent_messages")
      .select("to_email")
      .eq("tenant_id", tenantId)
      .eq("kind", "briefing")
      .gte("sent_at", since);
    if (seen.error) throw new Error(`rep discovery failed: ${seen.error.message}`);
    reps = [...new Set((seen.data ?? []).map((r) => r.to_email.trim().toLowerCase()))].sort();
    if (reps.length === 0) {
      console.log("No briefings were sent to anybody in that window.");
      return;
    }
  } else {
    reps = DEFAULT_REPS;
  }

  console.log(
    `\n${apply ? "APPLY" : "DRY RUN"}  backfilling prescriptions from briefings sent in the last ${days} days`,
  );
  console.log(`reps: ${reps.join(", ")}\n`);

  const res = await db
    .from("sent_messages")
    .select("id, deal_id, call_id, to_email, subject, body_text, sent_at")
    .eq("tenant_id", tenantId)
    .eq("kind", "briefing")
    .in("to_email", reps)
    .gte("sent_at", since)
    .order("sent_at", { ascending: true });
  if (res.error) throw new Error(`sent_messages read failed: ${res.error.message}`);
  const sent = (res.data ?? []) as SentRow[];

  if (sent.length === 0) {
    console.log("No briefings found in that window. Nothing to backfill.");
    return;
  }

  const dealsRes = await db
    .from("deals")
    .select("id, account")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(`deals read failed: ${dealsRes.error.message}`);
  const accounts = new Map(
    ((dealsRes.data ?? []) as Array<{ id: string; account: string }>).map((d) => [d.id, d.account]),
  );

  let parsedOk = 0;
  let unparseable = 0;
  let noCall = 0;
  let rowsWouldWrite = 0;
  let rowsWritten = 0;
  let rowsDuplicate = 0;
  let writeFailed = 0;

  for (const m of sent) {
    const account = m.deal_id ? accounts.get(m.deal_id) ?? m.deal_id : "(no deal)";
    const when = m.sent_at.slice(0, 16).replace("T", " ");

    // A briefing with no call has nothing to score against, and call_id is not
    // null on the ledger by design. Report it rather than inventing a target.
    if (!m.deal_id || !m.call_id) {
      noCall += 1;
      console.log(`  SKIP  ${when}  ${account.padEnd(24)} archived briefing has no ${m.deal_id ? "call" : "deal"} id`);
      continue;
    }

    const parsed = parseBriefingEmailText(m.body_text ?? "");
    if (!parsed) {
      unparseable += 1;
      console.log(`  SKIP  ${when}  ${account.padEnd(24)} body did not match the briefing layout`);
      continue;
    }
    parsedOk += 1;
    const prescriptions = prescriptionsFromBriefingEmail(parsed);
    rowsWouldWrite += prescriptions.length;

    console.log(`\n  ${when}  ${account}  (${m.to_email})`);
    for (const p of prescriptions) {
      console.log(`      ${p.kind === "question" ? "ask " : "next"}  ${p.text}`);
    }

    if (!apply) continue;

    const written = await recordPrescriptions({
      tenantId,
      dealId: m.deal_id,
      callId: m.call_id,
      source: "briefing",
      // When the rep was told, not when this script ran.
      issuedAt: m.sent_at,
      prescriptions,
    });
    if (written.status === "unavailable") {
      writeFailed += 1;
      console.log(`      WRITE FAILED: ${written.error}`);
    } else if (written.status === "written") {
      rowsWritten += written.inserted;
      rowsDuplicate += written.skippedDuplicates;
    }
  }

  console.log(`\n${"-".repeat(70)}`);
  console.log(`  briefings found        ${sent.length}`);
  console.log(`  parsed                 ${parsedOk}`);
  if (unparseable > 0) console.log(`  layout not recognized  ${unparseable}`);
  if (noCall > 0) console.log(`  no deal or call id     ${noCall}`);
  console.log(`  prescriptions          ${rowsWouldWrite}${apply ? "" : " (would write)"}`);
  if (apply) {
    console.log(`  written                ${rowsWritten}`);
    console.log(`  already in the ledger  ${rowsDuplicate}`);
    if (writeFailed > 0) console.log(`  write failures         ${writeFailed}`);
  }
  console.log(
    `\n  Every backfilled row carries framework_field_keys = null: the sent email holds the ` +
      `question's category, never the field ids. Rows issued after the migration carry them.`,
  );

  if (!apply) {
    console.log(`\n  Dry run. Re-run with --apply to write, and --apply --score to score straight after.\n`);
    return;
  }

  if (alsoScore) {
    console.log(`\n${"-".repeat(70)}\n  scoring\n`);
    const counts = await runPrescriptionScoring({
      tenantSlug: TENANT_SLUG,
      repEmails: reps,
      since,
      onDecision: (d) => {
        if (d.kind === "scored") {
          console.log(`  scored     ${d.account.padEnd(24)} ${d.rows} row(s), ${d.followed} done, ${d.notFollowed} not`);
        } else if (d.kind === "no-transcript") {
          console.log(
            `  ${d.retry ? "retry    " : "retired  "} ${d.account.padEnd(24)} ${d.rows} row(s): ${d.detail}`,
          );
        } else if (d.kind === "error") {
          console.log(`  ERROR      ${d.account.padEnd(24)} ${d.message}`);
        }
      },
    });
    console.log(`\n  ${JSON.stringify(counts, null, 2).replace(/\n/g, "\n  ")}\n`);
  } else {
    console.log(`\n  Written. Score them with:  npx tsx scripts/backfill-prescriptions.ts --apply --score\n`);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
