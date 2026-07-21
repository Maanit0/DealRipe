/**
 * Backfill a digest send into the log, for a digest that went out before the
 * logging existed. Inserts a sent_messages row (kind="digest", deal_id null).
 * Requires the deal_id-nullable migration to have run first:
 *   alter table sent_messages alter column deal_id drop not null;
 *
 * Defaults to the July 20 digest sent to Mark. Reads the HTML from the file
 * generate-digest wrote (the exact email that was sent). sent_at is taken from
 * that file's last-modified time (when it was generated and sent).
 *
 *   npx tsx scripts/log-digest-send.ts
 *   npx tsx scripts/log-digest-send.ts --to x@y.com --subject "..." --provider-id <id> --html ../digest-generated.html
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync, statSync } from "node:fs";

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const to = arg("--to", "mbuman@magaya.com");
  const subject = arg("--subject", "DealRipe weekly digest, week of July 20. 2 need attention");
  const providerId = arg("--provider-id", "9b69eff2-d59c-4f9f-b24e-b3c55f4bd350");
  const htmlPath = arg("--html", "../digest-generated.html");

  const html = readFileSync(htmlPath, "utf8");
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&middot;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentAt = (() => {
    const explicit = arg("--sent-at", "");
    if (explicit) return explicit;
    try {
      return statSync(htmlPath).mtime.toISOString();
    } catch {
      return new Date().toISOString();
    }
  })();

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  // Don't double-insert if this exact send is already logged.
  const existing = await db
    .from("sent_messages")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("kind", "digest")
    .eq("provider_id", providerId)
    .maybeSingle();
  if (existing.data) {
    console.log(`Already logged (provider_id ${providerId}). Nothing to do.`);
    return;
  }

  const res = await db.from("sent_messages").insert({
    tenant_id: tenantId,
    deal_id: null,
    call_id: null,
    kind: "digest",
    to_email: to,
    subject,
    body_html: html,
    body_text: text,
    provider_id: providerId,
    sent_at: sentAt,
  });
  if (res.error) {
    console.error(`Insert failed: ${res.error.message}`);
    if (/null value|not-null|deal_id/i.test(res.error.message)) {
      console.error(
        "\nRun the migration first:\n  alter table sent_messages alter column deal_id drop not null;",
      );
    }
    process.exit(1);
  }
  console.log(`Logged the digest sent to ${to} (Resend ${providerId}, sent ${sentAt}). View it at /digests.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
