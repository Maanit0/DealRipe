import type { ForecastTenant } from "../types";

/**
 * Prospect demo: Second Nature (built for Alisha O'Loughlin + Laura Hall).
 *
 * Second Nature sells a Resident Benefits Package (RBP) to residential
 * property-management companies. The book below is modeled on Second Nature's
 * world, property management, doors, CARR, NEAT, upsell + new business, the
 * Beagle/Buildium switching dynamic, but every account name and rep name is
 * FICTIONAL. We never reproduce a prospect's real pipeline data; this is a
 * representative pipeline in their exact shape.
 *
 * Framework is NEAT (Need, Economic impact, Access to authority, Timeline).
 * CRM is Salesforce (Gong does not write back to it). Calls record on Zoom.
 * Unit of value is a door (a managed rental unit); CARR is contracted ARR.
 *
 * The failure modes mirror what actually slips a property-management RBP deal:
 * the principal/owner who signs a portfolio-wide rollout has never been on a
 * call (only the on-site ops lead is engaged), an incumbent (Beagle, Buildium)
 * named and never displaced, a close date the rep left stale, and a deal gone
 * quiet with the stage clock still running. Every leverage action carries an
 * `execution`: the email, meeting, task, or Loom DealRipe drafts so the rep
 * acts in one click. Representative demo data, never a live integration.
 */
