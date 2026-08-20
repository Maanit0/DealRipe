/**
 * Meeting-type classification + non-sales recap.
 *
 * DealRipe auto-joins every meeting a rep is invited to, so not every captured
 * call is a new-opportunity sales call. Eduardo's feedback: a customer or
 * internal meeting still deserves a recap, but the sales-qualification framing
 * (captured gates / still-open gates) is the wrong shape for it. This module
 * classifies the meeting and, for non-sales meetings, produces a plain
 * takeaways + next-steps recap instead.
 *
 * Both calls fail soft: on any error the caller falls back to the existing
 * sales recap, so a classification hiccup never blocks a rep's recap.
 */

import { runModel } from "./model-run";

export type MeetingType = "new_opportunity" | "existing_customer" | "internal";

/**
 * Subjects that mean the deal is already won and this is delivery work.
 *
 * The tracked-opportunity tiebreaker below forces any customer-facing call on an
 * open CRM opportunity to be a sales call. That rule is right for a deep demo
 * that superficially reads as support, and wrong for these: EWI is a paying
 * customer in onboarding whose Rolldog opportunity 81491 is still open, so the
 * tiebreaker classified "Onboarding & Training" as new_opportunity/discovery and
 * counted a delivery session as pipeline in the CRO's digest. EWI is also the
 * account that previously produced a briefing telling a paying customer Magaya
 * was not their selected vendor, so it has been misread in this direction before.
 *
 * Exported and used by BOTH the pre-call prediction and the post-call
 * classifier. Two copies of this list would eventually disagree, and then the
 * prediction and the record would say different things about the same meeting.
 */
export function looksPostSigning(subject: string | null | undefined): boolean {
  const s = (subject ?? "").toLowerCase();
  if (!s) return false;
  // "Kickoff Meeting Intro" with a prospect is discovery, so "kickoff" alone is
  // not enough. It counts only alongside a delivery word.
  const delivery = /\bonboard(ing)?\b|\btraining\b|\bimplementation\b|\bgo[- ]live\b|\bhandoff\b|\bhand[- ]over\b|\bpost[- ]sale\b/.test(s);
  const kickoffDelivery = /\bkick[- ]?off\b/.test(s) && /\bimplementation\b|\bproject\b|\bonboard|\btraining\b/.test(s);
  return delivery || kickoffDelivery;
}

const MAX_CHARS = 14000; // enough signal for classification/summary, keeps cost low

/**
 * Classify a call transcript. Defaults to "new_opportunity" on any failure.
 *
 * `trackedOpportunity` is the deal-context tiebreaker: when the deal is an active,
 * open sales opportunity in the CRM (it has a Rolldog opportunity), any
 * customer-facing call on it is a sales call, never an existing-customer support
 * call, no matter how much a deep product demo sounds like one. Without that
 * signal a transcript-only read misclassifies expansion/analytics demos as
 * existing-customer meetings and drops the deal out of the pipeline.
 */
