/**
 * Apply the reviewed confirmed/high matches (from match-and-confirm.ts) onto
 * the auto-created deals: set rolldog_opportunity_id + rolldog_link_confidence.
 * That's what turns write-back on for a deal (the write-back path only writes
 * to a deal's own confirmed/high-linked opp). review/none are skipped.
 *
 * Dry-run by default: prints what it WOULD link. Pass --apply to write.
 *
 *   npx tsx scripts/apply-opp-links.ts            # dry run
 *   npx tsx scripts/apply-opp-links.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { autoDealExternalId } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SLUG = "magaya";

type Mapping = {
  domain: string;
  subject: string;
  status: string;
  oppId: string | null;
  account: string | null;
};

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dir = path.join(process.cwd(), ".previews");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith("opp-mappings-") && f.endsWith(".json"));
  } catch {
    /* no dir */
  }
  if (files.length === 0) {
    console.error("No .previews/opp-mappings-*.json. Run match-and-confirm.ts first.");
    process.exit(1);
  }

  const tenantId = await resolveTenantId(SLUG);
  const db = supabaseAdmin();
  let linked = 0;
  let noDeal = 0;
  let skipped = 0;

  for (const f of files) {
    const mappings: Mapping[] = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    for (const m of mappings) {
      if ((m.status !== "confirmed" && m.status !== "high") || !m.oppId) {
        skipped += 1;
        console.log(`  skip (${m.status}) ${m.domain} ${m.account ? `-> ${m.account}` : ""}`);
        continue;
      }
      const ext = autoDealExternalId(m.domain);
      const deal = await db
        .from("deals")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("external_id", ext)
        .maybeSingle();
      if (deal.error || !deal.data) {
        noDeal += 1;
        console.log(`  no auto deal for ${m.domain} yet (enable auto-join first) [would link -> opp ${m.oppId}]`);
        continue;
      }
      if (apply) {
        const upd = await db
          .from("deals")
          .update({ rolldog_opportunity_id: m.oppId, rolldog_link_confidence: m.status })
          .eq("id", deal.data.id);
        if (upd.error) {
          console.log(`  ERROR linking ${m.domain}: ${upd.error.message}`);
          continue;
        }
        console.log(`  LINKED ${m.domain} -> opp ${m.oppId} (${m.status})`);
      } else {
        console.log(`  would link ${m.domain} -> opp ${m.oppId} (${m.status})`);
      }
      linked += 1;
    }
  }

  console.log(
    `\n${apply ? "Linked" : "Would link"} ${linked}, ${noDeal} no-deal-yet, ${skipped} review/none skipped.`,
  );
  if (!apply) console.log("Dry run. Re-run with --apply to write the links.");
}

main().catch((e) => {
  console.error("Unexpected error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
