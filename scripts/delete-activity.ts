/**
 * Delete a single Rolldog activity by id (cleanup for the test activity, since
 * the UI may not be reachable). Prints the activity it would delete by default;
 * --apply performs the DELETE.
 *
 *   npx tsx scripts/delete-activity.ts --id 911506            # show what it is
 *   npx tsx scripts/delete-activity.ts --id 911506 --apply    # delete it
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

async function main(): Promise<void> {
  const id = arg("--id");
  const apply = process.argv.includes("--apply");
  if (!id) {
    console.error("Usage: --id <activityId> [--apply]");
    process.exit(1);
  }
  const tok = await token();

  const g = await fetch(`${BASE}/activities/${id}`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.api+json" },
  });
  if (!g.ok) {
    console.error(`Activity ${id} not found (${g.status}).`);
    process.exit(1);
  }
  const rec = ((await g.json()) as { data?: { attributes?: Record<string, unknown> } }).data;
  const a = rec?.attributes ?? {};
  console.log(`\nActivity ${id}:`);
  console.log(`  title:       ${a["activities"]}`);
  console.log(`  opportunity: ${a["opportunity-name"]}`);
  console.log(`  complete:    ${a["is-complete"]}`);

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to delete it.`);
    return;
  }

  const d = await fetch(`${BASE}/activities/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.api+json" },
  });
  console.log(`\nDELETE /activities/${id} -> ${d.status} ${d.ok ? "(deleted)" : await d.text()}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
