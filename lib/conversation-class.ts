/**
 * Four separate facts about a meeting, because one flag cannot carry them.
 *
 * `outcome='captured'` means media came back with text in it. It does NOT mean
 * the customer was there. Read in full on 2026-09-13, four of the ten thinnest
 * captured calls are two Magaya employees in an empty room agreeing to
 * reschedule, and one is a single line of a rep talking to somebody in the
 * corridor. CLAUDE.md already records this trap for the recap path ("a no-show
 * has a transcript ... about a thousand characters of nothing"); the recap
 * filters on outcome, the engagement test did not.
 *
 * LENGTH IS THE WRONG INSTRUMENT AND RANKS THEM BACKWARDS. Apexcargo is 759
 * characters and is a real exchange in which the customer hands over his legal
 * entity name and filer code for the proposal. Melek HealthCare is 1537
 * characters of two reps saying the prospect is not answering. Any threshold
 * that admits the second rejects the first.
 *
 * So four questions are asked separately, because they have different answers
 * and different consequences:
 *
 *   meetingOccurred               did it happen at all
 *   customerParticipated          did someone not ours actually speak
 *   contentCaptured               do we hold what was said
 *   substantiveCustomerConversation  was any of it about the business
 *
 * The last one matters because a customer can take a call without the deal
 * moving. Twcustomsbrokers is the customer on the line for a minute of audio
 * checks before ejecting our notetaker. That is participation, and it is not
 * progress, and calling it progress is how a deal reaches Moving on nothing.
 */

import { sideOfSpeaker, type Participant } from "./speaker-match";

/**
 * UNKNOWN IS NOT THE CUSTOMER.
 *
 * The first version of this file tested "not positively ours" and called the
 * result customerParticipated. That is too permissive and it undoes the point
 * of the speaker fix: seven real customers now resolve to UNKNOWN precisely
 * because their identity could not be established, and letting UNKNOWN prove
 * customer participation would hand back the guess that was just removed.
 *
 * So the two questions are asked separately and answered separately:
 *
 *   nonSellerHumanParticipated  somebody who is not ours spoke. UNKNOWN counts.
 *   customerParticipated        somebody GROUNDED to the customer spoke.
 *
 * and the same split runs through substance:
 *
 *   substantiveMeetingConversation   real deal talk happened on this call
 *   substantiveCustomerConversation  real deal talk is attributable to a
 *                                    verified customer-side person
 *
 * An UNKNOWN speaker may establish that a meeting happened and that a real
 * conversation took place. It may never establish a customer commitment, an
 * objection, a preference, an intent, or any buying behaviour, because all of
 * those are claims about a specific party.
 */
export type ConversationClass = {
  meetingOccurred: boolean | null;
  contentCaptured: boolean;
  /** Someone not identifiable as ours spoke. UNKNOWN satisfies this. */
  nonSellerHumanParticipated: boolean | null;
  /** Someone POSITIVELY grounded to the customer spoke. UNKNOWN does not. */
  customerParticipated: boolean | null;
  /** Deal-relevant conversation happened, whoever it is attributable to. */
  substantiveMeetingConversation: boolean | null;
  /** Deal-relevant conversation attributable to a verified customer person. */
  substantiveCustomerConversation: boolean | null;
  /** One of the canonical readings, for a human and for the audit. */
  verdict:
    | "substantive_customer_conversation"
    | "short_but_valid"
    | "substantive_unattributed"
    | "logistics_only"
    | "no_show"
    | "seller_only"
    | "verified_occurrence_no_content"
    | "undecidable";
  reason: string;
  /** Turns by anyone not identifiable as ours (customer OR unknown). */
  nonSellerTurns: number;
  nonSellerWords: number;
  /** Turns by a positively grounded customer person only. */
  customerTurns: number;
  customerWords: number;
};

