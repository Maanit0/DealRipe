import type { ForecastTenant } from "../types";

/**
 * DEMO TEMPLATE -- copy this folder to lib/demos/<prospect>/ and fill it in,
 * then register it in lib/demos/index.ts (one import + one line in DEMOS).
 *
 * Everything here is illustrative. NEVER paste one customer's private numbers
 * into a demo shown to a different prospect. Pull realistic figures from the
 * prospect's own discovery-call transcript instead.
 */
export const TEMPLATE: ForecastTenant = {
  slug: "template", // unique, lowercase; this is the ?tenant= value in the URL
  name: "Acme Co.", // prospect company name
  product: "One-line product context shown in the top bar",
  framework: "Scotsman", // must be a framework the engine knows ("Scotsman" | "DUCT")
  weekOf: "Mon DD, YYYY",
  lastUpdatedAgo: "12 minutes ago",
  changedCount: 0,
  numbers: {
    quarterTargetUsd: 0,
    quarterLabel: "Q_ YYYY",
    ripeForecastUsd: 0,
    repCommitUsd: 0,
  },
  movements: [
    // One entry per deal shown in the forecast view. See ../topsort for examples.
  ],
  leverage: [
    // Prescriptive "do this next" actions. See ../topsort for examples.
  ],
  leverageSummary: "One paragraph shown beneath the leverage cards.",
  calibration: {
    ripeAccuracyPct: 0,
    ripeDeviationUsd: 0,
    ripeDeviationFloorUsd: 0,
    repAccuracyPct: 0,
    repOvercommitUsd: 0,
    dealsTrainedOn: 0,
  },
};
