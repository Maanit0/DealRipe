/**
 * Authenticate to Magaya's Salesforce with the JWT bearer flow and report which
 * objects are actually readable.
 *
 * Ernesto configured the Connected App against the certificate we sent and set
 * the OAuth policy to "admin-approved users are pre-authorized". That is the
 * JWT bearer flow: the private key replaces a client secret, which is why no
 * secret was ever issued. lib/salesforce.ts still uses client_credentials, so
 * it cannot authenticate against this app; this proves the flow before that
 * refactor, and before Monday.
 *
 * It also answers the question the permission set raises. The grant covers
 * Opportunity, Lead, Contact, Event and Task, but the Sales Development fields
 * Mark screen-shared (Software Purposes, Compelling Events, Executive
 * Sponsorship, Budget Confirmed) live on ACCOUNT, which is not in the list. If
 * Account is unreadable, the pre-call context we wanted Salesforce for is out
 * of reach and that needs raising with Ernesto now, not on Monday.
 *
 * Setup in .env.local:
 *   SF_LOGIN_URL=https://magayacorporation.my.salesforce.com
 *   SF_CLIENT_ID=<consumer key from Ernesto>
 *   SF_USERNAME=svc_app1_salesforce_ro@magaya.com
 *   SF_PRIVATE_KEY_PATH=/absolute/path/to/dealripe-sf.key
 *
 *   npx tsx scripts/probe-salesforce-jwt.ts
 *
 * READ ONLY: authenticates and runs one bounded SELECT per object. Writes
 * nothing. Run on your Mac.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/** Objects to probe, and why each one matters. */
const OBJECTS: Array<{ name: string; why: string; granted: boolean }> = [
  { name: "Opportunity", why: "deal stage, amount, close date", granted: true },
  { name: "Lead", why: "pre-opportunity prospects (Fly Freight, Ilavant)", granted: true },
  { name: "Contact", why: "who we are selling to", granted: true },
  { name: "Event", why: "meeting history", granted: true },
  { name: "Task", why: "rep activity, and where recaps get written", granted: true },
  { name: "Account", why: "the Sales Development tab: compelling event, exec sponsor, budget", granted: false },
  { name: "OpportunityContactRole", why: "stakeholder roles on the deal", granted: false },
];

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env.local`);
  return v;
}

/**
 * Mint a JWT assertion. `aud` is the Salesforce LOGIN host, not the instance
 * host, even when the token endpoint is My Domain. Getting that wrong returns
 * an opaque "invalid_grant", which is the usual first failure here.
 */
function buildAssertion(clientId: string, username: string, privateKey: string, audience: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256" }));
  const claims = b64url(
    JSON.stringify({
      iss: clientId,
      sub: username,
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 180,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(privateKey))}`;
}

async function main(): Promise<void> {
  const loginUrl = (process.env.SF_LOGIN_URL ?? "https://magayacorporation.my.salesforce.com").replace(/\/$/, "");
  const clientId = need("SF_CLIENT_ID");
  const username = need("SF_USERNAME");
  const keyPath = need("SF_PRIVATE_KEY_PATH");
  const audience = process.env.SF_AUDIENCE ?? "https://login.salesforce.com";
  const privateKey = readFileSync(keyPath, "utf8");

  console.log(`\nlogin url:   ${loginUrl}`);
  console.log(`client id:   ${clientId.slice(0, 12)}...`);
  console.log(`run-as user: ${username}`);
  console.log(`audience:    ${audience}\n`);

  const assertion = buildAssertion(clientId, username, privateKey, audience);
  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const auth = (await res.json()) as {
    access_token?: string;
    instance_url?: string;
    error?: string;
    error_description?: string;
  };

  if (!auth.access_token) {
    console.log(`AUTH FAILED  (HTTP ${res.status})`);
    console.log(`  error:       ${auth.error ?? "(none)"}`);
    console.log(`  description: ${auth.error_description ?? "(none)"}\n`);
    console.log("Common causes, in order of likelihood:");
    console.log("  invalid_grant + 'user hasn't approved'  -> the run-as user is not pre-authorized on the app");
    console.log("  invalid_grant + no detail               -> wrong audience, or the cert does not match this key");
    console.log("  invalid_client_id                       -> consumer key mistyped\n");
    process.exit(1);
  }

  const instance = (auth.instance_url ?? loginUrl).replace(/\/$/, "");
  console.log(`AUTH OK. instance: ${instance}\n`);
  console.log("OBJECT READ ACCESS");

  const denied: string[] = [];
  for (const o of OBJECTS) {
    const soql = encodeURIComponent(`SELECT Id FROM ${o.name} LIMIT 1`);
    const r = await fetch(`${instance}/services/data/v61.0/query?q=${soql}`, {
      headers: { authorization: `Bearer ${auth.access_token}` },
    });
    const ok = r.ok;
    if (!ok && !o.granted) denied.push(o.name);
    const mark = ok ? "OK  " : "DENY";
    const note = ok ? "" : `  (${r.status})`;
    console.log(`  ${mark}  ${o.name.padEnd(24)} ${o.why}${note}`);
  }

  if (denied.includes("Account")) {
    console.log("");
    console.log("ACCOUNT IS NOT READABLE.");
    console.log("  The Sales Development section Mark screen-shared lives on Account, so the");
    console.log("  BDR context that justified the Salesforce read is out of reach as scoped.");
    console.log("  Worth raising with Ernesto today rather than discovering it on Monday.");
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
