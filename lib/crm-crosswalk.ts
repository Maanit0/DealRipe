/**
 * Customer domain -> CRM record ids, reviewed by hand.
 *
 * Automatic resolution covers the easy cases: a Salesforce contact whose email
 * matches the domain, or a Rolldog account name that starts with the domain
 * stem. It fails on the rest, and the failures are not our customer's fault to
 * fix on our schedule. IFF is the example: the account is "IFF US", the
 * opportunity is "IFF", nobody in Salesforce has an @iffusa.com address, and
 * Website is blank. Nothing about that is wrong, it just cannot be inferred.
 *
 * Rather than wait on a hygiene pass from someone else's team, we keep our own
 * crosswalk. Populate it from `npx tsx scripts/propose-crm-crosswalk.ts`, which
 * searches both systems and proposes candidates with their ids; a human confirms
 * and pastes them here. This file is the confirmation step, which is why it is
 * code under review rather than a table the resolver writes to itself. A wrong
 * entry silently briefs one customer's data on another customer's call.
 *
 * Domains are lowercase. Consumer-mail domains must never appear here: they
 * identify a person, not a company, so one entry would map every Gmail
 * prospect to the same account.
 */

export type CrosswalkEntry = {
  /** Salesforce Account 18- or 15-character id. */
  salesforceAccountId?: string;
  /** Rolldog opportunity id, as a string. */
  rolldogOpportunityId?: string;
  /** Who confirmed it and against what, so a wrong entry can be traced. */
  note: string;
};

export const CRM_CROSSWALK: Readonly<Record<string, CrosswalkEntry>> = Object.freeze({
  // Three Salesforce accounts carry website iffusa.com, which is why automatic
  // resolution abstained. "IFF US" is the right one: it is the Account Name
  // Eduardo screenshotted in the Sales Development thread on Aug 4, and Rolldog
  // 80018 carries the same name. The two "IFF, INC." records are duplicates.
  // Three names for one customer: the attendees are @protrans.com, Salesforce
  // calls the account "ProTrans", and Rolldog calls it "TOC Logistics". No
  // automatic match can bridge that, and "ProTrans" returns zero opportunities
  // in Rolldog. Opportunity 80731 is owned by Alexandra, sits at SQL2, and is
  // named "TOC Logistics -INBOND ONLY", which is the same product line as her
  // "TOC Inbond Additional Session" meeting.
  "protrans.com": {
    rolldogOpportunityId: "80731",
    note: "Rolldog account 'TOC Logistics', SF account 'ProTrans', domain protrans.com. Owner asuntrup, SQL2, created 2026-06-08. MS 2026-08-10",
  },
  "iffusa.com": {
    salesforceAccountId: "001RN00000iG0abYAC",
    rolldogOpportunityId: "80018",
    note: "Account 'IFF US' + Rolldog 80018 'IFF US'. Confirmed against Eduardo's Aug 4 Sales Development screenshot. MS 2026-08-09",
  },
});

function key(domain: string | null | undefined): string {
  return (domain ?? "").toLowerCase().trim();
}

export function crosswalkSalesforceAccountId(domain: string | null | undefined): string | null {
  return CRM_CROSSWALK[key(domain)]?.salesforceAccountId ?? null;
}

export function crosswalkRolldogOpportunityId(domain: string | null | undefined): string | null {
  return CRM_CROSSWALK[key(domain)]?.rolldogOpportunityId ?? null;
}

/** Domains we have already reviewed, so the proposer can skip them. */
export function crosswalkDomains(): string[] {
  return Object.keys(CRM_CROSSWALK);
}
