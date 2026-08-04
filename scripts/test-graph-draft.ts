/**
 * Create a test DRAFT in a rep's mailbox to prove the Mail.ReadWrite grant works
 * end to end. Nothing is ever sent: the draft lands in the rep's Drafts folder
 * and only they can send it.
 *
 *   npx tsx scripts/test-graph-draft.ts --tenant magaya.com --mailbox jlopez@magaya.com
 *   npx tsx scripts/test-graph-draft.ts --tenant magaya.com --mailbox jlopez@magaya.com --apply
 *
 * Dry run by default: prints exactly what would be written and stops. Pass
 * --apply to actually create the draft.
 *
 * The mailbox must be on GRAPH_MAIL_ALLOWED_MAILBOXES in .env.local, e.g.
 *   GRAPH_MAIL_ALLOWED_MAILBOXES=jlopez@magaya.com,ebencomo@magaya.com
 *
 * Needs MS_CLIENT_ID and MS_CLIENT_SECRET.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { allowedMailboxes, createDraft } from "../lib/graph-mail";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const tenant = arg("--tenant");
  const mailbox = arg("--mailbox");
  const apply = process.argv.includes("--apply");

  if (!tenant || !mailbox) {
    console.error("Usage: --tenant <domain-or-guid> --mailbox <rep@customer.com> [--apply]");
    process.exit(1);
  }

  const subject = "DealRipe test draft, safe to delete";
  const body = [
    "This is a DealRipe test draft.",
    "",
    "It was created in your Drafts folder to confirm the Outlook connection works.",
    "Nothing was sent, and DealRipe cannot send mail: it holds permission to write",
    "drafts only. Delete this whenever.",
    "",
    "Maanit",
  ].join("\n");

  console.log(`\ntenant:   ${tenant}`);
  console.log(`mailbox:  ${mailbox}`);
  console.log(`allowlist: ${allowedMailboxes().join(", ") || "(empty, set GRAPH_MAIL_ALLOWED_MAILBOXES)"}`);
  console.log(`\nsubject:  ${subject}`);
  console.log("body:");
  console.log(
    body
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );

  if (!apply) {
    console.log("\nDry run. Nothing written. Re-run with --apply to create the draft.\n");
    return;
  }

  const res = await createDraft({ tenantIdOrDomain: tenant, mailbox, subject, body });
  console.log(`\nDraft created in ${mailbox}'s Drafts folder.`);
  console.log(`  id:      ${res.id}`);
  if (res.webLink) console.log(`  open:    ${res.webLink}`);
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.name : "Error"}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
