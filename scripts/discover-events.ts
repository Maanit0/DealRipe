/**
 * DISCOVERY, not classification. What semantic events does this pipeline
 * actually contain, and which of them does our candidate vocabulary miss?
 *
 *   npx tsx scripts/discover-events.ts --limit 70
 *   npx tsx scripts/discover-events.ts --deal ghy
 *
 * READ ONLY. Writes JSONL to .previews/audit/, gitignored: every row carries a
 * customer quote under NDA.
 *
 * The candidate vocabulary is passed in as a HYPOTHESIS and the model is asked
 * to return anything it cannot express with it. A taxonomy written from first
 * principles and then confirmed against the data is not discovery; it is the
 * data being made to agree.
 *
 * THE IDENTITY RULE IS THE WHOLE POINT AND IS ENFORCED IN THE PROMPT. A
 * customer-semantic event needs a grounded customer source. Seller language
 * asserting a customer's position creates nothing: "as discussed, you approved
 * pricing" in a rep's email is not pricing_accepted. An UNKNOWN speaker can
 * establish that a meeting happened and that something was discussed, and can
 * never establish what the customer committed to, preferred, or objected to.
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { classifyConversation } from "../lib/conversation-class";
import { runModel } from "../lib/model-run";
import { sellerDirectory, sideOfSpeaker, type Participant } from "../lib/speaker-match";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const SELLER = "magaya.com";
const BUDGET = 55_000;

async function page<T>(t: string, c: string, tid: string | null): Promise<T[]> {
  const db = supabaseAdmin() as any; const o: T[] = [];
  for (let f = 0; ; f += 1000) {
    let q = db.from(t).select(c); if (tid) q = q.eq("tenant_id", tid);
    const r = await q.order("id", { ascending: true }).range(f, f + 999);
    if (r.error) throw new Error(`${t}: ${r.error.message}`);
    o.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break;
  } return o;
}

const CANDIDATES = `vendor_selected_us vendor_selected_competitor vendor_preference_us vendor_preference_competitor competitor_identified competitor_strengthened competitor_weakened competitor_eliminated evaluation_paused evaluation_resumed customer_rejected_solution customer_reopened_evaluation
pricing_sent pricing_received_confirmed pricing_discussed pricing_accepted pricing_objection discount_requested commercial_terms_accepted proposal_requested proposal_sent proposal_received_confirmed proposal_reviewed proposal_revision_requested proposal_accepted proposal_rejected contract_requested contract_sent contract_revision_requested contract_terms_accepted
budget_confirmed budget_indicated budget_pending budget_not_available budget_rejected budget_authority_identified
decision_process_identified decision_criteria_identified decision_date_set decision_date_changed decision_delayed internal_review_started internal_approval_requested internal_approval_received internal_approval_denied procurement_path_identified procurement_started legal_started legal_completed PO_process_started PO_received
new_stakeholder_identified new_stakeholder_engaged economic_buyer_identified economic_buyer_engaged signer_identified signer_engaged procurement_contact_engaged legal_contact_engaged technical_approver_engaged executive_sponsor_engaged
internal_advocacy_observed stakeholder_mobilized internal_information_shared internal_work_completed decision_process_navigated seller_given_internal_guidance customer_owned_next_step customer_defended_solution customer_pushed_approval
customer_commitment_made customer_commitment_modified customer_commitment_fulfilled customer_commitment_partially_fulfilled customer_commitment_overdue customer_commitment_broken customer_commitment_superseded
customer_target_date_set customer_timing_accelerated customer_timing_deferred implementation_target_set external_deadline_identified timing_dependency_identified
blocker_introduced blocker_resolved blocker_worsened blocker_reduced objection_raised objection_resolved regulatory_blocker_identified technical_blocker_identified commercial_blocker_identified internal_approval_blocker_identified
customer_initiated_email customer_initiated_meeting customer_initiated_next_step customer_reengaged customer_provided_requested_data customer_requested_information customer_requested_demo customer_requested_pricing customer_requested_reference customer_requested_security_material customer_requested_implementation_detail customer_declined_next_step`;

const SYSTEM = `You are reading the complete evidence for ONE B2B sales opportunity and extracting the semantic BUYING EVENTS it contains.

IDENTITY IS THE HARD RULE.
Every transcript speaker is marked CUSTOMER, MAGAYA or UNKNOWN. Every email is marked FROM CUSTOMER or FROM MAGAYA.
- A customer-semantic event (commitment, preference, objection, intent, selection, budget, urgency, champion behaviour) requires a CUSTOMER source: a grounded CUSTOMER transcript speaker, or an email FROM CUSTOMER.
- UNKNOWN speakers may support only: a meeting happened, a topic was discussed. Never a customer position.
- SELLER language asserting a customer's position creates NOTHING. "As discussed, you approved the pricing" in a Magaya email is not pricing_accepted.
- Seller-authored facts (proposal_sent, pricing_sent, contract_sent) ARE valid from a MAGAYA email, because they describe what the seller did.

DISTINCTIONS YOU MUST NOT COLLAPSE:
proposal sent != received != reviewed != accepted. No objection != budget confirmed. Main contact != champion. Meeting scheduled != customer accepted. Asking for pricing != accepting pricing.

Return ONLY a JSON object, no prose, no fences:
{"events":[{"type":"...","date":"YYYY-MM-DD","source":"CUSTOMER_TRANSCRIPT|CUSTOMER_EMAIL|SELLER_EMAIL|CALENDAR|CRM","actor":"person or null","quote":"<=180 chars verbatim, or null for seller-authored facts","confidence":"HIGH|MEDIUM|LOW","novel":false}],
 "commitments":[{"actor":"...","action":"...","made_at":"YYYY-MM-DD","due_at":"YYYY-MM-DD or null","conditional":true|false,"quote":"...","status":"OPEN|FULFILLED|PARTIALLY_FULFILLED|NOT_YET_DUE|OVERDUE|BROKEN|SUPERSEDED|UNABLE_TO_VERIFY","evidence_for_status":"..."}],
 "customerPosition":"SELECTED_US|LEANING_US|EVALUATING|LEANING_COMPETITOR|SELECTED_COMPETITOR|DEFERRED|NOT_BUYING|UNKNOWN",
 "commercialState":"NO_COMMERCIAL_DISCUSSION|PRICING_REQUESTED|PRICING_SENT|PRICING_DISCUSSION|PROPOSAL_SENT|PROPOSAL_REVIEW|COMMERCIAL_NEGOTIATION|COMMERCIAL_AGREEMENT|CONTRACT|LEGAL|PROCUREMENT|SIGNATURE_PENDING|SIGNED",
 "blockers":[{"type":"...","owner":"CUSTOMER|SELLER|EXTERNAL|UNKNOWN","description":"...","status":"OPEN|IMPROVING|WORSENING|RESOLVED","source":"...","customerSaysItBlocks":true|false}],
 "missedByReport":[{"what":"...","why_it_matters":"...","evidence":"...","date":"YYYY-MM-DD","polarity":"POSITIVE|NEGATIVE"}],
 "identityBlocked":[{"what_is_blocked":"...","speaker":"...","why":"..."}]}

USE THE CANDIDATE TYPES BELOW WHERE THEY FIT. Where a materially important thing the customer did or said CANNOT be expressed by any of them, invent a snake_case type and set "novel":true. Inventing a novel type is the most valuable thing you can do here, so do not force a poor fit. Do not invent a type for something trivial.

CANDIDATE TYPES:
${CANDIDATES}`;

/**
 * Parse the reply, and salvage a truncated one rather than losing the deal.
 *
 * At maxTokens 4000 the richest deals ran out of room mid-array and threw,
 * which discarded everything the model had already found on Loomis, Unitedchb
 * and Best. Raising the ceiling fixes the common case; this handles the tail,
 * because a partial extraction is worth far more than a failed one and losing
 * it silently is how a discovery pass under-reports the very deals with the
 * most to say.
 */
