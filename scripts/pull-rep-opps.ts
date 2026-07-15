/**
 * Pull the FULL opportunity list for each pilot rep from Rolldog (paginated),
 * so we can match calendar meetings to the right opp by account name and, once
 * confirmed, turn on write-back per deal.
 *
 * Confirmed working via scripts/list-rep-opps.ts: /opportunities?filter[user-id]=<id>.
 * Read-only. Writes the lists to .previews/rep-opps-<rep>.json and prints counts.
 *
 *   npx tsx scripts/pull-rep-opps.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.ROLLDOG_BASE_URL ?? "https://api.rolldog.com";
const OAUTH = process.env.ROLLDOG_OAUTH_URL ?? "https://login.rolldog.com/oauth/token";
const AUD = process.env.ROLLDOG_AUDIENCE ?? "https://rolldog-api";
const CID = process.env.ROLLDOG_CLIENT_ID;
const SECRET = process.env.ROLLDOG_CLIENT_SECRET;

const REPS = [
  { rep: "juan", userId: "82" },
  { rep: "eduardo", userId: "79" },
];

type Opp = {
  id: string;
  accountId: string | null;
  account: string;
  stage: string | null;
  dealSize: number | null;
  score: string | null;
  forecast: string | null;
};

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

async function getJson(tok: string, url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.api+json" },
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function pullAll(tok: string, userId: string): Promise<Opp[]> {
  const out: Opp[] = [];
  let next: string | null = `${BASE}/opportunities?filter[user-id]=${userId}&page[size]=100`;
  let guard = 0;
  while (next && guard < 50) {
    guard += 1;
    const body: any = await getJson(tok, next);
    for (const d of (body.data ?? []) as any[]) {
      const a = d.attributes ?? {};
      out.push({
        id: String(d.id),
        accountId: a["account-id"] != null ? String(a["account-id"]) : null,
        account: String(a["account-name"] ?? ""),
        stage: a["stage-name"] ?? null,
        dealSize: typeof a["deal-size"] === "number" ? a["deal-size"] : null,
        score: a["score"] != null ? String(a["score"]) : null,
        forecast: a["forecast-category"] ?? null,
      });
    }
    const nx = body.links?.next ?? null;
    next = nx ? (String(nx).startsWith("http") ? String(nx) : `${BASE}${nx}`) : null;
  }
  return out;
}

async function main(): Promise<void> {
  const tok = await token();
  const dir = path.join(process.cwd(), ".previews");
  mkdirSync(dir, { recursive: true });

  for (const { rep, userId } of REPS) {
    const opps = await pullAll(tok, userId);
    const file = path.join(dir, `rep-opps-${rep}.json`);
    writeFileSync(file, JSON.stringify(opps, null, 2), "utf8");
    console.log(`${rep} (user-id ${userId}): ${opps.length} opportunities -> ${file}`);
    for (const o of opps.slice(0, 8)) {
      console.log(`   ${o.id}  ${o.account}  [${o.stage ?? "?"}, ${o.forecast ?? "?"}, $${o.dealSize ?? "-"}]`);
    }
    if (opps.length > 8) console.log(`   ... and ${opps.length - 8} more`);
  }
  console.log("\nFull lists written to .previews/. Next: match these against their calendar customers.");
}

main().catch((e) => {
  console.error("Unexpected error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
