/**
 * Who a deal's artifacts belong to.
 *
 * deals.rep_email is written ONCE, when calendar-sync auto-creates the deal, from
 * whichever rep's calendar the invite was read off first. calendar-sync reads all
 * six calendars, so on a co-sold meeting that is a race, and the winner is
 * recorded permanently as the owner. Nothing has ever revisited it.
 *
 * It decides more than the briefing. The recap recipient, the mailbox the
 * follow-up draft is written INTO, the no-show mail, link-escalation and the
 * prescription ledger's rep attribution all read this one column, so a deal that
 * lost the race sends another rep's customer mail to the wrong person and credits
 * the wrong rep for the follow-through.
 *
 * Juan Lopez found his on 2026-08-27: "this opp is not under my name."
 *
 * THE ORGANIZER IS EVIDENCE ONLY WHEN THE ORGANIZER IS A REP. This is the whole
 * subtlety and getting it backwards would be far worse than the bug. Counted over
 * 227 captured calls on 2026-08-28: 106 are organized by a pilot rep, 12 by the
 * customer, and 109 by a Magaya person who is NOT a rep. Those 109 are the BDRs
 * (mmartin, zcruz, hmoreno, abby.gonzalez, rperez, mcoulombe and others), who
 * book the discovery call and hand it to the AE who runs it. A naive "route to
 * the organizer" would send nearly half the book's briefings and drafts to the
 * BDR who booked the meeting, which is not a smaller bug than the one it fixes.
 *
 * So this is deliberately narrow, and it abstains rather than guessing.
 */

import { listOpportunities } from "./rolldog";
import { supabaseAdmin } from "./supabase";
import { REP_UID } from "./rolldog-reconcile";
import { repEmailForDeal } from "./pilot-config";

export type DealRepVerdict =
  /** The source we trusted names the rep already on the deal. */
  | { status: "agrees"; repEmail: string; source: RepSource }
  /** The source we trusted names a DIFFERENT rep from the one on the deal. */
  | { status: "disagrees"; repEmail: string; current: string | null; source: RepSource; detail: string }
  /**
   * The deal is pinned in the static pilot map. A human wrote that down, so it
   * outranks anything inferred here and is never contradicted.
   */
  | { status: "pinned"; repEmail: string }
  /** More than one rep organizes calls on this deal. Genuinely co-sold; a person decides. */
  | { status: "co_sold"; reps: string[]; current: string | null }
  /**
   * No captured call is organized by a pilot rep, so there is NOTHING to check
   * rep_email against. Almost always a BDR-booked deal, which is the normal case
   * and not a problem. Deliberately distinct from "agrees": this is "did not
   * check", and reporting it as agreement would claim 109 verifications we never
   * made.
   */
  | { status: "no_rep_organizer"; current: string | null };

/**
 * Where the answer came from, in the order they are consulted.
 *
 * "rolldog_owner" is FIRST and it is the only one of these that is a statement
 * about ownership rather than a proxy for it. Juan's report was "this opp is not
 * under my name", which is a sentence about the opportunity owner: that field is
 * the concept the sales team actually uses, maintained by them, in the system
 * CLAUDE.md calls the one where the sales team lives.
 *
 * Measured 2026-08-28 over the 67 live deals carrying a Rolldog opportunity: 51
 * owners map to a pilot rep, and they agree with rep_email on 49. The two
 * disagreements were both real, and one of them is why this ladder exists at all
 * (see below).
 */
export type RepSource = "pilot_map" | "rolldog_owner" | "call_organizer";

/**
 * WHY SALESFORCE'S OWN "Sales Rep" FIELD IS NOT A RUNG HERE.
 *
 * Account.Sales_Rep__c is a lookup to User, so it resolves cleanly to a rep
 * email and looks like the obvious authority for the deals with no Rolldog
 * opportunity to ask. It was checked on 2026-08-28 before being used, and it
 * failed on the one case where we have ground truth from the rep's own mouth.
 *
 * Measured over the 123 live deals with a confirmed Salesforce account: 43 have
 * no Sales Rep set at all, 12 point at someone who is not an enrolled rep, and
 * 68 map to a pilot rep. Of those 68 it agrees with rep_email on 65 and
 * disagrees on 3. The first disagreement is Apexcargo, where the field says
 * jlopez, Rolldog opportunity 92797 is owned by sjohnson, every captured call is
 * organized by sjohnson, and Juan Lopez told us in as many words that the deal is
 * not his. The field is stale in exactly the way deals.rep_email is stale:
 * written once when the account was set up and never maintained afterwards.
 *
 * It is not a tiebreaker either, since it is blank on a third of the book and
 * would have to be trusted precisely where nothing else can check it. Its honest
 * use is as a SIGNAL: where it disagrees with Rolldog, a human should look. It
 * is not an answer, and 65 agreements do not license the 3.
 */

