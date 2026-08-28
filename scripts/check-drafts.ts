/**
 * Is the draft we recorded actually in the rep's mailbox?
 *
 * followup_draft_state is set to 'drafted' on the strength of a 201 from Graph,
 * which is a claim about a POST rather than about the mailbox. Ariel Rodriguez,
 * 2026-08-28, on a call where two of his rows said drafted: "I don't get
 * anything on draft."
 *
 * Looked up by the RFC 5322 internetMessageId that createDraft already stores in
 * sent_messages.provider_id. SUBJECT MATCHING WAS TRIED FIRST AND IS WRONG in
 * both directions: a reply draft inherits the thread's subject from Graph rather
 * than the one we generated, and the fresh-draft fallback subject stopped
 * carrying the account name on 2026-08-28 because the slug was leaking at
 * customers. Over the same 17 drafts, matching loosely said 8 were present and
 * matching on our recorded subject said 2. The id says which.
 *
 * Read-only.
 *
 *   npx tsx scripts/check-drafts.ts --days 7
 *   npx tsx scripts/check-drafts.ts --rep arodriguez@magaya.com --days 14
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readMessageStateByInternetId } from "../lib/graph-mail";
import { supabaseAdmin } from "../lib/supabase";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 7);
  const wantRep = (arg("--rep") ?? "").trim().toLowerCase();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("sent_messages")
    .select("sent_at, to_email, subject, provider_id")
    .eq("kind", "followup_draft")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false });
  if (error) throw new Error(error.message);

  const rows = (data ?? []).filter((r) => !wantRep || String(r.to_email ?? "").toLowerCase() === wantRep);
  if (rows.length === 0) {
    console.log(`\nNo drafts recorded in the last ${days} days.\n`);
    return;
  }

  const tally = { draft: 0, sent: 0, gone: 0, unavailable: 0, noId: 0 };
  console.log(`\n${rows.length} drafts recorded in the last ${days} days:\n`);

  for (const r of rows) {
    const mailbox = String(r.to_email ?? "").trim().toLowerCase();
    const id = String(r.provider_id ?? "").trim();
    const when = String(r.sent_at).slice(0, 16);
    const subj = String(r.subject ?? "").slice(0, 40);
    if (!id) {
      tally.noId += 1;
      console.log(`  NO ID      ${when}  ${mailbox.split("@")[0].padEnd(11)} ${subj}   (recorded before the id was stored)`);
      continue;
    }
    const state = await readMessageStateByInternetId({
      tenantIdOrDomain: "magaya.com",
      mailbox,
      internetMessageId: id,
    });
    tally[state.status === "draft" ? "draft" : state.status === "sent" ? "sent" : state.status === "gone" ? "gone" : "unavailable"] += 1;
    const label =
      state.status === "draft"
        ? "IN DRAFTS "
        : state.status === "sent"
          ? "SENT      "
          : state.status === "gone"
            ? "GONE      "
            : "UNREADABLE";
    console.log(`  ${label} ${when}  ${mailbox.split("@")[0].padEnd(11)} ${subj}`);
  }

  console.log(
    `\n  ${tally.draft} still in Drafts, ${tally.sent} the rep SENT, ${tally.gone} gone, ${tally.unavailable} unreadable, ${tally.noId} with no stored id.`,
  );
  // GONE is deliberately not called a failure. Graph 404s on the id when a
  // message is deleted AND, in some cases, after a send reassigns it, so the two
  // are not separable from here. Saying "gone" is the honest answer; saying
  // "never created" would be inventing the half we cannot see.
  console.log(`  "gone" means Graph no longer has that id: deleted by the rep, or sent in a way that reassigned it. Not separable from here.\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
