/**
 * Magaya best-rep plays.
 *
 * A curated set of how Juan and Eduardo actually ask for each qualification
 * gap, distilled from their real discovery and demo calls (see
 * scripts/rep-playbook.ts). The briefing and post-call prompts pull the plays
 * relevant to a deal's open gaps so DealRipe's guidance sounds like how
 * Magaya's best reps sell, not a generic B2B template.
 *
 * These are CRAFT, not causal win-claims: each play is an example of how the
 * best reps phrase a question or handle a moment, meant to be adapted to the
 * specific customer and attendees, never copied blind. They are curated by
 * hand from real transcripts. When the closed-loop learning lands (outcomes +
 * gate deltas), this is the seam that gets refined automatically; the getters
 * below stay the same.
 *
 * Magaya-only: this module is imported by the Magaya briefing and post-call
 * paths. The topsort / Keelson demo prompts do not use it.
 */

export type PlayCategory =
  | "situation"
  | "why_now"
  | "need_pain"
  | "competition"
  | "budget"
  | "authority"
  | "timeline"
  | "pricing_nda"
  | "gap_ack"
  | "demo"
  | "next_step";

export type Play = {
  category: PlayCategory;
  /** The rep-facing phrasing, close to verbatim from a real call. */
  ask: string;
  /** One short line, rep's eyes only, on why it works. */
  why: string;
};

/**
 * Curated plays. 2-3 per gap category plus the recurring techniques. Phrasings
 * are lightly cleaned from real Juan/Eduardo calls.
 */
const PLAYS: Play[] = [
  // Situation
  {
    category: "situation",
    ask: "Talk to me about your operations right now, the filing types you handle, and, if you're comfortable, the software you use today.",
    why: "Wide-open invitation so they self-select what matters, then drill into specifics.",
  },
  {
    category: "situation",
    ask: "Tell me as much as you can about how you run things today and how you do it.",
    why: "The 'as much as you can' framing signals real curiosity and produces longer, candid answers.",
  },
  // Why now
  {
    category: "why_now",
    ask: "A homegrown system is usually tailored and fine-tuned to you, so what is driving you to replace it now?",
    why: "The embedded assumption forces a real trigger instead of a generic answer.",
  },
  {
    category: "why_now",
    ask: "Do you already have executive approval for this, or are you still at the exploring stage?",
    why: "Binary answer reveals urgency and internal sponsorship in one question.",
  },
  {
    category: "why_now",
    ask: "What's the main motivating factor here? Are you getting your filer code, or are you taking over the business?",
    why: "Two concrete hypotheses let them confirm or correct instead of building an answer; grounded, this confirmed the trigger event.",
  },
  // Need and pain
  {
    category: "need_pain",
    ask: "Do you handle any of this with API or EDI integration, or is there AI built in, or are you keying those lines in by hand?",
    why: "Ending on the manual option makes the pain easy to confirm; it usually gets a yes.",
  },
  {
    category: "need_pain",
    ask: "How many amendments do you run per month on those contracts?",
    why: "Quantifies the pain so there is a number to anchor the proposal on.",
  },
  // Competition
  {
    category: "competition",
    ask: "If you're comfortable sharing, what software are you using today?",
    why: "Appending 'if you're comfortable' lowers resistance and they usually share anyway.",
  },
  {
    category: "competition",
    ask: "Were you affected by the outage the other day, or are you not on that platform?",
    why: "A casual, event-based probe surfaces competitor pain without attacking the competitor.",
  },
  // Budget
  {
    category: "budget",
    ask: "Do you have budget allocated for this, or are you still exploring and would need to create it?",
    why: "Two-option framing reveals whether budget exists or has to be built.",
  },
  {
    category: "budget",
    ask: "For reference, licensing runs about [X] to [Y] per month; I want you to have a ballpark so there are no surprises.",
    why: "Proactive anchoring before they ask surfaces budget reactions early and controls the pricing narrative.",
  },
  // Authority / decision process
  {
    category: "authority",
    ask: "How does procurement usually work when you buy software, and who signs off, the CEO or the procurement manager?",
    why: "Two named roles make it easy to answer and produce the real decision maker.",
  },
  {
    category: "authority",
    ask: "And what is their name?",
    why: "Ask right after the role is confirmed, so you capture the buyer for multi-threading before moving on.",
  },
  {
    category: "authority",
    ask: "Is [economic buyer] able to join us today?",
    why: "Confirms whether the buyer is in the room before investing in a full walkthrough.",
  },
  // Timeline
  {
    category: "timeline",
    ask: "You said you're evaluating now but not ready to implement until year-end, is that right, do I have that correct?",
    why: "Stating the assumption as a question reliably surfaces corrections (one call this flushed out a next-month start).",
  },
  {
    category: "timeline",
    ask: "Is that date to make a decision, or to be live in production?",
    why: "Splits one vague timeline into two milestones and gets a precise answer.",
  },
  {
    category: "timeline",
    ask: "Do you have a target to be live, are customers expecting this by September or October?",
    why: "Offering specific months anchors a real date instead of 'soon'.",
  },
  // Pricing + NDA gate (technique)
  {
    category: "pricing_nda",
    ask: "I can walk you through pricing verbally now; it won't look different in writing, but I can only send the written proposal once we have a mutual NDA signed.",
    why: "Keeps momentum with verbal pricing while the NDA becomes a micro-commitment that advances the deal.",
  },
  // Proactive gap acknowledgment (technique)
  {
    category: "gap_ack",
    ask: "I'll be honest, the domestic side isn't our strongest area; is that a key piece for you? Tell me about it.",
    why: "Naming the gap before they do disarms the objection and produces a candid statement of their real need.",
  },
  {
    category: "gap_ack",
    ask: "From the checklist you sent, we cover about 80% of your needs. There are only two items we don't, and here they are.",
    why: "Naming and right-sizing the gaps before the customer finds them let a demo close with 'it has all the features we hoped for' (gate confirmed: demo completed).",
  },
  // Demo discipline (technique)
  {
    category: "demo",
    ask: "We don't usually demo on the first call; we gather the details first so the demo is built exactly around how you work.",
    why: "Sets the process and earns a prepared, higher-stakes demo.",
  },
  {
    category: "demo",
    ask: "If you have real invoices, 50 or 300 lines, I can run them in the demo so you see how the system ingests your own data.",
    why: "Turns the demo into a proof of concept and raises the stakes for them to show up prepared.",
  },
  // Next step (the systematic gap: both reps leave next steps soft)
  {
    category: "next_step",
    ask: "Let's book the next call right now while we're on the phone, no pressure, and I'll send the invite before we hang up.",
    why: "Locking the date live is the single biggest fix; soft, conditional next steps are the reps' most consistent gap.",
  },
  {
    category: "next_step",
    ask: "If you send the contract by [date], you're live in about 30 days, so live by [date], and billing starts [date].",
    why: "A concrete date-based anchor makes the decision feel real and creates urgency without pressure.",
  },
  {
    category: "next_step",
    ask: "Can we stay on at the end of this call and cover the commercial proposal, so we don't have to book a separate meeting?",
    why: "Redirecting a request for a separate proposal meeting into the current call prevents slippage (gate confirmed: next step).",
  },
];

