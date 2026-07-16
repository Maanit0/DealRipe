/**
 * Link an auto-created deal to a Rolldog opportunity (the one-click confirm for
 * a review-tier match). This turns write-back ON for that deal: the write-back
 * path authorizes the linked opp per-deal. Shows the opp's account + website so
 * you can verify it's the right customer BEFORE writing.
 *
 *   npx tsx scripts/link-deal.ts --deal auto:corelogistics.net --opp 12345           # preview
 *   npx tsx scripts/link-deal.ts --deal auto:corelogistics.net --opp 12345 --apply   # link
 *
 * --confidence defaults to "confirmed" (a human confirmed it). Only confirmed
 * and high links write back.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const BASE = process.env.ROLLDOG_BASE_URL ?? "https://api.rolldog.com";
const OAUTH = process.env.ROLLDOG_OAUTH_URL ?? "https://login.rolldog.com/oauth/token";
const AUD = process.env.ROLLDOG_AUDIENCE ?? "https://rolldog-api";
const CID = process.env.ROLLDOG_CLIENT_ID;
const SECRET = process.env.ROLLDOG_CLIENT_SECRET;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function token(): Promise<string> {
  const res = await fetch(OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CID, client_secret: SECRET, audience: AUD, grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`token failed: ${res.status}`);
  return (await res.json()).access_token as string;
}
async function get(tok: string, path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.api+json" },
  });
  if (!res.ok) return null;
  return res.json();
}

async function main(): Promise<void> {
  const dealExternalId = arg("--deal");
  const opp = arg("--opp");
  const confidence = arg("--confidence") ?? "confirmed";
  const apply = process.argv.includes("--apply");
  if (!dealExternalId || !opp) {
    console.error("Usage: --deal <external_id> --opp <rolldog_opp_id> [--confidence confirmed|high] [--apply]");
    process.exit(1);
  }
  if (confidence !== "confirmed" && confidence !== "high") {
    console.error("--confidence must be 'confirmed' or 'high' (only those write back).");
    process.exit(1);
  }

  // Show the opp you're about to link to, so you can eyeball it.
  const tok = await token();
  const core = (await get(tok, `/opportunities/${opp}`))?.data?.attributes ?? {};
  const accountId = core["account-id"];
  const website = accountId ? (await get(tok, `/accounts/${accountId}`))?.data?.attributes?.website : null;

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const deal = await db
    .from("deals")
    .select("id, account")
    .eq("tenant_id", tenantId)
    .eq("external_id", dealExternalId)
    .maybeSingle();
  if (deal.error || !deal.data) {
    console.error(`Deal '${dealExternalId}' not found.`);
    process.exit(1);
  }

  console.log("");
  console.log(`DealRipe deal:  ${dealExternalId}  (account "${deal.data.account}")`);
  console.log(`Rolldog opp:    ${opp}  account "${core["account-name"] ?? "?"}"  website ${website ?? "(none)"}`);
  console.log(`Confidence:     ${confidence}`);
  console.log("");

  if (!apply) {
    console.log("Preview only. If that's the right customer, re-run with --apply to link and enable write-back.");
    return;
  }

  const upd = await db
    .from("deals")
    .update({ rolldog_opportunity_id: opp, rolldog_link_confidence: confidence })
    .eq("id", deal.data.id);
  if (upd.error) {
    console.error(`Link failed: ${upd.error.message}`);
    process.exit(1);
  }
  console.log("LINKED. Write-back will fire for this deal after its next captured call.");
}

main().catch((e) => {
  console.error("Unexpected error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
