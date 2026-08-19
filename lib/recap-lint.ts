/**
 * Rules the recap must obey before it reaches a rep or a customer's CRM.
 *
 * The briefing has had this since it existed (lib/briefing-lint.ts, called from
 * generate-briefing.ts). The recap never has. Its only protection was a line in
 * a prompt asking a model not to use em-dashes, which is a request rather than
 * enforcement, and it now flows to four places: the rep's email, the Rolldog
 * next-step write, the Salesforce Task description, and a Note on a customer's
 * account.
 *
 * Three tiers, because the failures are not alike and treating them alike gets
 * one of them wrong:
 *
 *   fix        Deterministic and lossless. Applied, not reported. Regenerating
 *              a 3m30s pass because of one en-dash is absurd, and the dash in
 *              the Salesforce Task title is not model output at all (it is the
 *              rep's own calendar subject) so it can ONLY be fixed this way.
 *   regenerate Worth one more attempt, then ship anyway and flag. Framework
 *              vocabulary in the narrative is off-register, not wrong, and
 *              suppressing the section would delete the operational-detail
 *              paragraph to fix a noun.
 *   suppress   Do not send. Anything that asserts what we cannot stand behind.
 *
 * The tiers are the whole point. The briefing's "twice and it is suppressed"
 * rule is right for a briefing, where a wrong fact is spoken aloud to a
 * customer. Applied wholesale to a recap it would throw away the most valuable
 * section over a word.
 */

import type { GeneralRecap } from "./meeting-classify";
import type { DemoStrategy, Narrative, PassResult } from "./recap-passes";

export type RecapFinding = {
  tier: "fix" | "regenerate" | "suppress";
  rule: string;
  detail: string;
  /** Which section it was found in, for a human reading the log. */
  where: string;
};

/**
 * Dashes, normalized rather than reported.
 *
 * Mark reads them as machine-written. An em-dash becomes a comma-space when it
 * is acting as a pause and a plain hyphen when it joins, and telling those
 * apart reliably is not worth it: a comma reads correctly in both, so both
 * become a comma. En-dashes in a numeric range become "to", which is how a
 * person would say it out loud.
 */
export function normalizeDashes(s: string): string {
  return s
    // 2010 to 2015, 5 to 10: a range, spoken as "to".
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1 to $2")
    // Everything else: a pause.
    .replace(/\s*[—–]\s*/g, ", ")
    // A dash at the very start of a line was a bullet, not a pause.
    .replace(/^,\s+/gm, "");
}

/**
 * Sales-qualification vocabulary, which the narrative is supposed to be free
 * of. This is the whole reason the narrative never receives the extraction.
 */
const FRAMEWORK_WORDS = [
  "compelling event",
  "budget holder",
  "decision criteria",
  "qualification",
  "still open",
  "captured on this call",
  "meddic",
  "bant",
  "pipeline stage",
  "sql0",
  "sql1",
  "sql2",
  "sql3",
  "sql4",
  "sql5",
];

/** An unfilled template token. Never acceptable in something we send. */
const PLACEHOLDER = /\[(?:insert|name|company|customer|todo|tbd|xxx)[^\]]*\]|\{\{[^}]+\}\}|\bTBD\b|\bXXX\b/i;

/**
 * A pain point with no verb describing a problem is a requirement CATEGORY that
 * leaked through.
 *
 * "Customs sophistication is a decision driver" is a category. "Unit
 * conversions have to be recalculated by hand" is a pain. Categories belong in
 * requirementsByArea, and ranking them as pains is what pushed the paragraph
 * the target doc calls "worth more than the whole gap audit" down to fourth.
 *
 * Detected structurally: a category is a noun phrase asserting importance, so
 * it matches "is a/the <something> driver|requirement|priority|factor" and
 * carries none of the verbs a described problem uses.
 */
