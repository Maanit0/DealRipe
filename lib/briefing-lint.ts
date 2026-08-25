/**
 * Deterministic checks on a generated briefing, before a rep ever sees it.
 *
 * The system prompt already forbids all of this. Prompts are probabilistic, and
 * one bad line costs more than it looks: a rep who reads "budget was noted as
 * confirmed on our end" out loud to a customer, or opens a proposal call by
 * asking whether budget exists, stops trusting the whole product in a single
 * sitting. There is no partial credit on a briefing.
 *
 * So the rules that must never break are enforced here in code, and a briefing
 * that trips one is regenerated rather than delivered. Two kinds of finding:
 *
 *   error   never ship this. Regenerate, and if it fails twice, ship nothing
 *           and log, because no briefing beats a wrong one.
 *   warn    worth seeing in a preview, not worth blocking on.
 *
 * Keep every pattern here narrow and literal. A loose regex that fires on a
 * legitimate briefing trains everyone to ignore the linter, which is worse than
 * not having one.
 */

import { standText } from "./briefing-blocks";

export type BriefingFinding = {
  level: "error" | "warn";
  field: string;
  rule: string;
  detail: string;
};

/** The shape this linter needs. Structurally compatible with MagayaBriefing. */
type LintableBriefing = {
  callObjective?: string | null;
  whereItStands?: unknown;
  nextStepCommitment?: string | null;
  whatsAtRisk?: string | null;
  signalFlag?: string | null;
  questions?: Array<{ ask?: string | null; why?: string | null }> | null;
};

/**
 * Language that reveals our own systems to the customer. These appear inside an
 * "ask", which the rep says out loud, so each one is a disclosure of internal
 * CRM state and an admission that we are reading from a file rather than
 * listening. Drawn from real generated output, not imagined.
 */
const INSIDER_PATTERNS: ReadonlyArray<{ re: RegExp; rule: string }> = Object.freeze([
  { re: /\b(noted|marked|logged|recorded|flagged|listed)\s+(as\s+)?(confirmed|complete|done)\b/i, rule: "cites our CRM state to the customer" },
  { re: /\bon our (end|side|records?)\b/i, rule: "cites our CRM state to the customer" },
  { re: /\b(our|the)\s+(records?|notes?|file|system|crm|data)\s+(show|says?|indicates?|has|have)\b/i, rule: "cites our CRM state to the customer" },
  { re: /\bwe have you (down|marked|listed)\b/i, rule: "cites our CRM state to the customer" },
  { re: /\b(per|from|according to)\s+(our|the)\s+(notes?|records?|bdr|crm)\b/i, rule: "cites our CRM state to the customer" },
  { re: /\bit says here\b/i, rule: "cites our CRM state to the customer" },
  { re: /\bmy notes (say|show)\b/i, rule: "cites our CRM state to the customer" },
]);

/**
 * The rep's own record, in an email the rep reads.
 *
 * The coaching block put "this rep completed 2 of 15 coached asks in the last
 * 60 days" into the red SIGNAL box, which is a performance scorecard in the
 * most alarming container on a page someone reads two minutes before speaking
 * to a customer. Maanit, 2026-08-25: "that looks very bad, those are sales
 * leader flags and they should go to a sales leader, not to the rep."
 *
 * These are an ERROR rather than a warning. The briefing regenerates, and a
 * briefing that keeps doing it is suppressed, because a rep who reads their own
 * follow-through rate in a pre-call email stops trusting the product in one
 * sitting and the tally was never theirs to receive.
 */
const REP_SCORECARD_PATTERNS: ReadonlyArray<{ re: RegExp; rule: string }> = Object.freeze([
  { re: /\bthis rep\b/i, rule: "describes the rep's own record to the rep" },
  { re: /\b\d+\s+of\s+\d+\s+(coached\s+)?(asks?|questions?|commitments?|prescriptions?)\b/i, rule: "quotes a follow-through tally to the rep" },
  { re: /\bcoached\s+asks?\b/i, rule: "quotes a follow-through tally to the rep" },
  { re: /\bfollow[- ]?through\s+(rate|record)\b/i, rule: "quotes a follow-through tally to the rep" },
  { re: /\byou (completed|raised|asked)\s+\d+\b/i, rule: "quotes a follow-through tally to the rep" },
  { re: /\bin the last \d+ days,? (you|this rep)\b/i, rule: "describes the rep's own record to the rep" },
]);

/**
 * Language describing the emptiness of our own database. A rep does not care
 * what we hold, and being told we hold nothing reads as an apology.
 */
