/**
 * List the exact briefings and recaps DealRipe emailed for a deal, and dump
 * each one's HTML to .previews/ so you can open it in a browser. Read-only.
 *
 *   npx tsx scripts/view-messages.ts --deal dutyfreeamericas
 *   npx tsx scripts/view-messages.ts --deal dutyfreeamericas --text   # also print bodies
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { getSentMessages } from "../lib/sent-messages";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ext = arg("--deal");
  const showText = process.argv.includes("--text");
  if (!ext) {
    console.error("Usage: --deal <external_id> [--text]");
    process.exit(1);
  }
  const tenantId = await resolveTenantId("magaya");
  const deal = await supabaseAdmin()
    .from("deals")
    .select("id, account")
    .eq("tenant_id", tenantId)
    .eq("external_id", ext)
    .maybeSingle();
  if (deal.error || !deal.data) {
    console.error(`Deal '${ext}' not found.`);
    process.exit(1);
  }

  const messages = await getSentMessages(deal.data.id);
  console.log(`\n${deal.data.account}: ${messages.length} sent message(s)\n`);
  if (messages.length === 0) {
    console.log("Nothing archived yet. Briefings/recaps are stored here from the next send onward.");
    return;
  }

  mkdirSync(".previews", { recursive: true });
  for (const m of messages) {
    const stamp = m.sentAt.replace(/[:.]/g, "-");
    const file = `.previews/${m.kind}-${ext}-${stamp}.html`;
    writeFileSync(file, m.bodyHtml, "utf8");
    console.log(`[${m.kind.toUpperCase()}] ${m.sentAt}  to ${m.toEmail}`);
    console.log(`  subject: ${m.subject}`);
    console.log(`  html:    ${file}`);
    if (showText) {
      console.log("  ----- text -----");
      console.log(
        m.bodyText
          .split("\n")
          .map((l) => "  " + l)
          .join("\n"),
      );
    }
    console.log("");
  }
  console.log("Open any of the .html files in a browser to see the exact email.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
