/**
 * Probe what deal signal is actually recoverable from a rep's Outlook, before
 * any of it is built.
 *
 * The plan is to feed email into the daily snapshot so the forecast stops being
 * flat between calls. Every feature in that plan assumes something about the
 * data: that conversationId groups a thread reliably, that we can tell inbound
 * from outbound, that customer replies are frequent enough to measure latency,
 * that new stakeholders visibly appear on threads. This script checks each of
 * those against the real mailbox instead of assuming.
 *
 *   npx tsx scripts/probe-graph-mail-signal.ts --mailbox jlopez@magaya.com
 *   npx tsx scripts/probe-graph-mail-signal.ts --mailbox ebencomo@magaya.com --days 90
 *   npx tsx scripts/probe-graph-mail-signal.ts --mailbox jlopez@magaya.com --all-domains
 *
 * READ ONLY. Creates nothing, writes nothing, stores nothing. Prints headers
 * and counts only, never message bodies. Requires the mailbox on
 * GRAPH_MAIL_ALLOWED_MAILBOXES and MS_CLIENT_ID / MS_CLIENT_SECRET.
 *
 * Must run on your Mac: the sandbox has no network route to Graph or Supabase.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { domainOf, listMailboxMessages, type MailMessage } from "../lib/graph-mail";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";
const GRAPH_TENANT = "magaya.com";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function num(name: string, fallback: number): number {
  const v = Number(arg(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Customer domains this rep has deals with, from auto:<domain> external ids. */
async function repDealDomains(mailbox: string): Promise<Map<string, string>> {
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();
  const { data } = await db
    .from("deals")
    .select("account, external_id, rep_email")
    .eq("tenant_id", tenantId);
  const map = new Map<string, string>();
  for (const d of data ?? []) {
    if ((d.rep_email ?? "").toLowerCase() !== mailbox.toLowerCase()) continue;
    const ext = d.external_id ?? "";
    if (ext.startsWith("auto:")) map.set(ext.slice(5).toLowerCase(), d.account);
  }
  return map;
}

function hours(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 3_600_000;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main(): Promise<void> {
  const mailbox = arg("--mailbox");
  const days = num("--days", 60);
  const allDomains = process.argv.includes("--all-domains");
  if (!mailbox) {
    console.error("Usage: --mailbox <rep@magaya.com> [--days 60] [--all-domains]");
    process.exit(1);
  }

  const dealDomains = await repDealDomains(mailbox);
  const since = new Date(Date.now() - days * 86_400_000);

  console.log(`\nmailbox:       ${mailbox}`);
  console.log(`window:        last ${days} days (since ${since.toISOString().slice(0, 10)})`);
  console.log(`deal domains:  ${dealDomains.size}${dealDomains.size ? ` (${[...dealDomains.keys()].slice(0, 8).join(", ")}${dealDomains.size > 8 ? ", ..." : ""})` : ""}`);
  console.log(`scoping:       ${allDomains ? "OFF (reading all mail, for volume comparison only)" : "ON (deal domains only)"}\n`);

  const msgs = await listMailboxMessages({
    tenantIdOrDomain: GRAPH_TENANT,
    mailbox,
    since,
    domains: allDomains ? [] : [...dealDomains.keys()],
  });

  if (msgs.length === 0) {
    console.log("No messages matched. Try --days 180, or --all-domains to check the mailbox is not empty.\n");
    return;
  }

  // ---- 1. Volume and the cost of scoping -------------------------------
  const outbound = msgs.filter((m) => m.outbound).length;
  console.log(`FEASIBILITY`);
  console.log(`  messages matched:     ${msgs.length}`);
  console.log(`  outbound / inbound:   ${outbound} / ${msgs.length - outbound}`);
  console.log(`  with conversationId:  ${msgs.filter((m) => m.conversationId).length} / ${msgs.length}`);
  console.log(`  with a timestamp:     ${msgs.filter((m) => m.at).length} / ${msgs.length}`);

  // ---- 2. Threading ----------------------------------------------------
  const threads = new Map<string, MailMessage[]>();
  for (const m of msgs) {
    const k = m.conversationId ?? `no-thread:${m.id}`;
    const list = threads.get(k);
    if (list) list.push(m);
    else threads.set(k, [m]);
  }
  const multi = [...threads.values()].filter((t) => t.length > 1);
  console.log(`\nTHREADING`);
  console.log(`  threads:              ${threads.size}`);
  console.log(`  multi-message:        ${multi.length} (single-message threads carry no latency signal)`);

  // ---- 3. Response latency, the highest-value feature -------------------
  const latencies: number[] = [];
  for (const t of threads.values()) {
    const ordered = [...t].filter((m) => m.at).sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
    for (let i = 1; i < ordered.length; i++) {
      // Only rep-sent -> customer-replied transitions.
      if (ordered[i - 1].outbound && !ordered[i].outbound) latencies.push(hours(ordered[i - 1].at!, ordered[i].at!));
    }
  }
  console.log(`\nCUSTOMER RESPONSE LATENCY`);
  if (latencies.length === 0) {
    console.log(`  no rep-sent -> customer-replied pairs found in this window.`);
  } else {
    console.log(`  measurable replies:   ${latencies.length}`);
    console.log(`  median:               ${median(latencies).toFixed(1)}h`);
    console.log(`  fastest / slowest:    ${Math.min(...latencies).toFixed(1)}h / ${Math.max(...latencies).toFixed(1)}h`);
  }

  // ---- 4. Stakeholder appearance, the authority signal ------------------
  let widened = 0;
  const newcomers: string[] = [];
  for (const t of threads.values()) {
    const ordered = [...t].filter((m) => m.at).sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
    const seen = new Set<string>();
    let first = true;
    for (const m of ordered) {
      const people = [m.from, ...m.to, ...m.cc].filter(Boolean) as string[];
      const added = people.filter((p) => !seen.has(p) && domainOf(p) !== domainOf(mailbox));
      if (!first && added.length > 0) {
        widened++;
        newcomers.push(...added);
      }
      people.forEach((p) => seen.add(p));
      first = false;
    }
  }
  console.log(`\nSTAKEHOLDER CHANGE  (new customer-side person joins mid-thread)`);
  console.log(`  threads that widened: ${widened}`);
  if (newcomers.length > 0) console.log(`  example newcomers:    ${[...new Set(newcomers)].slice(0, 6).join(", ")}`);

  // ---- 5. Coverage per deal --------------------------------------------
  console.log(`\nPER-DEAL COVERAGE`);
  const byDomain = new Map<string, number>();
  for (const m of msgs) {
    for (const p of [m.from, ...m.to, ...m.cc]) {
      const d = domainOf(p);
      if (d && dealDomains.has(d)) byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
    }
  }
  const ranked = [...byDomain.entries()].sort((a, b) => b[1] - a[1]);
  for (const [d, n] of ranked.slice(0, 15)) console.log(`  ${String(n).padStart(4)}  ${dealDomains.get(d) ?? d}  (${d})`);
  const silent = [...dealDomains.keys()].filter((d) => !byDomain.has(d));
  console.log(`  deals with zero email in window: ${silent.length} / ${dealDomains.size}`);

  // ---- 6. One raw shape, so the parser is built on what is real ---------
  const sample = msgs.find((m) => !m.outbound) ?? msgs[0];
  console.log(`\nSAMPLE PARSED MESSAGE (headers only, no body)`);
  console.log(
    JSON.stringify(
      { ...sample, preview: sample.preview ? `${sample.preview.slice(0, 60)}...` : "" },
      null,
      2,
    ),
  );
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.name : "Error"}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
