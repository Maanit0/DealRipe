/**
 * Which reps hear about a call.
 *
 * A deal has one rep_email, so recaps and drafts have always gone to one
 * person. Co-sold calls break that. ILS on Thursday is on both Alexandra's and
 * Daniel's calendars, one meeting and one bot, but only whoever's calendar
 * synced first is on the deal, so the other rep sits through the call and hears
 * nothing afterwards. That is worse than never having promised anything: they
 * were in the room, so they know a recap should exist.
 *
 * The invite already answers this. calls.participants holds the attendee list
 * including Magaya's own people, so the reps who were actually on the call are
 * the connected reps in that list. No new column and no new sync: it is the
 * same data the bot joined on.
 *
 * The recap goes to everyone who was there. The next step still belongs to ONE
 * of them, because "someone will send the proposal" is how a proposal does not
 * get sent, so the owner is named and the draft is written for them alone.
 */

import { isAutoJoinRep } from "./pilot-config";
import { supabaseAdmin } from "./supabase";

export type CallRecipients = {
  /** Every connected rep who was on the invite. Recap goes to all of them. */
  all: string[];
  /** The rep who owns the deal, and therefore the next step. Never null if all is non-empty. */
  owner: string | null;
  /** True when more than one rep attended, so the recap should say who owns what. */
  coSold: boolean;
};

type Participant = { email?: string | null; name?: string | null };

/**
 * Resolve recap recipients for a call.
 *
 * `fallbackOwner` is the deal's rep_email (or the pilot mapping). It is always
 * included even if the participants list is empty or unreadable: losing a recap
 * because an attendee list did not parse is a strictly worse failure than
 * sending one to a rep who was only half-involved.
 */
export async function recipientsForCall(
  tenantId: string,
  callId: string | null,
  fallbackOwner: string | null,
): Promise<CallRecipients> {
  const owner = fallbackOwner?.toLowerCase() ?? null;
  const all = new Set<string>();
  if (owner) all.add(owner);

  if (!callId) {
    return { all: [...all], owner, coSold: false };
  }

  const db = supabaseAdmin();
  try {
    const [call, conns] = await Promise.all([
      db.from("calls").select("participants").eq("id", callId).maybeSingle(),
      db
        .from("microsoft_connections")
        .select("user_principal_name")
        .eq("tenant_id", tenantId),
    ]);

    const participants = Array.isArray(call.data?.participants)
      ? (call.data?.participants as Participant[])
      : [];
    // Only reps with a live calendar connection AND auto-join enabled. Someone
    // who merely appears on an invite (an exec forwarded in, a colleague from
    // another team) has not opted into receiving DealRipe mail, and a recap
    // full of qualification data is not something to send unasked.
    const connected = new Set(
      (conns.data ?? [])
        .map((c) => (c.user_principal_name ?? "").toLowerCase())
        .filter((e) => e && isAutoJoinRep(e)),
    );

    for (const p of participants) {
      const email = (p?.email ?? "").toLowerCase().trim();
      if (email && connected.has(email)) all.add(email);
    }
  } catch {
    // Fall through with the owner alone. Best-effort by design: see above.
  }

  return { all: [...all], owner, coSold: all.size > 1 };
}

/**
 * The line that tells a co-sold pair who does what next.
 *
 * Without it, two reps read the same next step and each assumes the other has
 * it. Named explicitly, it is unambiguous, and the rep who does not own it
 * still has the context to follow the deal.
 */
export function coSoldOwnershipNote(
  recipients: CallRecipients,
  displayName: (email: string | null | undefined) => string | null,
): string | null {
  if (!recipients.coSold || !recipients.owner) return null;
  const others = recipients.all.filter((e) => e !== recipients.owner);
  if (others.length === 0) return null;
  const ownerName = displayName(recipients.owner) ?? recipients.owner;
  const otherNames = others.map((e) => displayName(e) ?? e).join(", ");
  return `${ownerName} and ${otherNames} were both on this call. The next step below is ${ownerName}'s to send, and the draft is waiting in ${ownerName}'s drafts folder.`;
}