function parseOrSalvage(raw: string): any | null {
  const start = raw.indexOf("{"); if (start < 0) return null;
  const slice = raw.slice(start, raw.lastIndexOf("}") + 1);
  try { return JSON.parse(slice); } catch { /* fall through */ }
  // Close the arrays and object at the last complete element.
  for (const cut of [slice.lastIndexOf("},"), slice.lastIndexOf("}")]) {
    if (cut <= 0) continue;
    for (const tail of ["}]}", "}]}}", "}}]}"]) {
      try { return JSON.parse(slice.slice(0, cut + 1) + tail); } catch { /* next */ }
    }
  }
  return null;
}

async function main(): Promise<void> {
  const limit = Number(arg("--limit") ?? 70);
  const only = arg("--deal");
  const tid = await resolveTenantId("magaya");
  const deals = await page<any>("deals", "id, account, rep_email, outcome_label", tid);
  const calls = await page<any>("calls", "id, deal_id, outcome, capture_class, call_date, scheduled_start, title, participants", tid);
  const trs = await page<any>("transcripts", "id, call_id, body", null);
  const body = new Map(trs.map((t: any) => [t.call_id, String(t.body ?? "")]));
  const msgs = await page<any>("deal_messages", "id, deal_id, direction, customer_side, is_machine_sender, is_calendar_response, sent_at, subject, from_email, body_trimmed, body_raw, agreement_kind, agreement_state", tid);
  const parts = (c: any) => (Array.isArray(c.participants) ? c.participants : []) as Participant[];
  const dir = sellerDirectory(calls.map(parts));

  const open = deals.filter((d: any) => !d.outcome_label);
  const scored = open.map((d: any) => {
    const cs = calls.filter((c: any) => c.deal_id === d.id && String(c.outcome) === "captured");
    const conv = cs.filter((c: any) => classifyConversation({ outcome: c.outcome, captureClass: c.capture_class,
      transcript: body.get(c.id) ?? "", participants: parts(c), directory: dir }).substantiveMeetingConversation === true).length;
    const em = msgs.filter((m: any) => m.deal_id === d.id && m.customer_side === true && !m.is_machine_sender
      && !m.is_calendar_response && (m.body_trimmed ?? m.body_raw ?? "").length > 40).length;
    return { d, score: conv * 3 + em };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const targets = only
    ? scored.filter((x) => String(x.d.account).toLowerCase().includes(only.toLowerCase()))
    : scored.slice(0, limit);

  mkdirSync(".previews/audit", { recursive: true });
  const out = ".previews/audit/events.jsonl";
  // APPEND, NEVER TRUNCATE, unless explicitly told to start over. Truncating
  // at the top of the run is what turned one API outage into the loss of the
  // six deals that had already succeeded.
  if (!only && process.argv.includes("--fresh")) writeFileSync(out, "", "utf8");
  const done = new Set<string>();
  try {
    for (const line of readFileSync(out, "utf8").split("\n")) {
      if (line.trim()) done.add(String(JSON.parse(line).deal));
    }
  } catch { /* no prior file */ }
  if (done.size) console.log(`  resuming: ${done.size} deal(s) already extracted`);
  console.log(`\n  extracting events from ${targets.length} deals -> ${out}\n`);

  for (const { d } of targets) {
    if (done.has(String(d.account))) continue;
    const cs = calls.filter((c: any) => c.deal_id === d.id)
      .sort((a: any, b: any) => String(b.call_date ?? b.scheduled_start).localeCompare(String(a.call_date ?? a.scheduled_start)));
    let spent = 0; const blocks: string[] = [];
    for (const c of cs) {
      const at = String(c.call_date ?? c.scheduled_start ?? "").slice(0, 10);
      const b = body.get(c.id) ?? "";
      if (!b.trim()) { blocks.push(`\n--- MEETING ${at} | ${c.title ?? ""} | outcome=${c.outcome} | NO TRANSCRIPT`); continue; }
      const v = classifyConversation({ outcome: c.outcome, captureClass: c.capture_class, transcript: b, participants: parts(c), directory: dir });
      // Label every speaker so the model never has to guess a side.
      const labelled = b.split("\n").map((line) => {
        const i = line.indexOf(":"); if (i <= 0) return line;
        const who = line.slice(0, i).trim();
        const s = sideOfSpeaker(parts(c), who, dir);
        return `[${s === "seller" ? "MAGAYA" : s === "customer" ? "CUSTOMER" : "UNKNOWN"}] ${line}`;
      }).join("\n");
      const room = Math.max(0, BUDGET - spent); if (room < 800) continue;
      const slice = labelled.length <= room ? labelled : labelled.slice(0, room) + "\n[...truncated]";
      spent += slice.length;
      blocks.push(`\n--- MEETING ${at} | ${c.title ?? ""} | verdict=${v.verdict}\n${slice}`);
    }
    const mine = msgs.filter((m: any) => m.deal_id === d.id && !m.is_calendar_response && !m.is_machine_sender)
      .sort((a: any, b: any) => String(b.sent_at).localeCompare(String(a.sent_at))).slice(0, 28);
    const mail = mine.map((m: any) => `\n--- EMAIL ${String(m.sent_at).slice(0,10)} | ${m.customer_side === true ? "FROM CUSTOMER" : "FROM MAGAYA"} | ${m.from_email} | ${m.subject ?? ""}\n${(m.body_trimmed ?? m.body_raw ?? "").trim().slice(0,1800) || "(no body)"}`);
    const agree = msgs.filter((m: any) => m.deal_id === d.id && m.agreement_kind)
      .map((m: any) => `    ${String(m.sent_at).slice(0,10)} ${m.agreement_kind} state=${m.agreement_state ?? "?"}`);

    const bundle = `DEAL: ${d.account}\nTODAY IS 2026-09-13.\n\n=== AGREEMENT EVENTS ===\n${agree.join("\n") || "  none"}\n\n=== MEETINGS ===\n${blocks.join("\n") || "  none"}\n\n=== EMAIL ===\n${mail.join("\n") || "  none"}`;
    try {
      // RETRY A TRANSIENT OUTAGE. A first run lost 64 of 70 deals to
      // "Connection error" in one API blip, and because the file is truncated
      // at the start of a run that also destroyed the six that had succeeded.
      // Discovery over a large corpus must not be all-or-nothing.
      let res: Awaited<ReturnType<typeof runModel>> | null = null;
      let lastErr = "";
      for (let attempt = 0; attempt < 4 && !res; attempt += 1) {
        try {
          res = await runModel({ task: "discovery.events", promptVersion: "v1", tenantId: tid,
            maxTokens: 12000, temperature: 0, system: SYSTEM, messages: [{ role: "user", content: bundle }] });
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        }
      }
      if (!res) throw new Error(lastErr);
      const blk = res.message.content.find((b) => b.type === "text");
      const raw = blk && "text" in blk ? blk.text : "";
      const j = parseOrSalvage(raw);
      if (!j) { console.log(`  ${String(d.account).slice(0,26).padEnd(28)} UNPARSEABLE (${raw.length} chars)`); continue; }
      appendFileSync(out, JSON.stringify({ deal: d.account, rep: d.rep_email, ...j }) + "\n", "utf8");
      const novel = (j.events ?? []).filter((e: any) => e.novel).length;
      console.log(`  ${String(d.account).slice(0,26).padEnd(28)} ${String((j.events ?? []).length).padStart(3)} events  ${String((j.commitments ?? []).length).padStart(2)} commitments  ${String(novel).padStart(2)} novel  pos=${j.customerPosition}  comm=${j.commercialState}`);
    } catch (e) {
      console.log(`  ${String(d.account).slice(0,26).padEnd(28)} FAILED: ${(e as Error).message.slice(0,80)}`);
    }
  }
  console.log(`\n  written to ${out}\n`);
}
main().catch((e) => { console.error("Unexpected error:", e.message ?? e); process.exit(1); });
