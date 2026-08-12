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
  // A Salesforce account confirmed by a human, for the case the matcher cannot
  // reach: Lumistar and MLX Trading Group were both in Salesforce and invisible
  // to it, because the deals are named "Korea" and "Mollaxpanama" after a
  // calendar subject and an email domain. Verify with sf-find-account.ts first,
  // this stores whatever id it is given.
  const sfAccount = arg("--sf-account");
  const confidence = arg("--confidence") ?? "confirmed";
  const apply = process.argv.includes("--apply");
  if (!dealExternalId || (!opp && !sfAccount)) {
    console.error(
      "Usage: --deal <external_id|account name> [--opp <rolldog_opp_id>] [--sf-account <salesforce_account_id>] [--confidence confirmed|high] [--apply]",
    );
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
  // Accepts the external_id or the account name. The external_id for a
  // free-mail customer is the full address, which nobody types from memory:
  // "Nat Forwarding" is the name in every report and was rejected here.
  const all = await db
    .from("deals")
    .select("id, account, external_id")
    .eq("tenant_id", tenantId);
  if (all.error) {
    console.error(`deals lookup failed: ${all.error.message}`);
    process.exit(1);
  }
  const rows = (all.data ?? []) as Array<{ id: string; account: string; external_id: string | null }>;
  const needle = dealExternalId.trim().toLowerCase();
  const exact = rows.filter((d) => String(d.external_id ?? "").toLowerCase() === needle);
  const byName = rows.filter((d) => (d.account ?? "").toLowerCase().includes(needle));
  const hits = exact.length > 0 ? exact : byName;

  if (hits.length === 0) {
    console.error(`Deal '${dealExternalId}' not found by external_id or account name.`);
    process.exit(1);
  }
  if (hits.length > 1) {
    // Linking the wrong deal writes one customer's qualification onto another
    // customer's opportunity, so an ambiguous name stops here.
    console.error(`'${dealExternalId}' matches ${hits.length} deals. Use the external_id:`);
    for (const h of hits) console.error(`  ${h.account}  ${h.external_id}`);
    process.exit(1);
  }
  const deal = { data: hits[0], error: null as null };

  console.log("");
  console.log(`DealRipe deal:  ${dealExternalId}  (account "${deal.data.account}")`);
  if (opp) {
    console.log(`Rolldog opp:    ${opp}  account "${core["account-name"] ?? "?"}"  website ${website ?? "(none)"}`);
  }
  if (sfAccount) {
    console.log(`Salesforce:     ${sfAccount}  (verify with sf-find-account.ts; this stores it as given)`);
  }
  console.log(`Confidence:     ${confidence}`);
  console.log("");

  if (!apply) {
    console.log("Preview only. If that's the right customer, re-run with --apply to link and enable write-back.");
    return;
  }

  // Only the fields actually supplied. A deal can be confirmed against one CRM
  // without touching what is stored for the other.
  const patch: Record<string, unknown> = {};
  if (opp) {
    patch.rolldog_opportunity_id = opp;
    patch.rolldog_link_confidence = confidence;
  }
  if (sfAccount) {
    patch.salesforce_account_id = sfAccount;
    patch.salesforce_link_confidence = confidence;
  }

  const upd = await db.from("deals").update(patch as never).eq("id", deal.data.id);
  if (upd.error) {
    console.error(`Link failed: ${upd.error.message}`);
    process.exit(1);
  }
  console.log("LINKED. Write-back will fire for this deal after its next captured call.");
  if (sfAccount && !opp) {
    console.log("");
    console.log("Salesforce only, which is correct before a discovery call: Magaya does not");
    console.log("create the Rolldog opportunity until after it. Once one exists, the link");
    console.log("resolver picks it up and Rolldog becomes the system of record from then on.");
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
