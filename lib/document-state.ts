/**
 * Has an agreement gone out on this deal, and did it come back signed.
 *
 * Adobe EchoSign puts the state in the subject: an envelope out for signature
 * carries the document name, and a fully executed one is prefixed "Completed:".
 * agreementSignal() has parsed that since it was written and nothing has ever
 * called it, so 52 notifications across 39 deals have been sitting in
 * deal_messages saying nothing.
 *
 * THE RETURN TYPE IS THE POINT. "We have seen no agreement" and "we have no
 * email log for this deal at all" are different facts and a boolean cannot hold
 * both. Same shape as crmContextStatus in lib/deal-context.ts, which is the
 * pattern every integration boundary here is supposed to follow.
 *
 * AND out_for_signature IS NOT "UNSIGNED". It means we watched it go out and
 * have not watched it come back. A deal can be signed in a channel we do not
 * read: a wet signature, a portal, an attachment on a thread we never ingested,
 * or simply a rep who forwarded it from a personal address. Reading it as
 * "still unsigned" is exactly the move that produced a briefing telling a
 * paying customer that Magaya was not their selected vendor, one integration
 * over.
 *
 * The independent second source is Rolldog gate 420, "Agreement Signed by
 * Company", which the rep ticks by hand. Where the two disagree, report both:
 * lib/stage-gates.ts already has the claimed-versus-confirmed vocabulary for
 * exactly this and inventing a third is how two systems become three counts.
 */

import { supabaseAdmin } from "./supabase";

export type DocumentState =
  /** An agreement notification we saw arrive with "Completed:". */
  | { status: "executed"; kind: string; at: string | null; sourceMessageId: string }
  /** Seen going out, not seen coming back. NOT proof it is unsigned. */
  | { status: "out_for_signature"; kind: string; at: string | null; sourceMessageId: string }
  /** We have messages on this deal and none of them is an agreement. */
  | { status: "none_seen" }
  /** No email log for this deal at all, so we have not looked. */
  | { status: "no_email_log" }
  /** The read failed. Never fold this into none_seen. */
  | { status: "unavailable"; error: string };

/**
 * Resolve one deal's agreement state from the message log.
 *
 * Most recent agreement notification wins, and an executed one wins outright:
 * EchoSign sends the "Completed:" mail after the out-for-signature mail, but a
 * re-send of the same envelope can arrive later and would otherwise walk the
 * state backwards from signed to pending.
 */
export async function readDocumentState(dealId: string): Promise<DocumentState> {
  const db = supabaseAdmin();
  const res = await db
    .from("deal_messages")
    .select("id, agreement_kind, agreement_state, sent_at")
    .eq("deal_id", dealId)
    .not("agreement_kind", "is", null)
    .order("sent_at", { ascending: false })
    .limit(25);
  if (res.error) return { status: "unavailable", error: res.error.message };

  const rows = res.data ?? [];
  if (rows.length === 0) {
    // No agreement rows. Distinguish "nothing to find" from "nothing to look
    // in": a deal with no messages at all has not been checked, it has been
    // guessed about.
    const any = await db.from("deal_messages").select("id", { count: "exact", head: true }).eq("deal_id", dealId);
    if (any.error) return { status: "unavailable", error: any.error.message };
    return (any.count ?? 0) > 0 ? { status: "none_seen" } : { status: "no_email_log" };
  }

  const executed = rows.find((r) => r.agreement_state === "executed");
  const chosen = executed ?? rows[0];
  return {
    status: executed ? "executed" : "out_for_signature",
    kind: String(chosen.agreement_kind),
    at: chosen.sent_at,
    sourceMessageId: chosen.id,
  };
}

/** One line for a prompt or a report. Null when there is nothing to say. */
export function documentStateLine(s: DocumentState): string | null {
  switch (s.status) {
    case "executed":
      return `A ${s.kind} came back executed${s.at ? ` on ${s.at.slice(0, 10)}` : ""}.`;
    case "out_for_signature":
      // Worded so a reader cannot take it as proof of an unsigned document.
      return `A ${s.kind} went out${s.at ? ` on ${s.at.slice(0, 10)}` : ""} and we have not seen it come back. It may have been signed somewhere we do not read.`;
    case "none_seen":
      return "No agreement has come through the mailboxes we read.";
    case "no_email_log":
    case "unavailable":
      // Deliberately silent. A prompt should say nothing rather than assert an
      // absence it cannot support.
      return null;
  }
}