export const SECOND_NATURE: ForecastTenant = {
  slug: "second-nature",
  name: "Second Nature",
  product: "Resident Benefits Package for residential property management",
  framework: "NEAT",
  weekOf: "Jul 27, 2026",
  lastUpdatedAgo: "6 minutes ago",
  changedCount: 4,
  numbers: {
    quarterTargetUsd: 1_500_000,
    quarterLabel: "Q3 2026",
    ripeForecastUsd: 918_000,
    repCommitUsd: 1_140_000,
  },
  movements: [
    {
      id: "rowan-hill",
      account: "Rowan Hill Residential",
      industry: "Residential property management, Midwest",
      productContext: "RBP across 400 doors, displacing an incumbent (Beagle)",
      arr: 137_242,
      rep: "Casey Boyd",
      status: "at_risk",
      repProb: 25,
      repQuarter: "Q3 2026",
      repDate: "Jul 27, 2026",
      lastProb: 25,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 7",
      thisProb: 15,
      thisQuarter: "Q4 2026",
      thisDate: "Oct 9",
      delta: -10,
      reason:
        "The principal who signs a portfolio-wide RBP switch has never been on a call. Only the on-site ops lead is engaged. And the bad Beagle experience that opened the door was never turned into a displacement case, so the switching objection is still open. Access-to-authority and the competitive switch are both unaddressed, and Evaluation-stage deals this size that carry an unhandled incumbent into pricing close at about half the rate.",
      convinceMe: 15,
    },
    {
      id: "kestrel-property",
      account: "Kestrel Property Group",
      industry: "Residential property management, Midwest",
      productContext: "RBP across 352 doors",
      arr: 122_990,
      rep: "Casey Boyd",
      status: "stalled",
      repProb: 25,
      repQuarter: "Q3 2026",
      repDate: "Jul 10, 2026",
      lastProb: 25,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 7",
      thisProb: 12,
      thisQuarter: "Q4 2026",
      thisDate: "Sep 30",
      delta: -13,
      reason:
        "Evaluation was held May 12 and nothing has moved since. The rep's close date of July 10 has already passed with no next meeting booked and no customer-side activity in weeks. The deal may be cold and the forecast has not caught up.",
      convinceMe: 12,
    },
    {
      id: "meridian-property",
      account: "Meridian Property Management",
      industry: "Residential property management, Mid-Atlantic",
      productContext: "RBP upsell, expanding managed doors",
      arr: 162_262,
      rep: "Marcus Vale",
      status: "at_risk",
      repProb: 50,
      repQuarter: "Q3 2026",
      repDate: "Jul 17, 2026",
      lastProb: 50,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 7",
      thisProb: 42,
      thisQuarter: "Q3 2026",
      thisDate: "Aug 5",
      delta: -8,
      reason:
        "Rep has this at Vendor of Choice closing July 17, but the vendor-of-choice conversation was actually held July 22, after the close date still on the deal. The date is stale and there is no mutual close plan on the record. A high-value upsell drifting on a date nobody updated.",
      convinceMe: 42,
    },
    {
      id: "fairway-rental",
      account: "Fairway Rental Management",
      industry: "Residential property management, mixed portfolio",
      productContext: "RBP across 400 doors on a Buildium-managed portfolio",
      arr: 57_395,
      rep: "Marcus Vale",
      status: "stalled",
      repProb: 25,
      repQuarter: "Q3 2026",
      repDate: "Jul 30, 2026",
      lastProb: 25,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 7",
      thisProb: 18,
      thisQuarter: "Q4 2026",
      thisDate: "Oct 1",
      delta: -7,
      reason:
        "Buildium is the incumbent across a mixed portfolio and the switching question raised at the broker conference was never resolved. Evaluation held April 20 with no advance since. Competition gate open, timeline drifting.",
      convinceMe: 18,
    },
    {
      id: "coastline-property",
      account: "Coastline Property Group",
      industry: "Residential property management, inbound",
      productContext: "RBP across 262 doors",
      arr: 94_515,
      rep: "Marcus Vale",
      status: "healthy",
      repProb: 95,
      repQuarter: "Q3 2026",
      repDate: "Jul 31, 2026",
      lastProb: 90,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 7",
      thisProb: 92,
      thisQuarter: "Q3 2026",
      thisDate: "Jul 31",
      delta: 2,
      reason:
        "Inbound deal, contract out since June 17. Decision-maker confirmed and the last open item is a quantified per-door value case. Clean profile; push for signature before month-end.",
      convinceMe: 92,
    },
    {
      id: "anchorline-property",
      account: "Anchorline Property Management",
      industry: "Residential property management, Southeast",
      productContext: "RBP with bi-monthly filter delivery; $300K insurance line",
      arr: 77_394,
      rep: "Marcus Vale",
      status: "healthy",
      repProb: 95,
      repQuarter: "Q3 2026",
      repDate: "Jul 10, 2026",
      lastProb: 92,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 7",
      thisProb: 94,
      thisQuarter: "Q3 2026",
      thisDate: "Jul 10",
      delta: 2,
      reason:
        "Contract out since June 16, customer signaled ready to move and the insurance line is resolved. Every NEAT gate is met with a customer quote behind it. DealRipe flags this as a clean commit.",
      convinceMe: 94,
    },
  ],
  leverage: [
    {
      account: "Rowan Hill Residential",
      action:
        "Get the principal into a working session before any pricing goes out, and turn the bad Beagle experience into a displacement case on the same call. Casey has a warm ops champion; have her ask the champion to broker 30 minutes with the owner, framed around the per-door retention and make-ready numbers. This portfolio-wide switch does not close without the signer in the room and the incumbent objection put to bed.",
      impacts: [
        { label: "Close probability", value: "+17 points" },
        { label: "Close date pulled in", value: "24 days" },
        { label: "Weighted forecast", value: "+$23K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "RBP deals at this door count that engaged the owner before pricing, with the incumbent switch addressed, closed on time 7 of 8 times last year.",
      execution: {
        kind: "email",
        buttonLabel: "Draft the email",
        to: "Ops lead, Rowan Hill Residential",
        subject: "One thing before we talk pricing",
        body:
          "Hi,\n\nBefore I put numbers in front of you, I want to make sure whoever owns the portfolio-wide call has seen how the resident benefits package actually lands, especially given the Beagle experience you mentioned.\n\nCould you help me get 30 minutes with the principal and you this week? I'll keep it tight: the per-door retention and make-ready math on your 400 doors, then a straight read on where we're different from Beagle so that's not an open question when it's time to sign.\n\nHappy to work around their calendar. Would Thursday or Friday morning work?\n\nBest,\nCasey",
      },
    },
    {
      account: "Kestrel Property Group",
      action:
        "Re-open this today with a specific reason to meet, not a check-in. Evaluation was seven weeks ago and the close date already passed. Send two concrete windows and the one number that would move it. Deals left quiet after a stalled eval die on the vine.",
      impacts: [
        { label: "Close probability", value: "+11 points" },
        { label: "Weighted forecast", value: "+$16K", bold: true },
      ],
      confidence: "Medium",
      confidenceNote:
        "Stalled evals re-engaged with a quantified reason to meet recover at roughly 2x the rate of a generic follow-up.",
      execution: {
        kind: "meeting",
        buttonLabel: "Re-book the meeting",
        title: "Kestrel Property Group / Second Nature — RBP impact review",
        withWhom: "Champion, Kestrel Property Group",
        note:
          "Re-opening after a stalled May evaluation. Leading with the per-door retention and filter-ticket numbers, not a status check, so there is a real reason to take the meeting.",
        calendar: {
          monthLabel: "July 2026",
          year: 2026,
          monthIndex: 6,
          days: [
            { day: 28, slots: ["10:00 AM CT", "1:30 PM CT"] },
            { day: 29, slots: ["9:00 AM CT", "3:00 PM CT"] },
            { day: 30, slots: ["11:00 AM CT"] },
          ],
        },
      },
    },
    {
      account: "Meridian Property Management",
      action:
        "Fix the date and set a mutual close plan on the next touch. The vendor-of-choice call already happened; there is no reason this sits at a passed close date with no agreed path to signature. Confirm the steps and dates back from go-live with the buyer, in writing.",
      impacts: [
        { label: "Close probability", value: "+12 points" },
        { label: "Weighted forecast", value: "+$19K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "Upsells at Vendor of Choice with a written mutual close plan close on time 3x more often than those tracked on the rep's date alone.",
      execution: {
        kind: "task",
        buttonLabel: "Open the task",
        title: "Set the mutual close plan and correct the date",
        detail:
          "1. Update the close date; the July 17 date is stale (VoC was held July 22).\n2. Send the buyer a written mutual close plan: security review, order form, signature, and go-live, with a date on each, worked back from their target.\n3. Confirm who signs the upsell and whether anyone new has to approve an expansion at this ACV.",
      },
    },
    {
      account: "Fairway Rental Management",
      action:
        "Surface the Buildium displacement now instead of waiting for another meeting. Send a tailored walkthrough of how the RBP sits alongside a Buildium-managed portfolio and where it wins, and confirm the specific integration concern on the next call. The Competition gate cannot close while that question is open.",
      impacts: [
        { label: "Close probability", value: "+10 points" },
        { label: "Weighted forecast", value: "+$9K", bold: true },
      ],
      confidence: "Medium",
      confidenceNote:
        "RBP deals where the incumbent question is resolved by mid-cycle win at about 1.6x the rate of those that carry it to negotiation.",
      execution: {
        kind: "loom",
        buttonLabel: "Draft the Loom",
        reason:
          "DealRipe suggested a Loom here because your team has closed similar mixed-portfolio evals by sending a short, tailored comparison rather than scheduling another call. It drafted the outline and the email to send it with.",
        videoTitle: "Second Nature RBP alongside your Buildium portfolio",
        outline: [
          "Open on the mixed-portfolio reality: RBP runs on top of Buildium, it does not replace your PM software.",
          "Show the per-door resident experience on a slice of doors like theirs.",
          "Name where Buildium's own tools stop and where the benefits package picks up: filters, retention, resident services.",
          "Close on the one concern from the broker conference: no rip-and-replace, no integration to maintain.",
        ],
        email: {
          to: "Champion, Fairway Rental Management",
          subject: "A 4-minute look: RBP on a Buildium portfolio",
          body:
            "Hi,\n\nYou raised a fair question at the conference about how this fits a Buildium-managed portfolio. Rather than book another call, I recorded a short walkthrough on a slice of doors like yours.\n\n[Loom link]\n\nIt's clear about what stays in Buildium and what the resident benefits package adds on top, no rip-and-replace. Happy to go deeper whenever works.\n\nBest,\nMarcus",
        },
      },
    },
    {
      account: "Coastline Property Group",
      action:
        "Lock the signing date. Contract has been out since mid-June and the only open item is the per-door value case. Deliver the one-pager and push for signature before the month rolls.",
      impacts: [
        { label: "Close probability", value: "+5 points" },
        { label: "Close date pulled in", value: "9 days" },
        { label: "Weighted forecast", value: "+$14K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "Contract-out deals with the value case delivered close on time about 9 of 10 times when pushed.",
      execution: {
        kind: "meeting",
        buttonLabel: "Book the signing call",
        title: "Coastline Property Group / Second Nature — value case and signature",
        withWhom: "Decision-maker, Coastline Property Group",
        note:
          "Contract out since June 17. Booking the signing call to deliver the per-door value one-pager and lock the date before month-end.",
        calendar: {
          monthLabel: "July 2026",
          year: 2026,
          monthIndex: 6,
          days: [
            { day: 28, slots: ["9:00 AM ET", "2:00 PM ET"] },
            { day: 29, slots: ["11:30 AM ET"] },
            { day: 30, slots: ["10:00 AM ET", "3:30 PM ET"] },
          ],
        },
      },
    },
  ],
  leverageSummary:
    "If all five actions are completed in the next 7 days, DealRipe projects the forecast lifts to $1.06M, closing 50% of the gap to target, with the two stalled deals either re-engaged or honestly pushed to Q4 so the quarter number reflects what is real.",
  calibration: {
    ripeAccuracyPct: 89,
    ripeDeviationUsd: 41_000,
    ripeDeviationFloorUsd: 180_000,
    repAccuracyPct: 61,
    repOvercommitUsd: 322_000,
    dealsTrainedOn: 142,
  },
};
