/**
 * Read-only preview: for the customers each rep actually has meetings with in
 * the next N days, propose the Rolldog opportunity by account-name match.
 * Writes nothing. Lets us judge match quality before wiring any write-back.
 *
 * Requires the pulled lists from scripts/pull-rep-opps.ts (.previews/rep-opps-*.json).
 *
 *   npx tsx scripts/preview-opp-matches.ts            # next 30 days
 *   npx tsx scripts/preview-opp-matches.ts --days 14
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import path from "node:path";

import { listUpcomingMeetings } from "../lib/microsoft-graph";
import { firstExternalDomain } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SLUG = "magaya";

// user_principal_name -> the rep file pulled by pull-rep-opps.ts
const REP_FILE: Record<string, string> = {
  "jlopez@magaya.com": "rep-opps-juan.json",
  "ebencomo@magaya.com": "rep-opps-eduardo.json",
};

type Opp = { id: string; account: string };

const STOP = new Set([
  "inc", "llc", "ltd", "corp", "co", "company", "the", "and", "of", "group",
  "international", "global", "usa", "us", "solutions", "services", "shipping",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Candidate customer strings from a meeting: subject minus noise, + domain SLD. */
function meetingSignals(subject: string | null, emails: string[]): string[] {
  const out: string[] = [];
  const dom = firstExternalDomain(emails);
  if (dom) out.push(dom.split(".")[0]);
  if (subject) {
    const cleaned = subject
      .toLowerCase()
      .replace(/magaya|demo|placeholder|software|presentation|call|meeting|intro|<>|\|/g, " ");
    out.push(cleaned);
  }
  return out;
}

function bestMatch(signals: string[], opps: Opp[]): { opp: Opp; score: number } | null {
  const sigTokens = new Set(signals.flatMap(tokens));
  if (sigTokens.size === 0) return null;
  let best: { opp: Opp; score: number } | null = null;
  for (const opp of opps) {
    const at = tokens(opp.account);
    if (at.length === 0) continue;
    const overlap = at.filter((t) => sigTokens.has(t)).length;
    if (overlap === 0) continue;
    // Score favors covering the opp's whole name (all its tokens matched).
    const score = overlap / at.length + overlap * 0.01;
    if (!best || score > best.score) best = { opp, score };
  }
  return best;
}

function confidence(score: number): string {
  if (score >= 1) return "STRONG";
  if (score >= 0.5) return "medium";
  return "weak";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const di = argv.indexOf("--days");
  const days = di !== -1 ? Number(argv[di + 1]) || 30 : 30;

  const dir = path.join(process.cwd(), ".previews");
  const tenantId = await resolveTenantId(SLUG);
  const db = supabaseAdmin();
  const conns = await db
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  if (conns.error) {
    console.error(`connections query failed: ${conns.error.message}`);
    process.exit(1);
  }

  for (const c of conns.data ?? []) {
    const upn = c.user_principal_name ?? "";
    const fileName = REP_FILE[upn];
    if (!fileName) continue;
    let opps: Opp[] = [];
    try {
      opps = JSON.parse(readFileSync(path.join(dir, fileName), "utf8"));
    } catch {
      console.log(`\n=== ${upn} — no ${fileName} (run pull-rep-opps.ts first) ===`);
      continue;
    }

    console.log(`\n=== ${upn} — matching next ${days}d meetings against ${opps.length} opps ===`);
    let events;
    try {
      events = await listUpcomingMeetings(c.id, days);
    } catch (err) {
      console.log(`  (skipped: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }

    const seen = new Set<string>();
    for (const e of events) {
      if (e.isCancelled || !e.joinUrl) continue;
      const emails = e.attendees.map((a) => a.email).filter((x): x is string => !!x);
      const dom = firstExternalDomain(emails);
      if (!dom) continue; // internal only
      const key = `${dom}|${e.subject ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const m = bestMatch(meetingSignals(e.subject ?? null, emails), opps);
      const tag = m ? `${confidence(m.score)}: ${m.opp.id} ${m.opp.account}` : "NO MATCH";
      console.log(`  ${e.subject ?? "(no subject)"}  [${dom}]\n     -> ${tag}`);
    }
  }
  console.log("\nReview the STRONG ones (safe to auto-link). medium/weak/NO MATCH would need a confirm.");
}

main().catch((e) => {
  console.error("Unexpected error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
