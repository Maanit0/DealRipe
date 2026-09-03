/**
 * Did anyone from the customer's side actually speak?
 *
 * A no-show is not the same as a call with no transcript, and the existing
 * NO_CONTENT filter cannot see the difference. Triadcargousa on 2026-09-02 is
 * the case: Juan and a BDR joined, waited six minutes for a prospect who never
 * arrived, and the bot recorded them doing it. 600 characters, outcome
 * `captured`, every length and outcome check passed, and the rep was emailed a
 * qualification audit reading "0 captured, 12 still open" for a meeting that
 * did not happen. Juan thumbed it down.
 *
 * The follow-up draft got this right on its own, because the model read the
 * transcript and wrote "we missed each other today". The recap did not, because
 * the gap audit is computed from the extraction and an empty extraction is
 * indistinguishable from a call where nothing was established. This is the
 * check that separates them.
 *
 * IT ANSWERS THREE WAYS AND FAILS OPEN. Suppressing a real recap is worse than
 * sending one for a no-show, so `silent` is returned only when every speaker in
 * the transcript is a known seller-side attendee. One unrecognised speaker is
 * enough for `spoke`: a colleague who joined off-invite, a name the diarizer
 * spelled differently, or a phone caller all mean somebody was in the room.
 */

const SELLER_DOMAIN = "magaya.com";

export type CustomerPresence =
  /** Somebody who is not on the seller's side said something. */
  | { status: "spoke"; who: string[] }
  /** Every speaker was a seller-side attendee. Nobody else was there. */
  | { status: "silent"; sellerSpeakers: string[] }
  /** No roster, no transcript, or nothing parseable. Never treat as a no-show. */
  | { status: "cannot_tell"; reason: string };

/** "Juan Lopez: Good afternoon." -> "Juan Lopez". */
function speakerLabels(transcript: string): string[] {
  const out = new Set<string>();
  for (const line of transcript.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0 || i > 60) continue;
    const name = line.slice(0, i).trim();
    // A label is a name, not a sentence that happens to contain a colon.
    if (!name || name.length > 44 || /[.!?]$/.test(name)) continue;
    out.add(name);
  }
  return [...out];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function readCustomerPresence(args: {
  transcript: string | null | undefined;
  participants: unknown;
}): CustomerPresence {
  const transcript = (args.transcript ?? "").trim();
  if (!transcript) return { status: "cannot_tell", reason: "no transcript" };

  const people = Array.isArray(args.participants)
    ? (args.participants as Array<{ email?: string | null; name?: string | null }>)
    : [];
  if (people.length === 0) return { status: "cannot_tell", reason: "no attendee roster on the call" };

  const sellerNames = new Set(
    people
      .filter((p) => String(p?.email ?? "").toLowerCase().endsWith(`@${SELLER_DOMAIN}`))
      .map((p) => norm(String(p?.name ?? "")))
      .filter(Boolean),
  );
  if (sellerNames.size === 0) {
    return { status: "cannot_tell", reason: "no seller-side attendee to compare speakers against" };
  }

  const labels = speakerLabels(transcript);
  if (labels.length === 0) return { status: "cannot_tell", reason: "no speaker labels in the transcript" };

  const strangers = labels.filter((l) => !sellerNames.has(norm(l)));
  return strangers.length > 0
    ? { status: "spoke", who: strangers }
    : { status: "silent", sellerSpeakers: labels };
}