/** Two sellers in an empty room. Said TO each other, never to a customer. */
const ROOM_CHATTER =
  /(never replied|did ?n.?t respond|not really sure he would join|fingers crossed|the usual five minute|let'?s? not wait|we should wait|reschedule|reprogramar|no me contestaba|vamos a reprogramar|i'?ll give her a call|i'?ll give him a call|look out for the reschedule|they did ?n.?t accept)/i;

/**
 * Turns that move no deal: joining, audio, greetings, and pure scheduling.
 *
 * Used only to decide whether a customer who DID speak said anything of
 * substance. It never decides participation, so a false positive here can
 * downgrade a call to logistics and can never erase the person.
 */
const PLEASANTRY =
  /(good (morning|afternoon|evening)|how are you|how'?s it going|nice to (meet|see) you|likewise|thank you|thanks|no worries|no problem|sorry about that|buenos días|buen día|cómo estás|un abrazo|hablamos)/i;

const AUDIO_OR_JOIN =
  /(can you hear me|you'?re muted|hear me okay|plug into|my airpods|share my screen|connect to them|waiting for|notetaker|transcriber|kick them out|i'?m out)/i;

/**
 * Did anything about the BUSINESS come up, on either side.
 *
 * This is what separates two calls of identical shape. Slade-global and
 * Noventraadvisory are both "the customer turned up and the meeting was
 * postponed", and the customer's own turns in both are pure scheduling. The
 * difference is that Slade-global carries the dependency the deal is actually
 * waiting on, the customer's accounting systems, and Noventraadvisory carries
 * nothing but an apology and a reschedule.
 *
 * Deliberately checked over the WHOLE transcript rather than the customer's
 * share. A short customer turn on a call that had substance still sits on a
 * call that had substance, and demanding the buyer personally utter a product
 * noun would throw away Apexcargo, where the entire value is two lines giving
 * the legal entity name and the filer code.
 *
 * It is a heuristic and it is the weakest thing in this file. It is bilingual
 * because roughly a third of these calls run in Spanish, and it will need
 * extending for a tenant that does not sell freight software.
 */
const BUSINESS_VOCAB =
  /\b(pricing|price|quote|proposal|contract|nda|budget|cost|invoice|licen[cs]e|users?|volume|demo|module|integration|api|warehouse|customs|filer code|abi|isf|bill of lading|freight|shipment|tracking|implementation|go.?live|training|migration|accounting|reporting|sistemas? contables|precio|propuesta|contrato|presupuesto|usuarios?|almac[eé]n|aduana|factura|implementaci[oó]n|capacitaci[oó]n)\b/i;

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Classify one meeting.
 *
 * `outcome` and `captureClass` are the stored verdicts; `transcript` and
 * `participants` are the evidence. Nothing here reads a character count of the
 * whole transcript.
 */
export function classifyConversation(args: {
  outcome: string | null;
  captureClass: string | null;
  transcript: string | null;
  participants: ReadonlyArray<Participant>;
  /** Every seller-domain person seen anywhere, for speaker resolution. */
  directory: ReadonlyArray<Participant>;
}): ConversationClass {
  const body = String(args.transcript ?? "");
  const contentCaptured = body.trim().length > 0;
  const none = { nonSellerTurns: 0, nonSellerWords: 0, customerTurns: 0, customerWords: 0 };

  if (!contentCaptured) {
    // No text. Occurrence is decided by the capture classifier alone: a refusal
    // means a human denied our bot, so the meeting ran. A lobby timeout is
    // undecidable and always will be, because a bot outside the room cannot see
    // whether anyone is inside it.
    if (args.captureClass === "lobby_refused") {
      return { meetingOccurred: true, contentCaptured: false, nonSellerHumanParticipated: null,
        customerParticipated: null, substantiveMeetingConversation: null,
        substantiveCustomerConversation: null, verdict: "verified_occurrence_no_content",
        reason: "a human denied the bot entry, so the meeting was running; no content was captured", ...none };
    }
    if (args.outcome === "no_show" || args.outcome === "no_conversation") {
      return { meetingOccurred: false, contentCaptured: false, nonSellerHumanParticipated: false,
        customerParticipated: false, substantiveMeetingConversation: false,
        substantiveCustomerConversation: false, verdict: "no_show", reason: `outcome ${args.outcome}`, ...none };
    }
    return { meetingOccurred: null, contentCaptured: false, nonSellerHumanParticipated: null,
      customerParticipated: null, substantiveMeetingConversation: null,
      substantiveCustomerConversation: null, verdict: "undecidable",
      reason: `no transcript and capture_class=${args.captureClass ?? "null"}`, ...none };
  }

  // Split into turns and resolve each speaker's side from the roster.
  const turns: Array<{ who: string; text: string }> = [];
  for (const line of body.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    turns.push({ who: line.slice(0, i).trim(), text: line.slice(i + 1).trim() });
  }
  // NOT-OURS rather than positively-customer. A customer is frequently on the
  // invite as a bare address with no display name, so there is nothing for the
  // matcher to match and a positive test reports them absent. Absence of a
  // match is not absence of a person.
  const side = (who: string) => sideOfSpeaker(args.participants, who, args.directory);
  const nonSeller = turns.filter((t) => side(t.who) !== "seller");
  // GROUNDED, not merely not-ours. This is the whole distinction.
  const grounded = turns.filter((t) => side(t.who) === "customer");
  const nonSellerTurns = nonSeller.length;
  const nonSellerWords = nonSeller.reduce((n, t) => n + words(t.text), 0);
  const customerTurns = grounded.length;
  const customerWords = grounded.reduce((n, t) => n + words(t.text), 0);
  const count = { nonSellerTurns, nonSellerWords, customerTurns, customerWords };

  if (nonSellerTurns === 0) {
    const chatter = ROOM_CHATTER.test(body);
    return { meetingOccurred: chatter ? false : null, contentCaptured: true,
      nonSellerHumanParticipated: false, customerParticipated: false,
      substantiveMeetingConversation: false, substantiveCustomerConversation: false,
      verdict: chatter ? "no_show" : "seller_only",
      reason: chatter
        ? "only our own people spoke, and they discuss the customer not turning up"
        : "only our own people spoke; whether the customer was present is not established",
      ...count };
  }

  // The customer spoke. Was any of it about the business?
  // A turn is substance if it is long enough to carry any, is not about the
  // audio or the notetaker, and is not a pleasantry. The pleasantry test is
  // LENGTH-GATED: "Good. How are you?" is nothing, but a long turn that happens
  // to contain "thank you" is still a real answer, and banning the phrase
  // outright would delete it.
  const isContent = (t: { text: string }) => {
    const w = words(t.text);
    if (w < 4) return false;
    if (AUDIO_OR_JOIN.test(t.text)) return false;   // specific enough to apply at any length
    return w >= 12 || !PLEASANTRY.test(t.text);
  };
  const substantive = nonSeller.filter(isContent);
  const substantiveGrounded = grounded.filter(isContent);
  // TWO TURNS AND TWELVE WORDS, not one turn.
  //
  // Single-turn thresholds cannot separate these calls, and chasing each
  // fragment with another regex is how a classifier becomes unmaintainable and
  // still wrong. Twcustomsbrokers leaves exactly one stray fragment ("I wonder.
  // That's weird") once the audio chatter is removed, and Apexcargo leaves two
  // turns totalling fourteen words which contain the legal entity name and the
  // filer code. Requiring a small amount of SUSTAINED customer content
  // separates them where a per-turn rule does not.
  const substantiveWords = substantive.reduce((n, t) => n + words(t.text), 0);
  const groundedWords = substantiveGrounded.reduce((n, t) => n + words(t.text), 0);
  const businessDiscussed = BUSINESS_VOCAB.test(body);
  const real = substantive.length >= 2 && substantiveWords >= 12 && businessDiscussed;
  const realGrounded = substantiveGrounded.length >= 2 && groundedWords >= 12 && businessDiscussed;
  if (!real) {
    return { meetingOccurred: true, contentCaptured: true,
      nonSellerHumanParticipated: true, customerParticipated: customerTurns > 0,
      substantiveMeetingConversation: false, substantiveCustomerConversation: false,
      verdict: "logistics_only",
      reason: businessDiscussed
        ? `the customer spoke, but only greetings, audio checks or scheduling (${substantive.length} content turn(s), ${substantiveWords} words)`
        : `the customer spoke, but nothing about the business came up on either side (${substantive.length} content turn(s), ${substantiveWords} words)`,
      ...count };
  }

  // A real conversation happened. Whether it is attributable to the CUSTOMER is
  // a second question, and an unattributed one is reported as such rather than
  // promoted.
  if (!realGrounded) {
    return { meetingOccurred: true, contentCaptured: true,
      nonSellerHumanParticipated: true, customerParticipated: customerTurns > 0,
      substantiveMeetingConversation: true, substantiveCustomerConversation: false,
      verdict: "substantive_unattributed",
      reason: `a real conversation took place, but no speaker could be grounded to the customer (${substantive.length} content turn(s) from unidentified speakers)`,
      ...count };
  }
  return { meetingOccurred: true, contentCaptured: true,
    nonSellerHumanParticipated: true, customerParticipated: true,
    substantiveMeetingConversation: true, substantiveCustomerConversation: true,
    verdict: substantiveGrounded.length <= 3 ? "short_but_valid" : "substantive_customer_conversation",
    reason: `${substantiveGrounded.length} grounded customer turn(s) carrying content, ${customerWords} customer words`,
    ...count };
}
