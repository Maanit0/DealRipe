/**
 * Discovery: can we pull all of Juan's and Eduardo's Rolldog opportunities?
 *
 * The app only reads opps one-by-one by id (scope-guarded). This standalone
 * script authenticates directly and tries Rolldog's list endpoint filtered by
 * owner, to learn whether a "list by owner" pull is even possible. Read-only,
 * prints what it finds. Run locally (Rolldog must be reachable):
 *
 *   npx tsx scripts/list-rep-opps.ts
 *
 * It first reads a known opp for each rep to get their Rolldog user-id, then
 * tries a few JSON:API filter forms against /opportunities. If one works we can
 * wire a real list; if all fail/empty, fall back to a rep-provided export.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = process.env.ROLLDOG_BASE_URL ?? "https://api.rolldog.com";
const OAUTH = process.env.ROLLDOG_OAUTH_URL ?? "https://login.rolldog.com/oauth/token";
const AUD = process.env.ROLLDOG_AUDIENCE ?? "https://rolldog-api";
const CID = process.env.ROLLDOG_CLIENT_ID;
const SECRET = process.env.ROLLDOG_CLIENT_SECRET;

// Known pilot opps, one per rep, to read the owner (user-id) from.
const KNOWN = [
  { rep: "Juan", opp: "80566" }, // Martin Brower
  { rep: "Eduardo", opp: "80018" }, // IFF Inc
];

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

async function main(): Promise<void> {
  const tok = await token();

  const owners: Record<string, string> = {};
  for (const k of KNOWN) {
    const r = await get(tok, `/opportunities/${k.opp}`);
    const attrs = r.body?.data?.attributes ?? {};
    const uid = attrs["user-id"];
    owners[k.rep] = String(uid ?? "");
    console.log(`${k.rep}: opp ${k.opp} -> user-id ${uid} (account: ${attrs["account-name"] ?? "?"})`);
  }

  console.log("\nTrying list-by-owner forms (looking for one that returns their pipeline):\n");
  for (const [rep, uid] of Object.entries(owners)) {
    if (!uid) continue;
    const forms = [
      `/opportunities?filter[user-id]=${uid}&page[size]=100`,
      `/opportunities?filter[owner]=${uid}&page[size]=100`,
      `/opportunities?filter[user]=${uid}&page[size]=100`,
      `/opportunities?user-id=${uid}&page[size]=100`,
    ];
    for (const path of forms) {
      const r = await get(tok, path);
      const count = Array.isArray(r.body?.data) ? r.body.data.length : null;
      console.log(`  ${rep}  ${path}\n     -> status ${r.status}, ${count === null ? "not a list" : `${count} opps`}`);
      if (count && count > 0) {
        const sample = (r.body.data as any[]).slice(0, 3).map((d) => `${d.id}:${d.attributes?.["account-name"] ?? "?"}`);
        console.log(`     sample: ${sample.join(", ")}`);
      }
    }
  }
  console.log("\nIf any form returned opps, tell me which and I'll wire a real list. If all failed, the reps' export is the path.");
}

main().catch((e) => {
  console.error("Unexpected error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