export async function classifyMeetingType(
  transcript: string,
  opts?: { trackedOpportunity?: boolean; subject?: string | null },
): Promise<MeetingType> {
  if (!process.env.ANTHROPIC_API_KEY || transcript.trim().length < 50) return "new_opportunity";
  // An onboarding or training session is delivery work even when the CRM
  // opportunity is still open, so the tiebreaker must stand down. Without this
  // the classifier cannot ever answer existing_customer for a tracked deal, and
  // a customer in implementation stays in the pipeline forever.
  const tracked = opts?.trackedOpportunity === true && !looksPostSigning(opts?.subject);
  const system = tracked
    ? `Classify a B2B call transcript for a deal that is a TRACKED, OPEN sales opportunity in the CRM. Because this deal is an active opportunity being sold, a call with the customer is a SALES call, not an existing-customer support call, even if a deep product demo makes it sound like one. Reply with ONLY the type word, nothing else.
- new_opportunity: a customer or prospect is on the call (discovery, demo, qualification, evaluation, pricing, negotiation). This is the default for any customer-facing call on this deal.
- internal: ONLY the seller's own team is present, with no customer or prospect voice at all.
Do NOT answer existing_customer for this deal.`
    : `Classify a B2B call transcript into exactly one type. Reply with ONLY the type word, nothing else.
- new_opportunity: a sales call with a prospect or a not-yet-closed deal (discovery, demo, qualification, evaluation, pricing).
- existing_customer: a call with a CURRENT customer already using or implementing the product (support, account management, onboarding, expansion of an already-won deal).
- internal: a call among the seller's own team with no customer/prospect present.`;
  try {
    const resp = await runModel({
      task: "meeting_classify.type",
      maxTokens: 10,
      temperature: 0,
      system,
      messages: [{ role: "user", content: `Transcript:\n\n${transcript.slice(0, MAX_CHARS)}` }],
    });
    const text = resp.message.content.map((b) => (b.type === "text" ? b.text : "")).join("").toLowerCase();
    if (text.includes("internal")) return "internal";
    if (!tracked && text.includes("existing_customer")) return "existing_customer";
    return "new_opportunity";
  } catch (err) {
    // The default stands: callers, the coverage report and the digest all treat
    // meeting_type as non-null, and a null here would ripple further than this
    // pass should. But it must not be silent. A failed classification is stored
    // as "new_opportunity" and is then indistinguishable from a classifier that
    // read the transcript and said so, which matters because join-gate later
    // counts a "new_opportunity" call as positive evidence that a counterparty
    // is commercial. Absence of a classification is not evidence of a sale.
    console.warn(
      `[meeting-classify] classification failed, defaulting to new_opportunity, which is a guess and not a read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "new_opportunity";
  }
}

export type CallSubtype = "discovery" | "demo" | "proposal" | "follow_up" | "customer" | "internal";

const SUBTYPE_LABEL: Record<CallSubtype, string> = {
  discovery: "Discovery",
  demo: "Demo",
  proposal: "Proposal",
  follow_up: "Follow-up",
  customer: "Customer",
  internal: "Internal",
};

export function callSubtypeLabel(s: string | null | undefined): string | null {
  if (!s) return null;
  return SUBTYPE_LABEL[s as CallSubtype] ?? null;
}

/**
 * Finer purpose of a call. Existing-customer and internal meetings map straight
 * from the meeting type; new-opportunity calls are classified from the transcript
 * into discovery / demo / proposal / follow_up so Mark can see what each meeting
 * was about. Defaults to "discovery" for an opportunity call on any failure.
 */
export async function classifyCallSubtype(args: {
  transcript: string;
  meetingType: MeetingType;
}): Promise<CallSubtype> {
  if (args.meetingType === "existing_customer") return "customer";
  if (args.meetingType === "internal") return "internal";
  if (!process.env.ANTHROPIC_API_KEY || args.transcript.trim().length < 50) return "discovery";

  const system = `Classify a B2B sales call's PURPOSE into exactly one label. Reply with ONLY the label word, nothing else.
- discovery: fact-finding about the prospect's operations, needs, and current tools. Early stage, no in-depth product shown.
- demo: a product demonstration or presentation is the main activity.
- proposal: pricing, a proposal/quote, terms, or negotiation is the main activity.
- follow_up: a follow-up or check-in on an already-progressing opportunity (recap, next steps, waiting on the customer), not primarily discovery, demo, or proposal.
Pick the label that best fits what the call was mostly about.`;
  try {
    const resp = await runModel({
      task: "meeting_classify.subtype",
      maxTokens: 10,
      temperature: 0,
      system,
      messages: [{ role: "user", content: `Transcript:\n\n${args.transcript.slice(0, MAX_CHARS)}` }],
    });
    const text = resp.message.content.map((b) => (b.type === "text" ? b.text : "")).join("").toLowerCase();
    if (text.includes("demo")) return "demo";
    if (text.includes("proposal")) return "proposal";
    if (text.includes("follow")) return "follow_up";
    return "discovery";
  } catch (err) {
    // transcript-sync wraps this call in `.catch(() => null)`, intending to
    // store null when the subtype is unknown. That catch can never fire while
    // this one returns a value, so a failure is stored as "discovery" instead.
    // Leaving the default in place (changing it would change what lands in the
    // calls row) but saying so, because "discovery" on a signed-contract call
    // is the kind of wrong that reads as a product that is not paying attention.
    console.warn(
      `[meeting-classify] subtype classification failed, defaulting to discovery, which is a guess and not a read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "discovery";
  }
}

export type GeneralRecap = {
  summary: string;
  takeaways: string[];
  nextSteps: string[];
};

/**
 * Produce a plain recap for a non-sales meeting: what it was about, the key
 * takeaways, and concrete next steps with owners where stated. No qualification
 * framing. Returns null on failure so the caller can fall back.
 */
export async function generateGeneralRecap(args: {
  account: string;
  transcript: string;
}): Promise<GeneralRecap | null> {
  if (!process.env.ANTHROPIC_API_KEY || args.transcript.trim().length < 50) return null;
  const system = `You recap a call for the rep who was on it (or invited). This is NOT a sales-qualification call, so do NOT use budget/authority/close-plan framing. Return ONLY JSON:
{
  "summary": string,        // 2-3 sentences: what this call was about
  "takeaways": string[],    // 3-6 key points that were discussed or decided
  "nextSteps": string[]     // concrete next steps, each naming the owner if stated (e.g. "Erika to send the list of 3 members needing API access")
}
Ground everything strictly in the transcript. If there are no clear next steps, return an empty array for nextSteps.`;
  try {
    const resp = await runModel({
      task: "meeting_classify.detail",
      maxTokens: 1200,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: `Account: ${args.account}\n\nTranscript:\n\n${args.transcript.slice(0, MAX_CHARS)}` }],
    });
    const text = resp.message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      takeaways: arr(parsed.takeaways),
      nextSteps: arr(parsed.nextSteps),
    };
  } catch {
    return null;
  }
}

