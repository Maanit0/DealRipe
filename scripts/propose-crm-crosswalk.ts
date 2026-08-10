/**
 * Propose Salesforce and Rolldog ids for the domains that will not resolve.
 *
 * The automatic resolvers handle the tidy cases. What is left is real accounts
 * whose Salesforce contacts use a different domain, whose Website is blank, or
 * whose Rolldog opportunity is named nothing like the domain. IFF is the type:
 * the account is "IFF US", the opportunity is "IFF", the domain is iffusa.com.
 * No inference gets there, but a human glancing at three candidates does it
 * instantly.
 *
 * So this searches both systems with several name variants and prints ranked
 * candidates with their ids, ready to paste into lib/crm-crosswalk.ts. It never
 * writes: a wrong mapping briefs one customer's data on another customer's
 * call, and that is not a decision to automate at 8pm the night before a
 * launch.
 *
 *   npx tsx scripts/propose-crm-crosswalk.ts
 *   npx tsx scripts/propose-crm-crosswalk.ts --domain iffusa.com --hint "IFF"
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { crosswalkDomains } from "../lib/crm-crosswalk";
import { listUpcomingMeetings } from "../lib/microsoft-graph";
import { firstExternalAddress, isAutoJoinRep, isFreeMailDomain } from "../lib/pilot-config";
import { searchOpportunities } from "../lib/rolldog";
import { findAccountsByName, getAccountContextByDomain } from "../lib/salesforce-context";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Name variants worth searching for a domain and its meeting subject.
 *
 * The subject is the richest signal available: "IFF -Magaya next steps" carries
 * the account name that the domain does not. Strip our own company name and the
 * scheduling noise, then keep the words a human would recognise.
 */
function candidateNames(domain: string, subjects: string[]): string[] {
  const stem = domain.split(".")[0];
  const out = new Set<string>();
  if (stem.length >= 3) out.add(stem);

  const NOISE = new Set([
    "magaya", "call", "meeting", "mtg", "follow", "up", "next", "steps", "intro", "demo",
    "review", "checkin", "check", "in", "with", "and", "the", "placeholder", "software",
    "presentation", "group", "sync", "discovery", "proposal", "renewal", "contract", "pm", "am",
  ]);

  for (const s of subjects) {
    const words = s
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3 && !NOISE.has(w.toLowerCase()) && !/^\d+$/.test(w));
    for (const w of words) out.add(w);
    // Adjacent pairs catch two-word company names like "FM Global".
    for (let i = 0; i < words.length - 1; i++) out.add(`${words[i]} ${words[i + 1]}`);
  }
  return [...out].slice(0, 8);
}

async function proposeFor(domain: string, subjects: string[]): Promise<void> {
  console.log("=".repeat(78));
  console.log(`${domain}${subjects.length ? `   ${subjects[0]}` : ""}`);

  if (isFreeMailDomain(domain)) {
    console.log("  consumer mail. Never map a person's mailbox to a company account.\n");
    return;
  }

  const already = await getAccountContextByDomain(domain).catch(() => null);
  if (already) {
    console.log(`  already resolves to "${already.accountName}". Nothing to do.\n`);
    return;
  }

  const names = candidateNames(domain, subjects);
  console.log(`  searching: ${names.join(", ")}`);
  console.log("");

  // ---- Salesforce candidates
  const sfSeen = new Map<string, { name: string; website: string | null; contacts: number; via: string }>();
  for (const n of names) {
    try {
      for (const a of await findAccountsByName(n)) {
        if (!sfSeen.has(a.id)) sfSeen.set(a.id, { ...a, via: n });
      }
    } catch (e) {
      console.log(`  salesforce search "${n}" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log("  SALESFORCE CANDIDATES");
  if (sfSeen.size === 0) console.log("     none");
  for (const [id, a] of [...sfSeen.entries()].slice(0, 8)) {
    console.log(`     ${id}  ${a.name.slice(0, 40).padEnd(42)}${(a.website ?? "-").slice(0, 26).padEnd(28)}${a.contacts} contacts   (via "${a.via}")`);
  }

  // ---- Rolldog candidates
  const rdSeen = new Map<string, { name: string; via: string }>();
  for (const n of names) {
    try {
      for (const o of await searchOpportunities(n, { pageSize: 8 })) {
        const id = String(o.id);
        if (!rdSeen.has(id)) rdSeen.set(id, { name: o.accountName ?? "(no name)", via: n });
      }
    } catch {
      /* best-effort */
    }
  }
  console.log("  ROLLDOG CANDIDATES");
  if (rdSeen.size === 0) console.log("     none");
  for (const [id, o] of [...rdSeen.entries()].slice(0, 8)) {
    console.log(`     ${id.padEnd(10)}${o.name.slice(0, 44).padEnd(46)}(via "${o.via}")`);
  }

  console.log("");
  console.log("  If one of each is clearly right, add to lib/crm-crosswalk.ts:");
  console.log(`     "${domain}": { salesforceAccountId: "...", rolldogOpportunityId: "...", note: "confirmed <how> <initials> <date>" },`);
  console.log("");
}

async function main(): Promise<void> {
  const single = arg("--domain");
  if (single) {
    const hint = arg("--hint");
    await proposeFor(single.toLowerCase(), hint ? [hint] : []);
    return;
  }

  const days = Number(arg("--days") ?? 7);
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();
  const conns = await db
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  if (conns.error) throw new Error(conns.error.message);

  const known = new Set(crosswalkDomains());
  const targets = new Map<string, string[]>();

  for (const c of conns.data ?? []) {
    const rep = (c.user_principal_name ?? "").toLowerCase();
    if (!rep || !isAutoJoinRep(rep)) continue;
    let meetings;
    try {
      meetings = await listUpcomingMeetings(c.id, days);
    } catch {
      continue;
    }
    for (const m of meetings) {
      const emails = (m.attendees ?? [])
        .map((a) => a.email)
        .filter((e): e is string => typeof e === "string" && e.length > 0);
      const address = firstExternalAddress(emails);
      if (!address) continue;
      const domain = address.split("@")[1] ?? "";
      if (!domain || known.has(domain) || isFreeMailDomain(domain)) continue;
      const list = targets.get(domain) ?? [];
      if (m.subject && !list.includes(m.subject)) list.push(m.subject);
      targets.set(domain, list);
    }
  }

  console.log("");
  console.log(`Crosswalk proposals · ${targets.size} domain(s) on the next ${days} days of calendars`);
  console.log("");
  for (const [domain, subjects] of targets) await proposeFor(domain, subjects);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
