/**
 * The customer's timezone, derived rather than guessed.
 *
 * This used to be a model output, and it was wrong and unstable. Three
 * previews of the same Dunavant call returned ET, ET and CT. Debra says on that
 * call "our main office is in Memphis, Tennessee", which is Central, so the
 * model was right once by luck.
 *
 * That value is not decorative. It feeds the proposed meeting time in the
 * follow-up draft, and docs/recap-target-eduardo.md records the failure Eduardo
 * watched a rep hit: proposing a next step with no usable time. A time in the
 * wrong zone is how a booked meeting becomes a no-show, which is why the recap
 * prompt already said "a wrong answer is worse than null" and then asked a
 * model to infer it anyway.
 *
 * So: a place name has to appear in the transcript, and the mapping from place
 * to zone is a table. No inference, no accents, no guessing from a company
 * name. When nothing matches we return null, which is a true statement about
 * what the call established.
 */

/** Short labels, matching what the follow-up draft renders. */
export type TimezoneLabel = "ET" | "CT" | "MT" | "PT" | "AKT" | "HT" | "AST" | "GMT" | "CET" | "EET" | "IST" | "JST" | "CST_CN" | "AEST";

export type TimezoneRead =
  | { status: "found"; label: TimezoneLabel; matched: string }
  /** The transcript named no place we recognize. Not a guess, an absence. */
  | { status: "no_location_stated" };

/**
 * Place to zone. Ordered longest-first at match time so "Kansas City" wins over
 * "Kansas" and "New York" over "York".
 *
 * US states are included because reps say "we're in Tennessee" as often as they
 * name a city. States split across zones (Texas, Florida, Tennessee, Kentucky,
 * Kansas, Nebraska, the Dakotas, Michigan, Indiana, Oregon, Idaho) are mapped
 * to the zone holding the large majority of their commercial activity, and the
 * cities above them override anyway.
 */
