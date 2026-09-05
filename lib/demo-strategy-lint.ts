/**
 * Checks the demo strategy must pass before it reaches a rep, a solution
 * engineer, or a Note on a customer's account.
 *
 * Same three tiers as lib/recap-lint.ts and the same reasoning: the failures
 * are not alike and treating them alike gets one of them wrong.
 *
 * Every rule here exists because the generator broke it at least once. The two
 * worth naming: the model emitted literal markdown into values after being told
 * a label renders in bold, and it referred to "validateInternally" by its JSON
 * key in copy a solution engineer reads. Neither is malformed, so nothing in
 * the parse path would ever have caught them. Both were found by reading the
 * output beside a document a human wrote for the same account, which does not
 * scale, which is why they are checks now.
 */
import type { DemoStrategyDoc } from "./demo-strategy";

export type DemoFinding = {
  tier: "fix" | "regenerate" | "suppress";
  rule: string;
  where: string;
  detail: string;
};

/** The label is what a reader scans and what reaches a slide. */
const LABEL_MAX_WORDS = 6;

/**
 * Verbs that are always the seller talking. A goal opening with one of these
 * is our sales objective wearing a goal's clothes: "Capture value beyond entry
 * filing" is what WE want out of the deal.
 */
const SELLER_VERBS = new Set([
  "capture", "support", "position", "prove", "demonstrate", "show", "win",
  "convert", "address", "enable", "deliver", "leverage", "drive", "satisfy",
  "achieve", "maintain", "ensure", "provide", "offer", "sell",
]);

/**
 * Our own schema. The reader has never seen it and never will.
 *
 * camelCase keys only. The first version of this list also carried "attendees",
 * "competitive" and "interests", which are ordinary English words, and it duly
 * flagged a correct sentence reading "multiple attendees referenced pricing".
 * A check that fires on the language the document is written in is worse than
 * no check, because it trains the reader to skip the output.
 */
const FIELD_NAMES = [
  "validateInternally", "strategicGoals", "painPoints", "buildsOnRepPlan",
  "pricingSignals", "systemLandscape", "companyOverview", "ourTeam",
  "additionalSections",
];

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const labelOf = (s: string) => {
  const i = s.indexOf(": ");
  return i > 0 ? s.slice(0, i) : null;
};

/** Every string a reader will actually see. Keys are never walked. */
function* prose(d: DemoStrategyDoc): Generator<[string, string]> {
  const push = function* (where: string, v: string[]): Generator<[string, string]> {
    for (const s of v) yield [where, s];
  };
  yield ["objective", d.objective];
  yield ["positioning", d.positioning];
  yield ["recommendation", d.recommendation];
  yield* push("companyOverview", d.companyOverview);
  yield* push("painPoints", d.painPoints);
  yield* push("strategicGoals", d.strategicGoals);
  yield* push("interests", d.interests);
  yield* push("competitive", d.competitive);
  yield* push("pricingSignals", d.pricingSignals);
  yield* push("skip", d.skip);
  yield* push("validateInternally", d.validateInternally);
  yield* push("risks", d.risks);
  yield* push("strengths", d.strengths);
  for (const v of d.volumes) yield ["volumes", `${v.label}: ${v.value}`];
  for (const a of d.attendees) yield ["attendees", `${a.name}. ${a.role}. ${a.controls}`];
  for (const a of d.ourTeam) yield ["ourTeam", `${a.name}. ${a.role}`];
  for (const s of d.systemLandscape) yield ["systemLandscape", `${s.area}. ${s.current}. ${s.note}`];
  for (const s of d.sessions) {
    yield ["session name", s.name];
    yield ["session why", s.why];
    yield* push(`session "${s.name}"`, s.cover);
  }
  for (const a of d.additionalSections) {
    yield ["additional section title", a.title];
    yield* push(`additional section "${a.title}"`, a.items);
  }
}


/**
 * Sections that state facts about the customer. A hedge here is an inference
 * wearing a fact's clothes.
 *
 * Deliberately excludes validateInternally, risks and skip, where "Steven did
 * not confirm" is the entire content and flagging it would be the check
 * misreading its own purpose.
 */
const FACTUAL_SECTIONS = new Set(["painPoints", "strategicGoals", "companyOverview", "volumes", "systemLandscape"]);

/**
 * Self-admitted inference. The Dunavant run emitted a pain point reading
 * "suggests entries are being completed outside business hours, though not
 * stated in those exact words", which is the generator telling you it made
 * something up. It had borrowed the shape of a real pain from a different
 * account and applied it where no evidence existed.
 */
