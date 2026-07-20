/**
 * Generate the weekly digest from LIVE deal context and write it to an HTML
 * file for review. Optionally send it. This is the automated version of the
 * hand-written digest: it pulls every deal's ranked signals from the snapshots
 * (lib/digest.ts getPilotDigest) and renders them, no hand-authoring.
 *
 * Safe by default: writes the file and previews; only sends with --send.
 *
 *   npx tsx scripts/generate-digest.ts                          # build + write ../digest-generated.html
 *   npx tsx scripts/generate-digest.ts --to mbuman@magaya.com   # build + preview recipient
 *   npx tsx scripts/generate-digest.ts --to mbuman@magaya.com --reply-to you@example.com --send
 *
 * Options:
 *   --out       output HTML path (default ../digest-generated.html)
 *   --to        recipient (required only with --send)
 *   --reply-to  replies go here
 *   --name      recipient name shown in the header (default "Mark Buman")
 *   --send      actually email it
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";

import { getPilotDigest } from "../lib/digest";
import { renderWeeklyDigestEmail } from "../lib/emails/weekly-digest";
import { sendEmail } from "../lib/mailer";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function weekLabel(): string {
  return new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/Chicago" });
}

async function main(): Promise<void> {
  const out = arg("--out") ?? "../digest-generated.html";
  const to = arg("--to");
  const replyTo = arg("--reply-to");
  const name = arg("--name") ?? "Mark Buman";
  const send = process.argv.includes("--send");

  const baseUrl = process.env.DEALRIPE_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? arg("--base-url");
  const tenantId = await resolveTenantId("magaya");
  const entries = await getPilotDigest(tenantId);
  const email = renderWeeklyDigestEmail({
    entries,
    weekLabel: weekLabel(),
    recipientName: name,
    baseUrl,
  });
  if (!baseUrl) {
    console.log("Note: DEALRIPE_APP_URL not set, digest rendered without deal links. Set it (e.g. https://your-app.vercel.app) to enable click-through.");
  }

  writeFileSync(out, email.html, "utf8");

  const attention = entries.filter((e) => e.attention > 0);
  console.log(`Deals scanned:     ${entries.length}`);
  console.log(`Needs attention:   ${attention.length}${attention.length ? "  (" + attention.slice(0, 5).map((e) => e.account).join(", ") + ")" : ""}`);
  console.log(`Subject:           ${email.subject}`);
  console.log(`Written to:        ${out}`);

  if (!send) {
    console.log(`\nReview the file above. To send: add --to <email> --send`);
    return;
  }
  if (!to) {
    console.error("\n--send requires --to <email>");
    process.exit(1);
  }
  const res = await sendEmail({ to, subject: email.subject, html: email.html, text: email.text, ...(replyTo ? { replyTo } : {}) });
  console.log(`\nSent to ${to}. Resend id: ${res.id}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
