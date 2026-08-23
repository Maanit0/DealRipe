/**
 * Who signs, and whether we have actually heard from them.
 *
 * WHY THIS EXISTS
 *
 * Three parts of DealRipe answered this question three different ways and all
 * three were wrong, in ways that reached a CRO's inbox.
 *
 *   lib/deal-signals-buyer.ts read `sql4_exec_involvement = Yes`, a single
 *   SQL4 framework field. 17 of Eduardo's 21 open deals sit at SQL0, where that
 *   question is never asked, so the field is structurally unfillable and the
 *   answer was 0 of 14. He closes deals; the number was nonsense.
 *
 *   lib/pipeline-changes.ts matched job titles against a regex built for a
 *   Fortune 500 org chart (cfo, chief financ, controller). Magaya sells to
 *   fifty-person freight forwarders where the signer is a "Company Director"
 *   or "Managing Director", so 9 of Eduardo's 21 deals carried a buyer-level
 *   contact and none matched.
 *
 *   Both then reported "the economic buyer has never been on a call" when they
 *   meant "we have not worked out who the buyer is", which is a claim about a
 *   person that the evidence does not support.
 *
 * THE SOURCE THAT WAS THERE THE WHOLE TIME
 *
 * lib/contacts-extract.ts already reads the transcript and labels each person's
 * relationship, and it has assigned `economic_buyer` to 28 contacts across the
 * pilot. Someone saying "I'll need Ricardo to approve this" is authority
 * evidence, spoken, on the record. A job title is an inference about authority;
 * what was said on the call is the thing itself.
 *
 * So the order is: what the transcript said, then the title, and the result
 * carries WHICH so a reader can weigh it.
 *
 * THE CONFUSION THIS IS BUILT TO CATCH
 *
 * A rep treating their champion as the buyer is the most expensive mistake in
 * mid-market sales and the one a forecast never shows until the deal stalls at
 * signature. `championMistakenForBuyer` fires when the only senior person on
 * the deal is labelled a champion and nobody is labelled a buyer, which is
 * exactly what that looks like from the outside.
 */

export type ContactLike = {
  name: string | null;
  role: string | null;
  relationship: string | null;
  last_contacted_at?: string | null;
};

/**
 * Titles that sign at a logistics SME.
 *
 * Only consulted when the transcript labelled nobody, and deliberately broad:
 * at this company size a "Director" or "Head of Operations" signs, and being
 * slightly generous names a real person to go and ask about, where being strict
 * claims nobody exists.
 */
const SENIOR_TITLE =
  /budget|cfo|coo|ceo|chief|owner|founder|president|managing director|company director|\bdirector\b|\bvp\b|vice president|head of|general manager|partner|final (say|decision)|economic|controller|signatory/i;

export type EconomicBuyerRead =
  | {
      status: "engaged";
      name: string | null;
      role: string | null;
      /** "transcript" when the extraction labelled them, "title" when inferred. */
      basis: "transcript" | "title";
    }
  | {
      status: "identified_absent";
      name: string | null;
      role: string | null;
      basis: "transcript" | "title";
    }
  /** Nobody has been worked out as the signer. NOT the same as absent. */
  | { status: "unidentified" };

function label(c: ContactLike): { name: string | null; role: string | null } {
  return { name: (c.name ?? "").trim() || null, role: (c.role ?? "").trim() || null };
}

export function resolveEconomicBuyer(contacts: ReadonlyArray<ContactLike>): EconomicBuyerRead {
  // 1. What the calls said. An engaged one beats an absent one: if two people
  //    were labelled and one has spoken to us, that is the live relationship.
  const labelled = contacts.filter((c) => c.relationship === "economic_buyer");
  const labelledEngaged = labelled.find((c) => c.last_contacted_at);
  if (labelledEngaged) return { status: "engaged", ...label(labelledEngaged), basis: "transcript" };
  if (labelled.length > 0) return { status: "identified_absent", ...label(labelled[0]), basis: "transcript" };

  // 2. Only then, the title. Same engaged-first rule.
  const byTitle = contacts.filter((c) => SENIOR_TITLE.test(`${c.role ?? ""} ${c.relationship ?? ""}`));
  const titleEngaged = byTitle.find((c) => c.last_contacted_at);
  if (titleEngaged) return { status: "engaged", ...label(titleEngaged), basis: "title" };
  if (byTitle.length > 0) return { status: "identified_absent", ...label(byTitle[0]), basis: "title" };

  return { status: "unidentified" };
}

/**
 * Is the rep running this deal through a champion they may be treating as the
 * signer?
 *
 * True when a senior-looking person is engaged, the transcript labelled them a
 * CHAMPION rather than a buyer, and no economic buyer is labelled anywhere on
 * the deal. That is the shape of a deal about to stall at signature, and it is
 * worth raising early rather than at the close date.
 *
 * Returns the person, so the flag can name them instead of gesturing.
 */
export function championMistakenForBuyer(
  contacts: ReadonlyArray<ContactLike>,
): { name: string | null; role: string | null } | null {
  if (contacts.some((c) => c.relationship === "economic_buyer")) return null;
  const seniorChampion = contacts.find(
    (c) => c.relationship === "champion" && c.last_contacted_at && SENIOR_TITLE.test(String(c.role ?? "")),
  );
  return seniorChampion ? label(seniorChampion) : null;
}

/** How to refer to them in a sentence: "Michael Bartz (CIO)", "the CIO". */
export function buyerLabelOf(read: EconomicBuyerRead): string | null {
  if (read.status === "unidentified") return null;
  const roleShort = (read.role ?? "").split(",")[0].split("(")[0].trim();
  if (read.name) return roleShort ? `${read.name} (${roleShort})` : read.name;
  return roleShort ? `the ${roleShort}` : null;
}
