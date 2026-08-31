/**
 * Give the re-engagement rows already in the Activity log something to open.
 *
 * `lib/reengage-draft.ts` archived every draft with `html: ""` until
 * 2026-08-31, so the rows render in the list and the detail panel is blank.
 * The body was never lost: recordSentMessage stored it in `body_text`. This
 * rebuilds `body_html` from what is already there.
 *
 * WHAT IT CANNOT RECOVER, and therefore does not invent: the flag that caused
 * the draft (only its id survives, in the subject prefix) and whether the draft
 * went onto an existing thread. Backfilled rows carry the body and the
 * recipients and no reason block. A row that says less than a fresh one is
 * honest; a row that guesses why we emailed a customer is not.
 *
 * Dry run by default, --apply WRITES.
 *
 *   npx tsx scripts/backfill-draft-archive.ts
 *   npx tsx scripts/backfill-draft-archive.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { draftArchiveHtml } from "../lib/draft-archive";
import { supabaseAdmin } from "../lib/supabase";

const APPLY = process.argv.includes("--apply");
// Rebuild rows that already have html. Needed once because the first pass wrote
// "New email to ..." on rows where the thread was never recorded; the renderer
// now has an unknown state and these have to be re-rendered to pick it up.
const REDO = process.argv.includes("--redo");

(async () => {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("sent_messages")
    .select("id, to_email, subject, body_text, body_html, sent_at")
    .eq("kind", "reengage_draft")
    .order("sent_at", { ascending: false });
  if (error) throw new Error(error.message);

  const blank = (data ?? []).filter((r) => (REDO || !r.body_html) && r.body_text);
  const noBody = (data ?? []).filter((r) => !r.body_html && !r.body_text);
  console.log(
    `${data?.length ?? 0} re-engagement rows, ${blank.length} blank and recoverable, ` +
      `${noBody.length} blank with no stored body (left alone)`,
  );

  for (const r of blank) {
    const to = String(r.to_email ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const html = draftArchiveHtml({
      to,
      body: String(r.body_text),
      // Omitted, which the renderer reads as UNKNOWN rather than as "new
      // email". Passing null claimed these were fresh sends when some were
      // replies, which is the same error the rest of this codebase keeps
      // making: an absent record rendered as a definite negative.
    });
    console.log(`  ${String(r.sent_at).slice(0, 16)}  ${String(r.subject).slice(0, 60)}  ${html.length} chars`);
    if (APPLY) {
      const { error: e } = await db.from("sent_messages").update({ body_html: html }).eq("id", r.id);
      if (e) console.error(`    FAILED: ${e.message}`);
    }
  }
  console.log(APPLY ? `\nwrote ${blank.length}` : `\ndry run, nothing written. --apply to write ${blank.length}`);
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
