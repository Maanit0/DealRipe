/**
 * The demo strategy, as its own artifact built from the whole deal.
 *
 * WHY THIS IS NOT THE RECAP PASS.
 *
 * buildDemoStrategy in lib/recap-passes.ts reads ONE call: the transcript in
 * front of it plus that call's narrative. It renders inside the recap body and
 * is addressed to the rep. Eduardo Bencomo asked for something different on
 * 2026-09-04, and the reason is the audience: the recap is his record of the
 * call, the demo strategy is a brief for whoever runs the demo. Both go to
 * Salesforce notes on the account, because the solution engineer does not get
 * DealRipe email. They open the account and read what is there.
 *
 * WHY THE WHOLE DEAL AND NOT THE CALL.
 *
 * His own ranking rule, verbatim: "the most repeated pain points from
 * discovery, tied to specific Magaya products." Repetition across calls is
 * invisible to something reading one call. Dunavant carries six transcripts and
 * 253,581 characters; the version he wrote by hand came off a single August 12
 * discovery call, which is the ceiling this is trying to beat rather than match.
 *
 * The four documents he sent (ABC, Aqua Gulf, Dunavant, Kestrel) are the
 * specification and the test set. Anything added here should be traceable to
 * something one of them does.
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { supabaseAdmin } from "./supabase";

/** One block of the demo, named for what it covers. */
export type DemoSession = {
  name: string;
  cover: string[];
  why: string;
  minutes: number | null;
};

export type DemoStrategyDoc = {
  /**
   * What this demo has to achieve, in one line.
   *
   * Eduardo's ABC document opens with "Objectives for the September 18
   * Session" and it is the first thing a solution engineer reads. Ours had a
   * "why" per session and nothing saying what the whole thing is for, which
   * leaves the reader to infer the objective from five sessions.
   *
   * Deliberately NOT another section of lists. He said he sometimes asks for a
   * short version, so this earns its place by being one sentence.
   */
  objective: string;
  /** Who is in the room and what each of them controls. */
  attendees: Array<{ name: string; role: string; controls: string }>;
  /**
   * Magaya's own people, per call.
   *
   * Eduardo's documents carry a third column for the Magaya side and this is a
   * brief for a solution engineer who was on none of the calls. Knowing that
   * Steven answered the FTZ question, or that Dan answered on quote security,
   * tells them who to ask rather than re-deriving it.
   */
  ourTeam: Array<{ name: string; role: string }>;
  /** What the company is and does, as facts rather than adjectives. */
  companyOverview: string[];
  /** Hard numbers. Users, transactions per month, shipments, offices. */
  volumes: Array<{ label: string; value: string }>;
  /** What they run today, per area, and what it implies for us. */
  systemLandscape: Array<{ area: string; current: string; note: string }>;
  /** The ranked pains, rewritten as initiatives they would fund. */
  strategicGoals: string[];
  /** Appetite with no pain behind it. A counterweight, never promoted to a goal. */
  interests: string[];
  /** Who we are measured against, and the bar that sets. */
  competitive: string[];
  sessions: DemoSession[];
  /** Modules NOT to show, and why. Half of what he asked for. */
  skip: string[];
  /**
   * What has been said about money, marked directional.
   *
   * Eduardo's Dunavant document gives this its own section, "Pricing Signals
   * (Directional, Not Final)", and it is the one section ours had no home for:
   * the numbers ended up scattered between validateInternally and strengths. On
   * that deal Debra pre-screens on price before exposing business stakeholders,
   * so a demo plan that does not surface where pricing stands is missing the
   * gate in front of it.
   */
  pricingSignals: string[];
  /** Answers we owe ourselves before walking in. Required. */
  validateInternally: string[];
  risks: string[];
  strengths: string[];
  recommendation: string;
  positioning: string;
  buildsOnRepPlan: boolean;
  /**
   * Sections this deal needs that the fields above do not hold.
   *
   * THE FOUR DOCUMENTS HE SENT ARE NOT ONE TEMPLATE. They share a core and then
   * diverge, because each deal earned a different section: Kestrel has
   * "Objections / Concerns Raised", "Competitive Intel", "Timeline" and "Deal
   * Impact"; Aqua Gulf has "Magaya Capabilities Discussed (Mapped to TOTE's
   * Needs)" and "Suggested Attendee List for Next Call"; ABC has a "Fit
   * Assessment" split into Strong Fit and Gap / Caution Area. Dunavant has
   * Volumes and Pricing Signals, which recurred often enough to become fields.
   *
   * A fixed schema cannot produce that, and forcing every deal through the same
   * fifteen headings is what makes a document read as generated. The core stays
   * fixed because those things matter on every deal and reliability there is
   * worth more than variety. This is the tail.
   *
   * Capped and guarded, because the failure mode is obvious: a model given an
   * open section list will invent headings to look thorough. A section has to
   * carry material that does not fit above AND change what somebody does.
   */
  additionalSections: Array<{ title: string; items: string[] }>;
};