const OUR_RECORD_PATTERNS: ReadonlyArray<{ re: RegExp; rule: string }> = Object.freeze([
  { re: /\bzero (prior )?qualification\b/i, rule: "describes our record instead of the deal" },
  { re: /\b(qualification (record|data|fields?)|all fields?)\b[^.]{0,40}\b(blank|empty)\b/i, rule: "describes our record instead of the deal" },
  { re: /\bnothing (is )?on record\b/i, rule: "describes our record instead of the deal" },
  { re: /\bno (confirmed )?qualification data\b/i, rule: "describes our record instead of the deal" },
  { re: /\bnot (yet )?on record\b/i, rule: "describes our record instead of the deal" },
  // "on file yet" and "confirmed yet" slipped past the first pass of these
  // patterns. Same defect wearing different words: it reports the state of our
  // database in a sentence that is supposed to report the state of the deal.
  { re: /\bon file( yet)?\b/i, rule: "describes our record instead of the deal" },
  { re: /\bno (prior )?qualification (is )?(confirmed|captured)\b/i, rule: "describes our record instead of the deal" },
  { re: /\b(no|zero)\s+(prior\s+|previous\s+)?qualification\s+(data|information|record)/i, rule: "describes our record instead of the deal" },
  { re: /\bnothing (confirmed|captured|recorded)( yet)?\b/i, rule: "describes our record instead of the deal" },
  { re: /\b(un)?confirmed (from|on) (prior|previous|any) calls?\b/i, rule: "describes our record instead of the deal" },
  { re: /\b(we|dealripe) (have|has) (no|not) (captured|heard|recorded)\b/i, rule: "describes our record instead of the deal" },
]);

/** Dashes Mark reads as machine-written. Hard rule, no exceptions. */
const DASH_RE = /[—–]/;

/**
 * Asking whether budget exists, once a price is already on the table.
 *
 * On a proposal or pricing call the customer is looking at a number, and the
 * only useful budget question is whether that number works. "Do you have budget
 * set aside" tells them we have not registered that we already quoted them.
 */
const BUDGET_EXISTENCE_RE =
  /\b(do you have|is there|have you (got|set))\b[^?]{0,40}\bbudget\b[^?]{0,40}\b(set aside|allocated|approved|in place|for this)\b/i;

/**
 * Unfilled placeholders in something the rep says out loud.
 *
 * The pricing play in magaya-plays is written as "runs about [X] to [Y] per
 * month", which is correct as a reference and wrong as a script: TOC shipped
 * "licensing typically runs in the range of X to Y per month" while Joe Arevalo
 * got a real range in the same run. A rep reading the first one live has to
 * invent a number mid-sentence. Either the briefing commits to a range or it
 * does not raise price.
 */
const PLACEHOLDER_RE = /(\bX to Y\b|\[[A-Za-z ]{1,20}\]|<[A-Za-z ]{1,20}>|\$X\b|\bTBD\b|\bINSERT\b)/;

const LATE_STAGE_SUBJECT_RE = /\b(proposal|pricing|quote|contract|redline|negotiat|renewal|agreement)\b/i;

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Every string in the optional blocks, as [path, value] pairs.
 *
 * The scalars list is the five core fields and predates the block shape, so a
 * rule applied only to it now covers less than half the page. coachThis is
 * exactly where a rep scorecard would appear and it is not a scalar.
 */
function blockText(b: LintableBriefing): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const SKIP = new Set(["targetFields", "targetLabel", "questions"]);
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      out.push([path, v]);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (SKIP.has(k)) continue;
        walk(x, path ? `${path}.${k}` : k);
      }
    }
  };
  const record = b as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (["callObjective", "whereItStands", "nextStepCommitment", "whatsAtRisk", "signalFlag", "questions"].includes(key)) continue;
    walk(record[key], key);
  }
  return out;
}

