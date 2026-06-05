export type IntegrationCategory =
  | "call_recording"
  | "crm"
  | "communication";

export type Integration = {
  id: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  brandLetter: string;
  brandColor: string;
};

export const INTEGRATIONS: Integration[] = [
  // Call recording
  { id: "gong", name: "Gong", category: "call_recording", description: "Reads call recordings and transcripts.", brandLetter: "G", brandColor: "#6366F1" },
  { id: "teams", name: "Microsoft Teams", category: "call_recording", description: "Reads call recordings and transcripts.", brandLetter: "T", brandColor: "#5059C9" },
  { id: "granola", name: "Granola", category: "call_recording", description: "Reads meeting notes and transcripts.", brandLetter: "G", brandColor: "#F59E0B" },

  // CRM
  { id: "salesforce", name: "Salesforce", category: "crm", description: "Reads pipeline, deals, contacts. Writes qualification fields back as evidence.", brandLetter: "S", brandColor: "#00A1E0" },
  { id: "rolldog", name: "Roll Dog", category: "crm", description: "Reads pipeline, deals, and contacts.", brandLetter: "R", brandColor: "#94A3B8" },
  { id: "einstein", name: "Einstein Activity Capture", category: "crm", description: "Reads call activity and email logs from Salesforce.", brandLetter: "E", brandColor: "#0EA5E9" },

  // Communication
  { id: "slack", name: "Slack", category: "communication", description: "Sends call briefings and updates to your team.", brandLetter: "S", brandColor: "#4A154B" },
  { id: "calendar", name: "Google Calendar", category: "communication", description: "Reads scheduled calls. Sends briefings 30 minutes before.", brandLetter: "C", brandColor: "#4285F4" },
  { id: "gmail", name: "Gmail / Outlook", category: "communication", description: "Reads email threads tied to active deals.", brandLetter: "M", brandColor: "#EA4335" },
];

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  call_recording: "Call recording (required)",
  crm: "CRM and pipeline (required)",
  communication: "Communication",
};

// ===== Frameworks =====

export type FrameworkKey = "MEDDIC" | "MEDDPICC" | "SCOTSMAN" | "CUSTOM";

export type FrameworkField = {
  letter: string;
  name: string;
  description: string;
};

export const FRAMEWORK_META: Record<
  FrameworkKey,
  { label: string; description: string; fieldCount: string }
> = {
  MEDDIC: {
    label: "MEDDIC",
    description: "Six fields. The classic enterprise sales framework.",
    fieldCount: "6 fields",
  },
  MEDDPICC: {
    label: "MEDDPICC",
    description: "Eight fields. MEDDIC plus paper process and competition.",
    fieldCount: "8 fields",
  },
  SCOTSMAN: {
    label: "SCOTSMAN",
    description: "Eighteen fields across eight categories. Used by TopSort and other marketplace teams.",
    fieldCount: "18 fields",
  },
  CUSTOM: {
    label: "Custom",
    description: "Variation of MEDDIC, MEDDPICC, or define your own. We will work with you to configure.",
    fieldCount: "Varies",
  },
};

export const MEDDIC_FIELDS: FrameworkField[] = [
  { letter: "M", name: "Metrics", description: "Quantified business impact for the customer." },
  { letter: "E", name: "Economic Buyer", description: "The person with budget authority." },
  { letter: "D", name: "Decision Criteria", description: "What the customer evaluates options against." },
  { letter: "D", name: "Decision Process", description: "How the buying decision gets made internally." },
  { letter: "I", name: "Identify Pain", description: "The specific business problem we are solving." },
  { letter: "C", name: "Champion", description: "Internal advocate selling on our behalf." },
];

export const MEDDPICC_FIELDS: FrameworkField[] = [
  { letter: "M", name: "Metrics", description: "Quantified business impact for the customer." },
  { letter: "E", name: "Economic Buyer", description: "The person with budget authority." },
  { letter: "D", name: "Decision Criteria", description: "What the customer evaluates options against." },
  { letter: "D", name: "Decision Process", description: "How the buying decision gets made internally." },
  { letter: "P", name: "Paper Process", description: "Procurement, legal, and signature workflow." },
  { letter: "I", name: "Identify Pain", description: "The specific business problem we are solving." },
  { letter: "C", name: "Champion", description: "Internal advocate selling on our behalf." },
  { letter: "C", name: "Competition", description: "Other vendors evaluated alongside us." },
];

// ===== Team =====

export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: "AE" | "Senior AE" | "Sales Manager";
};

export const TEAM_MEMBERS: TeamMember[] = [
  { id: "sarah-chen",      name: "Sarah Chen",      email: "sarah.chen@acme.io",      role: "AE" },
  { id: "marcus-johnson",  name: "Marcus Johnson",  email: "marcus.johnson@acme.io",  role: "Senior AE" },
  { id: "jess-tanaka",     name: "Jess Tanaka",     email: "jess.tanaka@acme.io",     role: "AE" },
  { id: "priya-patel",     name: "Priya Patel",     email: "priya.patel@acme.io",     role: "AE" },
  { id: "tom-williams",    name: "Tom Williams",    email: "tom.williams@acme.io",    role: "Sales Manager" },
  { id: "lily-park",       name: "Lily Park",       email: "lily.park@acme.io",       role: "AE" },
];

// ===== Deals =====

export type SimDeal = {
  id: string;
  account: string;
  arr: number;
  stage: string;
  close: string;
};

export const SIM_DEALS: SimDeal[] = [
  { id: "acme",      account: "Acme Corp",         arr: 185000,  stage: "Negotiation", close: "Q3 2026" },
  { id: "sentinel",  account: "Sentinel Robotics", arr: 340000,  stage: "Validation",  close: "Q3 2026" },
  { id: "beacon",    account: "Beacon Logistics",  arr: 95000,   stage: "Open",        close: "Q4 2026" },
  { id: "helix",     account: "Helix Foundry",     arr: 410000,  stage: "Validation",  close: "Q4 2026" },
  { id: "lumen",     account: "Lumen Health",      arr: 230000,  stage: "Proposal",    close: "Q3 2026" },
  { id: "vertex",    account: "Vertex Trading",    arr: 620000,  stage: "Negotiation", close: "Q3 2026" },
  { id: "polaris",   account: "Polaris Cloud",     arr: 145000,  stage: "Open",        close: "Q4 2026" },
  { id: "cipher",    account: "Cipher Systems",    arr: 1200000, stage: "Negotiation", close: "Q3 2026" },
];
