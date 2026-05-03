import { DealStatus, SCOTSMAN_FIELDS } from "./scotsman";

export type Deal = {
  id: string;
  name: string;
  ae: string;
  stageKey: string;
  lastActivityDays: number;
  valueUsd: number;
  context: string;
  status: DealStatus;
  insight: string; // one-line AI insight shown on dashboard card
};

// Helper to build a status map starting from all-Yes and overriding gaps.
function build(unknowns: string[]): DealStatus {
  const out: DealStatus = {};
  SCOTSMAN_FIELDS.forEach(f => {
    out[f.id] = unknowns.includes(f.id) ? "Unknown" : "Yes";
  });
  return out;
}

export const DEALS: Deal[] = [
  {
    id: "hiroshi-tanaka-q1-2026",
    name: "Hiroshi Tanaka — Q1 2026",
    ae: "Kenji",
    stageKey: "proposal",
    lastActivityDays: 47,
    valueUsd: 280_000,
    context:
      "Enterprise manufacturing account exploring data virtualization for Phase 2 rollout. Originally sourced by SDR in Feb 2026; close date pushed from Feb → Apr → Jul → Oct with minimal qualification advancement.",
    // 6/18 confirmed (Sc1, Sc2, C1, O1, S1, S2) — Timescale, Money, Authority, Need all unknown
    status: build(["T1", "T2", "T3", "M1", "M2", "M3", "A1", "A2", "A3", "A4", "N1", "N2"]),
    insight:
      "Close date pushed 3 times — no rep activity in 47 days. Likely phantom opportunity.",
  },
  {
    id: "joe-mccorkle-q1-2026",
    name: "Joe McCorkle — Q1 2026",
    ae: "Regina",
    stageKey: "validation",
    lastActivityDays: 19,
    valueUsd: 95_000,
    context:
      "Mid-market retail marketplace exploring Topsort's retail media stack. Joe McCorkle is the primary champion (Director of Monetization). Initial scoping call confirmed they run a 200+ vendor marketplace with ~$40M GMV, currently using a homegrown sponsored-listings system that the engineering team wants to retire. Budget signal exists but no approved number. No introduction to finance or product leadership yet.",
    // 13/18 confirmed, 5 unknown: C1, T2, A2, A3, A4
    status: build(["C1", "T2", "A2", "A3", "A4"]),
    insight:
      "Missing authority confirmation — 19 days stale. Regina needs to act this week.",
  },
  {
    id: "sarah-chen-q1-2026",
    name: "Sarah Chen — Q1 2026",
    ae: "Marcus",
    stageKey: "proposal",
    lastActivityDays: 3,
    valueUsd: 78_000,
    context:
      "DTC beauty marketplace evaluating Topsort sponsored listings for their seller marketplace launching in March. Sarah is VP Growth, has internal alignment with product but procurement has not been engaged. Competitive bake-off against Criteo in flight.",
    // 15/18 confirmed, 3 unknown: A3, A4, C1 — Proposal requires C1 → BLOCKED
    status: build(["C1", "A3", "A4"]),
    insight:
      "Procurement contact still missing and a competitor is in the room — close the loop before next call.",
  },
  {
    id: "marcus-webb-q1-2026",
    name: "Marcus Webb — Q1 2026",
    ae: "James",
    stageKey: "open",
    lastActivityDays: 1,
    valueUsd: 30_000,
    context:
      "Early discovery with a regional grocery marketplace. Marcus Webb (Head of Digital) brought us in after a referral. Validating fit for Topsort's standard portfolio.",
    // To Open requires T1,S1,M1,A1 — set those + nothing else = 4/18
    status: (() => {
      const s: DealStatus = {};
      SCOTSMAN_FIELDS.forEach(f => {
        s[f.id] = ["T1", "S1", "M1", "A1"].includes(f.id) ? "Yes" : "Unknown";
      });
      return s;
    })(),
    insight:
      "Early but clean — all four To-Open gates confirmed. Push for Validation in next call.",
  },
  {
    id: "dataflow-inc-q1-2026",
    name: "DataFlow Inc — Q1 2026",
    ae: "Regina",
    stageKey: "negotiation",
    lastActivityDays: 2,
    valueUsd: 68_000,
    context:
      "B2B SaaS marketplace at the contract stage. All 18 SCOTSMAN fields confirmed. Final paper-work in flight with legal.",
    status: build([]), // 18/18
    insight:
      "Fully qualified. Drive to signature this week — no open gaps.",
  },
];

export function getDeal(id: string): Deal | undefined {
  return DEALS.find(d => d.id === id);
}

// Role-aware deal list
export function dealsForUser(role: "CRO" | "AE", aeName?: string): Deal[] {
  if (role === "CRO") return DEALS;
  return DEALS.filter(d => d.ae === aeName);
}

// Backwards compat for any old import
export const SEED_DEAL = DEALS[0];
