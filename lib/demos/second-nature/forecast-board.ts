// ============================================================
// Second Nature — Sales-leader Forecast Board data
// ============================================================
// The live, proactive version of the week-over-week forecast sheet a
// Second Nature sales director maintains by hand. Columns mirror that
// sheet (Account, Type, Stage, Doors, Net New CARR, Rep Commit, DealRipe,
// Weighted, Close, Δ this week, Why) but the numbers are grounded in what
// the calls confirm, not what the rep logged.
//
// FICTIONAL accounts and reps in Second Nature's exact world (property
// management, doors, CARR, NEAT, Beagle/Buildium). Representative demo
// data, never a real pipeline.

export type BoardStage =
  | "Discovery"
  | "Evaluation"
  | "Vendor of Choice"
  | "Contract Out"
  | "Signed Contract"
  | "Closed Won";

export type BoardType = "New Business" | "Upsell";

export type WeekMove = "new" | "up" | "down" | "slipped" | "won" | "flat";

export type BoardDeal = {
  id: string;
  account: string;
  rep: string;
  type: BoardType;
  stage: BoardStage;
  doors: number;
  carr: number; // net new CARR
  repProb: number; // 0-100, what the rep commits
  ripeProb: number; // 0-100, DealRipe's grounded read
  repCloseDate: string;
  ripeCloseDate: string;
  repQuarter: string;
  ripeQuarter: string;
  deltaPts: number; // DealRipe week-over-week change
  move: WeekMove;
  why: string; // the reason DealRipe's read differs / what changed
};

// Open pipeline + signed + one closed-won, the way her sheet is laid out.
export const BOARD_DEALS: BoardDeal[] = [
  {
    id: "rowan-hill",
    account: "Rowan Hill Residential",
    rep: "Casey Boyd",
    type: "New Business",
    stage: "Evaluation",
    doors: 400,
    carr: 137_242,
    repProb: 25,
    ripeProb: 15,
    repCloseDate: "Jul 27",
    ripeCloseDate: "Oct 9",
    repQuarter: "Q3",
    ripeQuarter: "Q4",
    deltaPts: -10,
    move: "slipped",
    why: "Principal who signs has never been on a call; the Beagle switch was never turned into a displacement case. Authority + competition open.",
  },
  {
    id: "kestrel",
    account: "Kestrel Property Group",
    rep: "Casey Boyd",
    type: "New Business",
    stage: "Evaluation",
    doors: 352,
    carr: 122_990,
    repProb: 25,
    ripeProb: 12,
    repCloseDate: "Jul 10",
    ripeCloseDate: "Sep 30",
    repQuarter: "Q3",
    ripeQuarter: "Q4",
    deltaPts: -13,
    move: "slipped",
    why: "Eval held May 12, nothing since. Rep's close date already passed, no meeting booked, no customer activity in weeks. Likely cold.",
  },
  {
    id: "meridian",
    account: "Meridian Property Management",
    rep: "Marcus Vale",
    type: "Upsell",
    stage: "Vendor of Choice",
    doors: 210,
    carr: 162_262,
    repProb: 50,
    ripeProb: 42,
    repCloseDate: "Jul 17",
    ripeCloseDate: "Aug 5",
    repQuarter: "Q3",
    ripeQuarter: "Q3",
    deltaPts: -8,
    move: "down",
    why: "Close date is stale, the vendor-of-choice call was held Jul 22, after the date on the deal. No mutual close plan on the record.",
  },
  {
    id: "fairway",
    account: "Fairway Rental Management",
    rep: "Marcus Vale",
    type: "New Business",
    stage: "Evaluation",
    doors: 400,
    carr: 57_395,
    repProb: 25,
    ripeProb: 18,
    repCloseDate: "Jul 30",
    ripeCloseDate: "Oct 1",
    repQuarter: "Q3",
    ripeQuarter: "Q4",
    deltaPts: -7,
    move: "slipped",
    why: "Buildium incumbent on a mixed portfolio; switching question from the broker conference unresolved. Eval Apr 20, no advance.",
  },
  {
    id: "coastline",
    account: "Coastline Property Group",
    rep: "Marcus Vale",
    type: "New Business",
    stage: "Contract Out",
    doors: 262,
    carr: 94_515,
    repProb: 95,
    ripeProb: 92,
    repCloseDate: "Jul 31",
    ripeCloseDate: "Jul 31",
    repQuarter: "Q3",
    ripeQuarter: "Q3",
    deltaPts: 2,
    move: "up",
    why: "Contract out since Jun 17, decision-maker confirmed. Only the per-door value case is open. Clean.",
  },
  {
    id: "anchorline",
    account: "Anchorline Property Management",
    rep: "Marcus Vale",
    type: "New Business",
    stage: "Contract Out",
    doors: 181,
    carr: 77_394,
    repProb: 95,
    ripeProb: 94,
    repCloseDate: "Jul 10",
    ripeCloseDate: "Jul 10",
    repQuarter: "Q3",
    ripeQuarter: "Q3",
    deltaPts: 2,
    move: "up",
    why: "Ready to move, insurance line resolved. Every NEAT gate met with a quote behind it.",
  },
  {
    id: "harbor-point",
    account: "Harbor Point Property Management",
    rep: "Marcus Vale",
    type: "New Business",
    stage: "Signed Contract",
    doors: 116,
    carr: 27_709,
    repProb: 95,
    ripeProb: 95,
    repCloseDate: "Jul 6",
    ripeCloseDate: "Jul 6",
    repQuarter: "Q3",
    ripeQuarter: "Q3",
    deltaPts: 0,
    move: "flat",
    why: "Signed, mandatory across the portfolio. Awaiting counter-signature.",
  },
  {
    id: "cedar-vine",
    account: "Cedar & Vine Realty",
    rep: "Casey Boyd",
    type: "Upsell",
    stage: "Signed Contract",
    doors: 90,
    carr: 31_982,
    repProb: 95,
    ripeProb: 95,
    repCloseDate: "Jul 7",
    ripeCloseDate: "Jul 7",
    repQuarter: "Q3",
    ripeQuarter: "Q3",
    deltaPts: 0,
    move: "flat",
    why: "Signed. Order form counter-signature pending.",
  },
  {
    id: "timberline",
    account: "Timberline Property Management",
    rep: "Marcus Vale",
    type: "New Business",
    stage: "Discovery",
    doors: 150,
    carr: 44_300,
    repProb: 10,
    ripeProb: 10,
    repCloseDate: "Aug 20",
    ripeCloseDate: "Aug 20",
    repQuarter: "Q3",
    ripeQuarter: "Q3",
    deltaPts: 0,
    move: "new",
    why: "New inbound this week, discovery held. Need confirmed, everything else open.",
  },
];

