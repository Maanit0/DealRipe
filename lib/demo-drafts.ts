/**
 * Customer-facing email drafts for the keelson demo actions.
 *
 * The Actions / Forecast Room modals used to dump the internal coaching note into
 * the email body ("Send Sandra a side-by-side ..."), which reads like an
 * instruction to the rep, not an email to the customer. These are the real
 * outreach emails DealRipe would draft instead: addressed to the named contact,
 * grounded in the deal, and, for anything that needs a meeting, carrying concrete
 * time windows the recipient can pick from (like a scheduling email).
 *
 * Keyed by account, so it only applies to the fictional keelson deals.
 */

export type EmailDraft = { to: string; subject: string; body: string };

type DraftSpec = {
  toName: string;
  toRole: string;
  subject: string;
  intro: string[]; // paragraphs before the time options
  wantsTimes: boolean; // include concrete slots
  timesLead?: string; // sentence that introduces the slots
  outro?: string; // one paragraph after the times, before the sign-off
  signoff: string; // rep first name
};

// Upcoming weekday slots, formatted for an email ("Tue, Jul 28 · 10:00 AM PT").
export function upcomingSlots(n = 3): string[] {
  const times = ["10:00 AM PT", "1:30 PM PT", "9:00 AM PT", "3:00 PM PT"];
  const out: string[] = [];
  const d = new Date();
  let i = 0;
  while (out.length < n) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    out.push(`${day} · ${times[i % times.length]}`);
    i += 1;
  }
  return out;
}

