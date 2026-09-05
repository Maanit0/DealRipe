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
  /**
   * What is going wrong in their operation today, with the mechanics.
   *
   * Folded into strategicGoals until 2026-09-04, and that was the bug. With
   * nothing holding the concrete detail, the goals drifted into the seller's
   * voice: Impexx came back with "Capture value beyond entry filing" and
   * "Act before the schedule closes", neither of which is a thing the customer
   * wants. Two of Eduardo's three documents carry both sections separately
   * (Kestrel has Current Systems & Pain Points then Customer Priorities, ABC
   * has Current State / Pain Points then What They're Asking For), so the
   * split is his structure rather than an invention.
   */
  painPoints: string[];
  /** What they are trying to achieve, in their own voice. */
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
1a. NO MARKDOWN IN ANY VALUE. No asterisks, no underscores, no backticks, no hash headings. The reader's software owns every visual decision including which part is bold. Emphasis you type yourself arrives on the page as literal punctuation.
2. Ground everything in what the customer said. Do not invent requirements, numbers or people.
2b. IF YOU HAVE TO HEDGE IT, DELETE IT. A pain reading 'suggests entries are completed outside business hours, though not stated in those exact words' is you telling the reader you made it up, and it happened because a real pain from a different account got borrowed and applied where no evidence existed. Never write 'suggests', 'presumably', 'implies', 'can be inferred' or 'not stated in those words' about a fact concerning this customer. Either they said it and you quote it, or it is not in the document. This does not apply to the section on what to resolve before the demo, where 'nobody confirmed this' is the whole point.
2a. NAME THE CUSTOMER IN PROSE, NEVER OUR OWN SIDE. Customer names carry information the reader needs: which stakeholder said it tells them who to convince. A Magaya name inside a sentence does not, and on anything unresolved it reads as blame on a colleague the reader has to work with. State the thing itself instead: "The AI ingestion tool does not connect to the prior notice form", not "Alexandra confirmed the AI does not connect to the prior notice form". Where the reader genuinely needs to know which of our people to go to, put the name in parentheses at the END of the item: "(Steven)". The "ourTeam" field is the roster and is where our names belong.
3. RANK BY REPETITION. A pain raised on three calls outranks one raised once, and saying so is the point of being given every call. Where a pain recurred, the goal it becomes goes higher.
4. If the rep already proposed a demo plan, ADOPT their structure and improve it rather than inventing a competing one. Set buildsOnRepPlan true when you did.
5. Order sessions by what the customer weighted, never by our product's natural order.
6. "validateInternally" is REQUIRED and is the most important field. Anything the customer asked for where our answer was uncertain, hedged or negative, and which must be resolved BEFORE the session. An empty array asserts we checked and found none.
6a. EACH "validateInternally" ITEM IS "The open question: what was actually said, then who resolves it and before which session." Two sentences at most. Naming the session is the deadline, and without it the item is a worry rather than a task. Quote the hedge itself if there was one, because whoever resolves it needs to know how far we already went in front of the customer, but quote it without naming who said it and put that name in parentheses at the end.
7. "skip" is what NOT to demo and why, in the customer's own terms. A demo that goes wide lands soft. If they told you something is not a priority, or asked about something "just in case", it belongs here rather than in a session.
7a. EACH "skip" ITEM IS "The thing: why, then what to do instead." The reader scans the thing and must finish the line knowing the action, so end every item with the directive: "do not spend demo time on it", "mention it exists and move on", "show partial pallet release instead", "skip unless they ask for it". An item that gives only a reason leaves the reader deciding, which is the decision this document exists to make for them. A SKIP ITEM NEVER ALSO APPEARS AS A COVER BULLET. Now that skip items end in a directive, the directive is the whole item and it reads identically to a session bullet, so the temptation is to put it in both. Do not. "Mention air AMS exists and move on" belongs under skip once, and the reader meets it there.
8. "strategicGoals" REFRAMES the ranked pains as initiatives the customer would fund, in their language. A pain describes what is broken ("manual re-keying across seven disconnected systems"); a goal names what they are trying to achieve ("Consolidate onto fewer, standardized systems"). Never copy a pain across unchanged.
8a. WRITE EACH ONE AS "Short label: the evidence". The label is the goal itself in SIX WORDS OR FEWER, and two to four is the target and it is what a reader scans, so make it carry the meaning alone: "Replace CargoWise at materially lower cost", "Move fast", "Make one vendor decision where possible". After the colon give the evidence a reader can check: who said it, the number they gave, the phrase they used. A goal with no evidence behind it is an assertion, and a goal that is one long compound sentence cannot be scanned. "Achieve customs sophistication sufficient for their FTZ and high-volume entry workflows" is twelve words and fails; "Match or exceed CargoWise customs sophistication" is six and works; "Move fast" is two and works best. This label gets set in bold and is what a reader scans and what ends up on a slide, so pick the shortest phrase that still tells this goal apart from the others. Put the qualifiers after the colon.
8b. ORDER BY WHAT THEY WEIGHTED, and the first goal is the one they named as the primary driver. If someone said price is the number one reason they are moving, price is goal one, not goal five. Getting this order wrong misrepresents the deal to the person running the demo.
8c. Include a goal the customer stated even when it is not about product, PROVIDED THEY STATED IT AS SOMETHING THEY WANT. "We want to go live this year" is a goal. "He will be busier in two to three weeks" is a fact about our selling window, not a goal, and putting it in this list tells the reader the customer wants to be sold to.
8f. WRITE IT IN THE CUSTOMER'S VOICE, NOT THE SELLER'S. The test is whether they could put the line on their own internal slide without changing a word. These verbs are always the seller talking and may not open a goal: Capture, Support, Position, Prove, Demonstrate, Show, Win, Convert, Address, Enable, Deliver, Leverage, Drive. "Capture value beyond entry filing" is our sales objective; theirs is "Get more from the platform than we already have". "Support the tiered retainer billing model" is what WE would do; theirs is "Bill retainer tiers without counting entries by hand".
8g. A GOAL IS SOMETHING BROKEN THEY WANT FIXED, NOT A REASON WE THINK THEY WILL BUY. A trigger for looking, a deal timing window, a switching objection and a budget constraint are all real and none of them is a strategic goal. They belong in the objective, the risks, the pricing signals or an additional section. Concretely: "Stay ahead before the incumbent becomes a liability" is NOT a goal, it is why they took the call, and a giveaway is that its own evidence has to explain that the trigger is proactive rather than a crisis. If you find yourself writing that sentence, the entry belongs somewhere else. Test every goal by naming the manual work, the cost, the risk or the lost hours behind it. If you cannot, it is not a goal.
8h. PREFER MECHANICS TO CATEGORIES. The strongest goal in any of these documents is the one where the customer described exactly what they do by hand. "Stop tracking ISF due dates in Trello alongside the filing system" beats "Consolidate onto a single system", and it beats it because a solution engineer knows what to open.
8d. ONE IDEA PER GOAL. Never merge two things the customer named separately. "Go live this year on a single vendor if possible" is two goals wearing one label, a timeline and a vendor-consolidation preference, and merging them hides both and strands their evidence. Split them and give each its own line.
8e. DO NOT FOLD A SPECIFIC GOAL INTO A CATEGORY GOAL, above all where the customer is already solving it themselves. If they described building, buying or hand-running a workaround, that is the work they most want taken off their hands and it is the sharpest goal in the document. "Eliminate manual PGA and data-conversion work" inside "Achieve customs sophistication" disappears. Give it its own line.
8i. "painPoints" USES THE SAME "Short label: the detail" SHAPE AS THE GOALS, same six word cap on the label, same bold treatment when it renders. It IS WHAT IS GOING WRONG TODAY, WITH THE MECHANICS IN IT, and it is ranked the same way the goals are. A pain describes what they have to do by hand, what breaks, what it costs, or what they cannot see. "Customs sophistication is a decision driver" is a CATEGORY and belongs nowhere near this list. "Evening entry work: the day is consumed by customer advisory work and vendor coordination, so entries get done at night" is a pain. "Invalid FDA product codes: NetCHB's generator produces codes that do not validate" is another. Quote or paraphrase them closely; this is the section where their own words matter most.
8j. PAINS AND GOALS ARE DIFFERENT SECTIONS AND MUST NOT RESTATE EACH OTHER. The pain is the mechanics of what is broken; the goal is what they are trying to achieve. One line each, and the goal does not repeat the pain's detail. If a goal has no pain under it, the customer named an aspiration and that is fine; if a pain has no goal above it, say the pain and leave it. A pain labelled 'Match CargoWise NEO portal' sitting under a goal labelled 'Match CargoWise NEO portal for customers' is one idea printed twice, and the pain has done no work: the pain there is that customers rely on a portal owned by the vendor being replaced. A LABEL THAT WOULD READ CORRECTLY IN EITHER SECTION IS IN THE WRONG ONE. THE PAIN LABEL NAMES THE MECHANIC, NOT THE TOPIC. Two real failures to avoid: a pain labelled "Manual PGA and unit-conversion work" under a goal labelled "Eliminate manual PGA and unit-conversion work" is the same phrase with a verb bolted on, and the pain should be "PGA units recalculated on every entry". A pain labelled "Customers love CargoWise NEO portal" under a goal labelled "Match CargoWise NEO portal for customers" is the same again, and the pain there is "Portal customers rely on belongs to CargoWise". Strip the topic from the pain label and ask what is actually going wrong.
9. "interests" is appetite with NO pain behind it: curiosity, a "just in case" ask, something they leaned toward because we showed it. Keep these OUT of strategicGoals. Empty array when there are none.
10. "volumes" is hard numbers only, as stated by the customer. Users, transactions per month, shipments, dockets, offices, containers. If they did not give a number, do not estimate one.
11. "competitive" names who we are measured against and the bar that sets. If they love an incumbent's feature, the demo must show parity or better on it, not just coverage. Empty array if no competitor was named.
12. "attendees" is who on the CUSTOMER side has appeared and what each CONTROLS: budget, the technical decision, the evaluation, day to day operations. Not a contact list. Include a stakeholder who has not appeared yet if the calls say they gate a decision.
12a. "ourTeam" is the Magaya people who appeared, with what each of them answered on. The reader was on none of these calls and needs to know who to ask.
12b. "pricingSignals" is everything said about money, marked as directional. Numbers quoted, ranges, comparisons to what they pay today, and whether the customer has asked for pricing or been given it. Empty array if money never came up.
12c. NEVER NAME A FIELD OF THIS DOCUMENT IN ITS OWN PROSE. "Resolve all three validateInternally items before the session" leaked our JSON key into copy a solution engineer reads. Refer to a section by the heading the reader sees, or better, restate the thing itself. The reader has never seen this schema and never will.
13. No praise, no marketing language, no adjectives about our own product.
13a. EVERY FACT APPEARS ONCE. If a module belongs in "skip", do not also mention it inside a session. If a gap is in "validateInternally", do not restate it as a risk unless the risk is a different consequence. Repetition is the main reason a document like this stops being read, and a reader who meets the same sentence twice stops trusting the rest.
13b. BE TERSE. A bullet is one sentence. A session "why" is at most two, and names the evidence rather than narrating the call. Do not open a bullet with scene setting ("This is the session Debra warned about"); state the thing. Cut every word that does not change what the reader does.
13c. Completeness beats brevity where they conflict. Never drop a real finding to be short. Drop the words around it instead.
14. Name each session for what it covers. Do not prefix with "Session 1"; the reader's software numbers them.
14a. "objective" is ONE sentence naming what this demo has to achieve for the deal to advance. Not a summary of the sessions. On a deal where a gate exists, name the gate.
14b. EVERY "cover" BULLET OPENS WITH A VERB SAYING WHAT TO DO WITH IT. The solution engineer is reading instructions, not a table of contents, and a noun phrase leaves them guessing whether to demo it live, mention it in passing, or ask a question about it. "Entry types in scope: formal entries, ISF, in-bond, FTZ" is a heading. "Live demo the full entry set they file: formal entries, ISF, in-bond, FTZ receipt and transfer" is an instruction. Lead with the verb, never bury it: "The FTZ workflow should be demonstrated" is backwards.
14c. CHOOSE THE VERB BY WHAT THE EVIDENCE SUPPORTS. Something confirmed that we can show gets "Live demo" or "Walk". Something the customer was emphatic about gets "Lead with". A known gap, a limit or a roadmap item gets "Be transparent about" or "Acknowledge". Something they mentioned once and deprioritized gets "Mention only" or "Do not dwell on". Something we have not verified gets "Confirm", and if we have not verified it internally either it belongs in validateInternally as well. Other verbs are fine where they fit: Show, Demonstrate, Ask, Close, Compare, Bring. Do not attach a confident verb to an unconfirmed capability; that is how a hedge reaches a customer.
14d. A CAPABILITY LISTED IN "validateInternally" MAY NOT CARRY A CONFIDENT VERB IN A SESSION. If you are asking someone to confirm a thing exists before the session runs, its cover bullet says "Confirm and then show" or "Confirm before committing to show", never a bare "Show" or "Live demo". The same person reads both fields, and a bullet promising to demo what the next section calls unverified is exactly how a hedge reaches the customer. Check every cover bullet against validateInternally before you emit it.
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
  "painPoints": [string],
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

