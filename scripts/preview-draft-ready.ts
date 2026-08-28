/**
 * Render the "your draft is ready" email for a draft that already exists.
 *
 * Reads the real draft out of the rep's mailbox by the internetMessageId stored
 * on the sent_messages row, so the subject shown is the one Outlook actually
 * gave it. Sends nothing.
 *
 *   npx tsx scripts/preview-draft-ready.ts --rep arodriguez@magaya.com
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

import { renderDraftReadyEmail } from "../lib/emails/draft-ready";
import { readMessageStateByInternetId } from "../lib/graph-mail";
import { supabaseAdmin } from "../lib/supabase";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const rep = (arg("--rep") ?? "arodriguez@magaya.com").toLowerCase();
  const db = supabaseAdmin();
  const { data } = await db
    .from("sent_messages")
    .select("sent_at, subject, provider_id, body_text, deal_id")
    .eq("kind", "followup_draft")
    .eq("to_email", rep)
    .not("provider_id", "is", null)
    .order("sent_at", { ascending: false })
    .limit(1);
  const row = (data ?? [])[0];
  if (!row) {
    console.error(`No draft with a stored id for ${rep}.`);
    process.exit(1);
  }

  const { data: deal } = await db.from("deals").select("account").eq("id", row.deal_id as string).maybeSingle();

  const state = await readMessageStateByInternetId({
    tenantIdOrDomain: "magaya.com",
    mailbox: rep,
    internetMessageId: String(row.provider_id),
  });
  if (state.status !== "draft" && state.status !== "sent") {
    console.error(`That draft is ${state.status} in the mailbox, nothing to preview.`);
    process.exit(1);
  }

  const email = renderDraftReadyEmail({
    account: String(deal?.account ?? "the customer"),
    meetingWhen: String(row.sent_at ?? "").slice(0, 10),
    to: [],
    draftSubject: state.subject,
    body: String(row.body_text ?? ""),
    // Graph returns the real webLink only at creation time and we do not store
    // it, so this preview shows the BUTTON with a stand-in href. Marked as such
    // in the console output: the layout is real, this particular link is not.
    webLink: "https://outlook.office.com/mail/drafts/",
  });

  mkdirSync(".previews", { recursive: true });
  const out = ".previews/draft-ready.html";
  writeFileSync(out, email.html, "utf8");
  console.log(`\n  subject: ${email.subject}`);
  console.log(`  the draft's REAL subject in Outlook: "${state.subject}"`);
  console.log(`  what we had recorded instead:        "${row.subject}"`);
  console.log(`\n${email.text}\n`);
  console.log(`  the Open button here uses a stand-in link. In production it is the webLink Graph returns at creation.`);
  console.log(`  wrote ${out}\n`);
  execFile("open", [out], () => {});
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