// ====================================================================
// Pre-call classification
// ====================================================================

/**
 * What kind of meeting is this likely to be, BEFORE it happens?
 *
 * classifyMeetingType and classifyCallSubtype both read a transcript, so
 * nothing can be said about an upcoming call until after it is over. That is
 * fine for storage and wrong for planning: a rep wants to know on Monday that
 * Thursday's "Onboarding & Training" is a customer call and Thursday's "Kickoff
 * Meeting Intro" is discovery, and a check that only answers afterwards cannot
 * tell them.
 *
 * The signals available beforehand are weaker but real: the subject line, who
 * is on the invite, what previous calls on this deal turned out to be, and
 * whether the CRM holds an open opportunity. A human planner uses exactly these
 * and is right most of the time.
 *
 * This returns a PREDICTION and says so. It must never be written to
 * calls.meeting_type. The transcript classifier is the record; this exists to
 * be read by a person, and storing it would make a guess indistinguishable from
 * a read, which is the mistake this codebase keeps paying for.
 */
export type PredictedMeeting = {
  meetingType: MeetingType;
  callSubtype: CallSubtype;
  /** How much the signals actually supported this, for a human to weigh. */
  confidence: "high" | "medium" | "low";
  /** Plain sentence naming what drove it, so a wrong call is debuggable. */
  basis: string;
  /** True when the model was not consulted and this is rule-only. */
  heuristicOnly: boolean;
};

export type PredictUpcomingInput = {
  subject: string | null;
  /** Everyone on the invite, seller and customer alike. */
  attendeeEmails: ReadonlyArray<string>;
  sellerDomain: string;
  /** Subtypes of previous captured calls on this deal, newest first. */
  priorSubtypes: ReadonlyArray<string>;
  /** Stage from the CRM or the deal row, when known. */
  stageKey: string | null;
  /** The deal has an open CRM opportunity. Same tiebreaker as the post-call path. */
  trackedOpportunity: boolean;
};

