/**
 * Which observable signals precede which outcomes.
 *
 *   npx tsx scripts/mine-signals.ts
 *   npx tsx scripts/mine-signals.ts --outcome nda_executed
 *   npx tsx scripts/mine-signals.ts --segment new --min 12
 *
 * READ ONLY, and it prints no customer text. Magaya is under NDA and anything
 * derived from a transcript or a message is still that transcript or message,
 * so this emits counts and rates only.
 *
 * Supersedes scripts/mine-email-signals.ts, which looked at one channel and one
 * outcome.
 *
 * ------------------------------------------------------------------------
 * THE THREE MISTAKES THIS IS BUILT NOT TO REPEAT, all made in one afternoon
 * ------------------------------------------------------------------------
 *
 * 1. MEASURING AGAINST THE WRONG THING. The first version scored features
 *    against stage_advanced, which is rep-entered CRM hygiene: a rep moves a
 *    deal to Proposal because they remembered to, not because the buyer did
 *    anything. Correlating buyer behaviour against rep bookkeeping produces
 *    noise. Outcomes the BUYER produces and cannot fake (an executed NDA, an
 *    accepted meeting) are the targets worth having, and each is reported
 *    separately here rather than merged into one "progression" flag.
 *
 * 2. LETTING THE EVIDENCE POSTDATE THE OUTCOME. The second version asked
 *    whether a deal had EVER moved stage, with no date filter, while the CRM
 *    history reaches back to 2025 and the email starts 2026-06-22. 241 stage
 *    moves predated the messages being scored against them. Here every deal
 *    gets its OWN cutoff and features are computed strictly before it.
 *
 * 3. MIXING SEGMENTS. Existing customers have longer histories and move more
 *    often, so volume features inherited that and half the reported lift was
 *    the confound. Segment is explicit and "unknown" is never folded into
 *    "new".
 *
 * A fourth guard is inherited: a feature firing on more than 80% or under 5% of
 * deals separates nothing however good its lift looks. emailing_without_reply
 * fired on 60% of the book and was called a signal for weeks.
 *
 * WHAT THIS STILL CANNOT TELL YOU. Whether the signal CAUSED the outcome. It
 * reports what preceded what. A rep emails before almost everything.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { detectMicroOutcomes, type MicroOutcome } from "../lib/micro-outcomes";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function pageAll<T>(table: string, cols: string, tenantId: string | null): Promise<T[]> {
  const db = supabaseAdmin() as unknown as { from: (t: string) => { select: (c: string) => unknown } };
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
  to_emails: string[] | null;
  cc_emails: string[] | null;
  conversation_id: string | null;
};
type Call = {
  id: string;
  deal_id: string;
  call_date: string | null;
  scheduled_start: string | null;
  call_subtype: string | null;
  meeting_type: string | null;
  participants: unknown;
};

const MIN_CONVERSATION_CHARS = 2000;
const before = (t: string | null | undefined, cut: string) => !!t && String(t) < cut;

/**
 * Everything observable about a deal, as of `cut`.
 *
 * Both channels. Email features describe the written conversation; call
 * features describe the spoken one, and the two answer different questions:
 * a demo happening is a call fact, a price appearing in writing is an email
 * fact, and neither substitutes for the other.
 */
