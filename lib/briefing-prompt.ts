import type { Framework } from "./framework";
import {
  SPIN_FOLLOWUPS,
  extractionToStatus,
  gateStatus,
  type ExtractionResult,
  type Stage,
} from "./scotsman";
import type { Deal } from "./seed-data";

/**
 * System prompt for pre-call briefing generation. Framework-agnostic in
 * tone (the rules apply to any qualification framework); the framework
 * name is interpolated for context.
 */
export function buildBriefingSystemPrompt(framework: Framework): string {
  return `You write pre-call briefings for B2B SaaS sales reps. Your briefings are concise, scannable, and actionable. Each section is a single sentence. Every briefing uses extracted ${framework.name} call data to surface the highest-leverage next move for the rep.

Strictness rules:
1. No em-dashes (—) or en-dashes (–) anywhere in the output. Use commas, periods, or rephrase. This is a hard formatting rule with no exceptions.
2. No marketing language. No "Great opportunity!" or "compelling value proposition." Use the direct, concrete language a CRO uses with their rep.
3. Anchor every section to specific facts from the extraction state. Reference quoted customer evidence where possible, verbatim.
4. Use customer language where customer quotes exist. Do not paraphrase into generic sales speak.
5. If a compelling event is present in the extraction evidence (timing deadlines, holiday windows, signature dates the customer stated), surface it in the at-risk section in the customer's own words.
6. Do not invent facts that are not present in the extraction state or contacts list.
7. Each section is one sentence. No preamble, no qualifiers, no hedging.

Output format: a single JSON object, no prose, no markdown fences, no commentary.
{
  "callObjective": "single sentence describing what the rep should aim to accomplish on the next call",
  "nextStepCommitment": "single sentence on what the rep should ask the customer to commit to by end of call; must be specific and actionable, naming the person or action",
  "whatsAtRisk": "single sentence on what slips if this call goes badly, referencing the customer's own stated compelling event"
}`;
}

export function buildBriefingUserMessage(
  deal: Deal,
  framework: Framework,
  stage: Stage,
  nextStage: Stage | null,
  extraction: ExtractionResult,
  topQuestionIds: string[],
): string {
  const contactsLines = deal.contacts
    .map((c) => {
      const rel = c.relationship.replace("_", " ");
      const last = c.lastContactedAt
        ? `last contacted ${c.lastContactedAt}`
        : "never contacted";
      return `- ${c.name}, ${c.role}, ${rel}, ${last}`;
    })
    .join("\n");

  const extractionLines = framework.fields
    .map((f) => {
      const entry = extraction[f.fieldKey];
      if (entry && entry.status === "Yes") {
        return `- ${f.fieldKey} (${f.label}): Yes. Answer: ${entry.answer}. Evidence: "${entry.evidence}"`;
      }
      const label = entry?.status === "No" ? "No" : "Unknown";
      return `- ${f.fieldKey} (${f.label}): ${label}. Q: ${f.question}`;
    })
    .join("\n");

  const status = extractionToStatus(extraction);
  const currentGate = gateStatus(stage, status);
  const nextGateInfo = nextStage ? gateStatus(nextStage, status) : null;

  // Per-field follow-up resolution. For SCOTSMAN fields we have hardcoded
  // SPIN prompts; for any other framework, fall back to the field's
  // declared question (which IS the question to ask, e.g. a Rolldog
  // stage-gate item text).
  const followUpFor = (fieldKey: string): string => {
    return (
      SPIN_FOLLOWUPS[fieldKey] ??
      framework.fields.find((f) => f.fieldKey === fieldKey)?.question ??
      ""
    );
  };

  const topGapsLines = topQuestionIds
    .map((id, i) => `${i + 1}. ${id}: ${followUpFor(id)}`)
    .join("\n");

  const lines = [
    `ACCOUNT: ${deal.account}`,
    `INDUSTRY: ${deal.industry}`,
    `ARR: $${deal.arr.toLocaleString()}`,
    `STAGE: ${stage.label} (${stage.pct})`,
    `DAYS IN STAGE: ${deal.daysInStage}`,
    ``,
    `CONTACTS:`,
    contactsLines,
    ``,
    `CURRENT ${framework.name} STATE:`,
    extractionLines,
    ``,
    `GATE STATUS:`,
    `Current gate (${stage.label}) blocked on: ${currentGate.missing.join(", ") || "none"}`,
  ];

  if (nextStage && nextGateInfo) {
    lines.push(
      `Next gate (${nextStage.label}) blocked on: ${nextGateInfo.missing.join(", ") || "none"}`,
    );
  }

  lines.push(
    ``,
    `TOP 3 GAPS TO ADDRESS ON NEXT CALL (already computed, in priority order):`,
    topGapsLines,
    ``,
    `Write callObjective, nextStepCommitment, whatsAtRisk. Return JSON only.`,
  );

  return lines.join("\n");
}

/**
 * Compute the top-3 question IDs from the current gap state.
 *
 * Was previously SCOTSMAN-specific (CATEGORY_PRIORITY constant). Now
 * sorts by framework field sort_order so each framework controls its
 * own priority. Current-stage blockers come first, then next-stage
 * blockers; both lists are independently sorted by sort_order.
 */
export function computeTopQuestionIds(
  framework: Framework,
  extraction: ExtractionResult,
  stage: Stage,
  nextStage: Stage | null,
): string[] {
  const status = extractionToStatus(extraction);
  const currentBlockers = gateStatus(stage, status).missing;
  const nextBlockers = nextStage ? gateStatus(nextStage, status).missing : [];
  const nextOnly = nextBlockers.filter((id) => !currentBlockers.includes(id));

  const orderIndex = new Map<string, number>();
  framework.fields.forEach((f, i) => orderIndex.set(f.fieldKey, i));

  const byOrder = (a: string, b: string) => {
    const oa = orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ob = orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b);
  };

  const sortedCurrent = [...currentBlockers].sort(byOrder);
  const sortedNext = nextOnly.sort(byOrder);

  return [...sortedCurrent, ...sortedNext].slice(0, 3);
}