/**
 * The closing discipline, always surfaced. The playbook's clearest finding is
 * that both reps end most calls with a soft, conditional next step and no
 * locked date, and that the one call where the rep booked the next step live
 * (with a calendar invite before hanging up) was the model to replicate.
 */
export const CLOSING_DISCIPLINE =
  "End with a specific, dated next step, name the action and a concrete date, and book it on the call. Never leave it conditional (no 'if you think it makes sense') and never leave the date for the customer to initiate. If a date truly cannot be locked, assign a named action with a deadline (for example, send the NDA today, confirm by Thursday, so the demo can be booked next week).";

/** Map a gap's label or category text to a PlayCategory. Tolerant substring match. */
export function categoryForLabel(label: string | null | undefined): PlayCategory | null {
  const s = (label ?? "").toLowerCase();
  if (!s) return null;
  if (/budget|price|pricing|cost|invest|fund/.test(s)) return "budget";
  if (/competit|incumbent|alternativ|vendor/.test(s)) return "competition";
  if (/timeline|timing|close date|go.?live|implement/.test(s)) return "timeline";
  if (/authority|people|decision|procure|sign|stakeholder|economic buyer|champion/.test(s)) return "authority";
  if (/why.?now|trigger|compelling|urgen/.test(s)) return "why_now";
  if (/need|pain|challenge|problem|requirement/.test(s)) return "need_pain";
  if (/situation|current|operation|system|environment|scope/.test(s)) return "situation";
  return null;
}

/** Plays for a set of categories, in a stable, useful order. */
export function playsForCategories(categories: ReadonlyArray<PlayCategory>): Play[] {
  const wanted = new Set(categories);
  return PLAYS.filter((p) => wanted.has(p.category));
}

/**
 * Build a compact reference block for the briefing prompt from the deal's open
 * gap labels. Returns "" when nothing matches (so callers can append freely).
 * Always includes the closing discipline, since soft next steps are the
 * systematic gap on nearly every call.
 */
export function formatPlaysForBriefing(gapLabels: ReadonlyArray<string>): string {
  const cats = new Set<PlayCategory>();
  for (const l of gapLabels) {
    const c = categoryForLabel(l);
    if (c) cats.add(c);
  }
  // Always offer the moment-technique plays that apply on almost any call.
  cats.add("gap_ack");
  cats.add("pricing_nda");

  const plays = playsForCategories([...cats]);
  const lines: string[] = [
    "HOW MAGAYA'S BEST REPS ASK THESE (reference, adapt to this customer and the attendees, do not copy blindly):",
  ];
  for (const p of plays) {
    lines.push(`- [${p.category}] "${p.ask}"  (${p.why})`);
  }
  lines.push(`- [closing] ${CLOSING_DISCIPLINE}`);
  return lines.join("\n");
}
