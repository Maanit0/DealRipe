/**
 * Second Nature Forecast Board metadata: the columns from the sales leader's
 * hand-built spreadsheet that are not modeled on the deals table (Type, Doors,
 * her notes conventions), plus the closed-won band and per-rep calibration
 * narrative. Keyed by account / rep name; fictional demo data only.
 */

export type BoardType = "New Business" | "Upsell";

export const BOARD_META: Record<string, { type: BoardType; doors: number }> = {
  "Rowan Hill Residential": { type: "New Business", doors: 400 },
  "Kestrel Property Group": { type: "New Business", doors: 352 },
  "Meridian Property Management": { type: "Upsell", doors: 210 },
  "Fairway Rental Management": { type: "New Business", doors: 400 },
  "Coastline Property Group": { type: "New Business", doors: 262 },
  "Anchorline Property Management": { type: "New Business", doors: 181 },
  "Harbor Point Property Management": { type: "Upsell", doors: 116 },
  "Brightline Property Management": { type: "New Business", doors: 228 },
};

/** Accounts that belong in the closed-won band, not open pipeline. */
export const CLOSED_WON_ACCOUNTS = new Set(["Brightline Property Management"]);

export const CLOSED_WON_BAND = {
  account: "Brightline Property Management",
  type: "New Business" as BoardType,
  carr: 86_192,
  doors: 228,
  closeDate: "Jul 6",
  note: "Closed won at the regional conference. Onboarding kicked off Jul 20.",
};

/** Historical calibration narrative per rep (of every $100 committed, what lands). */
export const REP_CALIBRATION: Record<string, { landsPerHundred: number; note: string }> = {
  Casey: {
    landsPerHundred: 76,
    note: "Commits deals before the economic buyer is engaged. Over the last 8 quarters, $100 of Casey's commit has landed at about $76, so DealRipe discounts her number and flags the authority gap early.",
  },
  Marcus: {
    landsPerHundred: 88,
    note: "Slightly optimistic on close dates rather than deals; the dollars land, a quarter late. $100 of Marcus's commit lands at about $88 in-quarter.",
  },
  Erin: {
    landsPerHundred: 103,
    note: "Sandbags a little. $100 of Erin's commit has landed at about $103; if anything there is upside in what she holds back.",
  },
  Hollis: {
    landsPerHundred: 97,
    note: "Calibrated. $100 of Hollis's commit lands at about $97; his number is trustworthy as filed.",
  },
};
