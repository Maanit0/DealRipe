import type { ForecastTenant } from "../types";

/**
 * PROSPECT DEMO. Neutral mid-market B2B software account used for a CRO who
 * runs MEDDPICC on Salesforce + Gong. Deliberately generic (no vertical), so
 * it reads as a real pipeline rather than something built for one prospect.
 *
 * Story arc this account is engineered to tell:
 *   1. Economic buyer reached too late is the No. 1 stall  -> Brightwave.
 *   2. Gong only sees the calls it joined                  -> Parkside Group.
 *   3. Paper process and legal review drag                 -> Cedarline.
 *
 * URL: /forecast?tenant=cobalt
 * Everything here is illustrative, not any real customer's numbers.
 */
export const COBALT: ForecastTenant = {
  slug: "cobalt",
  name: "Cobalt",
  product: "B2B software platform",
  framework: "MEDDPICC",
  weekOf: "June 15, 2026",
  lastUpdatedAgo: "9 minutes ago",
  changedCount: 3,
  numbers: {
    quarterTargetUsd: 2_500_000,
    quarterLabel: "Q2 2026",
    ripeForecastUsd: 1_340_000,
    repCommitUsd: 1_780_000,
  },
  movements: [
    {
      id: "brightwave",
      account: "Brightwave",
      arr: 420_000,
      rep: "Diego Salas",
      status: "at_risk",
      repProb: 78,
      repQuarter: "Q2 2026",
      repDate: "Jun 30, 2026",
      lastProb: 71,
      lastQuarter: "Q2 2026",
      lastDate: "Jun 30",
      thisProb: 50,
      thisQuarter: "Q3 2026",
      thisDate: "Aug 11",
      delta: -21,
      reason:
        "CFO David Cho declined Tuesday's invite. Economic buyer 19 days untouched. Rep is working the champion, Rosa Lind in Ops, not the signer.",
      convinceMe: 50,
    },
    {
      id: "parkside",
      account: "Parkside Group",
      arr: 310_000,
      rep: "Diego Salas",
      status: "at_risk",
      repProb: 60,
      repQuarter: "Q2 2026",
      repDate: "Jun 20, 2026",
      lastProb: 55,
      lastQuarter: "Q2 2026",
      lastDate: "Jun 20",
      thisProb: 44,
      thisQuarter: "Q3 2026",
      thisDate: "Jul 18",
      delta: -11,
      reason:
        "Looks green in Salesforce, but the last 3 buyer touches were a phone call and an in person meeting, with no Gong on either. Economic buyer dark 21 days, and a competitor surfaced in an email thread Gong never saw.",
      convinceMe: 44,
    },
    {
      id: "keystone",
      account: "Keystone",
      arr: 260_000,
      rep: "Nina Brandt",
      status: "healthy",
      repProb: 90,
      repQuarter: "Q2 2026",
      repDate: "Jun 27, 2026",
      lastProb: 84,
      lastQuarter: "Q2 2026",
      lastDate: "Jun 27",
      thisProb: 90,
      thisQuarter: "Q2 2026",
      thisDate: "Jun 27",
      delta: 6,
      reason:
        "Signing gate met. Procurement aligned and paper process underway. DealRipe now flags this as a clean commit.",
      convinceMe: 90,
    },
    {
      id: "cedarline",
      account: "Cedarline",
      arr: 180_000,
      rep: "Nina Brandt",
      status: "stalled",
      repProb: 65,
      repQuarter: "Q2 2026",
      repDate: "Jun 18, 2026",
      lastProb: 40,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 30",
      thisProb: 33,
      thisQuarter: "Q3 2026",
      thisDate: "Aug 14",
      delta: -7,
      reason:
        "Decision process undocumented. Two stakeholders we have never met appeared on the last thread, and legal and redline have not been engaged.",
      convinceMe: 33,
    },
    {
      id: "tessera",
      account: "Tessera",
      arr: 95_000,
      rep: "Diego Salas",
      status: "at_risk",
      repProb: 50,
      repQuarter: "Q2 2026",
      repDate: "Jun 24, 2026",
      lastProb: 30,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 21",
      thisProb: 22,
      thisQuarter: "Q3 2026",
      thisDate: "Aug 6",
      delta: -8,
      reason:
        "Champion went quiet 14 days. No metric quantified, so the value case is still unproven.",
      convinceMe: 22,
    },
    {
      id: "vireo",
      account: "Vireo",
      arr: 240_000,
      rep: "Nina Brandt",
      status: "healthy",
      repProb: 80,
      repQuarter: "Q2 2026",
      repDate: "May 30, 2026",
      lastProb: 72,
      lastQuarter: "Q2 2026",
      lastDate: "May 30",
      thisProb: 78,
      thisQuarter: "Q2 2026",
      thisDate: "May 30",
      delta: 6,
      reason:
        "Economic buyer confirmed on last call. Last open MEDDPICC gate now closeable.",
      convinceMe: 78,
    },
  ],
  leverage: [
    {
      account: "Brightwave",
      action:
        "Get CFO David Cho into a working session this week. Your AE is working Rosa Lind in Ops, who cannot sign. Have Rosa broker the CFO introduction before Friday.",
      impacts: [
        { label: "Close probability", value: "+19 points" },
        { label: "Close date pulled in", value: "16 days" },
        { label: "Weighted forecast", value: "+$58K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "Deals at this stage that reached the economic buyer within 30 days closed on time 9 of 11 times.",
    },
    {
      account: "Parkside Group",
      action:
        "Pull this deal out of Gong's blind spot. Two of the last three buyer touches were never recorded. Get the next conversation onto a recorded call and confirm whether that competitor is really in the renewal.",
      impacts: [
        { label: "Close probability", value: "+13 points" },
        { label: "Weighted forecast", value: "+$36K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "Deals with more than 14 days of unrecorded buyer activity slip 70% of the time.",
    },
    {
      account: "Cedarline",
      action:
        "Map the paper process now. Legal and redline are not engaged, and at this deal size the contract always routes through a 30 to 45 day legal review. Ask for the procurement and legal timeline this week.",
      impacts: [
        { label: "Close probability", value: "+12 points" },
        { label: "Weighted forecast", value: "+$22K", bold: true },
      ],
      confidence: "Medium",
      confidenceNote:
        "At this deal size, an unstarted paper process by day 45 has added a full quarter on 6 of the last 7 deals.",
    },
    {
      account: "Tessera",
      action:
        "Quantify the metric or disqualify. There is no dollar value on the pain yet. Without a number, this will not survive the CFO.",
      impacts: [
        { label: "Close probability", value: "+15 points" },
        { label: "Weighted forecast", value: "+$14K", bold: true },
      ],
      confidence: "Medium",
      confidenceNote:
        "Deals with no quantified metric by stage 2 close at 12%.",
    },
  ],
  leverageSummary:
    "If these four actions land in the next 7 days, DealRipe projects forecast lifts to $1.51M, closing roughly 60% of the $1.16M gap to target. Every one of them is an economic buyer or paper process move that your current tooling currently reads as on track.",
  calibration: {
    ripeAccuracyPct: 90,
    ripeDeviationUsd: 38_000,
    ripeDeviationFloorUsd: 200_000,
    repAccuracyPct: 62,
    repOvercommitUsd: 440_000,
    dealsTrainedOn: 214,
  },
};