const SPECS: Record<string, DraftSpec> = {
  "Pacific Cargo Group": {
    toName: "Sandra Ng",
    toRole: "Director of Operations at Pacific Cargo Group",
    subject: "Keelson vs your current WMS, side by side",
    intro: [
      "Following the demo, I put together a side-by-side of Keelson and your current WMS on the two lanes we walked, focused on exactly where the manual customs work goes away and what a switch would and would not touch.",
      "I would rather walk it with you live so you can poke holes in it than just send a PDF.",
    ],
    wantsTimes: true,
    timesLead: "A few 30-minute windows that work on my side:",
    signoff: "Priya",
  },
  "Delmar Customs Brokerage": {
    toName: "Marcus Hale",
    toRole: "President at Delmar Customs Brokerage",
    subject: "20 minutes to pick this back up, Delmar",
    intro: [
      "I know things got busy on your end, so no worries at all about last week.",
      "I still think there is a real case to get the manual entry work off your team before peak, and I do not want it to slip. Could we grab 20 minutes with your ops folks to scope it?",
    ],
    wantsTimes: true,
    timesLead: "Here are a few times that work for me this week:",
    signoff: "Tom",
  },
  "Cascade Freight Systems": {
    toName: "Ray Delgado",
    toRole: "Operations Manager at Cascade Freight Systems",
    subject: "Getting Elena comfortable before we lock the rollout",
    intro: [
      "Thanks again for walking the pricing, and for taking the deck into your leadership review. That is the right groundwork.",
      "Before we lock the rollout for the Q4 peak, it is worth getting Elena 30 minutes with us. She is the one signing off, and the smoothest rollouts are the ones where the person approving has seen the plan and raised any concerns early, not at signature. It also means she is shaping the timeline rather than inheriting it.",
      "I would keep it tight: go-live timing, the data-migration risk, and where her team's time is needed. Nothing you and I have not already covered.",
    ],
    wantsTimes: true,
    timesLead: "A few windows that work on my end for the three of us:",
    outro: "Happy to send Elena the invite directly if that is easier for you.",
    signoff: "Dana",
  },
  "Summit Logistics": {
    toName: "Dana Whitfield",
    toRole: "Director of Operations at Summit Logistics",
    subject: "Re-grounding Summit, and looping in procurement",
    intro: [
      "Congrats again on the new ops role. Now that you are steering this, I would like to re-ground where we are so nothing gets lost in the handover.",
      "For a project this size, procurement usually likes to be looped in early. Could we find 30 minutes, and is it worth pulling in whoever owns procurement on your side?",
    ],
    wantsTimes: true,
    timesLead: "Some times that work for me:",
    signoff: "Alex",
  },
  "Anchor Freight Forwarding": {
    toName: "Tom Bianchi",
    toRole: "COO at Anchor Freight Forwarding",
    subject: "Let's lock the signing date, Anchor",
    intro: [
      "We are in great shape: commercials are agreed and legal cleared the last redlines. The only thing left is to schedule the signature so we hold your go-live before the Q4 peak.",
      "Let's put a short signing call on the calendar.",
    ],
    wantsTimes: true,
    timesLead: "A couple of quick windows that work for me:",
    signoff: "Dana",
  },
  "Vantage Supply Chain": {
    toName: "Maya Okonkwo",
    toRole: "VP Supply Chain at Vantage Supply Chain",
    subject: "Closing out the last open item, Vantage",
    intro: [
      "Thanks for confirming you are the decision maker. It sounds like the only open item is your legal review of the agreement.",
      "Two quick things to close it out: can you point me to who owns that review on your side, and would a short call with them help me answer questions live?",
    ],
    wantsTimes: true,
    timesLead: "If a call helps, here are a few times that work for me:",
    signoff: "Priya",
  },
  "Harborview Freight": {
    toName: "Nadia Brandt",
    toRole: "CFO at Harborview Freight",
    subject: "Scheduling the signing, Harborview",
    intro: [
      "Great to have you on last week's call. With every gate but the legal review confirmed, the cleanest next step is to get the signing scheduled so we protect your timeline.",
      "Could we find a short slot this week?",
    ],
    wantsTimes: true,
    timesLead: "A few windows that work for me:",
    signoff: "Priya",
  },
  "Tidewater Distribution": {
    toName: "Owen Marsh",
    toRole: "Director of Logistics at Tidewater Distribution",
    subject: "Proposal review and confirming budget, Tidewater",
    intro: [
      "Good momentum after Tuesday. To keep it moving, I would like to confirm the budget in writing and get the proposal review on the calendar while everyone is engaged.",
      "Would a 30-minute review work in the next week or so?",
    ],
    wantsTimes: true,
    timesLead: "Some times that work on my side:",
    signoff: "Priya",
  },

  // ----- Second Nature (property management / RBP). Written the way a good AE
  // actually writes after a call: grounded in what the customer said, one clear
  // ask, no pitch language. -----
  "Rowan Hill Residential": {
    toName: "Renee Alvarez",
    toRole: "Director of Operations at Rowan Hill Residential",
    subject: "The numbers for Greg, before we talk pricing",
    intro: [
      "Something you said stuck with me: Greg won't move on a case that isn't airtight, especially after Beagle. So before we talk pricing, I want to hand you a case he can't poke holes in.",
      "I pulled the per-door math on your 400 doors, what a two-point retention lift and the drop in filter tickets is worth a year, and exactly where Beagle's rollout went sideways versus how we run ours. One page, not a deck.",
      "The next step I'd suggest is 30 minutes with Greg to walk it together. Happy for you to make the intro, or I'll frame the numbers and you fill in the context, whatever plays better with him.",
    ],
    wantsTimes: true,
    timesLead: "A few windows on my side:",
    signoff: "Casey",
  },
  "Kestrel Property Group": {
    toName: "Priya Raman",
    toRole: "Operations Director at Kestrel Property Group",
    subject: "The per-door number for your 352 doors",
    intro: [
      "I know things went quiet after the evaluation, no worries, I know what leasing season does to a calendar.",
      "Rather than a check-in, I wanted to send something useful: on 352 doors, the retention lift plus the filter-ticket drop pencils out to a real number per year, and I'd like 20 minutes to show you how we got there so you can pressure-test it.",
      "If the timing's wrong, tell me and I'll come back when it's right. But you mentioned wanting this live before September renewals, and working back from that, the window is now.",
    ],
    wantsTimes: true,
    timesLead: "Two windows this week if either works:",
    signoff: "Casey",
  },
  "Meridian Property Management": {
    toName: "Owen Marsh",
    toRole: "Managing Partner at Meridian Property Management",
    subject: "The rollout steps you asked for, in writing",
    intro: [
      "You asked for the rollout mapped before you commit, that's the right ask, so here it is in writing rather than another meeting.",
      "Working back from September renewals: order form this week, resident notices out the week after, filter program live on the first tranche of doors by mid-August, full portfolio before renewals. Each step has an owner and a date on the attached one-pager.",
      "If that sequence works for you, the only thing left is your signature on the order form. If any step doesn't sit right, tell me which and I'll rework it.",
    ],
    wantsTimes: false,
    outro: "Happy to walk it live if that's faster, but I didn't want to make you take a meeting just to see the plan.",
    signoff: "Marcus",
  },
  "Fairway Rental Management": {
    toName: "Grant Sutter",
    toRole: "Broker / Principal at Fairway Rental Management",
    subject: "How this sits on top of Buildium, no rip-and-replace",
    intro: [
      "You've asked me the same fair question twice now, at the conference and on our call, and you deserve a straight answer instead of another meeting: does this sit on top of Buildium or replace it?",
      "It sits on top. Buildium stays your system of record, nothing migrates, and the benefits package runs alongside it. I recorded a four-minute walkthrough on a mixed portfolio like yours showing exactly where each one starts and stops.",
      "Watch it whenever, and if it answers the question, let's pick the eval back up. If it doesn't, tell me what's still open and I'll address that specifically.",
    ],
    wantsTimes: false,
    signoff: "Marcus",
  },
  "Coastline Property Group": {
    toName: "Sam Ortiz",
    toRole: "Principal at Coastline Property Group",
    subject: "The per-door numbers, and locking September",
    intro: [
      "You asked to get the September date locked, so let's do that.",
      "Attached is the per-door value one-pager you wanted the numbers from, retention, filter tickets, and make-ready, on your 262 doors. It's the same math we walked, just on paper for your file.",
      "If the numbers read the way we discussed, I'd like to put the signing call on the calendar this week so go-live prep starts well before renewals.",
    ],
    wantsTimes: true,
    timesLead: "A few short windows for the signing call:",
    signoff: "Erin",
  },
  "Anchorline Property Management": {
    toName: "Jordan Diaz",
    toRole: "Owner / Principal at Anchorline Property Management",
    subject: "Yes to moving the signing up",
    intro: [
      "Got your note, and yes, let's move the signing up a week so the filter program starts before August turns. I like the urgency.",
      "Everything on my side is ready: the agreement is final, and go-live prep starts the day it's signed.",
    ],
    wantsTimes: true,
    timesLead: "Earlier windows that work on my end:",
    signoff: "Erin",
  },
  "Harbor Point Property Management": {
    toName: "Alex Mercer",
    toRole: "VP Operations at Harbor Point Property Management",
    subject: "Ready the day the counter-signature is back",
    intro: [
      "Quick one, no action needed: I know the agreement is with your counsel this week.",
      "The day it comes back, go-live prep starts, resident notices, the filter schedule, the works, so making it mandatory across the portfolio lands cleanly. If counsel has any questions, send them my way and I'll turn answers around same day.",
    ],
    wantsTimes: false,
    signoff: "Hollis",
  },
  "Brightline Property Management": {
    toName: "Monica Reyes",
    toRole: "Director of Property Operations at Brightline Property Management",
    subject: "One thing gating your September go-live",
    intro: [
      "Everything from kickoff is on track: notices are ready to go next week and the filter schedule is set for the 228 doors.",
      "The one open item is the resident and unit data export, which I know landed in limbo when your ops coordinator left. It's the only thing gating the September go-live, so here's the easy version: either name whoever should own it and I'll walk them through it in 20 minutes, or send me a read-only export and we'll handle the mapping on our side.",
      "Whichever is less work for you. I just don't want this to be the reason residents wait.",
    ],
    wantsTimes: false,
    signoff: "Erin",
  },
};

/** The composed customer-facing email for a demo account, or null if not a demo account. */
export function demoEmailDraft(account: string | null | undefined): EmailDraft | null {
  if (!account) return null;
  const spec = SPECS[account];
  if (!spec) return null;
  const first = spec.toName.split(" ")[0];
  // Blank line between each intro paragraph so the body breathes, not a wall.
  const introBlock = spec.intro.flatMap((p, i) => (i === 0 ? [p] : ["", p]));
  const lines: string[] = [`Hi ${first},`, "", ...introBlock];
  if (spec.wantsTimes) {
    lines.push("", spec.timesLead ?? "A few times that work on my side:");
    for (const t of upcomingSlots(3)) lines.push(`  •  ${t}`);
    lines.push("", "If none of those land, send a couple that do and I will make it work.");
  }
  if (spec.outro) lines.push("", spec.outro);
  lines.push("", "Best,", spec.signoff);
  return { to: `${spec.toName}, ${spec.toRole}`, subject: spec.subject, body: lines.join("\n") };
}
