/**
 * What is in the email that nobody told DealRipe to look for.
 *
 *   npx tsx scripts/mine-email-signals.ts
 *   npx tsx scripts/mine-email-signals.ts --min-deals 8
 *
 * READ ONLY, and it prints no customer text. Magaya is under NDA and anything
 * derived from a message is still the message, so this emits COUNTS and RATES
 * only. Never add a line that prints a subject or a body.
 *
 * WHY THIS IS NOT AN EXTRACTOR. The 33 framework fields are a hypothesis
 * somebody wrote down in advance: they say what a qualified deal looks like at
 * Magaya, and transcript-ingest scores every call against them. That is
 * supervised, and it can only ever find what it was told to find.
 *
 * This asks the opposite question. Given 1,880 stored bodies that nothing has
 * ever read, which observable properties of the email actually separate deals
 * whose CRM stage advanced from deals whose did not? The features are
 * deterministic and cheap on purpose: reply latency, thread depth, who writes
 * first, whether the buying group grew, whether a customer question went
 * unanswered. No model, no prompt, no cost.
 *
 * HOW TO READ THE OUTPUT, AND THE TRAP IT IS BUILT AGAINST. A feature is only
 * interesting if it BOTH separates the two groups and does not fire on most of
 * the book. emailing_without_reply fired on 67 of 112 open deals, 60%, and was
 * an honest signal and a naive flag: it was true the moment a rep sent a
 * follow-up, which is the normal condition of a live conversation. So every row
 * prints its overall fire rate beside its lift, and a feature at 80% coverage
 * is noise however good its lift looks.
 *
 * THE OUTCOME LABEL IS DELIBERATELY NOT USED. Nine won and seventeen lost is
 * too small to learn from, and five of the losses are one hygiene sweep. Stage
 * advancement in crm_field_events is the substrate that exists at scale: 393
 * StageName transitions against 26 closes. This is the same argument as
 * preferring gate flips to victories.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function page<T>(table: string, cols: string, tenantId: string | null): Promise<T[]> {
  const db = supabaseAdmin() as unknown as {
    from: (t: string) => { select: (c: string) => Record<string, (...a: unknown[]) => unknown> };
  };
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: unknown = db.from(table).select(cols);
    if (tenantId) q = (q as { eq: (a: string, b: string) => unknown }).eq("tenant_id", tenantId);
    q = (q as { order: (c: string, o: unknown) => unknown }).order("id", { ascending: true });
    q = (q as { range: (a: number, b: number) => unknown }).range(from, from + 999);
    const res = (await (q as Promise<{ data: T[] | null; error: { message: string } | null }>));
    if (res.error) throw new Error(`${table} read failed: ${res.error.message}`);
    const rows = res.data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

type Msg = {
  deal_id: string;
  direction: string;
  customer_side: boolean | null;
  is_machine_sender: boolean | null;
  is_calendar_response: boolean;
  sent_at: string | null;
  subject: string | null;
  body_trimmed: string | null;
  body_chars: number | null;
  to_emails: string[] | null;
  cc_emails: string[] | null;
  conversation_id: string | null;
};

/** Deterministic, per deal. Every one is a yes/no a person could verify. */
type Features = Record<string, boolean>;

function featuresFor(msgs: Msg[]): Features {
  const real = msgs.filter((m) => !m.is_calendar_response && !m.is_machine_sender);
  const inbound = real.filter((m) => m.direction === "inbound" && m.customer_side === true);
  const outbound = real.filter((m) => m.direction === "outbound");
  const sorted = [...real].sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));

  // Did the buying group grow: more distinct customer addresses on the last
  // third of the thread than on the first third.
  const people = (m: Msg) => [...(m.to_emails ?? []), ...(m.cc_emails ?? [])].map((e) => e.toLowerCase());
  const third = Math.max(1, Math.floor(sorted.length / 3));
  const early = new Set(sorted.slice(0, third).flatMap(people));
  const late = new Set(sorted.slice(-third).flatMap(people));
  let grew = false;
  for (const p of late) if (!early.has(p)) grew = true;

  // A customer question that never got an outbound reply after it.
  const lastInbound = inbound[inbound.length - 1];
  const askedAndUnanswered =
    !!lastInbound?.body_trimmed &&
    lastInbound.body_trimmed.includes("?") &&
    !outbound.some((o) => String(o.sent_at) > String(lastInbound.sent_at));

  // Median customer reply latency in hours, bucketed.
  const latencies: number[] = [];
  for (const i of inbound) {
    const prior = outbound.filter((o) => String(o.sent_at) < String(i.sent_at)).pop();
    if (!prior?.sent_at || !i.sent_at) continue;
    const h = (Date.parse(i.sent_at) - Date.parse(prior.sent_at)) / 3_600_000;
    if (Number.isFinite(h) && h >= 0) latencies.push(h);
  }
  latencies.sort((a, b) => a - b);
  const medianLatency = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : null;

  const bodies = real.map((m) => m.body_trimmed ?? "").filter(Boolean);
  const allText = bodies.join("\n").toLowerCase();
  const longestInbound = Math.max(0, ...inbound.map((m) => (m.body_trimmed ?? "").length));

  return {
    "customer ever wrote": inbound.length > 0,
    "customer wrote 3+ times": inbound.length >= 3,
    "customer wrote first": sorted[0]?.direction === "inbound",
    "buying group grew on the thread": grew,
    "3+ distinct threads": new Set(real.map((m) => m.conversation_id).filter(Boolean)).size >= 3,
    "customer replied inside 24h (median)": medianLatency !== null && medianLatency <= 24,
    "customer took over 72h (median)": medianLatency !== null && medianLatency > 72,
    "a customer question went unanswered": askedAndUnanswered,
    "customer wrote a 500+ char message": longestInbound >= 500,
    "we sent 3+ in a row unanswered":
      outbound.length >= 3 && inbound.length === 0,
    "someone forwarded internally (Fwd:)": real.some((m) => /^\s*fwd?:/i.test(m.subject ?? "")),
    "a date or time was proposed in writing": /\b(does|would)\s+\w+day\b|\bavailability\b|\bcalendar invite\b/.test(allText),
    "pricing discussed in writing": /\b(pricing|quote|cost|per user|per month|discount)\b/.test(allText),
    "a next step was named in writing": /\bnext steps?\b/.test(allText),
    "someone mentioned legal or procurement": /\b(legal|procurement|purchasing|contract review)\b/.test(allText),
    "someone mentioned a competitor or alternative": /\b(alternative|competitor|another (vendor|provider|solution)|currently using)\b/.test(allText),
    "an internal blocker was named": /\b(waiting on|held up|on hold|budget freeze|approval)\b/.test(allText),
  };
}

