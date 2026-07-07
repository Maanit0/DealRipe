/**
 * Pilot customer allowlist for calendar sync.
 *
 * lib/calendar-sync.ts iterates Microsoft Graph events and dispatches a
 * Recall.ai bot only when at least one attendee's email domain matches
 * an entry in PILOT_CUSTOMER_DOMAINS. Every other event is silently
 * counted and dropped.
 *
 * This is the entire authority surface for "is this meeting in scope?"
 * Edit the constant + redeploy to add a pilot; no runtime "enable
 * domain" path exists.
 */

export type PilotDomainEntry = { domain: string; dealExternalId: string };

/**
 * Populated at kickoff when Mark Buman selects the three pilot deals;
 * until then calendar sync dispatches nothing (fail closed).
 */
export const PILOT_CUSTOMER_DOMAINS: ReadonlyArray<PilotDomainEntry> =
  Object.freeze([
    { domain: "morneauglobal.com", dealExternalId: "morneau" }, // Eduardo (Groupe Morneau, opp 81714)
    { domain: "albawheelsup.com", dealExternalId: "alba" }, // Eduardo (Alba Wheels Up, opp 78273)
    { domain: "martin-brower.com", dealExternalId: "martinbrower" }, // Juan (opp 80566; email domain uses a hyphen)
    { domain: "omniva.com", dealExternalId: "omniva" }, // Juan (opp 80983)
    { domain: "iffusa.com", dealExternalId: "iff" }, // Eduardo, IFF Inc (opp 80018; domain observed on the real invite)
    { domain: "dutyfreeamericas.com", dealExternalId: "dutyfreeamericas" }, // Eduardo, Duty Free Americas (opp 81454; confirm)
    // Norwegian Cruise Line (opp 77742): matched by subject only until Ed confirms the email domain.
    // Aqua Gulf deferred: not in Rolldog yet (awaiting their RFI, atypical ICP).
    // Seino Logix (opp 80189) excluded: non-US (Japan), outside the US-only pilot scope.
  ]);

/**
 * Which rep gets the post-call summary + pre-call briefing for each pilot
 * deal, keyed by the same dealExternalId used in PILOT_CUSTOMER_DOMAINS.
 * transcript-sync uses this to route the recap email. If a deal is missing
 * here, no email is sent (logged, not thrown).
 *
 * Confirm the exact addresses against microsoft_connections. ebencomo is
 * verified from the connect flow; jlopez is the expected form for Juan Lopez.
 */
export const PILOT_REP_EMAILS: Readonly<Record<string, string>> = Object.freeze({
  morneau: "ebencomo@magaya.com", // Eduardo
  alba: "ebencomo@magaya.com", // Eduardo
  martinbrower: "jlopez@magaya.com", // Juan
  omniva: "jlopez@magaya.com", // Juan
  iff: "ebencomo@magaya.com", // Eduardo
  norwegian: "ebencomo@magaya.com", // Eduardo
  dutyfreeamericas: "ebencomo@magaya.com", // Eduardo
});

export function repEmailForDeal(dealExternalId: string): string | null {
  return PILOT_REP_EMAILS[dealExternalId] ?? null;
}

/**
 * Deal slug -> live Rolldog opportunity id, for write-back routing. Empty
 * until the reps send their opportunity ids (Juan for martinbrower/omniva;
 * aquagulf only once it exists in Rolldog).
 *
 * IMPORTANT: adding an id here is NOT enough to write. The same id must also
 * be added to PILOT_OPPORTUNITY_IDS in crm-scope.ts (the security authority,
 * fail-closed). Until both are set, write-back safely no-ops.
 */
export const PILOT_DEAL_ROLLDOG_IDS: Readonly<Record<string, string>> =
  Object.freeze({
    morneau: "81714", // Eduardo, Groupe Morneau
    alba: "78273", // Eduardo, Alba Wheels Up
    martinbrower: "80566", // Juan, Martin Brower
    omniva: "80983", // Juan, Omniva
    iff: "80018", // Eduardo, IFF Inc
    norwegian: "77742", // Eduardo, Norwegian Cruise Line
    dutyfreeamericas: "81454", // Eduardo, Duty Free Americas
  });

export function rolldogOppIdForDeal(dealExternalId: string): string | null {
  return PILOT_DEAL_ROLLDOG_IDS[dealExternalId] ?? null;
}

/**
 * Match a list of attendee emails against the pilot allowlist.
 * Domain comparison is case-insensitive on the part after the last '@'.
 * Returns the first matching entry or null.
 */
export function matchPilotDomain(
  attendeeEmails: ReadonlyArray<string>,
): PilotDomainEntry | null {
  const list = effectivePilotDomains();
  if (list.length === 0) return null;
  for (const raw of attendeeEmails) {
    if (typeof raw !== "string") continue;
    const at = raw.lastIndexOf("@");
    if (at < 0) continue;
    const domain = raw.slice(at + 1).toLowerCase().trim();
    if (!domain) continue;
    for (const entry of list) {
      if (entry.domain.toLowerCase() === domain) return entry;
    }
  }
  return null;
}

/**
 * Fallback matching by meeting subject, for pilot calls where the customer is
 * not an invited attendee (customer-hosted links, internal-titled placeholders
 * like "DEMO PLACE HOLDER MARTIN BROWER"). If the deal name appears in the
 * subject, the bot joins even without the customer domain on the invite.
 *
 * Keywords are distinctive per deal to avoid false positives. Tradeoff: this
 * can also match internal prep meetings about the deal (no customer to record).
 */
export const PILOT_DEAL_SUBJECT_KEYWORDS: Readonly<Record<string, string[]>> =
  Object.freeze({
    morneau: ["morneau"],
    alba: ["alba wheels", "albawheels"],
    martinbrower: ["martin brower", "martin-brower", "martinbrower"],
    omniva: ["omniva"],
    iff: ["iff accounting", "iff inc", "iff usa", "iff chb"], // avoid bare "iff" (matches tariff/sniff/etc.)
    norwegian: ["norwegian cruise", "ncl"],
    dutyfreeamericas: ["duty free americas", "dutyfreeamericas"],
  });

/**
 * Match a meeting subject against the pilot deal keywords. Returns the deal's
 * PilotDomainEntry (so callers use it exactly like a domain match) or null.
 */
export function matchPilotSubject(
  subject: string | null | undefined,
): PilotDomainEntry | null {
  if (!subject) return null;
  const s = subject.toLowerCase();
  const list = effectivePilotDomains();
  for (const [slug, keywords] of Object.entries(PILOT_DEAL_SUBJECT_KEYWORDS)) {
    for (const kw of keywords) {
      if (s.includes(kw.toLowerCase())) {
        return (
          list.find((e) => e.dealExternalId === slug) ?? {
            domain: "(subject-match)",
            dealExternalId: slug,
          }
        );
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Test-only override
// ---------------------------------------------------------------------

let _testOverride: ReadonlyArray<PilotDomainEntry> | null = null;

/**
 * Test-only. Same guarded pattern as crm-scope's
 * __setPilotOpportunityIdsForTesting: throws if NODE_ENV=production so a
 * reviewer can confirm by inspection that no production code calls this.
 */
export function __setPilotDomainsForTesting(
  domains: ReadonlyArray<PilotDomainEntry> | null,
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "__setPilotDomainsForTesting cannot be called in production",
    );
  }
  _testOverride = domains;
}

function effectivePilotDomains(): ReadonlyArray<PilotDomainEntry> {
  return _testOverride ?? PILOT_CUSTOMER_DOMAINS;
}
