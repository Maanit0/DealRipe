/**
 * Discovery: does a Rolldog account record carry a website/domain we can match
 * on? If yes, we match customer domain -> account domain (bulletproof) instead
 * of guessing on names. Read-only; prints every attribute on the account so we
 * can spot a website/domain/email field.
 *
 *   npx tsx scripts/check-account-fields.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = process.env.ROLLDOG_BASE_URL ?? "https://api.rolldog.com";
const OAUTH = process.env.ROLLDOG_OAUTH_URL ?? "https://login.rolldog.com/oauth/token";
const AUD = process.env.ROLLDOG_AUDIENCE ?? "https://rolldog-api";
const CID = process.env.ROLLDOG_CLIENT_ID;
const SECRET = process.env.ROLLDOG_CLIENT_SECRET;

const KNOWN_OPPS = ["80566", "80018"]; // Martin Brower (Juan), IFF (Eduardo)

async function token(): Promise<string> {
  if (!CID || !SECRET) throw new Error("ROLLDOG_CLIENT_ID / ROLLDOG_CLIENT_SECRET not set");
  const res = await fetch(OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CID, client_secret: SECRET, audience: AUD, grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`token failed: ${res.status} ${await res.text()}`);
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

function printAttrs(label: string, body: any): void {
  const data = body?.data;
  const attrs = Array.isArray(data) ? data[0]?.attributes : data?.attributes;
  if (!attrs) {
    console.log(`  ${label}: no attributes (body keys: ${Object.keys(body ?? {}).join(", ")})`);
    return;
  }
  console.log(`  ${label}:`);
  for (const [k, v] of Object.entries(attrs)) {
    const val = typeof v === "string" || typeof v === "number" || v === null ? v : JSON.stringify(v);
    console.log(`     ${k}: ${val}`);
  }
}

async function main(): Promise<void> {
  const tok = await token();

  for (const opp of KNOWN_OPPS) {
    console.log(`\n=== opp ${opp} ===`);
    const core = await get(tok, `/opportunities/${opp}`);
    const accountId = core.body?.data?.attributes?.["account-id"];
    const accountName = core.body?.data?.attributes?.["account-name"];
    console.log(`  account-id ${accountId}  (${accountName})`);

    // Try the account resource directly, and via the opp relationship.
    if (accountId != null) {
      const a = await get(tok, `/accounts/${accountId}`);
      console.log(`  GET /accounts/${accountId} -> ${a.status}`);
      if (a.status === 200) printAttrs("account attributes", a.body);
    }
    const rel = await get(tok, `/opportunities/${opp}/account`);
    console.log(`  GET /opportunities/${opp}/account -> ${rel.status}`);
    if (rel.status === 200) printAttrs("account (via relationship)", rel.body);
  }

  console.log("\nLook for a website / domain / url / email field above. If one exists, we match domain-to-domain.");
}

main().catch((e) => {
  console.error("Unexpected error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