// The one deal that closed this week (celebrated, out of open pipeline).
export const BOARD_CLOSED_WON = {
  account: "Brightline Property Management",
  rep: "Marcus Vale",
  carr: 86_192,
  doors: 228,
  closeDate: "Jul 6",
  note: "Closed won at the regional conference.",
};

export function repWeighted(d: BoardDeal): number {
  return Math.round((d.carr * d.repProb) / 100);
}
export function ripeWeighted(d: BoardDeal): number {
  return Math.round((d.carr * d.ripeProb) / 100);
}

// ---- Week-over-week: add / move / close ("what came in, what moved, what closed") ----
export type BucketItem = { account: string; carr: number; detail: string };

export const WEEK_BUCKETS: {
  added: BucketItem[];
  progressed: BucketItem[];
  downgraded: BucketItem[];
  slipped: BucketItem[];
  won: BucketItem[];
} = {
  added: [
    { account: "Timberline Property Management", carr: 44_300, detail: "New inbound, discovery held this week" },
  ],
  progressed: [
    { account: "Coastline Property Group", carr: 94_515, detail: "Contract out, decision-maker confirmed (+2 pts)" },
    { account: "Anchorline Property Management", carr: 77_394, detail: "Insurance line resolved, ready to move (+2 pts)" },
  ],
  downgraded: [
    { account: "Meridian Property Management", carr: 162_262, detail: "Close date stale; no mutual plan (−8 pts)" },
    { account: "Rowan Hill Residential", carr: 137_242, detail: "Owner never engaged; Beagle switch open (−10 pts)" },
    { account: "Kestrel Property Group", carr: 122_990, detail: "Gone quiet since May eval (−13 pts)" },
    { account: "Fairway Rental Management", carr: 57_395, detail: "Buildium switch unresolved (−7 pts)" },
  ],
  slipped: [
    { account: "Rowan Hill Residential", carr: 137_242, detail: "Q3 → Q4: cannot close without the owner in the room" },
    { account: "Kestrel Property Group", carr: 122_990, detail: "Q3 → Q4: no path to a signature this quarter" },
    { account: "Fairway Rental Management", carr: 57_395, detail: "Q3 → Q4: competition gate still open" },
  ],
  won: [
    { account: "Brightline Property Management", carr: 86_192, detail: "Closed won at the regional conference" },
  ],
};

// The weighted-forecast bridge (last week -> this week). Illustrative bridge.
export const WATERFALL = {
  lastWeekWeighted: 372_000,
  addedUsd: 4_000,
  progressedUsd: 3_000,
  downgradedUsd: -44_000,
  thisWeekWeighted: 335_000,
  note: "Brightline closed won ($86K) this week, out of open pipeline and into the number.",
};

// ---- Per-rep roll-up with over/under-commit calibration (the Clari move) ----
export type RepRoll = {
  rep: string;
  openDeals: number;
  openCarr: number;
  repCommitWeighted: number; // sum of carr * repProb
  ripeForecastWeighted: number; // sum of carr * ripeProb
  bias: "over-commits" | "under-commits" | "calibrated";
  biasPct: number; // + = over-commits, - = under-commits (historical)
  // historical calibration bar: of every $100 this rep commits, how much lands
  landsPerHundred: number;
  note: string;
};

export const REP_ROLLUP: RepRoll[] = [
  {
    rep: "Casey Boyd",
    openDeals: 3,
    openCarr: 292_214, // Rowan + Kestrel + Cedar & Vine
    repCommitWeighted: 95_442,
    ripeForecastWeighted: 65_728,
    bias: "over-commits",
    biasPct: 24,
    landsPerHundred: 76,
    note: "Commits deals before the economic buyer is engaged. Over the last 8 quarters, $100 of Casey's commit has landed at ~$76. Discount her number, and coach the authority gap early.",
  },
  {
    rep: "Marcus Vale",
    openDeals: 6,
    openCarr: 463_866,
    repCommitWeighted: 289_547,
    ripeForecastWeighted: 268_939,
    bias: "calibrated",
    biasPct: -3,
    landsPerHundred: 103,
    note: "Slightly sandbags. $100 of Marcus's commit has landed at ~$103. His number is trustworthy; if anything, there is upside in what he is holding back.",
  },
];

// Top-strip numbers (weighted, this month), mirroring her sheet header.
export const BOARD_SUMMARY = {
  month: "July 2026",
  weekOf: "Week of Jul 27",
  totalOpenPipeline: 755_789,
  repCommitWeighted: 384_989,
  ripeForecastWeighted: 334_667,
  deltaWeighted: -50_322,
  openDeals: 9,
  doors: 2_161,
  closedWonThisMonth: 86_192,
};