export function lintBriefing(
  briefing: LintableBriefing,
  context: {
    stageKey?: string | null;
    meetingSubject?: string | null;
    /**
     * How many asks this call type is allowed. Zero or one means a briefing with
     * no questions is CORRECT, not broken.
     *
     * Until 2026-08-25 this rule assumed every briefing must carry questions,
     * which was true only because the schema forced it. The first demo briefing
     * generated under the new shape was suppressed twice and then dropped for
     * "no questions generated" while being exactly what a demo briefing should
     * be. A guardrail that encodes the old contract blocks the new one.
     */
    questionBudget?: number;
    /**
     * Total words the rep should have to read. Over budget is a REGENERATE, not
     * a warning: an instruction to be brief is the first thing a model trades
     * away when it has material, which is exactly when brevity matters most.
     */
    maxWords?: number;
  } = {},
): BriefingFinding[] {
  const findings: BriefingFinding[] = [];

  const scalars: Array<[string, string]> = [
    ["callObjective", text(briefing.callObjective)],
    // FLATTENED, NEVER text().
    //
    // whereItStands became an array of labelled lines on 2026-08-25. text()
    // returns "" for anything that is not a string, so reading it through text()
    // would have silently stopped scanning the one block these patterns exist
    // for, and every finding would have been "clean". A linter that cannot see
    // its own subject reports no problems, which is the exact failure this
    // codebase keeps paying for.
    ["whereItStands", standText(briefing.whereItStands)],
    ["nextStepCommitment", text(briefing.nextStepCommitment)],
    ["whatsAtRisk", text(briefing.whatsAtRisk)],
    ["signalFlag", text(briefing.signalFlag)],
  ];
  const questions = briefing.questions ?? [];
  const asks: Array<[string, string]> = questions.map((q, i) => [`questions[${i}].ask`, text(q?.ask)]);
  const whys: Array<[string, string]> = questions.map((q, i) => [`questions[${i}].why`, text(q?.why)]);

  // Dashes: everywhere, including the rep-facing "why".
  for (const [field, value] of [...scalars, ...asks, ...whys]) {
    if (DASH_RE.test(value)) {
      findings.push({ level: "error", field, rule: "em-dash or en-dash", detail: value });
    }
  }

  // Insider language: an error in an "ask" because it is spoken to the customer,
  // a warning in rep-facing prose where it is merely clumsy.
  for (const [field, value] of asks) {
    for (const { re, rule } of INSIDER_PATTERNS) {
      if (re.test(value)) findings.push({ level: "error", field, rule, detail: value });
    }
  }
  for (const [field, value] of [...scalars, ...whys]) {
    for (const { re, rule } of INSIDER_PATTERNS) {
      if (re.test(value)) findings.push({ level: "warn", field, rule, detail: value });
    }
  }

  // Our own record, in the rep-facing narrative.
  for (const [field, value] of scalars) {
    for (const { re, rule } of OUR_RECORD_PATTERNS) {
      if (re.test(value)) findings.push({ level: "error", field, rule, detail: value });
    }
  }

  // The REP's record, anywhere at all. Checked across every field rather than
  // just the narrative, because the first one to ship landed in signalFlag.
  for (const [field, value] of [...scalars, ...asks, ...whys, ...blockText(briefing)]) {
    for (const { re, rule } of REP_SCORECARD_PATTERNS) {
      if (re.test(value)) findings.push({ level: "error", field, rule, detail: value });
    }
  }

  // Unfilled placeholders in anything spoken to the customer.
  for (const [field, value] of asks) {
    if (PLACEHOLDER_RE.test(value)) {
      findings.push({
        level: "error",
        field,
        rule: "unfilled placeholder in something the rep says out loud",
        detail: value,
      });
    }
  }

  // Budget existence on a call where a number is already in play.
  const lateStage =
    LATE_STAGE_SUBJECT_RE.test(text(context.meetingSubject)) ||
    ["SQL3", "SQL4", "SQL5"].includes(text(context.stageKey));
  if (lateStage) {
    for (const [field, value] of asks) {
      if (BUDGET_EXISTENCE_RE.test(value)) {
        findings.push({
          level: "error",
          field,
          rule: "asks whether budget exists on a late-stage or pricing call",
          detail: value,
        });
      }
    }
  }

  // Structural minimums. An empty objective or a missing next step is not a
  // briefing, and shipping one teaches the rep it is optional.
  if (!text(briefing.callObjective).trim()) {
    findings.push({ level: "error", field: "callObjective", rule: "empty", detail: "" });
  }
  if (!text(briefing.nextStepCommitment).trim()) {
    findings.push({ level: "error", field: "nextStepCommitment", rule: "empty", detail: "" });
  }
  // A briefing with no questions is an error only where asking was the job.
  const budget = context.questionBudget ?? 3;
  if (questions.length === 0 && budget >= 2) {
    findings.push({ level: "error", field: "questions", rule: "no questions generated", detail: "" });
  }

  // Length, counted across everything the rep reads.
  if (context.maxWords) {
    const words = countBriefingWords(briefing);
    if (words > context.maxWords) {
      findings.push({
        level: "error",
        field: "length",
        rule: "too long to read before a call",
        detail: `${words} words against a budget of ${context.maxWords}. Cut the least important item in the longest block; do not trim every block evenly.`,
      });
    }
  }

  return findings;
}

export function briefingErrors(findings: ReadonlyArray<BriefingFinding>): BriefingFinding[] {
  return findings.filter((f) => f.level === "error");
}

/** One-line summary for logs and previews. */
export function describeFindings(findings: ReadonlyArray<BriefingFinding>): string {
  if (findings.length === 0) return "clean";
  return findings.map((f) => `${f.level.toUpperCase()} ${f.field}: ${f.rule}`).join("; ");
}


/**
 * Every word the rep actually reads, across all blocks.
 *
 * Counts strings anywhere in the object, including inside the block arrays,
 * because the length problem lives in the blocks: six people at three sentences
 * each is one section that outweighs the whole rest of the brief. targetFields
 * and targetLabel are excluded, since they are plumbing the rep never sees.
 */
export function countBriefingWords(b: unknown): number {
  const SKIP = new Set(["targetFields", "targetLabel"]);
  let n = 0;
  const walk = (v: unknown, key?: string): void => {
    if (key && SKIP.has(key)) return;
    if (typeof v === "string") {
      n += v.trim().split(/\s+/).filter(Boolean).length;
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
    }
  };
  walk(b);
  return n;
}
