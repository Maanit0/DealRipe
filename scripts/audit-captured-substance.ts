/**
 * Does a call marked outcome='captured' actually contain the CUSTOMER talking?
 *
 *   npx tsx scripts/audit-captured-substance.ts
 *   npx tsx scripts/audit-captured-substance.ts --show 12
 *
 * READ ONLY. Prints speaker labels and short fragments from customer calls, so
 * the output is transcript-class material and stays local.
 *
 * A CAPTURED TRANSCRIPT IS NOT A CUSTOMER CONVERSATION. transcript-sync marks a
 * call 'captured' when media came back with text in it. That text is very often
 * two Magaya people waiting in an empty room and agreeing to reschedule, which
 * is a NO-SHOW with a transcript, exactly the trap CLAUDE.md records for the
 * recap path ("a no-show has a transcript ... about a thousand characters of
 * nothing"). The recap filters on outcome; the activity report's engagement
 * test does not, so those calls establish "the customer engaged" on their own.
 *
 * The test is not length. Read 2026-09-13, Apexcargo is 759 characters and is a
 * real exchange where the customer gives his legal entity name and filer code,
 * while Melek HealthCare is 1537 characters of two reps saying the prospect is
 * not answering. Length ranks them the wrong way round.
 *
 * The test used here is whether any CUSTOMER-SIDE person is a speaker, decided
 * by lib/speaker-match.ts, which is the matcher mine-plays already relies on
 * and which knows that Recall diarizes one sentence across several fragments.
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { sellerDirectory, sideOfSpeaker, type Participant } from "../lib/speaker-match";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };

async function page<T>(t: string, c: string, tid: string | null): Promise<T[]> {
  const db = supabaseAdmin() as any; const o: T[] = [];
  for (let f = 0; ; f += 1000) {
    let q = db.from(t).select(c); if (tid) q = q.eq("tenant_id", tid);
    const r = await q.order("id", { ascending: true }).range(f, f + 999);
    if (r.error) throw new Error(`${t}: ${r.error.message}`);
    o.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break;
  } return o;
}

/** Phrases two sellers say to each other in an empty room. */
const NO_SHOW_TALK = /(never replied|did ?n.t respond|not really sure he would join|fingers crossed that they show|give it the usual five minute|we should wait|reschedule|reprogramar|no me contestaba|if you're there|you're muted if you)/i;

async function main(): Promise<void> {
  const showN = Number(arg("--show") ?? 0);
  const tid = await resolveTenantId("magaya");
  const deals = await page<any>("deals", "id, account", tid);
  const calls = await page<any>("calls", "id, deal_id, outcome, call_date, scheduled_start, participants", tid);
  const trs = await page<any>("transcripts", "id, call_id, body", null);
  const body = new Map(trs.map((t: any) => [t.call_id, String(t.body ?? "")]));
  const name = new Map(deals.map((d: any) => [d.id, d.account]));
  const parts = (c: any): Participant[] => (Array.isArray(c.participants) ? c.participants : []) as Participant[];
  const dir = sellerDirectory(calls.map(parts));

  const capd = calls.filter((c: any) => String(c.outcome) === "captured" && (body.get(c.id) ?? "").trim().length > 0);
  type Row = { deal: string; at: string; chars: number; customerSpoke: boolean; speakers: string[]; noShowTalk: boolean; id: string };
  const rows: Row[] = [];
  for (const c of capd) {
    const b = body.get(c.id) ?? "";
    const speakers = [...new Set(b.split("\n").map((l) => (l.includes(":") ? l.slice(0, l.indexOf(":")).trim() : "")).filter(Boolean))];
    // ASK WHETHER ANYONE WHO IS NOT OURS SPOKE, not whether a speaker matched a
    // customer invitee. The first version tested the latter and reported 27
    // calls with "no customer speaker", including 13k to 36k character
    // conversations whose speaker list plainly contains the buyer: John
    // Locasto, Lawrence Welch, Paris, Hasan miracle. sideOfSpeaker could not
    // MATCH them because the customer is often on the invite as a bare address
    // (info@, a gmail) with no display name, so labelNamesParticipant has
    // nothing to match against. Absence of a match is not absence of a person,
    // which is this codebase's own failure mode.
    //
    // A speaker we cannot positively identify as ours is therefore treated as
    // non-seller, which is the fail-safe direction: it can only ever make a
    // call look MORE like a real conversation, never less.
    const nonSeller = speakers.filter((s) => sideOfSpeaker(parts(c), s, dir) !== "seller");
    const customerSpoke = nonSeller.length > 0;
    rows.push({ deal: String(name.get(c.deal_id) ?? "?"), at: String(c.call_date ?? c.scheduled_start).slice(0, 10),
      chars: b.length, customerSpoke, speakers, noShowTalk: NO_SHOW_TALK.test(b), id: c.id });
  }

  const bad = rows.filter((r) => !r.customerSpoke);
  console.log(`\n  ${capd.length} calls marked outcome='captured' with transcript text.`);
  console.log(`  EVERY speaker identifiable as Magaya, so nobody outside the company spoke: ${bad.length}\n`);
  console.log(`  ${"deal".padEnd(26)} ${"date".padEnd(11)} ${"chars".padStart(6)}  no-show talk  speakers`);
  console.log("  " + "-".repeat(100));
  for (const r of bad.sort((a, b) => a.chars - b.chars)) {
    console.log(`  ${r.deal.slice(0, 25).padEnd(26)} ${r.at.padEnd(11)} ${String(r.chars).padStart(6)}  ${r.noShowTalk ? "YES         " : "no          "}  ${r.speakers.slice(0, 4).join(" | ").slice(0, 60)}`);
  }
  const withTalk = bad.filter((r) => r.noShowTalk);
  console.log(`\n  of those, transcripts that also read as a no-show or reschedule: ${withTalk.length}`);
  console.log(`  band: under 2500 chars ${bad.filter((r) => r.chars < 2500).length}, over ${bad.filter((r) => r.chars >= 2500).length}\n`);

  if (showN > 0) {
    for (const r of bad.sort((a, b) => b.chars - a.chars).slice(0, showN)) {
      console.log(`\n----- ${r.deal} ${r.at} (${r.chars} chars) -----`);
      console.log((body.get(r.id) ?? "").slice(0, 700));
    }
  }
}
main().catch((e) => { console.error("Unexpected error:", e.message ?? e); process.exit(1); });