export async function predictUpcomingMeeting(
  input: PredictUpcomingInput,
): Promise<PredictedMeeting> {
  const subject = (input.subject ?? "").trim();
  const customerPresent = input.attendeeEmails.some(
    (e) => e.includes("@") && !e.toLowerCase().endsWith(`@${input.sellerDomain}`),
  );

  // No customer on the invite is decisive on its own and needs no model call.
  if (!customerPresent && input.attendeeEmails.length > 0) {
    return {
      meetingType: "internal",
      callSubtype: "internal",
      confidence: "high",
      basis: "no external attendee on the invite",
      heuristicOnly: true,
    };
  }

  if (!process.env.ANTHROPIC_API_KEY || subject.length < 3) {
    return {
      meetingType: "new_opportunity",
      callSubtype: "discovery",
      confidence: "low",
      basis: subject.length < 3 ? "no usable subject line" : "no model available, defaulted",
      heuristicOnly: true,
    };
  }

  const system = `You predict what a B2B sales meeting will be, from its invitation. You do NOT have a transcript. Reply with ONLY two words separated by a slash: <type>/<subtype>.

type is one of:
- new_opportunity: a prospect or an open, not-yet-won deal. Discovery, demo, evaluation, pricing, negotiation.
- existing_customer: a company already using or implementing the product. Onboarding, training, kickoff after signing, support, account management.
- internal: only the seller's own people.

subtype is one of:
- discovery: fact finding, first conversations, introductions.
- demo: a product demonstration is the main event.
- proposal: pricing, quote, terms, contract or negotiation is the main event.
- follow_up: a check in on something already in motion.
- customer: use this whenever type is existing_customer.
- internal: use this whenever type is internal.

Judge from the wording of the subject and the context given. "Kickoff" after a signed deal is existing_customer/customer; "Kickoff Meeting Intro" with a prospect is new_opportunity/discovery. "Onboarding" and "Training" are existing_customer/customer. Weigh the prior calls heavily: a deal whose last call was a proposal is not back at discovery.`;

  const context = [
    `Subject: ${subject}`,
    `External attendees present: ${customerPresent ? "yes" : "no"}`,
    input.stageKey ? `CRM stage: ${input.stageKey}` : null,
    input.priorSubtypes.length > 0
      ? `Previous calls on this deal, newest first: ${input.priorSubtypes.join(", ")}`
      : `No previous captured calls on this deal.`,
    input.trackedOpportunity
      ? `This deal is an OPEN, TRACKED sales opportunity in the CRM.`
      : `This deal has no open opportunity in the CRM.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const resp = await runModel({
      task: "meeting_classify.d",
      maxTokens: 12,
      temperature: 0,
      system,
      messages: [{ role: "user", content: context }],
    });
    const text = resp.message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .toLowerCase();

    let meetingType: MeetingType = "new_opportunity";
    if (text.includes("internal")) meetingType = "internal";
    else if (text.includes("existing_customer")) meetingType = "existing_customer";

    // Apply the SAME tiebreaker the post-call path uses, so the two cannot
    // disagree on the one rule that has already caused a misclassification: an
    // open opportunity means a customer-facing call is a sales call, however
    // much a deep product session sounds like support.
    if (
      meetingType === "existing_customer" &&
      input.trackedOpportunity &&
      !looksPostSigning(input.subject)
    ) {
      meetingType = "new_opportunity";
    }

    let callSubtype: CallSubtype = "discovery";
    if (meetingType === "existing_customer") callSubtype = "customer";
    else if (meetingType === "internal") callSubtype = "internal";
    else if (text.includes("demo")) callSubtype = "demo";
    else if (text.includes("proposal")) callSubtype = "proposal";
    else if (text.includes("follow")) callSubtype = "follow_up";

    // A subject line alone is thin. Prior calls are what make a prediction
    // trustworthy, so say which situation the reader is in.
    const confidence =
      input.priorSubtypes.length > 0 ? "high" : subject.length >= 12 ? "medium" : "low";

    return {
      meetingType,
      callSubtype,
      confidence,
      basis:
        input.priorSubtypes.length > 0
          ? `subject plus ${input.priorSubtypes.length} prior call(s) on this deal`
          : "subject line and invite only, no call history on this deal",
      heuristicOnly: false,
    };
  } catch (err) {
    console.warn(
      `[meeting-classify] pre-call prediction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      meetingType: "new_opportunity",
      callSubtype: "discovery",
      confidence: "low",
      basis: "prediction failed, this is a default and not a read",
      heuristicOnly: true,
    };
  }
}
