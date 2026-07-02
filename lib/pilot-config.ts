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
    { domain: "aquagulf.com", dealExternalId: "aquagulf" }, // Eduardo
    { domain: "martinbrower.com", dealExternalId: "martinbrower" }, // Juan
    { domain: "omniva.com", dealExternalId: "omniva" }, // Juan
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
  aquagulf: "ebencomo@magaya.com", // Eduardo
  martinbrower: "jlopez@magaya.com", // Juan (confirm exact address)
  omniva: "jlopez@magaya.com", // Juan (confirm exact address)
});

export function repEmailForDeal(dealExternalId: string): string | null {
  return PILOT_REP_EMAILS[dealExternalId] ?? null;
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
