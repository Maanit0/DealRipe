/**
 * The narrative and demo-strategy passes.
 *
 * Eduardo Bencomo, 2026-08-14, on the recap we were sending him: "It's very
 * tied to the checks that we have. It's like, is this covered, is this covered.
 * So we need also the nuances." And: "This does not allow me to prepare for a
 * demo."
 *
 * The cause is topology, not prompt wording. The old recap's user message led
 * with all 27 qualification fields and appended the transcript underneath, so
 * the model was narrating a checklist with the transcript as supporting
 * evidence. It inherited the framework's shape because the framework was the
 * frame.
 *
 * So the rule this file exists to enforce:
 *
 *   THE NARRATIVE PASS NEVER RECEIVES THE EXTRACTION.
 *
 * Not "is told to ignore it". Absent from the prompt. buildNarrative's
 * signature has no extraction parameter and no framework parameter, which is
 * the only version of this instruction that cannot be quietly undone later.
 * The gap audit is unaffected and unmoved: it stays deterministic, computed
 * from the framework, and it runs after the narrative. He asked for it to stay.
 *
 * Two things make the output safe enough to paste into a customer's CRM, which
 * is what he actually does with it:
 *
 * 1. EVERY FACT CARRIES A QUOTE, AND EVERY QUOTE IS VERIFIED. Quotes are
 *    checked against the transcript with groundingScore, the same function that
 *    already downgrades unfounded extraction confirmations. A fact whose quote
 *    is not in the transcript is DELETED, never paraphrased into safety.
 *
 * 2. NUMBERS ARE HELD TO A HIGHER BAR THAN PROSE. "Approximately 125 users",
 *    "under 1,000 transactions a month", "600 lines" are the most valuable
 *    content in a discovery call and the most damaging to get wrong, because a
 *    pricing estimate gets built from them. They are emitted as individual
 *    structured facts so each one can be verified on its own rather than
 *    hidden inside a paragraph that passes as a whole.
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { groundingScore } from "./grounding";

/**
 * A pass either produced something, ran and found nothing, or failed.
 *
 * These are three different facts and the recap says which. "No demo strategy
 * because this was a contract review" and "no demo strategy because the model
 * call timed out" produce the same blank space on the page, and only one of
 * them is worth a rep's attention. Never an empty section.
 */
export type PassResult<T> =
  | { status: "present"; value: T }
  /** The pass ran over the transcript and there was genuinely no material. */
  | { status: "absent"; reason: string }
  /** The pass did not complete. We do not know what it would have said. */
  | { status: "unavailable"; reason: string };

/** A claim about the customer, with the words they used to make it. */
export type QuotedFact = {
  /** The claim in our words, for reading. */
  statement: string;
  /** Theirs, for trusting. Verified against the transcript before it survives. */
  quote: string;
  /** Who said it, when the transcript attributes it. */
  speaker: string | null;
};

/** A measured fact. Same shape, held to a stricter grounding threshold. */
export type NumericFact = QuotedFact & {
  /** The figure itself, as they said it: "125", "under 1,000", "95%". */
  value: string;
  /** What it counts: "users", "freight forwarding transactions per month". */
  unit: string;
};

