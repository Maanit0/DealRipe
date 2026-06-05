export type FieldStatus = "Yes" | "No" | "Unknown";

export type ScotsmanField = {
  id: string;          // e.g. "Sc1"
  category: ScotsmanCategory;
  label: string;       // e.g. "Scope"
  question: string;    // exact text from Paul's spreadsheet
};

export type ScotsmanCategory =
  | "Scope"
  | "Competition"
  | "Originality"
  | "Timescale"
  | "Size"
  | "Money"
  | "Authority"
  | "Need";

export const SCOTSMAN_FIELDS: ScotsmanField[] = [
  { id: "Sc1", category: "Scope",       label: "Scope",       question: "Does the project fit with Topsort's standard portfolio of services?" },
  { id: "Sc2", category: "Scope",       label: "Scope",       question: "Can it be fully matched within Topsort's current product portfolio?" },
  { id: "C1",  category: "Competition", label: "Competition", question: "Do we know who else might be bidding / been approached?" },
  { id: "O1",  category: "Originality", label: "Originality", question: "Can we offer something 'original' or unique to this potential opportunity?" },
  { id: "T1",  category: "Timescale",   label: "Timescale",   question: "Are we aware of their timescales?" },
  { id: "T2",  category: "Timescale",   label: "Timescale",   question: "Is the timescale defined?" },
  { id: "T3",  category: "Timescale",   label: "Timescale",   question: "Does the timescale fall within our capability from history and experience?" },
  { id: "S1",  category: "Size",        label: "Size",        question: "Is the project size worth pursuing?" },
  { id: "S2",  category: "Size",        label: "Size",        question: "Is the potential client of a size that makes it viable (project or potential)?" },
  { id: "M1",  category: "Money",       label: "Money",       question: "Is a target budget defined?" },
  { id: "M2",  category: "Money",       label: "Money",       question: "How much is it? Is it approved?" },
  { id: "M3",  category: "Money",       label: "Money",       question: "Does the budget fit with Topsort's normal pricing schedules?" },
  { id: "A1",  category: "Authority",   label: "Authority",   question: "Are we speaking to the right person?" },
  { id: "A2",  category: "Authority",   label: "Authority",   question: "Do we know who has the authority to make the decision?" },
  { id: "A3",  category: "Authority",   label: "Authority",   question: "Do we have access to the decision maker / process?" },
  { id: "A4",  category: "Authority",   label: "Authority",   question: "Do we know who else is involved?" },
  { id: "N1",  category: "Need",        label: "Need",        question: "Our solution aligns functionally to the desired outcome" },
  { id: "N2",  category: "Need",        label: "Need",        question: "Can we match all identified needs?" },
];

export type Stage = {
  key: string;
  label: string;
  pct: string;
  required: string[];
};

const ALL_IDS = SCOTSMAN_FIELDS.map(f => f.id);

export const STAGES: Stage[] = [
  { key: "open",        label: "To Open",              pct: "10%",  required: ["T1","S1","M1","A1"] },
  { key: "validation",  label: "Validation",           pct: "20%",  required: ["T1","T2","S1","S2","M1","A1","A2","N1"] },
  { key: "proposal",    label: "Proposal / Generation",pct: "40%",  required: ALL_IDS.filter(id => !["A3","A4"].includes(id)) },
  { key: "negotiation", label: "Negotiation",          pct: "80%",  required: ALL_IDS },
  { key: "signing",     label: "Signing",              pct: "90%",  required: ALL_IDS },
  { key: "closed",      label: "Closed Won",           pct: "100%", required: ALL_IDS },
];

export type DealStatus = Record<string, FieldStatus>;

export function gateStatus(stage: Stage, status: DealStatus): { go: boolean; missing: string[] } {
  const missing = stage.required.filter(id => status[id] !== "Yes");
  return { go: missing.length === 0, missing };
}

// ---------- Additions for DealRipe extraction layer ----------

