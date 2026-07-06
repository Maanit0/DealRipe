/**
 * Dry-run the pre-call briefing email: generate a briefing for a seeded deal,
 * render the email, and write an HTML preview. Optionally send it.
 *
 *   npx tsx scripts/test-briefing-email.ts
 *   npx tsx scripts/test-briefing-email.ts --deal aquagulf
 *   npx tsx scripts/test-briefing-email.ts --send you@example.com
 *
 * Requires ANTHROPIC_API_KEY + Supabase. --send needs RESEND_API_KEY +
 * MAIL_FROM. No database writes.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderPreCallBriefingEmail } from "../lib/emails/pre-call-briefing";
import { loadFramework } from "../lib/framework";
import { generateMagayaBriefing } from "../lib/generate-briefing";
import { getDealForTenant } from "../lib/supabase-queries";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

type Args = { tenantSlug: string; dealExternalId: string; send?: string; out: string };

function parseArgs(argv: string[]): Args {
  const a: Args = {
    tenantSlug: "magaya",
    dealExternalId: "aquagulf",
    out: path.join(process.cwd(), ".previews", "pre-call-briefing.html"),
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--tenant") a.tenantSlug = argv[++i] ?? a.tenantSlug;
    else if (v === "--deal") a.dealExternalId = argv[++i] ?? a.dealExternalId;
    else if (v === "--send") a.send = argv[++i];
    else if (v === "--out") a.out = argv[++i] ?? a.out;
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = await resolveTenantId(args.tenantSlug);
  const db = supabaseAdmin();

  const dealRow = await db
    .from("deals")
    .select("id, framework_id")
    .eq("tenant_id", tenantId)
    .eq("external_id", args.dealExternalId)
    .maybeSingle();
  if (dealRow.error || !dealRow.data) {
    console.error(`Deal '${args.dealExternalId}' not found for tenant ${args.tenantSlug}.`);
    process.exit(1);
  }
  if (!dealRow.data.framework_id) {
    console.error(`Deal '${args.dealExternalId}' has no framework.`);
    process.exit(1);
  }

  const deal = await getDealForTenant(tenantId, dealRow.data.id);
  if (!deal) {
    console.error("getDealForTenant returned null.");
    process.exit(1);
  }
  const framework = await loadFramework(tenantId, dealRow.data.framework_id);
  if (!framework) {
    console.error("loadFramework returned null.");
    process.exit(1);
  }

  console.log(`deal:      ${deal.account} (${deal.stageKey})`);
  console.log("generating briefing...");
  const briefing = await generateMagayaBriefing(deal, framework);
  if (!briefing) {
    console.error("briefing generation returned null.");
    process.exit(1);
  }

  const email = renderPreCallBriefingEmail(briefing, {
    account: deal.account,
    stageKey: deal.stageKey,
    minutesUntil: 30,
  });

  mkdirSync(path.dirname(args.out), { recursive: true });
  writeFileSync(args.out, email.html, "utf8");

  console.log("");
  console.log("================= EMAIL (text) =================");
  console.log(`Subject: ${email.subject}`);
  console.log("");
  console.log(email.text);
  console.log("===============================================");
  console.log("");
  console.log(`HTML preview written to: ${args.out}`);

  if (args.send) {
    console.log(`sending to ${args.send} ...`);
    const { sendEmail } = await import("../lib/mailer");
    const res = await sendEmail({
      to: args.send,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    console.log(`sent. id=${res.id}`);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
