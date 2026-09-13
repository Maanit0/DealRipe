/**
 * SUBSTANTIVE evidence audit of the Commit + Expect deals.
 *
 *   npx tsx scripts/audit-commit-expect.ts --bundle-only
 *   npx tsx scripts/audit-commit-expect.ts --deal ghy
 *   npx tsx scripts/audit-commit-expect.ts            # all 17
 *
 * READ ONLY against production. Writes dossiers to .previews/audit/, which is
 * gitignored: every one of them quotes a customer under NDA.
 *
 * WHY A MODEL AND NOT A QUERY. The question is what the customer actually said
 * and whether the report's prose is stronger than the evidence. That is a
 * reading task. Everything mechanical (who spoke, what was sent, what is
 * overdue) is assembled here deterministically and handed over as fact, so the
 * model is judging language against evidence rather than reconstructing it.
 *
 * TWO THINGS IT IS TOLD NOT TO TRUST, both established 2026-09-13:
 *
 *   outcome='captured' does not mean the customer talked. Four of the ten
 *   thinnest captured calls are two Magaya people in an empty room agreeing to
 *   reschedule. Every transcript is passed in full with its invite roster so
 *   participation is judged, not assumed.
 *
 *   sideOfSpeaker is not ground truth. lib/speaker-match.ts:89 substring-matches
 *   the email local part, so "sjohnson" contains "john" and the customer John
 *   Locasto is scored as Magaya's Steven Johnson. The roster is passed with
 *   full addresses and the model resolves side from the domain, with UNKNOWN
 *   available and required when it cannot.
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { runModel } from "../lib/model-run";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const SELLER = "magaya.com";
const ASOF = "2026-09-13";
/** Per deal. Recent first; a deal with six calls does not need all of them in full. */
const TRANSCRIPT_BUDGET = 60_000;