const PLACES: ReadonlyArray<readonly [string, TimezoneLabel]> = Object.freeze([
  // US cities that actually come up in logistics
  ["memphis", "CT"], ["nashville", "CT"], ["knoxville", "ET"], ["chattanooga", "ET"],
  ["chicago", "CT"], ["dallas", "CT"], ["fort worth", "CT"], ["houston", "CT"],
  ["austin", "CT"], ["san antonio", "CT"], ["laredo", "CT"], ["el paso", "MT"],
  ["new orleans", "CT"], ["kansas city", "CT"], ["st louis", "CT"], ["saint louis", "CT"],
  ["minneapolis", "CT"], ["milwaukee", "CT"], ["omaha", "CT"], ["oklahoma city", "CT"],
  ["new york", "ET"], ["newark", "ET"], ["boston", "ET"], ["philadelphia", "ET"],
  ["baltimore", "ET"], ["washington", "ET"], ["atlanta", "ET"], ["charlotte", "ET"],
  ["miami", "ET"], ["doral", "ET"], ["orlando", "ET"], ["tampa", "ET"], ["jacksonville", "ET"],
  ["savannah", "ET"], ["charleston", "ET"], ["norfolk", "ET"], ["detroit", "ET"],
  ["cleveland", "ET"], ["columbus", "ET"], ["cincinnati", "ET"], ["pittsburgh", "ET"],
  ["indianapolis", "ET"], ["louisville", "ET"], ["buffalo", "ET"],
  ["denver", "MT"], ["salt lake city", "MT"], ["phoenix", "MT"], ["albuquerque", "MT"],
  ["los angeles", "PT"], ["long beach", "PT"], ["san francisco", "PT"], ["oakland", "PT"],
  ["san diego", "PT"], ["seattle", "PT"], ["tacoma", "PT"], ["portland", "PT"],
  ["las vegas", "PT"], ["sacramento", "PT"],
  ["anchorage", "AKT"], ["honolulu", "HT"],

  // US states
  ["tennessee", "CT"], ["texas", "CT"], ["illinois", "CT"], ["louisiana", "CT"],
  ["missouri", "CT"], ["minnesota", "CT"], ["wisconsin", "CT"], ["iowa", "CT"],
  ["arkansas", "CT"], ["mississippi", "CT"], ["alabama", "CT"], ["oklahoma", "CT"],
  ["nebraska", "CT"], ["kansas", "CT"],
  ["new jersey", "ET"], ["new hampshire", "ET"], ["new york state", "ET"],
  ["massachusetts", "ET"], ["pennsylvania", "ET"], ["maryland", "ET"], ["virginia", "ET"],
  ["georgia", "ET"], ["florida", "ET"], ["ohio", "ET"], ["michigan", "ET"],
  ["north carolina", "ET"], ["south carolina", "ET"], ["connecticut", "ET"],
  ["maine", "ET"], ["vermont", "ET"], ["delaware", "ET"], ["indiana", "ET"],
  ["kentucky", "ET"], ["west virginia", "ET"],
  ["colorado", "MT"], ["utah", "MT"], ["arizona", "MT"], ["new mexico", "MT"],
  ["montana", "MT"], ["wyoming", "MT"], ["idaho", "MT"],
  ["california", "PT"], ["washington state", "PT"], ["oregon", "PT"], ["nevada", "PT"],

  // Canada
  ["toronto", "ET"], ["ottawa", "ET"], ["montreal", "ET"], ["quebec", "ET"],
  ["winnipeg", "CT"], ["calgary", "MT"], ["edmonton", "MT"],
  ["vancouver", "PT"], ["halifax", "AST"],

  // Elsewhere, for the international deals in this pilot
  ["london", "GMT"], ["dublin", "GMT"], ["lisbon", "GMT"],
  ["madrid", "CET"], ["barcelona", "CET"], ["paris", "CET"], ["amsterdam", "CET"],
  ["rotterdam", "CET"], ["antwerp", "CET"], ["hamburg", "CET"], ["berlin", "CET"],
  ["milan", "CET"], ["rome", "CET"], ["zurich", "CET"], ["vienna", "CET"],
  ["warsaw", "CET"], ["prague", "CET"], ["belgrade", "CET"], ["serbia", "CET"],
  ["athens", "EET"], ["istanbul", "EET"], ["bucharest", "EET"], ["beirut", "EET"],
  ["mumbai", "IST"], ["delhi", "IST"], ["bangalore", "IST"], ["chennai", "IST"],
  ["tokyo", "JST"], ["osaka", "JST"], ["seoul", "JST"],
  ["shanghai", "CST_CN"], ["shenzhen", "CST_CN"], ["guangzhou", "CST_CN"],
  ["ningbo", "CST_CN"], ["xiamen", "CST_CN"], ["hong kong", "CST_CN"],
  ["sydney", "AEST"], ["melbourne", "AEST"],
]);

const NORMALIZED: ReadonlyArray<readonly [string, TimezoneLabel]> = Object.freeze(
  [...PLACES].sort((a, b) => b[0].length - a[0].length),
);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

/**
 * Read the customer's timezone off the transcript.
 *
 * `sellerHomes` are places the SELLER is based, which must not win. Magaya is
 * headquartered in Miami and says so on calls; matching that would put every
 * customer in Eastern. They are skipped unless nothing else matches, and even
 * then they lose, because the seller's own office says nothing about where the
 * customer is.
 */
export function readCustomerTimezone(
  transcript: string,
  sellerHomes: ReadonlyArray<string> = ["miami", "doral", "florida"],
): TimezoneRead {
  const hay = ` ${normalize(transcript)} `;
  const skip = new Set(sellerHomes.map((s) => normalize(s).trim()));
  for (const [place, label] of NORMALIZED) {
    if (skip.has(place)) continue;
    if (hay.includes(` ${place} `)) return { status: "found", label, matched: place };
  }
  return { status: "no_location_stated" };
}