export type DemoStrategyResult =
  | { status: "ok"; doc: DemoStrategyDoc; sources: SourceCounts }
  | { status: "no_material"; reason: string }
  | { status: "unavailable"; reason: string };

export type SourceCounts = {
  calls: number;
  transcripts: number;
  transcriptChars: number;
  extractedFields: number;
};

/**
 * Everything known about the deal, ordered oldest first.
 *
 * Oldest first on purpose: the model is being asked which pains RECUR, and a
 * reverse-chronological list makes the first mention look like the latest one.
 */
async function gatherDealMaterial(dealId: string, asOf?: string): Promise<{
  account: string;
  transcriptBlock: string;
  extractionBlock: string;
  counts: SourceCounts;
} | null> {
  const db = supabaseAdmin();

  const deal = await db.from("deals").select("account").eq("id", dealId).maybeSingle();
  if (deal.error || !deal.data) return null;
  const account = String((deal.data as { account: string }).account);

  // asOf exists to make the comparison against a human-written strategy fair.
  // Eduardo's Dunavant document says "prepared from the August 12, 2026
  // discovery call", so grading ours against his while ours has read four later
  // demos measures nothing. With a cutoff both sides see the same evidence.
  let q = db
    .from("calls")
    .select("id, call_date, title, meeting_type, call_subtype, participants")
    .eq("deal_id", dealId);
  if (asOf) q = q.lte("call_date", asOf);
  const calls = await q.order("call_date", { ascending: true });
  if (calls.error) return null;
  const callRows = (calls.data ?? []) as Array<{
    id: string; call_date: string | null; title: string | null;
    meeting_type: string | null; call_subtype: string | null; participants: unknown;
  }>;

  const parts: string[] = [];
  let transcripts = 0;
  let chars = 0;
  for (const c of callRows) {
    const t = await db.from("transcripts").select("body").eq("call_id", c.id).maybeSingle();
    const body = String((t.data as { body?: string } | null)?.body ?? "").trim();
    if (!body) continue;
    transcripts += 1;
    chars += body.length;
    const who = Array.isArray(c.participants)
      ? (c.participants as Array<{ name?: string; email?: string }>)
          .map((p) => `${p?.name ?? ""} <${p?.email ?? ""}>`)
          .join(", ")
      : "";
    parts.push(
      `--- CALL ${c.call_date ?? "undated"}  "${c.title ?? "untitled"}"  ` +
        `(${c.meeting_type ?? "unclassified"}/${c.call_subtype ?? "none"})\n` +
        (who ? `INVITED: ${who}\n` : "") +
        body,
    );
  }

  // The extraction is the customer's own words with a captured date on each,
  // already verified. It is a cheaper and more reliable source for "what did
  // they say they need" than asking the model to re-derive it from raw text.
  const fx = await db
    .from("field_extractions")
    .select("framework_field_key, status, answer, evidence, last_updated_from_call_id")
    .eq("deal_id", dealId);
  const fxRows = (fx.data ?? []) as Array<{
    framework_field_key: string; status: string | null; answer: string | null;
    evidence: string | null; last_updated_from_call_id: string | null;
  }>;
  // An asOf cutoff that filtered the transcripts and not the extraction would
  // leak the future: the qualification record is updated by every later call,
  // so a "prepared from the August 12 call" run would silently carry what was
  // learned in September. Keep only extractions sourced from a call we are
  // allowed to see. A row with no source call is dropped under a cutoff, since
  // we cannot date it and guessing defeats the point of the cutoff.
  const allowedCalls = new Set(callRows.map((c) => c.id));
  const answered = fxRows.filter(
    (r) =>
      r.status === "Yes" &&
      (r.answer ?? "").trim() &&
      (!asOf || (r.last_updated_from_call_id && allowedCalls.has(r.last_updated_from_call_id))),
  );
  const extractionBlock = answered
    .map((r) => `- ${r.framework_field_key}: ${r.answer}${r.evidence ? `  ["${r.evidence}"]` : ""}`)
    .join("\n");

  return {
    account,
    transcriptBlock: parts.join("\n\n"),
    extractionBlock,
    counts: { calls: callRows.length, transcripts, transcriptChars: chars, extractedFields: answered.length },
  };
}

