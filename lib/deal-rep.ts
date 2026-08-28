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

import { supabaseAdmin } from "./supabase";
import { REP_UID } from "./rolldog-reconcile";
import { repEmailForDeal } from "./pilot-config";

export type DealRepVerdict =
  /** Every captured call is organized by one pilot rep, and it is the one on the deal. */
  | { status: "agrees"; repEmail: string }
  /** Every captured call is organized by ONE pilot rep, and it is NOT the one on the deal. */
  | { status: "disagrees"; repEmail: string; current: string | null; calls: number }
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
}): Promise<DealRepVerdict> {
  const current = args.currentRepEmail ? args.currentRepEmail.trim().toLowerCase() : null;

  const pinned = args.externalId ? repEmailForDeal(args.externalId) : null;
  if (pinned) return { status: "pinned", repEmail: pinned.toLowerCase() };

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
  if (current === repEmail) return { status: "agrees", repEmail };
  return { status: "disagrees", repEmail, current, calls };
}
