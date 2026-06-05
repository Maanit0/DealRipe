import type { ForecastTenant } from "../types";

export const AWARE: ForecastTenant = {
  slug: "aware",
  name: "Aware, Inc.",
  product: "Biometric authentication and identity verification",
  framework: "DUCT",
  weekOf: "May 18, 2026",
  lastUpdatedAgo: "9 minutes ago",
  changedCount: 4,
  numbers: {
    quarterTargetUsd: 2_500_000,
    quarterLabel: "Q2 2026",
    ripeForecastUsd: 1_330_000,
    repCommitUsd: 1_600_000,
  },
  movements: [
    {
      id: "banco-patagonia",
      account: "Banco Patagonia",
      industry: "Retail bank, Latin America",
      productContext: "Knomi mobile authentication for remote customer onboarding",
      arr: 480_000,
      rep: "Erica Klein",
      status: "at_risk",
      repProb: 78,
      repQuarter: "Q2 2026",
      repDate: "Jun 28, 2026",
      lastProb: 78,
      lastQuarter: "Q2 2026",
      lastDate: "Jun 28",
      thisProb: 71,
      thisQuarter: "Q3 2026",
      thisDate: "Aug 12",
      delta: -7,
      reason:
        "Customer said 'before our fiscal close' on April 7 call. Erica logged Q2 close from Head of Digital signal. Procurement not yet contacted. Banco Patagonia procurement adds 60 to 90 days on Knomi-scale contracts. DUCT Timing gate downgraded from green to amber.",
      convinceMe: 60,
    },
    {
      id: "us-customs",
      account: "U.S. Customs Border Modality Program",
      industry: "Government, border management",
      productContext:
        "AwareABIS multi modal biometric identification for border crossings",
      arr: 1_200_000,
      rep: "Jimmy Park",
      status: "at_risk",
      repProb: 32,
      repQuarter: "Q3 2026",
      repDate: "Aug 15, 2026",
      lastProb: 32,
      lastQuarter: "Q3 2026",
      lastDate: "Aug 15",
      thisProb: 25,
      thisQuarter: "Q4 2026",
      thisDate: "Nov 30",
      delta: -7,
      reason:
        "Day 41 of typical 60 to 90 day federal procurement cycle. Contracting officer not yet contacted on $1.2M contract. Decision Authority gate remains open. Slips one quarter at minimum.",
      convinceMe: 25,
    },
    {
      id: "pinnacle-health",
      account: "Pinnacle Health Network",
      industry: "Healthcare, multi state hospital system",
      productContext: "Knomi for EPCS prescriber authentication",
      arr: 310_000,
      rep: "Jimmy Park",
      status: "at_risk",
      repProb: 58,
      repQuarter: "Q2 2026",
      repDate: "Jun 30, 2026",
      lastProb: 58,
      lastQuarter: "Q2 2026",
      lastDate: "Jun 30",
      thisProb: 50,
      thisQuarter: "Q3 2026",
      thisDate: "Aug 22",
      delta: -8,
      reason:
        "Customer asking for on device matching but rep scoped server side architecture. Use Case gate flipped from amber to red. Mismatch on Knomi deployment model.",
      convinceMe: 50,
    },
    {
      id: "heritage-trust",
      account: "Heritage Trust Bank",
      industry: "Financial services, regional U.S. bank",
      productContext:
        "Knomi for KYC remote account opening plus AML transaction authentication",
      arr: 620_000,
      rep: "Erica Klein",
      status: "stalled",
      repProb: 41,
      repQuarter: "Q3 2026",
      repDate: "Jul 18, 2026",
      lastProb: 41,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 18",
      thisProb: 38,
      thisQuarter: "Q3 2026",
      thisDate: "Jul 25",
      delta: -3,
      reason:
        "Champion confirmed but Competition gate partial. FaceTec and Oz Forensics named in evaluation last week. No displacement strategy documented in deal notes.",
      convinceMe: 55,
    },
    {
      id: "riverside-sheriff",
      account: "Riverside County Sheriff",
      industry: "Law enforcement, county level",
      productContext:
        "AFIX Tracker for fingerprint, palmprint, and latent print identification",
      arr: 340_000,
      rep: "Marcus Webb",
      status: "healthy",
      repProb: 67,
      repQuarter: "Q2 2026",
      repDate: "May 28, 2026",
      lastProb: 67,
      lastQuarter: "Q2 2026",
      lastDate: "May 28",
      thisProb: 72,
      thisQuarter: "Q2 2026",
      thisDate: "May 28",
      delta: 5,
      reason:
        "Sheriff and IT lead confirmed in last call. Decision Authority gate now green. Clean commit forming.",
      convinceMe: 78,
    },
    {
      id: "apex-logistics",
      account: "Apex Logistics",
      industry: "Enterprise security, mid market logistics",
      productContext:
        "AwareID for workforce authentication and physical access control",
      arr: 220_000,
      rep: "Marcus Webb",
      status: "healthy",
      repProb: 80,
      repQuarter: "Q2 2026",
      repDate: "Apr 30, 2026",
      lastProb: 80,
      lastQuarter: "Q2 2026",
      lastDate: "Apr 30",
      thisProb: 84,
      thisQuarter: "Q2 2026",
      thisDate: "Apr 30",
      delta: 4,
      reason:
        "All four DUCT gates evidenced. Marcus Webb pattern: clean operator profile.",
      convinceMe: 84,
    },
  ],
  leverage: [
    {
      account: "Banco Patagonia",
      action:
        "Recalibrate timing with Adriana Vega, Banco Patagonia's Head of Digital. On April 7 call she said 'we want this in production before our fiscal close.' Erica logged Q2 close, but Adriana speaks for the digital team, not procurement. Banco Patagonia's procurement adds 60 to 90 days minimum on Knomi-scale contracts. Get written timeline confirmation from procurement before next technical review.",
      impacts: [
        { label: "Close probability", value: "+14 points" },
        { label: "Clarity gained", value: "21 days" },
        { label: "Weighted forecast", value: "+$48K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "7 of last 9 LATAM banking deals required procurement timeline confirmation separate from digital team signal before close commitment.",
    },
    {
      account: "U.S. Customs Border Modality Program",
      action:
        "Engage Operations program lead and contracting officer now. Adam Reyes is IT Director, no signing authority on $1M+ federal contracts. We are at day 41 on a 60 to 90 day procurement cycle.",
      impacts: [
        { label: "Close probability", value: "+18 points" },
        { label: "Weighted forecast", value: "+$76K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "Every federal contract above $1M in last 8 quarters required program lead and contracting officer engagement before signing.",
    },
    {
      account: "Pinnacle Health Network",
      action:
        "Re scope to on device Knomi D architecture or disqualify. Customer wants on device matching for EPCS compliance. Rep scoped server side Knomi S which mismatches their HIPAA posture.",
      impacts: [
        {
          label: "Loss avoidance",
          value: "$48K weighted forecast",
          bold: true,
        },
        {
          label: "Rep hours saved",
          value: "60 hours over Q3 if disqualified",
        },
      ],
      confidence: "Medium",
      confidenceNote:
        "Three of last four EPCS deals at Aware closed lost when deployment model was misaligned at validation stage.",
    },
    {
      account: "Heritage Trust Bank",
      action:
        "Surface FaceTec and Oz Forensics displacement strategy. Champion is friendly but Competition gate cannot close without a clear competitive narrative. Marcus Webb pattern: “who else made the shortlist and what is their gap?”",
      impacts: [
        { label: "Close probability", value: "+11 points" },
        { label: "Weighted forecast", value: "+$26K", bold: true },
      ],
      confidence: "Medium",
      confidenceNote:
        "Deals where Competition gate closes by stage 3 win at 1.6x the rate of deals where it stays open into negotiation.",
    },
    {
      account: "Riverside County Sheriff",
      action:
        "Lock signing date. All four DUCT gates green. Sheriff and IT lead confirmed. Push for AFIX Tracker signature in next 14 days before quarter roll.",
      impacts: [
        { label: "Close probability", value: "+6 points" },
        { label: "Close date pulled in", value: "9 days" },
        { label: "Weighted forecast", value: "+$22K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "Clean DUCT operator profile: 92% of deals at this gate state close on time when pushed.",
    },
  ],
  leverageSummary:
    "If all five actions are completed in the next 7 days, DealRipe projects forecast lifts to $1.45M, closing 55% of the gap to target.",
  calibration: {
    ripeAccuracyPct: 89,
    ripeDeviationUsd: 41_000,
    ripeDeviationFloorUsd: 250_000,
    repAccuracyPct: 61,
    repOvercommitUsd: 268_000,
    dealsTrainedOn: 184,
  },
};