async function page<T>(t: string, c: string, tid: string | null): Promise<T[]> {
  const db = supabaseAdmin() as any; const o: T[] = [];
  for (let f = 0; ; f += 1000) {
    let q = db.from(t).select(c); if (tid) q = q.eq("tenant_id", tid);
    const r = await q.order("id", { ascending: true }).range(f, f + 999);
    if (r.error) throw new Error(`${t}: ${r.error.message}`);
    o.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break;
  } return o;
}
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function main(): Promise<void> {
  const only = arg("--deal");
  const bundleOnly = process.argv.includes("--bundle-only");
  const tid = await resolveTenantId("magaya");
  const report = JSON.parse(readFileSync(".previews/audit/sep14.json", "utf8")) as { rows: Array<Record<string,string>> };
  const ce = report.rows.filter((r) => /\b(Commit|Expect)\b/.test(r.meta));

  const deals = await page<any>("deals", "id, account, rep_email, salesforce_account_id, outcome_label", tid);
  const calls = await page<any>("calls", "id, deal_id, outcome, call_date, scheduled_start, title, participants, organizer_email, capture_class, ingest_error", tid);
  const trs = await page<any>("transcripts", "id, call_id, body", null);
  const body = new Map(trs.map((t: any) => [t.call_id, String(t.body ?? "")]));
  const msgs = await page<any>("deal_messages", "id, deal_id, direction, customer_side, is_machine_sender, is_calendar_response, sent_at, subject, from_email, to_emails, body_trimmed, body_raw, agreement_kind, agreement_state", tid);

  // The report renders a CRM display name; deals.account holds DealRipe's slug.
  // Neither prefix nor token matching covers all of it, so the five that resist
  // both are pinned by hand rather than guessed. "TNS Cargo Service LLC" is the
  // deal slugged Transportnstore and no string rule finds that.
  const PINNED: Record<string, string> = {
    "iffus": "IFF Inc",
    "ghyinternational": "Ghy",
    "tnscargoservicellc": "Transportnstore",
    "synchronized": "1synchronized",
  };
  const resolve = (name: string) => {
    const n = norm(name);
    if (PINNED[n]) return deals.find((d: any) => d.account === PINNED[n]);
    return deals.find((d: any) => norm(d.account) === n)
      ?? deals.find((d: any) => norm(d.account).length >= 5 && (n.startsWith(norm(d.account)) || norm(d.account).startsWith(n)))
      ?? deals.find((d: any) => norm(d.account).length >= 5 && n.length >= 5 && norm(d.account).includes(n.slice(0, 8)));
  };

  mkdirSync(".previews/audit/dossiers", { recursive: true });
  const targets = only ? ce.filter((r) => norm(r.deal).includes(norm(only))) : ce;
  console.log(`\n  ${ce.length} Commit+Expect rows; auditing ${targets.length}\n`);

  for (const row of targets) {
    const d = resolve(row.deal);
    if (!d) { console.log(`  ${row.deal}: DEAL NOT RESOLVED`); continue; }

    // ---- calls, newest first, full text within budget ----
    const cs = calls.filter((c: any) => c.deal_id === d.id)
      .sort((a: any, b: any) => String(b.call_date ?? b.scheduled_start).localeCompare(String(a.call_date ?? a.scheduled_start)));
    let spent = 0; const callBlocks: string[] = [];
    for (const c of cs) {
      const at = String(c.call_date ?? c.scheduled_start ?? "").slice(0, 10);
      const ppl = (Array.isArray(c.participants) ? c.participants : []) as any[];
      const roster = ppl.map((p: any) => {
        const em = String(p?.email ?? "").toLowerCase();
        const side = !em ? "NO ADDRESS" : em.endsWith("@" + SELLER) ? "MAGAYA" : "CUSTOMER-SIDE";
        return `      ${String(p?.name ?? "(no name)")} <${em || "?"}>  [${side}]  rsvp=${p?.responseStatus ?? "?"}`;
      }).join("\n");
      const b = body.get(c.id) ?? "";
      const future = at > ASOF;
      const head = `\n--- MEETING ${at}${future ? "  (FUTURE, has not happened)" : ""} | title: ${c.title ?? "(none)"} | outcome=${c.outcome ?? "null"} | capture_class=${c.capture_class ?? "null"}\n    invite roster:\n${roster || "      (empty)"}`;
      if (!b.trim()) { callBlocks.push(`${head}\n    TRANSCRIPT: none stored.${c.ingest_error ? ` ingest_error: ${String(c.ingest_error).slice(0,160)}` : ""}`); continue; }
      const room = Math.max(0, TRANSCRIPT_BUDGET - spent);
      if (room < 500) { callBlocks.push(`${head}\n    TRANSCRIPT: ${b.length} chars, omitted for budget.`); continue; }
      const slice = b.length <= room ? b : b.slice(0, room) + "\n    [...truncated]";
      spent += slice.length;
      callBlocks.push(`${head}\n    TRANSCRIPT (${b.length} chars):\n${slice}`);
    }

    // ---- email bodies, human only ----
    const mine = msgs.filter((m: any) => m.deal_id === d.id && !m.is_calendar_response && !m.is_machine_sender)
      .sort((a: any, b: any) => String(b.sent_at).localeCompare(String(a.sent_at)));
    const mailBlocks = mine.slice(0, 30).map((m: any) => {
      const t = (m.body_trimmed ?? m.body_raw ?? "").replace(/\s+\n/g, "\n").trim().slice(0, 2200);
      return `\n--- EMAIL ${String(m.sent_at).slice(0,10)} | ${m.customer_side === true ? "FROM CUSTOMER" : "FROM MAGAYA"} | from ${m.from_email} | subj: ${m.subject ?? ""}\n${t || "(no body stored)"}`;
    });
    const machine = msgs.filter((m: any) => m.deal_id === d.id && m.is_machine_sender && m.agreement_kind)
      .map((m: any) => `    ${String(m.sent_at).slice(0,10)} ${m.agreement_kind} state=${m.agreement_state ?? "?"} subj=${m.subject ?? ""}`);

    const bundle = [
      `DEAL: ${d.account}   (report renders it as "${row.deal}")`,
      `REP: ${d.rep_email}`,
      `CRM LINE FROM THE REPORT: ${row.meta}`,
      `TODAY IS ${ASOF}.`,
      ``,
      `=== WHAT THE PIPELINE REVIEW CURRENTLY CLAIMS ===`,
      `  section:      ${row.section}`,
      `  status pill:  ${row.status}`,
      `  What changed: ${row.changed}`,
      `  Next step:    ${row.next}`,
      `  DealRipe read:${row.read}`,
      `  Action:       ${row.action}`,
      ``,
      `=== AGREEMENT / SIGNATURE EVENTS (machine senders, system-authored) ===`,
      machine.length ? machine.join("\n") : "    none",
      ``,
      `=== MEETINGS AND TRANSCRIPTS (newest first) ===`,
      callBlocks.join("\n") || "  none",
      ``,
      `=== HUMAN EMAIL (newest first, max 30) ===`,
      mailBlocks.join("\n") || "  none",
    ].join("\n");

    const path = `.previews/audit/dossiers/${norm(d.account)}.evidence.txt`;
    writeFileSync(path, bundle, "utf8");
    console.log(`  ${String(d.account).padEnd(28)} ${String(bundle.length).padStart(7)} chars  ${cs.length} meetings, ${mine.length} human emails -> ${path}`);
    if (bundleOnly) continue;

    const res = await runModel({
      task: "audit.commit_expect", promptVersion: "v1-substantive", tenantId: tid,
      maxTokens: 4000, temperature: 0,
      system: SYSTEM, messages: [{ role: "user", content: bundle }],
    });
    const blk = res.message.content.find((b) => b.type === "text");
    const out = blk && "text" in blk ? blk.text : "(no output)";
    writeFileSync(`.previews/audit/dossiers/${norm(d.account)}.dossier.md`, out, "utf8");
    console.log(`      dossier written (${out.length} chars)`);
  }
  console.log(`\n  dossiers in .previews/audit/dossiers/ (gitignored, NDA)\n`);
}

