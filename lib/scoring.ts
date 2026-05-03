// Paul's exact 6 criteria from CONTEXT.md lines 60-66
export const CRITERIA = [
  { key: "objective",   label: "Opened with clear call objective" },
  { key: "situation",   label: "Asked situation questions" },
  { key: "implication", label: "Linked problems to implications" },
  { key: "buying_map",  label: "Confirmed buying map / stakeholders" },
  { key: "timescale",   label: "Confirmed timescale with evidence" },
  { key: "next_meeting",label: "Booked next meeting before ending call" }, // CARDINAL RULE
] as const;

export type CriterionKey = (typeof CRITERIA)[number]["key"];

export type CriterionResult = {
  key: CriterionKey;
  label: string;
  passed: boolean;
  evidence: string;
};

export type CallScore = {
  id: string;
  dealId: string;
  ae: string;
  loggedAt: string; // ISO
  notes: string;
  criteria: CriterionResult[];
  overall: number; // 0-6
  cardinalRuleMet: boolean;
  summary: string;
  scotsmanUpdates?: { fieldId: string; newStatus: "Yes" | "No" | "Unknown" }[];
};
