import type { ForecastTenant } from "../types";

/**
 * Prospect demo: Keelson (fictional).
 *
 * A mid-market logistics software company (10 to 50 reps, on Salesforce, no
 * RevOps) selling its freight and customs platform to freight forwarders,
 * customs brokers, and 3PLs. This is the DealRipe ICP. All names, deals, and
 * numbers are invented for the demo. NEVER a real customer's data.
 *
 * The reasons and next steps mirror the failure modes DealRipe actually
 * surfaces: an economic buyer who signs but has never been on a call, a
 * no-show that means a deal went cold, a competitor named and never
 * addressed, procurement not engaged at the point in the cycle it always is.
 *
 * Each leverage action carries an `execution`: the email, meeting, or task
 * DealRipe drafts so the rep can act in one click.
 */
export const KEELSON: ForecastTenant = {
  slug: "keelson",
  name: "Keelson",
  product: "Freight and customs software for mid-market logistics",
  framework: "Scotsman",
  weekOf: "Jul 20, 2026",
  lastUpdatedAgo: "8 minutes ago",
  changedCount: 3,
  numbers: {
    quarterTargetUsd: 2_500_000,
    quarterLabel: "Q3 2026",
    ripeForecastUsd: 1_290_000,
    repCommitUsd: 1_660_000,
  },
  movements: [
    {
      id: "cascade-freight",
      account: "Cascade Freight Systems",
      industry: "Freight forwarding, US West Coast",
      productContext: "Keelson customs and freight module for cross-border shipments",
      arr: 420_000,
      rep: "Dana Reyes",
      status: "at_risk",
      repProb: 88,
      repQuarter: "Q3 2026",
      repDate: "Aug 22, 2026",
      lastProb: 70,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 12",
      thisProb: 58,
      thisQuarter: "Q4 2026",
      thisDate: "Oct 15",
      delta: -12,
      reason:
        "The VP of Operations who signs off on a purchase this size has never been on a call. Dana sent pricing before the economic buyer was engaged. Authority gate downgraded from green to amber, and this ACV always slips a quarter when the signer is not in the room by proposal.",
      convinceMe: 58,
    },
    {
      id: "delmar-customs",
      account: "Delmar Customs Brokerage",
      industry: "Customs brokerage, Gulf Coast",
      productContext: "Keelson entry filing and compliance automation",
      arr: 180_000,
      rep: "Tom Fielding",
      status: "at_risk",
      repProb: 55,
      repQuarter: "Q3 2026",
      repDate: "Sep 5, 2026",
      lastProb: 55,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 8",
      thisProb: 40,
      thisQuarter: "Q3 2026",
      thisDate: "Sep 30",
      delta: -8,
      reason:
        "Last scheduled call was a no-show and no one from Delmar has responded in 9 days. Stage clock still running. This deal may have gone cold and the forecast has not caught up.",
      convinceMe: 40,
    },
    {
      id: "pacific-cargo",
      account: "Pacific Cargo Group",
      industry: "3PL, national",
      productContext: "Keelson warehouse and freight visibility suite",
      arr: 320_000,
      rep: "Priya Nair",
      status: "at_risk",
      repProb: 62,
      repQuarter: "Q3 2026",
      repDate: "Aug 29, 2026",
      lastProb: 58,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 15",
      thisProb: 47,
      thisQuarter: "Q3 2026",
      thisDate: "Sep 20",
      delta: -11,
      reason:
        "A competing WMS was named on the last call and never addressed. Competition gate is open with no displacement narrative in the notes. Deals that carry an unhandled competitor into negotiation close at half the rate.",
      convinceMe: 47,
    },
    {
      id: "summit-logistics",
      account: "Summit Logistics",
      industry: "Freight forwarding, Midwest",
      productContext: "Keelson customs module plus freight billing",
      arr: 250_000,
      rep: "Alex Moreno",
      status: "stalled",
      repProb: 60,
      repQuarter: "Q3 2026",
      repDate: "Aug 15, 2026",
      lastProb: 54,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 18",
      thisProb: 49,
      thisQuarter: "Q3 2026",
      thisDate: "Jul 25",
      delta: -5,
      reason:
        "Champion changed roles internally and procurement is still not engaged at day 62, past the point this ACV always routes through it. No new call in 8 days.",
      convinceMe: 49,
    },
    {
      id: "anchor-freight",
      account: "Anchor Freight Forwarding",
      industry: "Freight forwarding, Northeast",
      productContext: "Keelson full platform, 40 seats",
      arr: 510_000,
      rep: "Dana Reyes",
      status: "healthy",
      repProb: 92,
      repQuarter: "Q3 2026",
      repDate: "Aug 8, 2026",
      lastProb: 89,
      lastQuarter: "Q3 2026",
      lastDate: "Aug 8",
      thisProb: 94,
      thisQuarter: "Q3 2026",
      thisDate: "Aug 8",
      delta: 3,
      reason:
        "Every Scotsman gate is met with a customer quote behind it. Procurement is aligned and the signer has been in the room twice. DealRipe flags this as a clean commit.",
      convinceMe: 94,
    },
    {
      id: "vantage-supply",
      account: "Vantage Supply Chain",
      industry: "3PL, Southeast",
      productContext: "Keelson freight visibility suite",
      arr: 210_000,
      rep: "Priya Nair",
      status: "healthy",
      repProb: 84,
      repQuarter: "Q3 2026",
      repDate: "Aug 12, 2026",
      lastProb: 76,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 20",
      thisProb: 80,
      thisQuarter: "Q3 2026",
      thisDate: "Aug 12",
      delta: 4,
      reason:
        "Decision maker confirmed on the last call and the last open gate is now closeable. Clean profile forming.",
      convinceMe: 80,
    },
  ],
  leverage: [
    {
      account: "Cascade Freight Systems",
      action:
        "Get the VP of Operations into a working session before any proposal goes out. Dana has a warm champion; ask him to broker a 30-minute call this week. The signer has never been on a call, and this ACV does not close without them in the room.",
      impacts: [
        { label: "Close probability", value: "+16 points" },
        { label: "Close date pulled in", value: "21 days" },
        { label: "Weighted forecast", value: "+$54K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "Deals at this ACV that engaged the economic buyer before proposal closed on time 7 of 8 times last year.",
      execution: {
        kind: "email",
        buttonLabel: "Draft the email",
        to: "Ray Delgado, Ops Manager, Cascade Freight",
        subject: "One ask before we send pricing",
        body:
          "Hi Ray,\n\nBefore I send pricing over, I want to make sure Elena (VP Operations) has seen how Keelson handles your cross-border customs flow, since she'll be signing off.\n\nCould you help me get 30 minutes with her and you this week? I'll keep it tight: a five-minute walkthrough of the customs module on your actual lanes, then her questions.\n\nHappy to work around her calendar. Would Thursday or Friday morning work?\n\nBest,\nDana",
      },
    },
    {
      account: "Delmar Customs Brokerage",
      action:
        "Re-book the missed call directly with the economic buyer today, not the champion. Send two concrete time windows and a one-line reason to meet. Nine days of silence after a no-show is where these deals die quietly.",
      impacts: [
        { label: "Close probability", value: "+10 points" },
        { label: "Weighted forecast", value: "+$18K", bold: true },
      ],
      confidence: "Medium",
      confidenceNote:
        "Deals re-engaged within 3 days of a no-show recover at 2x the rate of those left to the next scheduled touch.",
      execution: {
        kind: "meeting",
        buttonLabel: "Re-book the meeting",
        title: "Delmar / Keelson — customs automation review",
        withWhom: "Marcus Hale, President, Delmar Customs Brokerage",
        note:
          "Re-booking after last week's no-show. Sending directly to Marcus, the signer, not the champion, with a one-line reason to meet.",
        calendar: {
          monthLabel: "July 2026",
          year: 2026,
          monthIndex: 6,
          days: [
            { day: 22, slots: ["10:00 AM PT", "11:30 AM PT"] },
            { day: 23, slots: ["1:30 PM PT", "3:00 PM PT"] },
            { day: 24, slots: ["9:00 AM PT"] },
          ],
        },
      },
    },
    {
      account: "Pacific Cargo Group",
      action:
        "Surface the competitive displacement now. Priya should send a tailored walkthrough of Keelson versus the named WMS and confirm the specific gap on the next call. The Competition gate cannot close without it.",
      impacts: [
        { label: "Close probability", value: "+12 points" },
        { label: "Weighted forecast", value: "+$30K", bold: true },
      ],
      confidence: "Medium",
      confidenceNote:
        "Deals where the Competition gate closes by stage 3 win at 1.6x the rate of deals where it stays open.",
      execution: {
        kind: "loom",
        buttonLabel: "Draft the Loom",
        reason:
          "DealRipe suggested a Loom here because you've closed similar competitive evals by sending a tailored comparison video. It drafted the outline and the email to send it with.",
        videoTitle: "Keelson vs your current WMS — for Sandra's team",
        outline: [
          "Open on the three things Sandra flagged: real-time customs status, multi-warehouse visibility, and freight billing.",
          "Show the customs status view live on a lane like theirs.",
          "Go side-by-side with the incumbent WMS: name where they're stronger, then where Keelson wins for a 3PL their size.",
          "Close on the one gap that matters to Pacific: customs and freight billing in one system, no integration to maintain.",
        ],
        email: {
          to: "Sandra Ng, Director of Operations, Pacific Cargo Group",
          subject: "A 4-minute walkthrough: Keelson vs your current WMS",
          body:
            "Hi Sandra,\n\nYou asked how Keelson stacks up against your current WMS on the three things that matter to your team. Rather than another deck, I recorded a short walkthrough on a lane like yours.\n\n[Loom link]\n\nIt's honest about where they're stronger and clear on where we win for a 3PL your size. Happy to go deeper on the next call.\n\nBest,\nPriya",
        },
      },
    },
    {
      account: "Summit Logistics",
      action:
        "Re-engage the new champion and open procurement this week. This ACV always routes through procurement by day 60 and we are past it with no contact.",
      impacts: [
        { label: "Close probability", value: "+14 points" },
        { label: "Weighted forecast", value: "+$26K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "8 of 8 deals at this ACV in the last 6 quarters went through procurement before close.",
      execution: {
        kind: "task",
        buttonLabel: "Open the task",
        title: "Re-engage Summit and open procurement",
        detail:
          "1. Intro call with Dana Whitfield, the new Director of Operations replacing the champion who moved roles.\n2. Ask Dana to loop in procurement now. This ACV always routes through them and we are at day 62.\n3. Send the security and DPA packet ahead so procurement is not the bottleneck.",
      },
    },
    {
      account: "Anchor Freight Forwarding",
      action:
        "Lock the signing date. All gates are met with evidence and the signer is aligned. Push for signature in the next 10 days before the quarter rolls.",
      impacts: [
        { label: "Close probability", value: "+6 points" },
        { label: "Close date pulled in", value: "11 days" },
        { label: "Weighted forecast", value: "+$28K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "Clean gate profile: deals in this state close on time 92% of the time when pushed.",
      execution: {
        kind: "meeting",
        buttonLabel: "Book the signing call",
        title: "Anchor Freight / Keelson — signature and go-live",
        withWhom: "Tom Bianchi, COO, Anchor Freight Forwarding",
        note:
          "All gates met. Booking the signing call to lock the date before the quarter rolls.",
        calendar: {
          monthLabel: "July 2026",
          year: 2026,
          monthIndex: 6,
          days: [
            { day: 27, slots: ["9:00 AM PT", "2:00 PM PT"] },
            { day: 28, slots: ["3:00 PM PT"] },
            { day: 29, slots: ["10:30 AM PT"] },
          ],
        },
      },
    },
  ],
  leverageSummary:
    "If all five actions are completed in the next 7 days, DealRipe projects the forecast lifts to $1.46M, closing 58% of the gap to target.",
  calibration: {
    ripeAccuracyPct: 90,
    ripeDeviationUsd: 36_000,
    ripeDeviationFloorUsd: 210_000,
    repAccuracyPct: 63,
    repOvercommitUsd: 298_000,
    dealsTrainedOn: 184,
  },
};