const SYSTEM = `You are auditing ONE sales opportunity for a CRO. You are given the raw evidence and what a generated pipeline review currently claims about it. Your job is to establish what the CUSTOMER actually said and did, and to judge whether the report's prose is supported.

TWO THINGS YOU MUST NOT ASSUME.

1. A transcript existing does NOT mean the customer was on the call. Several "captured" calls in this pilot are two Magaya employees sitting in an empty room agreeing to reschedule. Decide participation from the transcript itself.

2. Decide SPEAKER SIDE from the invite roster, which gives every attendee's email and marks MAGAYA or CUSTOMER-SIDE by domain. A speaker whose side you cannot resolve is UNKNOWN, and an UNKNOWN quote is NEVER attributed to the customer. Do not guess from a first name.

RULES.
- Seller activity is not buying progress. A rep sending seven emails is not engagement. A rep booking a meeting is not the customer accepting.
- Never upgrade an inference into a fact. "Looks interesting, send pricing" is not "buyer is sold". No objection to price is not "budget confirmed". A main contact is not a champion. Acknowledging receipt is not reviewing a proposal.
- A champion requires BEHAVIOUR: internal work, mobilising colleagues, coordinating, advocating, owning next steps. Responsiveness alone is CONTACT ONLY.
- Conditional language matters. "We'll probably sign once..." is not "we will sign".
- Absence is evidence. Something promised that did not happen is often the most important fact on the deal.
- Quote the customer where it carries weight. Keep quotes short and verbatim.

Write the dossier in EXACTLY this structure, in plain prose, no em-dashes:

1. CURRENT CUSTOMER REALITY  (2-5 sentences)
2. MATERIAL EVIDENCE TIMELINE  (3-8 dated events, then one "SO WHAT?" line)
3. CUSTOMER DID / CUSTOMER DID NOT
4. CUSTOMER SAID  (only material substance, with short quotes)
5. COMMITMENTS + FOLLOW-THROUGH  (who, what, when, due, outcome, and one of FOLLOWED THROUGH / PARTIALLY / NOT YET DUE / OVERDUE / BROKEN / UNABLE TO VERIFY)
6. BUYING GROUP  (champion: VERIFIED CHAMPION / POSSIBLE CHAMPION / CONTACT ONLY / UNKNOWN. economic buyer and signer each: IDENTIFIED+ENGAGED / IDENTIFIED NOT ENGAGED / INFERRED / UNKNOWN, with the evidence)
7. COMMERCIAL / BUYING PROCESS  (pricing, budget, proposal, procurement, decision process, competition, each at its precise state)
8. PATH TO CLOSE  (remaining customer steps; path CLEAR/PARTIALLY MAPPED/MOSTLY UNKNOWN; close date SUPPORTED/AGGRESSIVE/UNSUPPORTED/CUSTOMER-DEPENDENT)
9. CRM VS CUSTOMER  (current forecast, evidence-supported forecast, why)
10. CURRENT REPORT AUDIT  (each of What changed / Next step / DealRipe read / Action / status, each marked VERIFIED / SUPPORTED INFERENCE / WEAK INFERENCE / UNSUPPORTED / CONTRADICTED / STALE, with one line of reasoning)
11. WHAT THE REPORT IS MISSING  (only material customer evidence, each with source, date, and where it belongs)
12. SALES-LEADER BOTTOM LINE  (one paragraph: what Mark needs to know before this deal comes up)

Be concise. Say "no evidence" where there is none. Do not pad.`;

main().catch((e) => { console.error("Unexpected error:", e.message ?? e); process.exit(1); });
