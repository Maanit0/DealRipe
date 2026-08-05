/**
 * What does Outlook actually put in a reply draft before we touch it?
 *
 * Our drafts end with a signature block learned from the rep's sent mail. If
 * Graph's createReply already seeds the body with the rep's Outlook signature,
 * the rep opens the draft and sees two. That is the kind of detail that makes a
 * rep stop trusting the feature, and it cannot be reasoned about: Graph's
 * behaviour here varies by tenant and by how the signature is configured.
 *
 * So: create a reply skeleton, read what came back, report whether it contains
 * a signature and how the quoted thread is delimited, then DELETE it. Nothing
 * is sent, and nothing is left behind for the rep to find.
 *
 *   npx tsx scripts/probe-reply-shape.ts --mailbox jlopez@magaya.com --domain corelogistics.net
 *
 * Mailbox must be on GRAPH_MAIL_ALLOWED_MAILBOXES. Run on your Mac.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { assertMailboxAllowed, listMailboxMessages, resolveGraphTenantId } from "../lib/graph-mail";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_TENANT = "magaya.com";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function token(): Promise<string> {
  const tenantId = await resolveGraphTenantId(GRAPH_TENANT);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.MS_CLIENT_ID ?? process.env.MICROSOFT_CLIENT_ID ?? "",
    client_secret: process.env.MS_CLIENT_SECRET ?? process.env.MICROSOFT_CLIENT_SECRET ?? "",
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as { access_token?: string; error_description?: string };
  if (!json.access_token) throw new Error(json.error_description ?? "token request failed");
  return json.access_token;
}

async function main(): Promise<void> {
  const mailbox = arg("--mailbox");
  const domain = arg("--domain");
  if (!mailbox || !domain) {
    console.error("Usage: --mailbox <rep@magaya.com> --domain <customer.com>");
    process.exit(1);
  }
  assertMailboxAllowed(mailbox);

  const msgs = await listMailboxMessages({
    tenantIdOrDomain: GRAPH_TENANT,
    mailbox,
    since: new Date(Date.now() - 180 * 86_400_000),
    domains: [domain],
  });
  const target = msgs.find((m) => !m.outbound) ?? msgs[0];
  if (!target) {
    console.log(`\nNo messages with ${domain} in ${mailbox}. Try another domain.\n`);
    return;
  }

  console.log(`\nreplying to: "${target.subject}"  (${target.at})`);
  console.log(`from:        ${target.from}\n`);

  const t = await token();
  const user = encodeURIComponent(mailbox);

  const createRes = await fetch(
    `${GRAPH_BASE}/users/${user}/messages/${encodeURIComponent(target.id)}/createReply`,
    { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}" },
  );
  if (!createRes.ok) throw new Error(`createReply failed: ${createRes.status} ${await createRes.text()}`);
  const draft = (await createRes.json()) as { id?: string; body?: { content?: string }; toRecipients?: unknown[] };
  if (!draft.id) throw new Error("no draft id returned");

  const html = draft.body?.content ?? "";
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

  console.log("WHAT GRAPH SEEDED THE REPLY WITH");
  console.log(`  recipients prefilled: ${(draft.toRecipients ?? []).length}`);
  console.log(`  body length:          ${html.length} chars of HTML`);
  console.log(`  visible text length:  ${text.length} chars`);
  console.log(`  looks like a signature block: ${/(?:sincerely|best regards|regards,|thanks,|\+?\d[\d .()-]{8,})/i.test(text) ? "YES" : "no"}`);
  console.log(`  contains the quoted thread:   ${/from:|sent:|wrote:/i.test(text) ? "YES" : "no"}`);
  console.log("");
  console.log("FIRST 600 CHARS OF VISIBLE TEXT");
  console.log(text.slice(0, 600) || "(empty)");
  console.log("");

  const del = await fetch(`${GRAPH_BASE}/users/${user}/messages/${encodeURIComponent(draft.id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${t}` },
  });
  console.log(del.ok ? "Probe draft deleted. Nothing left in the mailbox.\n" : `WARNING: could not delete probe draft ${draft.id} (HTTP ${del.status}). Delete it by hand.\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