const PILOT_REPS = new Set(Object.keys(REP_UID).map((e) => e.toLowerCase()));

/** True when this address belongs to one of the six enrolled reps. */
export function isPilotRep(email: string | null | undefined): boolean {
  return PILOT_REPS.has(String(email ?? "").trim().toLowerCase());
}

/**
 * What the calls say about who owns this deal.
 *
 * Reads ONLY calls that actually happened. A cancelled or never-dispatched row
 * carries an organizer and no evidence that the rep ran anything.
 */
export async function resolveDealRep(args: {
  dealId: string;
  externalId: string | null;
  currentRepEmail: string | null;
  rolldogOpportunityId: string | null;
}): Promise<DealRepVerdict> {
  const current = args.currentRepEmail ? args.currentRepEmail.trim().toLowerCase() : null;

  const pinned = args.externalId ? repEmailForDeal(args.externalId) : null;
  if (pinned) return { status: "pinned", repEmail: pinned.toLowerCase() };

  // ROLLDOG'S OWNER FIRST, and it OUTRANKS the organizer.
  //
  // The organizer was tried as the primary signal and it is a proxy, not the
  // fact. Vivot is the case that settled it: every captured call is organized by
  // Ariel, so the organizer rule moved the deal to him, and Rolldog records
  // Alexandra as the owner. Both are true. One of them is a statement about who
  // ran a meeting and the other is a statement about whose deal it is, and only
  // the second is what routes a rep's customer mail. Reading them the other way
  // round reassigns a deal on the evidence of a single co-sold call.
  //
  // It also sees cases the organizer cannot: Cargocleared routed to Juan with
  // Alexandra owning the opportunity, and no pilot rep organizes its calls at
  // all, so there was nothing for the organizer rule to notice.
  if (args.rolldogOpportunityId) {
    const owner = await rolldogOwnerEmail(args.rolldogOpportunityId);
    if (owner) {
      const detail = `Rolldog opportunity ${args.rolldogOpportunityId} is owned by them`;
      return current === owner
        ? { status: "agrees", repEmail: owner, source: "rolldog_owner" }
        : { status: "disagrees", repEmail: owner, current, source: "rolldog_owner", detail };
    }
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("calls")
    .select("organizer_email, outcome")
    .eq("deal_id", args.dealId)
    .not("organizer_email", "is", null);
  if (error) throw new Error(`calls read failed for ${args.dealId}: ${error.message}`);

  const organizers = new Map<string, number>();
  for (const row of data ?? []) {
    const email = String((row as { organizer_email: unknown }).organizer_email ?? "")
      .trim()
      .toLowerCase();
    if (!isPilotRep(email)) continue;
    organizers.set(email, (organizers.get(email) ?? 0) + 1);
  }

  if (organizers.size === 0) return { status: "no_rep_organizer", current };
  if (organizers.size > 1) {
    return { status: "co_sold", reps: [...organizers.keys()].sort(), current };
  }

  const [repEmail, calls] = [...organizers.entries()][0];
  const detail = `all ${calls} captured call${calls === 1 ? "" : "s"} organized by them, and the deal has no readable Rolldog owner`;
  return current === repEmail
    ? { status: "agrees", repEmail, source: "call_organizer" }
    : { status: "disagrees", repEmail, current, source: "call_organizer", detail };
}


/**
 * The pilot rep who owns a Rolldog opportunity, or null.
 *
 * Null covers three different things on purpose, and all three mean "do not act
 * on this" rather than "no owner": the opportunity did not come back (16 of 67
 * on 2026-08-28, archived or deleted), it carries no user-id, or the user-id is
 * not one of the six enrolled reps. Falling through to the organizer is the
 * right response to all of them, and inventing an owner from any of them is not.
 */
async function rolldogOwnerEmail(opportunityId: string): Promise<string | null> {
  let rows;
  try {
    rows = await listOpportunities(`filter[id]=${encodeURIComponent(opportunityId)}&page[size]=1`);
  } catch {
    // A Rolldog outage must not reassign anyone. Fall through to the organizer,
    // which is local and cannot fail this way.
    return null;
  }
  const owner = rows[0]?.owner;
  if (!owner) return null;
  for (const [email, uid] of Object.entries(REP_UID)) {
    if (String(uid) === String(owner)) return email.toLowerCase();
  }
  return null;
}