const SYSTEM = `You plan product demonstrations for Magaya, a logistics software vendor (customs filing and ABI, freight forwarding and TMS, warehouse management, rate management, customer portal, plugins and integrations). You are given EVERY captured call on one deal plus the verified qualification record. Produce the demo strategy the account team and the solution engineer will run from.

This document is read by a solution engineer who was not on any of the calls. They need to know what to show, in what order, what to skip, and what to be careful about.

HARD RULES:
1. No em-dashes or en-dashes anywhere.
2. Ground everything in what the customer said. Do not invent requirements, numbers or people.
3. RANK BY REPETITION. A pain raised on three calls outranks one raised once, and saying so is the point of being given every call. Where a pain recurred, the goal it becomes goes higher.
4. If the rep already proposed a demo plan, ADOPT their structure and improve it rather than inventing a competing one. Set buildsOnRepPlan true when you did.
5. Order sessions by what the customer weighted, never by our product's natural order.
6. "validateInternally" is REQUIRED and is the most important field. Anything the customer asked for where our answer was uncertain, hedged or negative, and which must be resolved BEFORE the session. An empty array asserts we checked and found none.
7. "skip" is what NOT to demo and why, in the customer's own terms. A demo that goes wide lands soft. If they told you something is not a priority, or asked about something "just in case", it belongs here rather than in a session.
8. "strategicGoals" REFRAMES the ranked pains as initiatives the customer would fund, in their language. A pain describes what is broken ("manual re-keying across seven disconnected systems"); a goal names what they are trying to achieve ("Consolidate onto fewer, standardized systems"). These go on a slide with the customer's logo on it, so write them as the customer would write them. Never copy a pain across unchanged.
9. "interests" is appetite with NO pain behind it: curiosity, a "just in case" ask, something they leaned toward because we showed it. Keep these OUT of strategicGoals. Empty array when there are none.
10. "volumes" is hard numbers only, as stated by the customer. Users, transactions per month, shipments, dockets, offices, containers. If they did not give a number, do not estimate one.
11. "competitive" names who we are measured against and the bar that sets. If they love an incumbent's feature, the demo must show parity or better on it, not just coverage. Empty array if no competitor was named.
12. "attendees" is who on the CUSTOMER side has appeared and what each CONTROLS: budget, the technical decision, the evaluation, day to day operations. Not a contact list. Include a stakeholder who has not appeared yet if the calls say they gate a decision.
12a. "ourTeam" is the Magaya people who appeared, with what each of them answered on. The reader was on none of these calls and needs to know who to ask.
12b. "pricingSignals" is everything said about money, marked as directional. Numbers quoted, ranges, comparisons to what they pay today, and whether the customer has asked for pricing or been given it. Empty array if money never came up.
13. No praise, no marketing language, no adjectives about our own product.
13a. EVERY FACT APPEARS ONCE. If a module belongs in "skip", do not also mention it inside a session. If a gap is in "validateInternally", do not restate it as a risk unless the risk is a different consequence. Repetition is the main reason a document like this stops being read, and a reader who meets the same sentence twice stops trusting the rest.
13b. BE TERSE. A bullet is one sentence. A session "why" is at most two, and names the evidence rather than narrating the call. Do not open a bullet with scene setting ("This is the session Debra warned about"); state the thing. Cut every word that does not change what the reader does.
13c. Completeness beats brevity where they conflict. Never drop a real finding to be short. Drop the words around it instead.
14. Name each session for what it covers. Do not prefix with "Session 1"; the reader's software numbers them.
14a. "objective" is ONE sentence naming what this demo has to achieve for the deal to advance. Not a summary of the sessions. On a deal where a gate exists, name the gate.
15. Where the customer was emphatic or emotional about something, say so in the session's "why". That is a signal about what to lead with.
16. SESSION SHAPE FOLLOWS THE CUSTOMER. If they asked to split the evaluation across several meetings, sessions are meetings and should say so in the name. If the demo is one meeting, sessions are segments within it and the minutes should sum to something a single meeting can hold. Never impose a structure the customer did not ask for when they asked for one.
16a. Aim for a document a solution engineer reads in one sitting. Roughly: at most 6 sessions, at most 8 items in any list, strategic goals no more than 7. Targets, not truncation. If a deal genuinely carries more, keep it.
17. "additionalSections" is for material this deal carries that the fields above have no home for. Add one ONLY when both are true: the material does not fit any field above, and a reader would do something differently for having read it. Real examples from documents written for other deals: objections raised and how to handle each, a competitive read where a named rival is in play, the decision timeline and what gates it, who should be invited to the next call, a product-by-product mapping where many modules were discussed. Do NOT restate anything already in a field above, do not add a section to look thorough, and return an empty array when the deal does not call for one. At most four.

Return a single JSON object, no prose, no markdown fences:
{
  "objective": string,
  "attendees": [{"name": string, "role": string, "controls": string}],
  "ourTeam": [{"name": string, "role": string}],
  "pricingSignals": [string],
  "companyOverview": [string],
  "volumes": [{"label": string, "value": string}],
  "systemLandscape": [{"area": string, "current": string, "note": string}],
  "strategicGoals": [string],
  "interests": [string],
  "competitive": [string],
  "sessions": [{"name": string, "cover": [string], "why": string, "minutes": number|null}],
  "skip": [string],
  "validateInternally": [string],
  "risks": [string],
  "strengths": [string],
  "recommendation": string,
  "positioning": string,
  "buildsOnRepPlan": boolean,
  "additionalSections": [{"title": string, "items": [string]}]
}`;