export type Narrative = {
  /** Two or three sentences: what this account is and how serious it is. */
  executiveSummary: string;
  /** Their systems, offices, headcount and volumes, in their numbers. */
  currentEnvironment: NumericFact[];
  /** Everything else about how they work today that is not a number. */
  environmentNotes: QuotedFact[];
  /** Ranked, most important first, each with the customer's own words. */
  painPoints: QuotedFact[];
  /**
   * The specific operational detail nobody would have captured.
   *
   * On the Dunavant call this was Gina's manual product data problem: no
   * central database, inbound entries that grew from 20 lines to 100, outbound
   * up to 600, unit conversions redone by hand off the 214 to build the 7501,
   * and an internal project plan started a week earlier. That one paragraph is
   * worth more than the whole gap audit and it exists only because someone read
   * the transcript for what was said rather than for what was missing.
   */
  operationalDetail: string | null;
  /** Grouped the way the customer's business is grouped, not the framework's. */
  requirementsByArea: Array<{ area: string; requirements: string[] }>;
  /** Who evaluates, who is explicitly not deciding, how legal works. */
  buyingProcess: QuotedFact[];
  /** Timeline and urgency, with the evidence for it. */
  timeline: QuotedFact[];
  /**
   * What each side agreed to do, split by who owes it.
   *
   * Added after comparing our output to the one Eduardo wrote himself from this
   * transcript. His carried the four figures he asked Debra to send (user counts
   * by area, monthly containers, INTTRA bookings, air and eAWB volumes) and ours
   * carried none of them, despite those being the direct input to the pricing
   * estimate that is the next thing that has to happen on the deal. A recap that
   * loses the ask loses the deal's next move.
   *
   * `weOwe` also catches commitments the REP made, which is why quotes here are
   * not restricted to the customer. Eduardo answering "not at all" when Michael
   * asked whether declining Magaya's internal accounting changes the price is a
   * commercial commitment, and it was nowhere in our first version.
   */
  nextSteps: {
    customerOwes: QuotedFact[];
    weOwe: QuotedFact[];
  };
};

export type DemoSession = {
  name: string;
  /** What to cover, in order. */
  cover: string[];
  /** Why this order, tied to what the customer said. */
  why: string;
  minutes: number | null;
};

export type DemoStrategy = {
  /**
   * The customer's own initiatives, reframed from what hurts.
   *
   * THIS IS THE SEAM BETWEEN THE RECAP AND THE DECK. Eduardo's own Aqua Gulf
   * output has a "Strategic Goals (Reframed from Pain Points)" section, and six
   * of its seven lines are slide 4 of the Magaya deck he then presented,
   * verbatim. The deck opens with the customer's goals BEFORE Magaya's company
   * overview, which is the motion: mirror their goals back first.
   *
   * A pain and a goal are not the same object and the difference is the whole
   * point of the reframe:
   *
   *   pain  "a fragmented multi-system environment creates cross-training
   *          burden, manual re-keying and reporting inconsistency"
   *   goal  "Consolidate onto fewer, standardized systems"
   *
   * A pain is a problem you describe back to a customer. A goal is an
   * initiative they would fund, in their language, that can go on a slide with
   * their logo on it.
   *
   * Structured rather than prose, deliberately, so a deck generator can consume
   * it later without re-parsing English.
   */
  strategicGoals: string[];
  /**
   * Appetite with no pain behind it yet.
   *
   * A third category, and it earns its place mostly as a COUNTERWEIGHT. Eduardo's
   * own Dunavant strategy guards against it in writing: "confirm Ocean + Air AMS
   * (note: Air AMS was a 'just in case' ask, not a current need, don't
   * over-index on it)." Interests are the most common reason a demo goes wide
   * and lands soft, so they are labelled as interests and never promoted into
   * strategicGoals.
   *
   * An interest becomes a goal when it acquires a number or an owner. Aqua
   * Gulf's AMS started as curiosity and became a funded goal the moment "~350
   * shipments/year currently turned away" attached to it.
   */
  interests: string[];
  sessions: DemoSession[];
  /**
   * What to resolve internally before the session.
   *
   * Required, and empty means "we looked and found none" rather than "nobody
   * asked". On Dunavant the answer is unmissable: Gina asked whether Magaya can
   * hold a per-client product database and Steven answered "there's no database
   * like storage warehouse storage solution that we would have". That is a
   * possible functional gap sitting on the critical path to the demo, and it is
   * the single item the rep most needs before walking into it.
   */
  validateInternally: string[];
  risks: string[];
  positioning: string;
  /**
   * The read on the deal itself: what is going for it, and the one thing to do.
   *
   * Eduardo's own version of this recap ended with an opportunity assessment and
   * a recommendation ("move fast, but do not lead with a generic platform
   * demo"). Ours ended with a positioning sentence and nothing about whether the
   * deal is good. A manager reading the Note wants the judgement, not only the
   * plan.
   */
  strengths: string[];
  recommendation: string;
  /**
   * True when the rep already proposed a plan on the call and this refines it.
   *
   * A strategy that invents a competing plan is noise. Eduardo proposed the
   * split himself on the Dunavant call, customs compliance first at an hour then
   * forwarding, rates and the portal at two, so the useful output adopts his
   * order, says why it is right against what the customer weighted, and adds
   * what he missed.
   */
  buildsOnRepPlan: boolean;
};