function featuresFor(args: {
  msgs: Msg[];
  calls: Call[];
  charsByCall: Map<string, number>;
  custCharsByCall: Map<string, number>;
  cut: string;
}): Record<string, boolean> {
  const msgs = args.msgs.filter(
    (m) => !m.is_calendar_response && !m.is_machine_sender && before(m.sent_at, args.cut) && m.body_trimmed,
  );
  const inbound = msgs.filter((m) => m.direction === "inbound" && m.customer_side === true);
  const outbound = msgs.filter((m) => m.direction === "outbound");
  const sorted = [...msgs].sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));
  const text = msgs.map((m) => m.body_trimmed ?? "").join("\n").toLowerCase();

  const calls = args.calls.filter((c) => before(c.call_date ?? c.scheduled_start, args.cut));
  const real = calls.filter((c) => (args.charsByCall.get(c.id) ?? 0) >= MIN_CONVERSATION_CHARS);

  // Customer share of talk, from the diarized transcript. A call where the rep
  // talked for fifty minutes is a different object from one where the buyer did.
  let custShare: number | null = null;
  const totals = real.map((c) => ({
    total: args.charsByCall.get(c.id) ?? 0,
    cust: args.custCharsByCall.get(c.id) ?? 0,
  }));
  const sumTotal = totals.reduce((n, t) => n + t.total, 0);
  const sumCust = totals.reduce((n, t) => n + t.cust, 0);
  if (sumTotal > 0) custShare = sumCust / sumTotal;

  const people = (m: Msg) => [...(m.to_emails ?? []), ...(m.cc_emails ?? [])].map((e) => e.toLowerCase());
  const third = Math.max(1, Math.floor(sorted.length / 3));
  const early = new Set(sorted.slice(0, third).flatMap(people));
  const grew = [...new Set(sorted.slice(-third).flatMap(people))].some((p) => !early.has(p));

  const latencies: number[] = [];
  for (const i of inbound) {
    const prior = outbound.filter((o) => String(o.sent_at) < String(i.sent_at)).pop();
    if (!prior?.sent_at || !i.sent_at) continue;
    const h = (Date.parse(i.sent_at) - Date.parse(prior.sent_at)) / 3_600_000;
    if (Number.isFinite(h) && h >= 0) latencies.push(h);
  }
  latencies.sort((a, b) => a - b);
  const medLat = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;

  return {
    // --- call signals ---
    "had a captured conversation": real.length > 0,
    "2+ captured conversations": real.length >= 2,
    "3+ captured conversations": real.length >= 3,
    "a discovery call happened": real.some((c) => c.call_subtype === "discovery"),
    "a demo happened": real.some((c) => c.call_subtype === "demo"),
    "a proposal call happened": real.some((c) => c.call_subtype === "proposal"),
    "customer did 40%+ of the talking": custShare !== null && custShare >= 0.4,
    "customer did under 25% of the talking": custShare !== null && custShare < 0.25,
    "3+ people on the customer side": (() => {
      const emails = new Set<string>();
      for (const c of real) {
        const ps = Array.isArray(c.participants) ? (c.participants as Array<{ email?: string | null }>) : [];
        for (const p of ps) {
          const e = String(p?.email ?? "").toLowerCase();
          if (e && !e.endsWith("@magaya.com")) emails.add(e);
        }
      }
      return emails.size >= 3;
    })(),
    // --- email signals ---
    "customer ever wrote": inbound.length > 0,
    "customer wrote 3+ times": inbound.length >= 3,
    "customer wrote first": sorted[0]?.direction === "inbound",
    "buying group grew on the thread": grew,
    "3+ distinct threads": new Set(msgs.map((m) => m.conversation_id).filter(Boolean)).size >= 3,
    "customer replied inside 24h (median)": medLat !== null && medLat <= 24,
    "customer took over 72h (median)": medLat !== null && medLat > 72,
    "customer wrote a 500+ char message": inbound.some((m) => (m.body_trimmed ?? "").length >= 500),
    "we sent 2+ with no reply": outbound.length >= 2 && inbound.length === 0,
    "pricing discussed in writing": /\b(pricing|quote|cost|per user|per month|discount)\b/.test(text),
    "a next step named in writing": /\bnext steps?\b/.test(text),
    "a date proposed in writing": /\b(does|would)\s+\w+day\b|\bavailability\b/.test(text),
    "legal or procurement mentioned": /\b(legal|procurement|purchasing|contract review)\b/.test(text),
    "an internal blocker named": /\b(waiting on|held up|on hold|budget freeze|approval)\b/.test(text),
    "a competitor or incumbent mentioned": /\b(alternative|competitor|another (vendor|provider|solution)|currently using)\b/.test(text),
  };
}

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const minGroup = Number(arg("--min") ?? 10);
  const segment = arg("--segment");
  const onlyOutcome = arg("--outcome");

  const [msgs, calls, transcripts, outcomes] = await Promise.all([
    pageAll<Msg>(
      "deal_messages",
      "id, deal_id, direction, customer_side, is_machine_sender, is_calendar_response, sent_at, subject, body_trimmed, to_emails, cc_emails, conversation_id",
      tenantId,
    ),
    pageAll<Call>("calls", "id, deal_id, call_date, scheduled_start, call_subtype, meeting_type, participants", tenantId),
    pageAll<{ call_id: string; body: string | null }>("transcripts", "id, call_id, body", null),
    detectMicroOutcomes(tenantId),
  ]);

  const charsByCall = new Map(transcripts.map((t) => [t.call_id, String(t.body ?? "").length]));
  // Customer share of talk. Speaker lines are "Name: text"; a line whose speaker
  // is not a known Magaya participant counts as the customer. Crude, and stated
  // as crude: it is a ratio, not an attribution.
  const custCharsByCall = new Map<string, number>();
  for (const t of transcripts) {
    const c = calls.find((x) => x.id === t.call_id);
    const sellerNames = new Set<string>();
    const ps = Array.isArray(c?.participants) ? (c?.participants as Array<{ name?: string | null; email?: string | null }>) : [];
    for (const p of ps) {
      if (String(p?.email ?? "").toLowerCase().endsWith("@magaya.com")) {
        const n = String(p?.name ?? "").toLowerCase().trim();
        if (n) sellerNames.add(n);
      }
    }
    let cust = 0;
    for (const line of String(t.body ?? "").split("\n")) {
      const m = /^([^:]{2,60}):\s*(.*)$/.exec(line);
      if (!m) continue;
      const who = m[1].toLowerCase().trim();
      const isSeller = [...sellerNames].some((s) => s.includes(who) || who.includes(s));
      if (!isSeller) cust += m[2].length;
    }
    custCharsByCall.set(t.call_id, cust);
  }

  const msgsByDeal = new Map<string, Msg[]>();
  for (const m of msgs) msgsByDeal.set(m.deal_id, [...(msgsByDeal.get(m.deal_id) ?? []), m]);
  const callsByDeal = new Map<string, Call[]>();
  for (const c of calls) callsByDeal.set(c.deal_id, [...(callsByDeal.get(c.deal_id) ?? []), c]);

  // Segment. meeting_type is written AFTER capture, so a deal with no captured
  // call has none and is "unknown", never "new".
  const kindByDeal = new Map<string, string>();
  for (const c of calls) {
    if (!c.meeting_type || c.meeting_type === "internal") continue;
    if (c.meeting_type === "existing_customer" || !kindByDeal.has(c.deal_id)) kindByDeal.set(c.deal_id, c.meeting_type);
  }
  const segOf = (d: string) =>
    kindByDeal.get(d) === "existing_customer" ? "existing" : kindByDeal.has(d) ? "new" : "unknown";

  const universe = [...new Set([...msgsByDeal.keys(), ...callsByDeal.keys()])].filter(
    (d) => !segment || segOf(d) === segment,
  );

  // Last observed activity, used as the cutoff for deals the outcome never
  // happened to. Without it a negative deal would be scored on its whole
  // history against a positive deal scored only up to its outcome, which
  // rewards features that simply need time to accumulate.
  const lastActivity = new Map<string, string>();
  for (const d of universe) {
    const times = [
      ...(msgsByDeal.get(d) ?? []).map((m) => m.sent_at),
      ...(callsByDeal.get(d) ?? []).map((c) => c.call_date ?? c.scheduled_start),
    ]
      .filter(Boolean)
      .map(String)
      .sort();
    if (times.length) lastActivity.set(d, times[times.length - 1]);
  }

  const byKind = new Map<string, MicroOutcome[]>();
  for (const o of outcomes) byKind.set(o.kind, [...(byKind.get(o.kind) ?? []), o]);

  console.log(`\n  universe: ${universe.length} deals${segment ? ` in segment "${segment}"` : " (all segments)"}\n`);

  for (const [kind, list] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (onlyOutcome && kind !== onlyOutcome) continue;

    // First occurrence per deal. Anything after it is consequence, not cause.
    const firstAt = new Map<string, string>();
    for (const o of list) {
      if (!universe.includes(o.dealId)) continue;
      const cur = firstAt.get(o.dealId);
      if (!cur || o.occurredAt < cur) firstAt.set(o.dealId, o.occurredAt);
    }
    const pos = [...firstAt.keys()];
    const neg = universe.filter((d) => !firstAt.has(d) && lastActivity.has(d));
    if (pos.length < minGroup || neg.length < minGroup) {
      console.log(`  ${kind}: ${pos.length} with / ${neg.length} without - below the ${minGroup} floor, skipped`);
      continue;
    }

    const feats = new Map<string, Record<string, boolean>>();
    for (const d of [...pos, ...neg]) {
      const cut = firstAt.get(d) ?? lastActivity.get(d) ?? "9999";
      feats.set(
        d,
        featuresFor({
          msgs: msgsByDeal.get(d) ?? [],
          calls: callsByDeal.get(d) ?? [],
          charsByCall,
          custCharsByCall,
          cut,
        }),
      );
    }
    const names = Object.keys(feats.get(pos[0]) ?? {});
    const rows = names
      .map((n) => {
        const a = pos.filter((d) => feats.get(d)?.[n]).length / pos.length;
        const b = neg.filter((d) => feats.get(d)?.[n]).length / neg.length;
        const o = [...pos, ...neg].filter((d) => feats.get(d)?.[n]).length / (pos.length + neg.length);
        return { n, a, b, o, lift: a - b };
      })
      .filter((r) => r.o <= 0.8 && r.o >= 0.05)
      .sort((x, y) => Math.abs(y.lift) - Math.abs(x.lift));

    // THE WINDOW BIAS, MEASURED RATHER THAN ASSUMED.
    //
    // A positive deal is scored up to its OUTCOME; a negative deal is scored up
    // to its last activity. So positives systematically get shorter windows,
    // and every feature that accumulates with time ("customer wrote 3+ times",
    // "buying group grew", "3+ threads") is biased AGAINST them. On an outcome
    // that happens early and often, that alone can turn every lift negative,
    // which is exactly the shape stage_advanced shows.
    //
    // There is no clean fix without matched sampling, so the bias is printed.
    // A negative lift on a cumulative feature means nothing when the positive
    // group had half the window to accumulate it in.
    const windowDays = (d: string) => {
      const times = [
        ...(msgsByDeal.get(d) ?? []).map((m) => m.sent_at),
        ...(callsByDeal.get(d) ?? []).map((c) => c.call_date ?? c.scheduled_start),
      ]
        .filter(Boolean)
        .map(String)
        .sort();
      const cut = firstAt.get(d) ?? lastActivity.get(d) ?? "";
      const start = times.find((t) => t < cut);
      if (!start || !cut) return null;
      const n = (Date.parse(cut) - Date.parse(start)) / 86_400_000;
      return Number.isFinite(n) ? n : null;
    };
    const med = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
    const wPos = med(pos.map(windowDays).filter((n): n is number => n !== null));
    const wNeg = med(neg.map(windowDays).filter((n): n is number => n !== null));

    console.log(`\n  ======== ${kind}  (${pos.length} with, ${neg.length} without) ========`);
    console.log(
      `  median observation window: ${Math.round(wPos)}d with vs ${Math.round(wNeg)}d without` +
        (wNeg > wPos * 1.5
          ? "   <- NEGATIVES HAD MUCH LONGER; discount negative lifts on cumulative features"
          : wPos > wNeg * 1.5
            ? "   <- POSITIVES HAD MUCH LONGER; discount positive lifts on cumulative features"
            : "   (comparable)"),
    );
    console.log(`  signal                                      with  without  lift  fires on`);
    const pct = (x: number) => `${String(Math.round(x * 100)).padStart(3)}%`;
    for (const r of rows.slice(0, 8)) {
      console.log(
        `  ${r.n.padEnd(42)}${pct(r.a)}  ${pct(r.b)}   ${(r.lift >= 0 ? "+" : "") + Math.round(r.lift * 100)}%`.padEnd(72) +
          `${pct(r.o)}`,
      );
    }
  }

  console.log(
    `\n  Features are computed STRICTLY BEFORE each deal's own outcome, and before\n` +
      `  last activity for deals it never happened to. Rows firing on over 80% or\n` +
      `  under 5% of deals are hidden: they separate nothing.\n` +
      `  This is what PRECEDED what. It is not what caused what.\n`,
  );
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