/**
 * Strip markdown emphasis the model was never asked for.
 *
 * Telling the prompt a label "gets set in bold" produced literal
 * "**ISF due-date tracking in Trello:**" in the value. The renderer already
 * bolds the label, so this rendered the asterisks and double-emphasised the
 * text. Worse and much quieter: splitGoal looks for ": " and the markdown makes
 * it ":** ", so every label parsed as having no label at all and the six word
 * cap was skipped on all eleven of them without a word in the log.
 */
const stripMd = (s: string): string =>
  s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").trim();

const strArr = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.flatMap((x) => (typeof x === "string" && x.trim() ? [stripMd(x)] : []))
    : [];

const GOAL_LABEL_MAX_WORDS = 6;

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

function splitGoal(g: string): { label: string; evidence: string } | null {
  const i = g.indexOf(": ");
  return i > 0 ? { label: g.slice(0, i), evidence: g.slice(i + 2) } : null;
}

/**
 * Enforce the eight word cap on a goal's label.
 *
 * Rule 8a asks for it and the model ignores it on the goals that are hardest to
 * compress, which are the ones that most need it: three of seven labels came
 * back over the cap on the second attempt. The label is what a reader scans, so
 * a twelve word compound sentence there defeats the section.
 *
 * A repair rather than a full regeneration, because the whole document costs
 * two minutes and only the labels are wrong. Only the offending labels are sent
 * and only a label comes back. The evidence half is never sent for rewriting
 * and is re-attached here from the original string, so this cannot silently
 * alter a fact.
 *
 * Fails open. A goal with a long label is worse than one with a short label and
 * far better than no goal, so anything unexpected keeps the original.
 */
