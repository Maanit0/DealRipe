/**
 * Show exactly what Salesforce context a pre-call briefing would carry.
 *
 * Run this before wiring the context into live briefings. It prints the
 * label -> API-name map the integration user can actually see, then the
 * rendered block for one or more customer domains, so you can check the real
 * Magaya data rather than trusting that the field labels matched.
 *
 *   npx tsx scripts/probe-account-context.ts --domain cargocleared.com
 *   npx tsx scripts/probe-account-context.ts --upcoming        # every external
 *                                                              # domain on the
 *                                                              # team's calendars
 *
 * READ ONLY. Runs describe and bounded SELECTs. Writes nothing.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { listUpcomingMeetings } from "../lib/microsoft-graph";
import { accountContextLines, accountFieldMap, getAccountContextByDomain } from "../lib/salesforce-context";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";
const INTERNAL = new Set(["magaya.com"]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type DomainHit = { why: string; addresses: string[] };

/** Every external domain the team is meeting in the next `days` days. */
async function upcomingDomains(days: number): Promise<Map<string, DomainHit>> {
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();
  const conns = await db
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  if (conns.error) throw new Error(conns.error.message);

  const found = new Map<string, DomainHit>();
  for (const c of conns.data ?? []) {
    let meetings;
    try {
      meetings = await listUpcomingMeetings(c.id, days);
    } catch {
      continue;
    }
    for (const m of meetings) {
      for (const a of m.attendees ?? []) {
        const email = (a.email ?? "").toLowerCase();
        const d = email.split("@")[1];
        if (!d || INTERNAL.has(d)) continue;
        const hit = found.get(d);
        if (hit) {
          if (!hit.addresses.includes(email)) hit.addresses.push(email);
        } else {
          found.set(d, { why: `${c.user_principal_name} · ${m.subject ?? "(untitled)"}`, addresses: [email] });
        }
      }
    }
  }
  return found;
}

async function main(): Promise<void> {
  console.log("");
  console.log("ACCOUNT FIELDS VISIBLE TO THE INTEGRATION USER");
  const map = await accountFieldMap();
  if (map.size === 0) {
    console.log("  none of the wanted labels matched. Either the labels differ in this org,");
    console.log("  or field-level security is hiding them from the integration user.");
  }
  for (const [label, api] of map) console.log(`  ok    ${label.padEnd(34)} ${api}`);
  console.log("");

  const single = arg("--domain");
  const domains = new Map<string, DomainHit>();
  if (single) {
    domains.set(single.toLowerCase(), { why: "(explicit)", addresses: [] });
  } else if (process.argv.includes("--upcoming")) {
    const days = Number(arg("--days") ?? 7);
    const found = await upcomingDomains(days);
    for (const [d, hit] of found) domains.set(d, hit);
    console.log(`${found.size} external domain(s) on the team's calendars in the next ${days} days.\n`);
  } else {
    console.error("Usage: --domain <example.com>  |  --upcoming [--days 7]");
    process.exit(1);
  }

  let hits = 0;
  for (const [domain, hit] of domains) {
    console.log("-".repeat(72));
    console.log(`${domain}   ${hit.why}`);
    let ctx;
    try {
      ctx = await getAccountContextByDomain(domain, hit.addresses);
    } catch (e) {
      console.log(`  error: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!ctx) {
      console.log("  no confident Salesforce account match (none found, or more than one).");
      console.log("  The briefing falls back to whatever DealRipe captured on prior calls.");
      continue;
    }
    hits++;
    console.log("");
    console.log(
      accountContextLines(ctx)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
    console.log("");
  }

  console.log("-".repeat(72));
  console.log(`${hits} of ${domains.size} domain(s) resolved to a Salesforce account.`);
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
