/**
 * Read-only probe: does the Rolldog API support listing / searching opportunities?
 * The production client only ever GETs /opportunities/{id}; this checks whether a
 * collection endpoint exists so we can auto-detect newly-created opps for deals
 * DealRipe already captured. Tries a plain list, a paged list, and a few JSON:API
 * filter shapes, and prints status + the attribute keys of the first opportunity
 * (so we learn what we can match on: company name, domain, external id).
 *
 * Runs on your Mac (uses your ROLLDOG_* env). GET only, writes nothing.
 *
 *   npx tsx scripts/rolldog-list-probe.ts
 *   npx tsx scripts/rolldog-list-probe.ts --q "Core Logistics"
 */

import { config } from "dotenv";
config({ path: ".env.local" });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BASE = process.env.ROLLDOG_BASE_URL ?? "https://api.rolldog.com";
const OAUTH = process.env.ROLLDOG_OAUTH_URL ?? "https://login.rolldog.com/oauth/token";
const AUD = process.env.ROLLDOG_AUDIENCE ?? "https://rolldog-api";
const CID = process.env.ROLLDOG_CLIENT_ID;
const SECRET = process.env.ROLLDOG_CLIENT_SECRET;

async function getToken(): Promise<string> {
  const res = await fetch(OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CID, client_secret: SECRET, audience: AUD, grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`oauth ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("no access_token in oauth response");
  return j.access_token;
}

async function get(token: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.api+json" },
  });
  const text = await res.text().catch(() => "");
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  return { status: res.status, body };
}

function summarize(body: unknown): string {
  const b = body as { data?: unknown; meta?: unknown; errors?: unknown };
  if (b?.errors) return `errors: ${JSON.stringify(b.errors).slice(0, 200)}`;
  const data = b?.data;
  if (Array.isArray(data)) {
    const meta = b?.meta ? ` meta=${JSON.stringify(b.meta).slice(0, 120)}` : "";
    const rows = (data as Array<{ id?: string; attributes?: Record<string, unknown> }>).slice(0, 15).map((r) => {
      const a = r.attributes ?? {};
      const acct = a["account-name"] ?? a["name"] ?? "?";
      const ext = a["external-id"] ?? "—";
      const stage = a["stage-name"] ?? a["stage"] ?? "?";
      const owner = a["user-id"] ?? "?";
      const created = a["created-at"] ?? "?";
      const arch = a["archived"] ? " ARCHIVED" : "";
      return `      opp ${r.id}  "${acct}"  owner=${owner}  stage=${stage}  created=${created}  sf-id=${ext}${arch}`;
    });
    return `LIST ok: ${data.length} items.${meta}\n${rows.join("\n")}`;
  }
  if (data && typeof data === "object") return `single object (not a list)`;
  return `unexpected shape: ${JSON.stringify(body).slice(0, 200)}`;
}

async function main(): Promise<void> {
  if (!CID || !SECRET) { console.log("\nROLLDOG_CLIENT_ID / ROLLDOG_CLIENT_SECRET not set in .env.local\n"); return; }
  const q = arg("--q") ?? "Core";
  const token = await getToken();
  console.log(`\nBase: ${BASE}\n`);

  const paths = [
    `/opportunities?filter[search]=${encodeURIComponent(q)}`,
    "/opportunities?sort=-created-at&page[size]=8",
    "/opportunities?sort=-created_at&page[size]=8",
  ];

  for (const p of paths) {
    try {
      const r = await get(token, p);
      console.log(`GET ${p}`);
      console.log(`  -> ${r.status}  ${r.status < 300 ? summarize(r.body) : JSON.stringify(r.body).slice(0, 220)}`);
    } catch (e) {
      console.log(`GET ${p}\n  -> error: ${e instanceof Error ? e.message : String(e)}`);
    }
    console.log("");
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
