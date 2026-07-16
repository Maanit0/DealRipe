/**
 * Find a Rolldog account (and its opportunities) by website domain, so we can
 * resolve a deal to the right opp even when the account name doesn't match the
 * meeting. Tries a few filter forms; uses iffusa.com as a known-good control
 * (that account's website is http://www.iffusa.com).
 *
 *   npx tsx scripts/find-account-by-domain.ts
 *   npx tsx scripts/find-account-by-domain.ts corelogistics.net
 */

import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = process.env.ROLLDOG_BASE_URL ?? "https://api.rolldog.com";
const OAUTH = process.env.ROLLDOG_OAUTH_URL ?? "https://login.rolldog.com/oauth/token";
const AUD = process.env.ROLLDOG_AUDIENCE ?? "https://rolldog-api";
const CID = process.env.ROLLDOG_CLIENT_ID;
const SECRET = process.env.ROLLDOG_CLIENT_SECRET;

async function token(): Promise<string> {
  const res = await fetch(OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CID, client_secret: SECRET, audience: AUD, grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`token failed: ${res.status}`);
  return (await res.json()).access_token as string;
}
async function get(tok: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.api+json" },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function findAccount(tok: string, domain: string): Promise<void> {
  console.log(`\n=== ${domain} ===`);
  const forms = [
    `/accounts?filter[website]=${encodeURIComponent(domain)}`,
    `/accounts?filter[website]=${encodeURIComponent("http://www." + domain)}`,
    `/accounts?filter[website]=${encodeURIComponent("https://www." + domain)}`,
    `/accounts?filter[website][like]=${encodeURIComponent(domain)}`,
    `/accounts?search=${encodeURIComponent(domain)}`,
  ];
  let accountId: string | null = null;
  for (const path of forms) {
    const r = await get(tok, path);
    const list = Array.isArray(r.body?.data) ? r.body.data : [];
    console.log(`  ${path}\n     -> status ${r.status}, ${list.length} account(s)`);
    for (const a of list.slice(0, 3)) {
      console.log(`        ${a.id}  ${a.attributes?.name ?? "?"}  (${a.attributes?.website ?? "no site"})`);
      if (!accountId) accountId = String(a.id);
    }
    if (accountId) break;
  }
  if (!accountId) {
    console.log("  -> no account matched this domain by any form.");
    return;
  }
  // That account's opportunities.
  const opps = await get(tok, `/opportunities?filter[account-id]=${accountId}&page[size]=50`);
  const list = Array.isArray(opps.body?.data) ? opps.body.data : [];
  console.log(`  opportunities for account ${accountId}: status ${opps.status}, ${list.length}`);
  for (const o of list) {
    console.log(`        opp ${o.id}  "${o.attributes?.["account-name"] ?? "?"}"  ${o.attributes?.["stage-name"] ?? ""}`);
  }
}

async function main(): Promise<void> {
  const domains = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const targets = domains.length > 0 ? domains : ["iffusa.com", "corelogistics.net"];
  const tok = await token();
  for (const d of targets) await findAccount(tok, d);
  console.log("\nIf iffusa.com resolved to IFF's account/opp, the same form works for corelogistics.net.");
}

main().catch((e) => {
  console.error("Unexpected error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