// ====================================================================
// Grounding
// ====================================================================

/**
 * Below this a quote's content is essentially absent from the transcript.
 *
 * Deliberately stricter than the extraction gate (0.35). A gap audit that keeps
 * a loosely-evidenced gate costs a rep one redundant question. A narrative that
 * keeps an invented volume puts a wrong number in a Salesforce Note that a
 * solution engineer and a pricing estimate are both built from.
 */
const QUOTE_MIN = 0.7;
/** Numbers get no benefit of the doubt at all: verbatim or a near-verbatim run. */
const NUMERIC_MIN = 0.95;

function keepQuoted<T extends QuotedFact>(facts: T[], transcript: string, min: number): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  // Near-duplicates are dropped silently rather than counted as grounding
  // failures, because they are the model saying one true thing twice, not
  // inventing anything. The Dunavant readout carried the accounting answer as
  // two entries whose only difference was a trailing clause.
  const seen = new Set<string>();
  const fingerprint = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 12).join(" ");
  for (const f of facts) {
    if (!f?.quote || !f?.statement) continue;
    const key = fingerprint(f.statement);
    if (key.length > 0 && seen.has(key)) continue;
    if (key.length > 0) seen.add(key);
    (groundingScore(f.quote, transcript) >= min ? kept : dropped).push(f);
  }
  return { kept, dropped };
}

/** What grounding removed, so a silent deletion is never silent. */
export type GroundingTrace = {
  droppedFacts: number;
  droppedNumbers: number;
  examples: string[];
};

// ====================================================================
// Pass 1: narrative
// ====================================================================