async function main(): Promise<void> {
  const minDeals = Number(arg("--min-deals") ?? 6);
  const tenantId = await resolveTenantId("magaya");

  const msgs = await page<Msg>(
    "deal_messages",
    "id, deal_id, direction, customer_side, is_machine_sender, is_calendar_response, sent_at, subject, body_trimmed, body_chars, to_emails, cc_emails, conversation_id",
    tenantId,
  );
  const crm = await page<{ deal_id: string | null; field: string; old_value: string | null; new_value: string | null; changed_at: string }>(
    "crm_field_events",
    "id, deal_id, field, old_value, new_value, changed_at",
    tenantId,
  );

  const byDeal = new Map<string, Msg[]>();
  for (const m of msgs) {
    if (!m.body_trimmed) continue;
    byDeal.set(m.deal_id, [...(byDeal.get(m.deal_id) ?? []), m]);
  }

  // PROGRESSION, not victory. A deal advanced if Salesforce recorded a
  // StageName change on it at any point we hold. Deliberately not the outcome
  // label: 9 won and 17 lost is too small, and 5 of the losses are one sweep.
  const advanced = new Set<string>();
  for (const e of crm) {
    if (e.deal_id && e.field === "StageName" && e.new_value && e.new_value !== e.old_value) advanced.add(e.deal_id);
  }

  const deals = [...byDeal.keys()];
  const adv = deals.filter((d) => advanced.has(d));
  const flat = deals.filter((d) => !advanced.has(d));

  console.log(`\n  deals with stored email bodies:  ${deals.length}`);
  console.log(`  ...whose CRM stage ever moved:   ${adv.length}`);
  console.log(`  ...whose stage never moved:      ${flat.length}`);
  if (adv.length < minDeals || flat.length < minDeals) {
    console.log(`\n  Both groups need at least ${minDeals} deals to say anything. Stopping.\n`);
    return;
  }

  const featuresByDeal = new Map(deals.map((d) => [d, featuresFor(byDeal.get(d) ?? [])]));
  const names = Object.keys(featuresByDeal.get(deals[0]) ?? {});

  type Row = { name: string; advRate: number; flatRate: number; overall: number; lift: number };
  const rows: Row[] = names.map((name) => {
    const a = adv.filter((d) => featuresByDeal.get(d)?.[name]).length / adv.length;
    const f = flat.filter((d) => featuresByDeal.get(d)?.[name]).length / flat.length;
    const o = deals.filter((d) => featuresByDeal.get(d)?.[name]).length / deals.length;
    return { name, advRate: a, flatRate: f, overall: o, lift: a - f };
  });

  const pct = (x: number) => `${String(Math.round(x * 100)).padStart(3)}%`;
  console.log(`\n  feature                                       moved  flat   lift   fires on`);
  console.log("  " + "-".repeat(78));
  for (const r of rows.sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift))) {
    // A feature firing on almost everything or almost nothing separates nothing,
    // however good its lift looks. emailing_without_reply fired on 60% of the
    // book and was called a signal for weeks.
    const useless = r.overall > 0.8 || r.overall < 0.05;
    const mark = useless ? "  (fires on too much/too little to be a flag)" : Math.abs(r.lift) >= 0.2 ? "  <-" : "";
    console.log(
      `  ${r.name.padEnd(44)}${pct(r.advRate)} ${pct(r.flatRate)}  ${(r.lift >= 0 ? "+" : "") + Math.round(r.lift * 100)}%`.padEnd(74) +
        `${pct(r.overall)}${mark}`,
    );
  }

  console.log(
    `\n  READ THIS AS DIRECTION, NOT AS TRUTH. n=${deals.length} deals, and "stage moved" is a\n` +
      `  proxy for progression that a hygiene sweep or a rep tidying the pipeline also\n` +
      `  satisfies. A feature worth shipping needs a second look at whether the email\n` +
      `  CAUSED the move or merely accompanied it, which this cannot tell you.\n`,
  );
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
