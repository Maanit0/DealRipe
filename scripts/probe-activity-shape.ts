/**
 * Read-only: learn how a Rolldog activity encodes its assignee (rep) and due
 * date, so we can enrich the next-action write later with one confirmed create.
 * Reads an opportunity's activities, surfaces the ones that actually have a rep,
 * an assignment, or a planned-completion set, and dumps one full record (with
 * relationships) so we see exactly how the assignee is linked. Writes nothing.
 *
 * Run against a MATURE opp the reps actively manage (real to-dos), e.g. one of
 * Eduardo's deals: morneau 81714, alba 78273, iff 80018.
 *
 *   npx tsx scripts/probe-activity-shape.ts --opp 81714
 */

import { config } from "dotenv";
config({ path: ".env.local" });

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
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.api+json" } });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, json, text };
}

type Rec = { id?: string; type?: string; attributes?: Record<string, unknown>; relationships?: Record<string, unknown> };

async function main(): Promise<void> {
  const opp = arg("--opp");
  if (!opp) {
    console.error("Usage: --opp <opportunityId>");
    process.exit(1);
  }
  const tok = await token();

  const list = await get(tok, `${BASE}/opportunities/${opp}/activities?page[size]=50`);
  console.log(`\n===== GET /opportunities/${opp}/activities  [${list.status}] =====`);
  if (list.status !== 200 || !list.json) {
    console.log(list.text.slice(0, 400));
    return;
  }
  const rows = ((list.json as { data?: unknown }).data ?? []) as Rec[];
  console.log(`${rows.length} activities.\n`);

  const interesting: Rec[] = [];
  for (const r of rows) {
    const a = r.attributes ?? {};
    const rep = a["rep"];
    const assignment = a["assignment-id"];
    const due = a["planned-completion"];
    const manager = a["manager"];
    const title = String(a["activities"] ?? "").slice(0, 50);
    console.log(
      `  ${r.id}  complete=${a["is-complete"]}  rep=${JSON.stringify(rep)}  assignment=${JSON.stringify(assignment)}  due=${JSON.stringify(due)}  "${title}"`,
    );
    if (rep != null || assignment != null || due != null || manager != null) interesting.push(r);
  }

  const picks = (interesting.length > 0 ? interesting : rows).slice(0, 2);
  for (const p of picks) {
    const full = await get(tok, `${BASE}/activities/${p.id}`);
    console.log(`\n===== FULL /activities/${p.id}  [${full.status}] =====`);
    console.log(JSON.stringify((full.json as { data?: unknown })?.data ?? full.json, null, 2).slice(0, 2500));
  }

  if (interesting.length === 0) {
    console.log(`\nNo activity had a rep/assignment/due date set. Try a busier opp (a deal with real rep to-dos).`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