const NARRATIVE_SYSTEM = `You are writing the readout of a B2B sales call for the account team. You were on the call. Your reader was not, and needs to understand this customer's business well enough to prepare for a demo.

Write what the customer actually said. Their operation, their numbers, their words.

HARD RULES:
1. No em-dashes or en-dashes anywhere. Use commas or periods.
2. Never state a fact the transcript does not support. Every fact you emit carries the speaker's own quote, copied VERBATIM from the transcript, including any typos or mangled words in it. Do not clean up, correct, or reflow a quote. If you cannot quote it, do not claim it. Quotes may be from the customer OR from the seller, whichever said the thing.
2b. THE QUOTE MUST BE THE EVIDENCE FOR THE CLAIM, SPOKEN BY THE PERSON THE CLAIM IS ABOUT. A question is never evidence of its own answer. If you want to say the customer is leaving their vendor over price, quote the CUSTOMER saying price. Do NOT quote the seller asking "why are you switching?", which proves only that the question was asked. If the answer was never actually spoken, omit the claim entirely. Set "speaker" to the person whose position the claim describes.
2c. ATTRIBUTE TO THE CUSTOMER, NOT TO THE SELLER RESTATING THEM. The seller frequently repeats a customer's numbers back to confirm them ("so you have six users"). The customer owns that fact; the seller is echoing it. Attribute it to the customer who originally gave it, and quote the customer. If only the seller ever said the number and the customer never confirmed it, do not emit it as a fact about their business at all.
3. Do not use sales qualification vocabulary. Banned: compelling event, budget holder, decision criteria, qualification, discovery, stage, gap, pipeline, MEDDIC, BANT, SQL0 through SQL5, "still open", "captured". Describe what is true about the business instead.
4. No praise, no marketing language, no "great call", no adjectives that sell. Plain and factual.
5. Attribute by name when the transcript names the speaker.
6. Prefer the customer's phrasing over yours. If they said "we start by quote", write that, do not write "their process begins with quotation".

SECTION BUDGETS (there is no overall length limit; density is the point):
- executiveSummary: 2 to 3 sentences. What this account is, what they are trying to do, how serious it is.
- currentEnvironment: EVERY number THE CUSTOMER gave about THEIR OWN business. User counts, transaction volumes, percentages, line counts, office counts, dockets, headcount. One entry per number. This is the highest value section, do not summarize it away. EXCLUDE any figure the seller quoted, especially prices, rates and estimates: our price is not a fact about their operation, and this section is what a pricing estimate gets built from. A price the seller named belongs in environmentNotes if it belongs anywhere. Each "statement" here MUST be a complete sentence that already contains the figure, written the way a person would say it: "They run approximately 125 users across warehousing, freight forwarding and customs." NOT a bare label like "Total users across all platforms", which cannot be read aloud in a sentence.
- environmentNotes: how they work today that is not numeric. Systems they run, what connects to what, where the manual work is.
- painPoints: SPECIFIC PROBLEMS, not requirement categories. A pain point describes something that is going wrong in their operation today, with the mechanics of it: what they have to do by hand, what breaks, what it costs them. "Customs sophistication is a decision driver" is NOT a pain point, it is a category, and categories belong in requirementsByArea. "Unit conversions have to be recalculated by hand on every outbound entry because there is no product database" IS one. If a customer names a driver without describing a problem underneath it, leave it out of this section entirely; the executive summary already carries it.
  RANK BY HOW MUCH OF THE PROBLEM THEY DESCRIBED, not by what you judge to be important, and not by whether they used the word "driver". In order: (a) a problem they described the mechanics of at length, (b) a problem they attached numbers to, (c) a problem they returned to more than once, (d) everything else. Depth of description is the customer telling you what actually hurts, and it is an observation about the transcript rather than an opinion, so two readers produce the same order.
- operationalDetail: the ONE specific operational problem a generic notetaker would have missed, written as a full paragraph with the mechanics in it. Null only if the call genuinely contained no such detail.
- requirementsByArea: grouped by how THEIR business is organized (for example customs, warehousing, forwarding, portal, integrations), not by any sales framework.
- buyingProcess: who evaluates, who was explicitly said NOT to be the decision maker, how legal and procurement work.
- timeline: dates, urgency, and what is driving it.
- environmentNotes MUST also include any COMMERCIAL COMMITMENT either side made on the call, such as an answer about whether an optional module changes the price.
- nextSteps: split by who owes it. customerOwes is everything the customer agreed to send or do. weOwe is everything the seller agreed to send or do. Every specific figure or document the seller ASKED THE CUSTOMER FOR belongs in customerOwes, listed individually rather than as "send the requested data". If the seller asked for four numbers, that is four entries.

Return a single JSON object, no prose, no markdown fences:
{
  "executiveSummary": string,
  "currentEnvironment": [{"value": string, "unit": string, "statement": string, "quote": string, "speaker": string|null}],
  "environmentNotes": [{"statement": string, "quote": string, "speaker": string|null}],
  "painPoints": [{"statement": string, "quote": string, "speaker": string|null}],
  "operationalDetail": string|null,
  "requirementsByArea": [{"area": string, "requirements": [string]}],
  "buyingProcess": [{"statement": string, "quote": string, "speaker": string|null}],
  "timeline": [{"statement": string, "quote": string, "speaker": string|null}],
  "nextSteps": {
    "customerOwes": [{"statement": string, "quote": string, "speaker": string|null}],
    "weOwe": [{"statement": string, "quote": string, "speaker": string|null}]
  }
}`;

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const o = JSON.parse(s) as unknown;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asQuoted(v: unknown): QuotedFact[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    if (typeof o.statement !== "string" || typeof o.quote !== "string") return [];
    return [
      {
        statement: o.statement.trim(),
        quote: o.quote.trim(),
        speaker: typeof o.speaker === "string" && o.speaker.trim() ? o.speaker.trim() : null,
      },
    ];
  });
}

