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

export type BriefingFinding = {
  level: "error" | "warn";
  field: string;
  rule: string;
  detail: string;
};

/** The shape this linter needs. Structurally compatible with MagayaBriefing. */
type LintableBriefing = {
  callObjective?: string | null;
  whereItStands?: string | null;
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
 * Language describing the emptiness of our own database. A rep does not care
 * what we hold, and being told we hold nothing reads as an apology.
 */
const OUR_RECORD_PATTERNS: ReadonlyArray<{ re: RegExp; rule: string }> = Object.freeze([
  { re: /\bzero (prior )?qualification\b/i, rule: "describes our record instead of the deal" },
  { re: /\b(qualification (record|data|fields?)|all fields?)\b[^.]{0,40}\b(blank|empty)\b/i, rule: "describes our record instead of the deal" },
  { re: /\bnothing (is )?on record\b/i, rule: "describes our record instead of the deal" },
  { re: /\bno (confirmed )?qualification data\b/i, rule: "describes our record instead of the deal" },
  { re: /\bnot (yet )?on record\b/i, rule: "describes our record instead of the deal" },
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

const LATE_STAGE_SUBJECT_RE = /\b(proposal|pricing|quote|contract|redline|negotiat|renewal|agreement)\b/i;

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function lintBriefing(
  briefing: LintableBriefing,
  context: { stageKey?: string | null; meetingSubject?: string | null } = {},
): BriefingFinding[] {
  const findings: BriefingFinding[] = [];

  const scalars: Array<[string, string]> = [
    ["callObjective", text(briefing.callObjective)],
    ["whereItStands", text(briefing.whereItStands)],
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
  if (questions.length === 0) {
    findings.push({ level: "error", field: "questions", rule: "no questions generated", detail: "" });
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
