/**
 * Read-only discovery of a Rolldog opportunity's related resources, so we can
 * find what the "interactions" tab is actually called in the API and learn its
 * shape before building a create-interaction write. Writes nothing.
 *
 * Step 1: GET the opportunity and print its attribute keys + every relationship
 *         name with its related link.
 * Step 2: auto-follow related links that look like interactions/activities/notes
 *         and print the first record's type + attributes.
 *
 *   npx tsx scripts/probe-interactions.ts --opp 82481
 */

import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = process.env.ROLLDOG_BASE_URL ?? "https://api.rolldog.com";
const OAUTH = process.env.ROLLDOG_OAUTH_URL ?? "https://login.rolldog.com/oauth/token";
const AUD = process.env.ROLLDOG_AUDIENCE ?? "https://rolldog-api";
const CID = process.env.ROLLDOG_CLIENT_ID;
const SECRET = process.env.ROLLDOG_CLIENT_SECRET;

const INTEREST = /interact|activit|note|task|event|timeline|touch|log|comment/i;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function token(): Promise<string> {
  if (!CID || !SECRET) throw new Error("ROLLDOG_CLIENT_ID / ROLLDOG_CLIENT_SECRET not set");
  const res = await fetch(OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CID, client_secret: SECRET, audience: AUD, grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function get(tok: string, url: string): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.api+json" },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, json, text };
}

async function main(): Promise<void> {
  const opp = arg("--opp");
  if (!opp) {
    console.error("Usage: --opp <opportunityId>");
    process.exit(1);
  }
  const tok = await token();

  const oppRes = await get(tok, `${BASE}/opportunities/${opp}`);
  console.log(`\n===== GET /opportunities/${opp}  [${oppRes.status}] =====`);
  if (oppRes.status !== 200 || !oppRes.json) {
    console.log(oppRes.text.slice(0, 400));
    return;
  }
  const data = (oppRes.json as { data?: { attributes?: Record<string, unknown>; relationships?: Record<string, { links?: { related?: string } }> } }).data;
  console.log(`\nattribute keys:\n  ${Object.keys(data?.attributes ?? {}).join(", ")}`);

  const rels = data?.relationships ?? {};
  console.log(`\nrelationships:`);
  const toFollow: Array<{ name: string; url: string }> = [];
  for (const [name, rel] of Object.entries(rels)) {
    const related = rel?.links?.related ?? "(no related link)";
    console.log(`  ${name}  ->  ${related}`);
    if (INTEREST.test(name) && typeof rel?.links?.related === "string") {
      toFollow.push({ name, url: rel.links.related });
    }
  }

  if (toFollow.length === 0) {
    console.log(`\nNo relationship name looked interaction-like. Paste the full list above and I'll pick.`);
    return;
  }

  for (const { name, url } of toFollow) {
    const full = url.startsWith("http") ? url : `${BASE}${url}`;
    const r = await get(tok, `${full}${full.includes("?") ? "&" : "?"}page[size]=2`);
    console.log(`\n===== ${name}  [${r.status}]  ${full} =====`);
    if (r.status !== 200 || !r.json) {
      console.log(r.text.slice(0, 300));
      continue;
    }
    const d = (r.json as { data?: unknown }).data;
    const first = Array.isArray(d) ? d[0] : d;
    if (!first) {
      console.log("(no records)");
      continue;
    }
    const rec = first as { type?: string; id?: string; attributes?: Record<string, unknown> };
    console.log(`type: ${rec.type}`);
    console.log(`attribute keys: ${Object.keys(rec.attributes ?? {}).join(", ")}`);
    console.log(`sample:\n${JSON.stringify(first, null, 2).slice(0, 1500)}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