async function shortenGoalLabels(goals: string[], kind = "goal", attempt = 1): Promise<string[]> {
  // Two failures, one repair. A label over the cap has to be shortened; an item
  // with no "label: detail" shape at all has to be given one. The second case
  // was invisible until lintDemoStrategy caught it on Kestrel, because
  // splitGoal returns null there and a filter looking only for "too long"
  // skipped it in silence.
  const over = goals.flatMap((g, i) => {
    const parts = splitGoal(g);
    if (!parts) return [{ i, parts: { label: g, evidence: g }, missing: true }];
    return wordCount(parts.label) > GOAL_LABEL_MAX_WORDS ? [{ i, parts, missing: false }] : [];
  });
  if (over.length === 0) return goals;

  const ask =
    `Each numbered line is a customer ${kind}. Give each one a short label a reader can scan.\n` +
    `The label is ${GOAL_LABEL_MAX_WORDS} words or fewer and two to four is the target. It must carry the meaning ` +
    `alone, because it is what gets set in bold and what reaches a slide. Keep the customer's own vocabulary. ` +
    `Drop qualifiers, examples and lists; the sentence that follows the label already carries them. ` +
    `Return the label ONLY, never the sentence, and no punctuation on the end.\n` +
    `No markdown and no asterisks. No em-dashes or en-dashes. ` +
    `Return JSON only, no prose: {"labels": [string]} in the same order and the same count.\n\n` +
    over.map((x, n) => `${n + 1}. ${x.missing ? x.parts.evidence : x.parts.label}`).join("\n");

  let out: string[] = [];
  try {
    const res = await getAnthropicClient().messages.create({
      model: getAnthropicModel(),
      max_tokens: 700,
      temperature: 0,
      messages: [{ role: "user", content: ask }],
    });
    const o = parseObj(res.content.map((c) => ("text" in c ? c.text : "")).join(""));
    out = strArr(o?.labels);
  } catch (err) {
    console.warn(`[label-repair] ${kind} attempt ${attempt}: call failed:`, err instanceof Error ? err.message : err);
    return goals;
  }
  if (out.length !== over.length) {
    console.warn(`[label-repair] ${kind} attempt ${attempt}: asked for ${over.length} labels, got ${out.length}`);
    return goals;
  }

  const fixed = [...goals];
  over.forEach((x, n) => {
    const label = stripMd(out[n]).replace(/[.:]+$/, "").trim();
    // Accept only a label within the cap. Where the label was merely too long,
    // also require the rewrite to be genuinely shorter: a model returning its
    // input has solved nothing, and the original at least reads as written
    // prose. Where there was no label the bar is the cap alone, since there is
    // nothing to be shorter than.
    if (!label || wordCount(label) > GOAL_LABEL_MAX_WORDS) {
      console.warn(`[label-repair] ${kind} attempt ${attempt}: rejected "${label}" (${wordCount(label)}w)`);
      return;
    }
    if (!x.missing && wordCount(label) >= wordCount(x.parts.label)) {
      console.warn(`[label-repair] ${kind} attempt ${attempt}: not shorter, kept "${x.parts.label}"`);
      return;
    }
    fixed[x.i] = `${label}: ${x.parts.evidence}`;
  });

  // One retry over whatever is still over the cap. Failing open on the first
  // miss left an eight word label on a shipped Dunavant document, and a single
  // extra small call is far cheaper than the two minutes a full regeneration
  // costs. Bounded at two attempts so a label that genuinely cannot be
  // compressed does not loop.
  if (attempt < 2 && fixed.some((g) => { const p = splitGoal(g); return !p || wordCount(p.label) > GOAL_LABEL_MAX_WORDS; })) {
    return shortenGoalLabels(fixed, kind, attempt + 1);
  }
  return fixed;
}

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
          for (const k of [a, b, ...(c ? [c] : [])]) out[k] = typeof r[k] === "string" ? stripMd(r[k] as string) : "";
          return out[a] ? [out] : [];
        })
      : [];

  const [painPoints, strategicGoals] = await Promise.all([
    shortenGoalLabels(strArr(o.painPoints), "pain point"),
    shortenGoalLabels(strArr(o.strategicGoals), "goal"),
  ]);

  return {
    status: "ok",
    sources: material.counts,
    doc: {
      objective: typeof o.objective === "string" ? stripMd(o.objective) : "",
      attendees: pairs(o.attendees, "name", "role", "controls") as DemoStrategyDoc["attendees"],
      ourTeam: pairs(o.ourTeam, "name", "role") as DemoStrategyDoc["ourTeam"],
      pricingSignals: strArr(o.pricingSignals),
      companyOverview: strArr(o.companyOverview),
      volumes: pairs(o.volumes, "label", "value") as DemoStrategyDoc["volumes"],
      systemLandscape: pairs(o.systemLandscape, "area", "current", "note") as DemoStrategyDoc["systemLandscape"],
      painPoints,
      strategicGoals,
      interests: strArr(o.interests),
      competitive: strArr(o.competitive),
      sessions,
      skip: strArr(o.skip),
      validateInternally: strArr(o.validateInternally),
      risks: strArr(o.risks),
      strengths: strArr(o.strengths),
      recommendation: typeof o.recommendation === "string" ? stripMd(o.recommendation) : "",
      positioning: typeof o.positioning === "string" ? stripMd(o.positioning) : "",
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
  block("PAIN POINTS", d.painPoints.map((x) => `- ${x}`));
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