const HEDGE = /\b(?:though not stated|not stated in those|not stated explicitly|no direct quote|we can infer|can be inferred|presumably|suggests that|implies that|would suggest|likely means)\b/i;

const norm = (s: string) =>
  new Set(
    s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 3 && !["with","from","this","that","their","they","have","into","onto","across","where","when","without"].includes(w)),
  );

/** How much two labels overlap, 0 to 1. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / Math.min(a.size, b.size);
}

export function lintDemoStrategy(d: DemoStrategyDoc): DemoFinding[] {
  const out: DemoFinding[] = [];
  const add = (tier: DemoFinding["tier"], rule: string, where: string, detail: string) =>
    out.push({ tier, rule, where, detail });

  for (const [where, s] of prose(d)) {
    if (!s) continue;
    if (/[—–]/.test(s)) add("fix", "dash", where, s.slice(0, 90));
    if (/\*\*|__|`/.test(s)) add("regenerate", "markdown-in-value", where, s.slice(0, 90));
    // A bracketed token with no digits is an unfilled placeholder. Digits are
    // excluded because a real citation or a bracketed year is not a hole.
    const ph = s.match(/\[[^\]\d]{3,40}\]/);
    if (ph) add("suppress", "placeholder", where, ph[0]);
    for (const f of FIELD_NAMES) {
      if (s.includes(f)) add("regenerate", "schema-name-in-prose", where, `"${f}" in: ${s.slice(0, 70)}`);
    }
  }

  // The label carries the meaning alone, so it has to stay scannable.
  for (const [where, list] of [["painPoints", d.painPoints], ["strategicGoals", d.strategicGoals]] as const) {
    for (const item of list) {
      const lab = labelOf(item);
      if (!lab) { add("regenerate", "no-label", where, item.slice(0, 80)); continue; }
      if (words(lab).length > LABEL_MAX_WORDS) {
        add("regenerate", "label-too-long", where, `${words(lab).length} words: ${lab}`);
      }
    }
  }

  // A goal must be something the customer would put on their own slide.
  for (const g of d.strategicGoals) {
    const first = (labelOf(g) ?? g).split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "");
    if (first && SELLER_VERBS.has(first)) {
      add("regenerate", "seller-voice-goal", "strategicGoals", `opens with "${first}": ${labelOf(g) ?? g}`);
    }
  }

  for (const [where, str] of prose(d)) {
    if (FACTUAL_SECTIONS.has(where) && HEDGE.test(str)) {
      add("regenerate", "unsupported-inference", where, str.slice(0, 110));
    }
  }

  // A pain is the mechanics of what is broken; a goal is what they want. When
  // the two labels are the same thing the reader meets one idea twice and the
  // pain section stops carrying its own weight.
  for (const pain of d.painPoints) {
    const pl = labelOf(pain);
    if (!pl) continue;
    for (const goal of d.strategicGoals) {
      const gl = labelOf(goal);
      // Strictly above three quarters. A pain and the goal above it share a
      // subject by design, so some overlap is correct and the question is
      // whether each label still carries a word the other does not.
      // "China-to-US file handoff dependency" against "Replicate China-to-US
      // file handoff" lands exactly on three quarters and IS differentiated:
      // one names the state, the other the action. "Manual PGA and
      // unit-conversion work" against "Eliminate manual PGA and unit-conversion
      // work" is 1.0 and is the same phrase with a verb bolted on.
      if (gl && overlap(norm(pl), norm(gl)) > 0.75) {
        add("regenerate", "pain-restates-goal", "painPoints", `"${pl}" vs goal "${gl}"`);
      }
    }
  }

  if (!d.objective.trim()) add("suppress", "no-objective", "objective", "the document has no stated objective");
  for (const s of d.sessions) {
    if (s.cover.length === 0) add("suppress", "empty-session", `session "${s.name}"`, "a heading with nothing under it");
  }
  if (d.sessions.length === 0 && d.validateInternally.length === 0) {
    add("suppress", "nothing-to-say", "document", "no sessions and nothing to resolve");
  }
  return out;
}

export const worstTier = (f: DemoFinding[]): DemoFinding["tier"] | null =>
  f.some((x) => x.tier === "suppress") ? "suppress"
  : f.some((x) => x.tier === "regenerate") ? "regenerate"
  : f.some((x) => x.tier === "fix") ? "fix"
  : null;