const CATEGORY_SHAPE =
  /\b(is|are|was|were|remains?)\s+(a|an|the)?\s*(named|explicit|primary|key|stated|main|top)?\s*(decision\s+)?(driver|requirement|priority|factor|criterion|criteria)\b/i;
const PROBLEM_VERBS =
  /\b(cannot|can't|must|have to|has to|had to|forces?|forced|breaks?|broke|fails?|failed|rekey|manually|by hand|recalculat|workaround|duplicat|loses?|lost|blocks?|blocked|prevents?|requires?|struggl|takes? \d|spends?|wastes?)\b/i;

export function lintRecap(args: {
  narrative: PassResult<Narrative>;
  demoStrategy: PassResult<DemoStrategy>;
}): RecapFinding[] {
  const out: RecapFinding[] = [];
  if (args.narrative.status !== "present") return out;
  const n = args.narrative.value;

  const scan = (text: string, where: string): void => {
    if (!text) return;
    if (/[—–]/.test(text)) {
      out.push({ tier: "fix", rule: "dashes", detail: "em or en dash present", where });
    }
    const ph = text.match(PLACEHOLDER);
    if (ph) {
      out.push({
        tier: "suppress",
        rule: "placeholder",
        detail: `unfilled token ${ph[0]}`,
        where,
      });
    }
  };

  scan(n.executiveSummary, "executiveSummary");
  scan(n.operationalDetail ?? "", "operationalDetail");
  for (const f of n.painPoints) scan(f.statement, "painPoints");
  for (const f of n.environmentNotes) scan(f.statement, "environmentNotes");
  for (const f of n.currentEnvironment) scan(f.statement, "currentEnvironment");

  // Framework vocabulary, narrative only. The audit is ALLOWED to use it: that
  // is what the audit is.
  const narrativeProse = [
    n.executiveSummary,
    n.operationalDetail ?? "",
    ...n.painPoints.map((p) => p.statement),
    ...n.environmentNotes.map((p) => p.statement),
  ]
    .join(" ")
    .toLowerCase();
  for (const w of FRAMEWORK_WORDS) {
    if (narrativeProse.includes(w)) {
      out.push({
        tier: "regenerate",
        rule: "framework-vocabulary",
        detail: `the readout used "${w}", which is our language and not the customer's`,
        where: "narrative",
      });
    }
  }

  // Categories masquerading as pain points.
  for (const p of n.painPoints) {
    if (CATEGORY_SHAPE.test(p.statement) && !PROBLEM_VERBS.test(p.statement)) {
      out.push({
        tier: "regenerate",
        rule: "category-as-pain",
        detail: `"${p.statement.slice(0, 80)}" states importance without describing a problem; it belongs in requirementsByArea`,
        where: "painPoints",
      });
    }
  }

  // A heading with nothing under it asserts that we looked and found nothing,
  // which for these sections we cannot stand behind.
  if (n.painPoints.length === 0 && n.environmentNotes.length === 0) {
    out.push({
      tier: "suppress",
      rule: "empty-readout",
      detail: "the readout has neither pain points nor environment notes",
      where: "narrative",
    });
  }

  if (args.demoStrategy.status === "present") {
    for (const s of args.demoStrategy.value.sessions) scan(s.name, "demoStrategy.sessions");
    for (const v of args.demoStrategy.value.validateInternally) scan(v, "demoStrategy.validateInternally");
    scan(args.demoStrategy.value.recommendation, "demoStrategy.recommendation");
  }

  return out;
}

/** Findings that mean do not send. */
export function recapBlockers(findings: ReadonlyArray<RecapFinding>): RecapFinding[] {
  return findings.filter((f) => f.tier === "suppress");
}

/** One line per finding, for the log. */
export function describeRecapFindings(findings: ReadonlyArray<RecapFinding>): string {
  return findings.map((f) => `  [${f.tier}] ${f.rule} in ${f.where}: ${f.detail}`).join("\n");
}

/**
 * Apply every `fix`-tier rule to a narrative in place of reporting it.
 *
 * Returns a copy. The structured facts keep their quotes untouched: a quote is
 * verbatim customer speech and normalizing a dash inside one would break the
 * grounding check that verified it against the transcript.
 */
export function applyRecapFixes(n: Narrative): Narrative {
  const fixFact = <T extends { statement: string }>(f: T): T => ({
    ...f,
    statement: normalizeDashes(f.statement),
  });
  return {
    ...n,
    executiveSummary: normalizeDashes(n.executiveSummary),
    operationalDetail: n.operationalDetail ? normalizeDashes(n.operationalDetail) : null,
    currentEnvironment: n.currentEnvironment.map(fixFact),
    environmentNotes: n.environmentNotes.map(fixFact),
    painPoints: n.painPoints.map(fixFact),
    buyingProcess: n.buyingProcess.map(fixFact),
    timeline: n.timeline.map(fixFact),
    requirementsByArea: n.requirementsByArea.map((r) => ({
      area: normalizeDashes(r.area),
      requirements: r.requirements.map(normalizeDashes),
    })),
    nextSteps: {
      customerOwes: n.nextSteps.customerOwes.map(fixFact),
      weOwe: n.nextSteps.weOwe.map(fixFact),
    },
  };
}

// ---------------------------------------------------------------------------
// General recap
// ---------------------------------------------------------------------------

/**
 * Lint the fallback recap for a non-qualification call.
 *
 * This was the last generated artifact reaching a rep with no checks at all.
 * It runs on renewals, support calls and internal meetings, which is exactly
 * where sales-qualification language is most wrong: generateGeneralRecap is
 * explicitly told not to use budget or close-plan framing, so finding that
 * vocabulary here means the instruction did not take, not that the wording is
 * merely off-register.
 *
 * Same three tiers as lintRecap and the same rule ids, so a caller can handle
 * findings from either without special-casing.
 */
export function lintGeneralRecap(recap: GeneralRecap): RecapFinding[] {
  const out: RecapFinding[] = [];

  const scan = (text: string, where: string): void => {
    if (!text) return;
    if (/[—–]/.test(text)) {
      out.push({ tier: "fix", rule: "dashes", detail: "em or en dash present", where });
    }
    const ph = text.match(PLACEHOLDER);
    if (ph) {
      out.push({ tier: "suppress", rule: "placeholder", detail: `unfilled token ${ph[0]}`, where });
    }
  };

  scan(recap.summary, "summary");
  recap.takeaways.forEach((t, i) => scan(t, `takeaways[${i}]`));
  recap.nextSteps.forEach((t, i) => scan(t, `nextSteps[${i}]`));

  const prose = [recap.summary, ...recap.takeaways, ...recap.nextSteps].join(" ").toLowerCase();
  for (const w of FRAMEWORK_WORDS) {
    if (prose.includes(w)) {
      out.push({
        tier: "regenerate",
        rule: "framework-vocabulary",
        detail: `a non-qualification recap used "${w}", which this call type should never be framed in`,
        where: "generalRecap",
      });
    }
  }

  // A recap with no summary and nothing to say asserts that we listened and
  // there was nothing, which is the no-show shape. Those are filtered on
  // outcome upstream; anything reaching here with no content is a generation
  // failure and should not be sent as if it were a record of the call.
  if (!recap.summary.trim() && recap.takeaways.length === 0) {
    out.push({
      tier: "suppress",
      rule: "empty-readout",
      detail: "the recap has no summary and no takeaways",
      where: "generalRecap",
    });
  }

  return out;
}

/** Dash normalisation for the general recap. Lossless, so it never regenerates. */
export function applyGeneralRecapFixes(recap: GeneralRecap): GeneralRecap {
  return {
    summary: normalizeDashes(recap.summary),
    takeaways: recap.takeaways.map(normalizeDashes),
    nextSteps: recap.nextSteps.map(normalizeDashes),
  };
}