function parseObj(raw: string): Record<string, unknown> | null {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(t.slice(a, b + 1)) as Record<string, unknown>;
    return typeof o === "object" && o ? o : null;
  } catch {
    return null;
  }
}

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

export async function buildDemoStrategyForDeal(args: {
  dealId: string;
  /** Only read calls on or before this date (YYYY-MM-DD). For fair comparisons. */
  asOf?: string;
  /** Cap on transcript characters sent. Dunavant is 253k; the model handles it, but a runaway deal should not. */
  maxTranscriptChars?: number;
}): Promise<DemoStrategyResult> {
  const material = await gatherDealMaterial(args.dealId, args.asOf);
  if (!material) return { status: "unavailable", reason: "could not read the deal" };
  if (material.counts.transcripts === 0) {
    // Not a failure. There is genuinely nothing to plan a demo from, and saying
    // so is different from saying the model returned nothing.
    return { status: "no_material", reason: `no transcript on any of ${material.counts.calls} call(s)` };
  }

  const cap = args.maxTranscriptChars ?? 400_000;
  const transcripts =
    material.transcriptBlock.length > cap
      ? material.transcriptBlock.slice(-cap)
      : material.transcriptBlock;

  const user =
    `ACCOUNT: ${material.account}\n` +
    `CAPTURED CALLS: ${material.counts.transcripts} of ${material.counts.calls}\n\n` +
    (material.extractionBlock
      ? `VERIFIED QUALIFICATION RECORD, the customer's own words with what we captured:\n${material.extractionBlock}\n\n`
      : "") +
    `EVERY CAPTURED CALL ON THIS DEAL, oldest first:\n${transcripts}\n\n` +
    `Write the demo strategy JSON. Return JSON only.`;

  let text = "";
  try {
    const res = await getAnthropicClient().messages.create({
      model: getAnthropicModel(),
      max_tokens: 8000,
      // Zero, for the reason the recap pass documents: this is pure synthesis
      // with no quote to anchor it, so run-to-run variance shows up as a
      // different demo plan. A solution engineer builds from this.
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    text = res.content.map((c) => ("text" in c ? c.text : "")).join("");
  } catch (err) {
    return { status: "unavailable", reason: `the model call failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const o = parseObj(text);
  if (!o) return { status: "unavailable", reason: "the response was not valid JSON" };

  const sessions: DemoSession[] = Array.isArray(o.sessions)
    ? (o.sessions as unknown[]).flatMap((x) => {
        if (!x || typeof x !== "object") return [];
        const s = x as Record<string, unknown>;
        if (typeof s.name !== "string" || !s.name.trim()) return [];
        return [{
          name: s.name,
          cover: strArr(s.cover),
          why: typeof s.why === "string" ? s.why : "",
          minutes: typeof s.minutes === "number" ? s.minutes : null,
        }];
      })
    : [];

  const pairs = <A extends string, B extends string>(v: unknown, a: A, b: B, c?: string) =>
    Array.isArray(v)
      ? (v as unknown[]).flatMap((x) => {
          if (!x || typeof x !== "object") return [];
          const r = x as Record<string, unknown>;
          const out: Record<string, string> = {};
          for (const k of [a, b, ...(c ? [c] : [])]) out[k] = typeof r[k] === "string" ? (r[k] as string) : "";
          return out[a] ? [out] : [];
        })
      : [];

  return {
    status: "ok",
    sources: material.counts,
    doc: {
      objective: typeof o.objective === "string" ? o.objective : "",
      attendees: pairs(o.attendees, "name", "role", "controls") as DemoStrategyDoc["attendees"],
      ourTeam: pairs(o.ourTeam, "name", "role") as DemoStrategyDoc["ourTeam"],
      pricingSignals: strArr(o.pricingSignals),
      companyOverview: strArr(o.companyOverview),
      volumes: pairs(o.volumes, "label", "value") as DemoStrategyDoc["volumes"],
      systemLandscape: pairs(o.systemLandscape, "area", "current", "note") as DemoStrategyDoc["systemLandscape"],
      strategicGoals: strArr(o.strategicGoals),
      interests: strArr(o.interests),
      competitive: strArr(o.competitive),
      sessions,
      skip: strArr(o.skip),
      validateInternally: strArr(o.validateInternally),
      risks: strArr(o.risks),
      strengths: strArr(o.strengths),
      recommendation: typeof o.recommendation === "string" ? o.recommendation : "",
      positioning: typeof o.positioning === "string" ? o.positioning : "",
      buildsOnRepPlan: o.buildsOnRepPlan === true,
      additionalSections: Array.isArray(o.additionalSections)
        ? (o.additionalSections as unknown[])
            .flatMap((x) => {
              if (!x || typeof x !== "object") return [];
              const r = x as Record<string, unknown>;
              const title = typeof r.title === "string" ? r.title.trim() : "";
              const items = strArr(r.items);
              return title && items.length > 0 ? [{ title, items }] : [];
            })
            .slice(0, 4)
        : [],
    },
  };
}

/**
 * The document, as plain text for a Salesforce note.
 *
 * Section order follows Eduardo's own four documents: who is in the room, what
 * the company is, what they run today, what they are trying to achieve, then
 * the plan, then what we owe ourselves before walking in.
 */
export function renderDemoStrategy(account: string, d: DemoStrategyDoc, callDate?: string): string {
  const out: string[] = [];
  const block = (title: string, lines: string[]) => {
    if (lines.length === 0) return;
    out.push(title, ...lines, "");
  };

  out.push(`DEMO STRATEGY - ${account}`);
  if (callDate) out.push(`Prepared from the calls captured through ${callDate}`);
  out.push("");
  if (d.objective) { out.push("OBJECTIVE", d.objective, ""); }

  block("CALL ATTENDEES", d.attendees.map((a) => `- ${a.name}, ${a.role}. ${a.controls}`));
  block("MAGAYA TEAM", d.ourTeam.map((a) => `- ${a.name}, ${a.role}`));
  block("COMPANY OVERVIEW", d.companyOverview.map((s) => `- ${s}`));
  block("VOLUMES", d.volumes.map((v) => `- ${v.label}: ${v.value}`));
  // The model ends `current` with a period about half the time, so joining with
  // ". " produced "into it.. This is the system". Trim before joining.
  block(
    "CURRENT SYSTEM LANDSCAPE",
    d.systemLandscape.map((s) => {
      const cur = s.current.replace(/\s*\.\s*$/, "");
      return `- ${s.area}: ${cur}${s.note ? `. ${s.note}` : ""}`;
    }),
  );
  block("STRATEGIC GOALS", d.strategicGoals.map((s) => `- ${s}`));
  block("INTERESTS, NOT YET REQUIREMENTS", d.interests.map((s) => `- ${s}`));
  block("COMPETITIVE POSITION", d.competitive.map((s) => `- ${s}`));
  block("PRICING SIGNALS", d.pricingSignals.map((s) => `- ${s}`));

  if (d.sessions.length > 0) {
    out.push("RECOMMENDED DEMO STRATEGY");
    if (d.buildsOnRepPlan) out.push("This builds on the plan the rep already proposed on the call.");
    d.sessions.forEach((s, i) => {
      out.push(`${i + 1}. ${s.name}${s.minutes ? ` (~${s.minutes} min)` : ""}`);
      for (const c of s.cover) out.push(`   - ${c}`);
      if (s.why) out.push(`   Why: ${s.why}`);
    });
    out.push("");
  }

  block("WHAT TO AVOID", d.skip.map((s) => `- ${s}`));
  block("RESOLVE BEFORE THE DEMO", d.validateInternally.map((s) => `- ${s}`));
  block("RISKS", d.risks.map((s) => `- ${s}`));
  block("DEAL STRENGTHS", d.strengths.map((s) => `- ${s}`));
  if (d.positioning) block("POSITIONING", [d.positioning]);
  // Between the plan and the judgement: deal-specific material sits after the
  // demo plan it informs, and before the recommendation that weighs it.
  for (const sec of d.additionalSections) {
    block(sec.title.toUpperCase(), sec.items.map((i) => `- ${i}`));
  }
  if (d.recommendation) block("RECOMMENDATION", [d.recommendation]);

  return out.join("\n").trimEnd();
}