function asNumeric(v: unknown): NumericFact[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    if (
      typeof o.statement !== "string" ||
      typeof o.quote !== "string" ||
      typeof o.value !== "string" ||
      typeof o.unit !== "string"
    ) {
      return [];
    }
    return [
      {
        statement: o.statement.trim(),
        quote: o.quote.trim(),
        speaker: typeof o.speaker === "string" && o.speaker.trim() ? o.speaker.trim() : null,
        value: o.value.trim(),
        unit: o.unit.trim(),
      },
    ];
  });
}

export async function buildNarrative(args: {
  /** The account name. Nothing else about the deal is passed in, by design. */
  account: string;
  transcript: string;
}): Promise<{ result: PassResult<Narrative>; grounding: GroundingTrace }> {
  const empty: GroundingTrace = { droppedFacts: 0, droppedNumbers: 0, examples: [] };

  if (!process.env.ANTHROPIC_API_KEY) {
    return { result: { status: "unavailable", reason: "ANTHROPIC_API_KEY is not set" }, grounding: empty };
  }
  if (args.transcript.trim().length < 400) {
    return {
      result: {
        status: "absent",
        reason: `the transcript is ${args.transcript.trim().length} characters, too short to read a business out of`,
      },
      grounding: empty,
    };
  }

  // Generate, and retry once if the JSON does not parse.
  //
  // Measured on Medov's 70,252-character transcript: two consecutive runs, one
  // clean readout and one "the narrative response was not valid JSON". The
  // failure is silent in the worst way, because an unparseable response
  // downgrades the whole recap to the old shallow shape and the rep gets the
  // questionnaire this rebuild exists to replace. Nothing in the output says
  // why.
  //
  // A truncated or malformed response is not evidence about the call, so a
  // retry is honest rather than papering over a real absence. The second
  // attempt raises max_tokens, because the most likely cause on a long
  // transcript is the response being cut off mid-object rather than the model
  // misunderstanding the format.
  let o: Record<string, unknown> | null = null;
  let lastError = "";
  for (const attempt of [0, 1]) {
    let text: string;
    try {
      const resp = await getAnthropicClient().messages.create({
        model: getAnthropicModel(),
        max_tokens: attempt === 0 ? 8000 : 16000,
        temperature: 0.2,
        system: NARRATIVE_SYSTEM,
        messages: [
          {
            role: "user",
            // Account name and transcript. No framework, no extraction, no stage,
            // no CRM state. This is the fix; keep it this way.
            content: `ACCOUNT: ${args.account}\n\nTRANSCRIPT:\n${args.transcript}\n\nWrite the readout JSON. Return JSON only.`,
          },
        ],
      });
      const block = resp.content.find((b) => b.type === "text");
      text = block && "text" in block ? block.text : "";
    } catch (err) {
      // A thrown call is not a parse problem and retrying it here would race
      // the SDK's own retries. Report it.
      return {
        result: {
          status: "unavailable",
          reason: `the narrative generation call failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        grounding: empty,
      };
    }

    o = parseJsonObject(text);
    if (o) break;
    lastError = `the response was not valid JSON (${text.length} chars, attempt ${attempt + 1})`;
    if (attempt === 0) {
      console.warn(
        `[recap-passes] narrative JSON did not parse for ${args.account} at ${text.length} chars, retrying with a larger budget`,
      );
    }
  }

  if (!o) {
    return {
      result: { status: "unavailable", reason: `the narrative response could not be parsed twice: ${lastError}` },
      grounding: empty,
    };
  }

  const numbers = keepQuoted(asNumeric(o.currentEnvironment), args.transcript, NUMERIC_MIN);
  const notes = keepQuoted(asQuoted(o.environmentNotes), args.transcript, QUOTE_MIN);
  const pains = keepQuoted(asQuoted(o.painPoints), args.transcript, QUOTE_MIN);
  const buying = keepQuoted(asQuoted(o.buyingProcess), args.transcript, QUOTE_MIN);
  const timeline = keepQuoted(asQuoted(o.timeline), args.transcript, QUOTE_MIN);
  const ns = (o.nextSteps ?? {}) as Record<string, unknown>;
  const customerOwes = keepQuoted(asQuoted(ns.customerOwes), args.transcript, QUOTE_MIN);
  const weOwe = keepQuoted(asQuoted(ns.weOwe), args.transcript, QUOTE_MIN);

  const grounding: GroundingTrace = {
    droppedNumbers: numbers.dropped.length,
    droppedFacts:
      notes.dropped.length +
      pains.dropped.length +
      buying.dropped.length +
      timeline.dropped.length +
      customerOwes.dropped.length +
      weOwe.dropped.length,
    examples: [
      ...numbers.dropped,
      ...pains.dropped,
      ...notes.dropped,
      ...buying.dropped,
      ...timeline.dropped,
      ...customerOwes.dropped,
      ...weOwe.dropped,
    ]
      .slice(0, 5)
      .map((d) => `${d.statement} (quote not found: "${d.quote.slice(0, 60)}")`),
  };

  const requirementsByArea = Array.isArray(o.requirementsByArea)
    ? (o.requirementsByArea as unknown[]).flatMap((x) => {
        if (!x || typeof x !== "object") return [];
        const r = x as Record<string, unknown>;
        if (typeof r.area !== "string" || !Array.isArray(r.requirements)) return [];
        const reqs = r.requirements.filter((q): q is string => typeof q === "string" && q.trim().length > 0);
        return reqs.length ? [{ area: r.area.trim(), requirements: reqs }] : [];
      })
    : [];

  const executiveSummary = typeof o.executiveSummary === "string" ? o.executiveSummary.trim() : "";
  const operationalDetail =
    typeof o.operationalDetail === "string" && o.operationalDetail.trim() ? o.operationalDetail.trim() : null;

  // If grounding removed everything, the honest answer is that we have no
  // narrative, not a narrative made of headings.
  const anyContent =
    executiveSummary.length > 0 ||
    numbers.kept.length > 0 ||
    notes.kept.length > 0 ||
    pains.kept.length > 0 ||
    requirementsByArea.length > 0;
  if (!anyContent) {
    return {
      result: {
        status: "absent",
        reason:
          grounding.droppedFacts + grounding.droppedNumbers > 0
            ? `every claim was dropped because its quote could not be found in the transcript (${
                grounding.droppedFacts + grounding.droppedNumbers
              } dropped)`
            : "the model returned no usable content",
      },
      grounding,
    };
  }

  return {
    result: {
      status: "present",
      value: {
        executiveSummary,
        currentEnvironment: numbers.kept,
        environmentNotes: notes.kept,
        painPoints: pains.kept,
        operationalDetail,
        requirementsByArea,
        buyingProcess: buying.kept,
        timeline: timeline.kept,
        nextSteps: { customerOwes: customerOwes.kept, weOwe: weOwe.kept },
      },
    },
    grounding,
  };
}

// ====================================================================
// Pass 3: demo strategy
// ====================================================================

const DEMO_SYSTEM = `You plan product demonstrations for a logistics software vendor (Magaya: customs filing, freight forwarding, warehouse management, rate management, customer portal). You are given a readout of a discovery call and the transcript. Produce the demo strategy the account team will run.

HARD RULES:
1. No em-dashes or en-dashes anywhere.
2. Ground everything in what the customer said. Do not invent requirements.
3. If the REP already proposed a demo plan on the call, ADOPT their structure and improve it. Say why the order is right against what the customer weighted, and add what they missed. Inventing a competing plan is worse than useless. Set buildsOnRepPlan true when you did this.
4. Order sessions by what the customer weighted most heavily, not by our product's natural order.
5. "validateInternally" is REQUIRED and is the most important field. List anything the customer asked for where our answer on the call was uncertain, hedged, or negative, and which must be resolved internally BEFORE the session. If the call contained none, return an empty array, which asserts that we checked and found none.
6. No praise, no marketing language.
7. "strengths" and "recommendation" are the read on the deal itself. Strengths are the concrete facts that make this winnable (an incumbent contract ending, a stated urgency, a budget already validated), not adjectives. The recommendation is ONE paragraph a sales manager could act on, naming what to do first and what not to do.
8. Name the session for what it covers. Do NOT prefix it with "Session 1" or a number; the reader's software numbers them.
9. "strategicGoals" REFRAMES the ranked pain points as initiatives the customer would fund, in their language, one line each. A pain describes what is broken ("manual re-keying across seven disconnected systems"); a goal names what they are trying to achieve ("Consolidate onto fewer, standardized systems"). Write goals a customer would recognise as their own words on their own slide. Never copy a pain across unchanged, and never invent a goal the call does not support. Order them the way the customer weighted them.
10. "interests" is appetite the customer showed with NO pain behind it: curiosity, a "just in case" ask, something they leaned toward because we showed it rather than because they walked in wanting it. Keep these OUT of strategicGoals. They are the most common reason a demo goes wide and lands soft, so listing them separately is a warning, not a wish list. Empty array when the call showed none.

Return a single JSON object, no prose, no markdown fences:
{
  "strategicGoals": [string],
  "interests": [string],
  "sessions": [{"name": string, "cover": [string], "why": string, "minutes": number|null}],
  "validateInternally": [string],
  "risks": [string],
  "strengths": [string],
  "recommendation": string,
  "positioning": string,
  "buildsOnRepPlan": boolean
}`;

function renderNarrativeForDemo(n: Narrative): string {
  const lines: string[] = [];
  lines.push(`SUMMARY: ${n.executiveSummary}`);
  if (n.currentEnvironment.length) {
    lines.push(`\nTHEIR NUMBERS:`);
    for (const f of n.currentEnvironment) lines.push(`- ${f.value} ${f.unit}. ${f.statement}`);
  }
  if (n.environmentNotes.length) {
    lines.push(`\nHOW THEY WORK TODAY:`);
    for (const f of n.environmentNotes) lines.push(`- ${f.statement}`);
  }
  if (n.painPoints.length) {
    lines.push(`\nWHAT HURTS, RANKED:`);
    for (const f of n.painPoints) lines.push(`- ${f.statement} ("${f.quote}")`);
  }
  if (n.operationalDetail) lines.push(`\nOPERATIONAL DETAIL:\n${n.operationalDetail}`);
  if (n.requirementsByArea.length) {
    lines.push(`\nREQUIREMENTS BY AREA:`);
    for (const r of n.requirementsByArea) lines.push(`- ${r.area}: ${r.requirements.join("; ")}`);
  }
  if (n.buyingProcess.length) {
    lines.push(`\nHOW THEY BUY:`);
    for (const f of n.buyingProcess) lines.push(`- ${f.statement}`);
  }
  if (n.timeline.length) {
    lines.push(`\nTIMING:`);
    for (const f of n.timeline) lines.push(`- ${f.statement}`);
  }
  return lines.join("\n");
}

export async function buildDemoStrategy(args: {
  account: string;
  transcript: string;
  /** The verified narrative. Passing the raw transcript alone loses the ranking. */
  narrative: Narrative;
}): Promise<PassResult<DemoStrategy>> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { status: "unavailable", reason: "ANTHROPIC_API_KEY is not set" };
  }

  let text: string;
  try {
    const resp = await getAnthropicClient().messages.create({
      model: getAnthropicModel(),
      max_tokens: 4000,
      // Zero, unlike the narrative.
      //
      // The narrative is anchored: every fact carries a quote that is verified
      // against the transcript, so variation there moves prose and not content.
      // The demo strategy has no such anchor. It is pure synthesis, so it is
      // where run-to-run variance concentrated: two runs of the same Dunavant
      // call produced different session structures. This artifact becomes a
      // Salesforce Note a solution engineer builds a demo from, and there
      // stability is worth more than variety.
      temperature: 0,
      system: DEMO_SYSTEM,
      messages: [
        {
          role: "user",
          content: `ACCOUNT: ${args.account}\n\nCALL READOUT:\n${renderNarrativeForDemo(
            args.narrative,
          )}\n\nTRANSCRIPT:\n${args.transcript}\n\nWrite the demo strategy JSON. Return JSON only.`,
        },
      ],
    });
    const block = resp.content.find((b) => b.type === "text");
    text = block && "text" in block ? block.text : "";
  } catch (err) {
    return {
      status: "unavailable",
      reason: `the demo strategy call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const o = parseJsonObject(text);
  if (!o) return { status: "unavailable", reason: "the demo strategy response was not valid JSON" };

  const sessions: DemoSession[] = Array.isArray(o.sessions)
    ? (o.sessions as unknown[]).flatMap((x) => {
        if (!x || typeof x !== "object") return [];
        const s = x as Record<string, unknown>;
        if (typeof s.name !== "string") return [];
        const cover = Array.isArray(s.cover) ? s.cover.filter((c): c is string => typeof c === "string") : [];
        return [
          {
            // The model numbers its own sessions ("Session 1: Customs
            // Compliance") and every renderer also numbers them, which reads as
            // "Session 1: Session 1: ...". Strip the prefix here rather than in
            // one renderer, so the email, the preview and the Salesforce Note
            // cannot disagree about it.
            name: s.name.trim().replace(/^session\s*\d+\s*[:.\-]\s*/i, "").trim(),
            cover,
            why: typeof s.why === "string" ? s.why.trim() : "",
            minutes: typeof s.minutes === "number" && Number.isFinite(s.minutes) ? s.minutes : null,
          },
        ];
      })
    : [];

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()) : [];

  const strategicGoals = strings(o.strategicGoals);
  const validateInternally = strings(o.validateInternally);

  // Absent only when there is nothing at all.
  //
  // This used to key on sessions alone, which threw the whole pass away on any
  // call too narrow to warrant splitting a demo. Two things worth keeping
  // survive that shape: the strategic goals, which are the deck material and
  // exist whether or not a demo needs planning, and validateInternally, which
  // rule 5 calls the most important field in the object. The Protrans call is
  // the case: one reporting mechanism, no sessions to plan, and a genuine
  // contradiction to resolve before the session.
  if (sessions.length === 0 && strategicGoals.length === 0 && validateInternally.length === 0) {
    return {
      status: "absent",
      reason: "the call did not establish goals, sessions or anything to resolve before a demo",
    };
  }

  return {
    status: "present",
    value: {
      strategicGoals,
      interests: strings(o.interests),
      sessions,
      validateInternally,
      risks: strings(o.risks),
      strengths: strings(o.strengths),
      recommendation: typeof o.recommendation === "string" ? o.recommendation.trim() : "",
      positioning: typeof o.positioning === "string" ? o.positioning.trim() : "",
      buildsOnRepPlan: o.buildsOnRepPlan === true,
    },
  };
}
