/**
 * Match each rep's upcoming external meetings to a Rolldog opportunity, and
 * CONFIRM the match by the account's website domain. A match is only marked
 * "confirmed" when the candidate account's website domain equals the meeting's
 * invite domain, so it can never confirm the wrong customer. Website-null or
 * name-only candidates drop to a "review" list for a one-click human confirm.
 *
 * Read-only. Requires .previews/rep-opps-*.json from pull-rep-opps.ts (re-run
 * that after this update so the lists include account IDs).
 *
 *   npx tsx scripts/match-and-confirm.ts            # next 30 days
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { listUpcomingMeetings } from "../lib/microsoft-graph";
import { firstExternalDomain } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SLUG = "magaya";
const BASE = process.env.ROLLDOG_BASE_URL ?? "https://api.rolldog.com";
const OAUTH = process.env.ROLLDOG_OAUTH_URL ?? "https://login.rolldog.com/oauth/token";
const AUD = process.env.ROLLDOG_AUDIENCE ?? "https://rolldog-api";
const CID = process.env.ROLLDOG_CLIENT_ID;
const SECRET = process.env.ROLLDOG_CLIENT_SECRET;

const REP_FILE: Record<string, string> = {
  "jlopez@magaya.com": "rep-opps-juan.json",
  "ebencomo@magaya.com": "rep-opps-eduardo.json",
};

type Opp = { id: string; accountId: string | null; account: string };

const STOP = new Set([
  "inc", "llc", "ltd", "corp", "co", "company", "the", "and", "of", "group",
  "international", "global", "usa", "us", "solutions", "services",
  // industry-generic words that cause false matches:
  "logistics", "logistica", "cargo", "freight", "trans", "transport",
  "shipping", "logistic",
]);

function squish(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
}
function siteDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(String(url).includes("://") ? String(url) : `http://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

async function token(): Promise<string> {
  if (!CID || !SECRET) throw new Error("ROLLDOG_CLIENT_ID / ROLLDOG_CLIENT_SECRET not set");
  const res = await fetch(OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CID, client_secret: SECRET, audience: AUD, grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`token failed: ${res.status}`);
  return (await res.json()).access_token as string;
}
async function accountWebsite(tok: string, accountId: string): Promise<string | null> {
  const res = await fetch(`${BASE}/accounts/${accountId}`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.api+json" },
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body?.data?.attributes?.website ?? null;
}

function candidates(meetingDomain: string, subject: string | null, opps: Opp[]): Opp[] {
  const sqDom = squish(meetingDomain.split(".")[0]);
  const sig = new Set([...tokens(subject ?? ""), ...tokens(meetingDomain.split(".")[0])]);
  const scored: { opp: Opp; score: number }[] = [];
  for (const opp of opps) {
    const sq = squish(opp.account);
    let score = 0;
    if (sq && sq === sqDom) score = 3;
    else if (sqDom.length >= 4 && (sq.includes(sqDom) || sqDom.includes(sq))) score = 2;
    else {
      const at = tokens(opp.account);
      const overlap = at.filter((t) => sig.has(t)).length;
      if (overlap > 0 && at.length > 0) score = overlap / at.length;
    }
    if (score > 0) scored.push({ opp, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((s) => s.opp);
}

async function main(): Promise<void> {
  const days = 30;
  const dir = path.join(process.cwd(), ".previews");
  mkdirSync(dir, { recursive: true });
  const tok = await token();
  const tenantId = await resolveTenantId(SLUG);
  const db = supabaseAdmin();
  const conns = await db.from("microsoft_connections").select("id, user_principal_name").eq("tenant_id", tenantId);
  if (conns.error) {
    console.error(conns.error.message);
    process.exit(1);
  }

  for (const c of conns.data ?? []) {
    const upn = c.user_principal_name ?? "";
    const file = REP_FILE[upn];
    if (!file) continue;
    let opps: Opp[] = [];
    try {
      opps = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    } catch {
      console.log(`\n=== ${upn}: missing ${file} (re-run pull-rep-opps.ts) ===`);
      continue;
    }
    console.log(`\n=== ${upn} — ${opps.length} opps ===`);
    let events;
    try {
      events = await listUpcomingMeetings(c.id, days);
    } catch (err) {
      console.log(`  (skipped: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }

    const mappings: any[] = [];
    const seen = new Set<string>();
    for (const e of events) {
      if (e.isCancelled || !e.joinUrl) continue;
      const emails = e.attendees.map((a) => a.email).filter((x): x is string => !!x);
      const dom = firstExternalDomain(emails);
      if (!dom) continue;
      if (seen.has(dom)) continue;
      seen.add(dom);

      // Tier 1: website domain == invite domain (exact identity, safest).
      // Tier 2 (website null): the invite domain squished equals exactly ONE
      // opp's account name squished, e.g. martin-brower.com == "MARTIN BROWER".
      // Unique + exact, so safe to auto-link. Anything else -> human review.
      const sqDom = squish(dom.split(".")[0]);
      const exact = opps.filter((o) => squish(o.account) === sqDom);
      const cands = candidates(dom, e.subject ?? null, opps);
      let confirmed: Opp | null = null;
      for (const cand of cands) {
        if (!cand.accountId) continue;
        const site = siteDomain(await accountWebsite(tok, cand.accountId));
        if (site && site === dom) {
          confirmed = cand;
          break;
        }
      }
      let status: string;
      let opp: Opp | null;
      if (confirmed) {
        status = "confirmed";
        opp = confirmed;
      } else if (exact.length === 1) {
        status = "high";
        opp = exact[0];
      } else {
        opp = cands[0] ?? null;
        status = opp ? "review" : "none";
      }
      mappings.push({
        domain: dom,
        subject: e.subject ?? "",
        status,
        oppId: opp?.id ?? null,
        account: opp?.account ?? null,
      });
      console.log(
        `  ${dom}  (${e.subject ?? ""})\n     -> ${status.toUpperCase()}: ${opp ? `${opp.id} ${opp.account}` : "no candidate"}`,
      );
    }
    const out = path.join(dir, `opp-mappings-${upn.split("@")[0]}.json`);
    writeFileSync(out, JSON.stringify(mappings, null, 2), "utf8");
    const auto = mappings.filter((m) => m.status === "confirmed" || m.status === "high").length;
    console.log(`  ${auto}/${mappings.length} auto-linkable (confirmed + high) -> ${out}`);
  }
  console.log(
    "\nCONFIRMED = website domain matched. HIGH = domain squished == a unique account name.",
  );
  console.log("Both are safe to auto-link + write back. REVIEW = ambiguous, needs a one-click human OK.");
}

main().catch((e) => {
  console.error("Unexpected error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