// SPIN follow-up questions, mapped to each Scotsman field by ID.
// These are the questions a rep would ask to fill the gap when the
// field is currently No or Unknown.
export const SPIN_FOLLOWUPS: Record<string, string> = {
  Sc1: "What outcome are you trying to achieve, and how would you know it's working?",
  Sc2: "If we had to deliver one capability in the first thirty days that would prove value, which one?",

  C1:  "Who else have you spoken to about this, and what stood out to you about them, good or bad?",

  O1:  "What would have to be true for you to feel confident going with us over the alternatives?",

  T1:  "What's driving the timing on this for you?",
  T2:  "Working backward from go-live, when would we need a signed contract in hand?",
  T3:  "Walk me through your procurement process. How long does legal usually take to review a contract this size?",

  S1:  "Just to make sure we're aligned, the proposal we're working toward is in this range, does that match what you've been planning for?",
  S2:  "Help me understand the broader picture, what's the size of the program this would support over twelve to twenty-four months?",

  M1:  "Has this spend already been budgeted for this fiscal year, or would it need to be approved as a new line item?",
  M2:  "What's the budget cycle look like for this purchase, and who controls that line item?",
  M3:  "If our pricing came in at the level we discussed, would that be a comfortable fit or would you need to come back with anything?",

  A1:  "Other than yourself, who else has to be a yes for this to move forward?",
  A2:  "Walk me through who needs to sign off on a contract this size. Is your CEO or CFO in the loop yet?",
  A3:  "If I asked you to take this proposal to your CEO without me on the call, would you feel ready to do that?",
  A4:  "Who else is going to influence this decision, even if they're not the signer?",

  N1:  "If we got everything right and you were looking back twelve months from now, what would have changed in your business?",
  N2:  "If you don't fix this, what does it cost the business over the next twelve months?",
};

// What DealRipe returns from the extraction API for each field.
// This is what gets rendered into the Opportunity Control sheet.
export type FieldExtraction =
  | {
      status: "Yes";
      answer: string;       // 1-2 sentence paraphrase of what the customer said
      evidence: string;     // direct quote from transcript
      confidence: number;   // 0.0 to 1.0
      lastUpdatedFromCallId?: string;
    }
  | {
      status: "No" | "Unknown";
      // No answer extracted. The SPIN follow-up from SPIN_FOLLOWUPS[id]
      // will be surfaced in the UI.
    };

// Full extraction result returned by /api/extract-scotsman
export type ExtractionResult = Record<string, FieldExtraction>;

// Helper: convert ExtractionResult to the DealStatus your gating uses
export function extractionToStatus(extraction: ExtractionResult): DealStatus {
  const status: DealStatus = {};
  for (const id of SCOTSMAN_FIELDS.map(f => f.id)) {
    status[id] = extraction[id]?.status ?? "Unknown";
  }
  return status;
}

// Helper: get the SPIN follow-up for a field that's not yet a Yes
export function getSpinFor(fieldId: string): string | undefined {
  return SPIN_FOLLOWUPS[fieldId];
}

// ---------- Framework adapter (for client-side mergeExtraction) ----------
//
// lib/framework.ts loads Framework objects from Supabase. The browser
// doesn't have Supabase admin access (or want a round-trip to render the
// extraction sheet), so the topsort demo UI uses this hardcoded mirror
// of the SCOTSMAN framework. Keep it in sync with the SCOTSMAN_FIELDS
// constant above. The id is the placeholder "scotsman-builtin" because
// client-side merge doesn't touch the database.
//
// Production server-side code (lib/transcript-ingest.ts, the briefing
// route) always loads through lib/framework.ts.
export type FrameworkFieldLite = {
  fieldKey: string;
  label: string;
  question: string;
  stageKey: string | null;
  sortOrder: number;
};

export type FrameworkLite = {
  id: string;
  name: string;
  fields: FrameworkFieldLite[];
};

export const SCOTSMAN_AS_FRAMEWORK: FrameworkLite = {
  id: "scotsman-builtin",
  name: "SCOTSMAN",
  fields: SCOTSMAN_FIELDS.map((f, i) => ({
    fieldKey: f.id,
    label: f.label,
    question: f.question,
    stageKey: null,
    sortOrder: i,
  })),
};