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

  const body = String(row.body_text ?? "");
  const firstLines = body.split("\n").map((l) => l.trim()).filter(Boolean).slice(1, 3).join(" ");

  const email = renderDraftReadyEmail({
    account: String(deal?.account ?? "the customer"),
    to: [],
    draftSubject: state.subject,
    // The real webLink is only returned at creation time and is not stored, so
    // the preview shows the shape without a live link. Say so rather than
    // rendering a fake one.
    webLink: null,
    preview: firstLines ? firstLines.slice(0, 180) : null,
  });

  mkdirSync(".previews", { recursive: true });
  const out = ".previews/draft-ready.html";
  writeFileSync(out, email.html, "utf8");
  console.log(`\n  subject: ${email.subject}`);
  console.log(`  the draft's REAL subject in Outlook: "${state.subject}"`);
  console.log(`  what we had recorded instead:        "${row.subject}"`);
  console.log(`\n${email.text}\n`);
  console.log(`  wrote ${out}\n`);
  execFile("open", [out], () => {});
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
