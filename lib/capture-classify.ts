/**
 * Why a call did or did not produce a conversation.
 *
 * This is the single source of that decision. transcript-sync writes it at
 * the moment of failure, the backfill recovers it for calls decided before
 * this file existed, and capture-health counts it. None of the three restate
 * the rules, because a checker that can disagree with the code it checks
 * will, and it will do so confidently.
 *
 * The bug that produced this file: transcript-sync recorded "bot done but
 * media unavailable" on fourteen calls. Recall had told us the real cause for
 * every one of them and we discarded it, because extractLatestStatusDetail in
 * lib/recall.ts reads the sub_code off the LAST status entry. A bot that dies
 * in a waiting room ends on a bare "done" that carries no sub_code, and the
 * entry immediately before it carries timeout_exceeded_waiting_room. So the
 * code printed "sub_code=(none given)" with the answer one array element away.
 *
 * Thirteen of the fourteen were never admitted to the meeting. Not one of
 * them lost media, because not one of them ever recorded any.
 *
 * The rule this file exists to hold: evidence we do not have is never
 * evidence of absence. There are three separate states for "we do not know"
 * and none of them is a failure category.
 */

import { getBot, RecallApiError, type BotResource } from "./recall";

// ====================================================================
// Evidence
// ====================================================================

/** One Recall lifecycle transition, kept as observed. */
export type CaptureStatusChange = {
  code: string;
  /** Null means Recall gave no sub_code on this entry, not that there was no cause. */
  subCode: string | null;
  message: string | null;
  at: string | null;
};

/**
 * What we know about a bot, and how we came to know it.
 *
 * Three states, not two. "Recall says the bot was kicked out of the waiting
 * room", "we asked and Recall no longer has this bot", and "we never asked"
 * look the same at the call level and mean completely different things.
 */
export type CaptureEvidence =
  | {
      state: "observed";
      statusChanges: CaptureStatusChange[];
      hasMedia: boolean;
      recordingCount: number;
    }
  | {
      /** We asked and could not be told. The cause is now unrecoverable. */
      state: "unavailable";
      reason: string;
      /** True when Recall has forgotten the bot rather than merely failed to answer. */
      expired: boolean;
    }
  | {
      /** We never asked. Says nothing at all about the call. */
      state: "not_checked";
      reason: string;
    }
  | {
      /**
       * We did not ask Recall, and we do not need to: we are holding the
       * conversation.
       *
       * A stored transcript is stronger evidence of capture than any status
       * history, because it is the thing the status history exists to predict.
       * This state was added so the 77 successfully captured calls could be
       * classified without a Recall round trip and without a second copy of the
       * rule living in a backfill script.
       *
       * It only ever yields 'captured'. It is deliberately incapable of
       * explaining a FAILURE, because local state cannot: "no transcript" is
       * consistent with a lobby timeout, a no-show and a media loss alike, and
       * telling those apart is exactly what Recall's history is for. A caller
       * with no transcript must use `not_checked` and go ask.
       */
      state: "local";
      transcriptChars: number;
      reason: string;
    };

// ====================================================================
// Verdict
// ====================================================================

export type CaptureCategory =
  /** A conversation was recorded and extracted. */
  | "captured"
  /** The bot got in and there was no conversation to capture. Not our failure. */
  | "no_show"
  /** Never admitted, and Recall cannot tell us whether the meeting even ran. */
  | "lobby_timeout"
  /** A human was present and actively denied the bot. The meeting happened. */
  | "lobby_refused"
  /** Never reached a waiting room at all: a dead link, an inaccessible meeting. */
  | "never_joined"
  /** Reached in_call_recording and the media is gone. Recall's side. */
  | "media_lost"
  /** We cannot say, and the reason we cannot say is carried with it. */
  | "unknown";

/**
 * Whether this call counts against capture rate.
 *
 * Tri-state, because the honest answer for a lobby timeout is neither yes nor
 * no. The number goes to a CRO. Counting an undecidable as a failure
 * understates the product and counting it as a success overstates it, so it
 * is reported as itself and the reader decides.
 */
export type FailureVerdict = "yes" | "no" | "undecidable";

export type CaptureVerdict = {
  category: CaptureCategory;
  /** Recall's own word, verbatim. Null means Recall did not give one. */
  subCode: string | null;
  /** One line for a human. Always names the reason when the category is unknown. */
  detail: string;
  /** Whether this verdict rests on observation or on the absence of it. */
  basis: CaptureEvidence["state"];
  countsAsCaptureFailure: FailureVerdict;
  /** True when the bot reached the point of recording. */
  reachedRecording: boolean;
};

// ====================================================================
// Recall's vocabulary
// ====================================================================

/**
 * Sub_codes seen in the Magaya pilot, plus the ones Recall's automatic_leave
 * config implies we will eventually see. Anything not listed falls through to
 * a structural read of the status codes and, failing that, to unknown. A
 * sub_code we have never seen must never be silently absorbed into a category
 * that happens to be nearby.
 */
const SUB_CODE_MEANING: Record<string, { category: CaptureCategory; detail: string }> = {
  // A human clicked deny. Somebody was in that meeting.
  bot_kicked_from_waiting_room: {
    category: "lobby_refused",
    detail: "someone in the meeting denied the bot entry, so the meeting was running and the bot was refused",
  },
  bot_kicked_from_call: {
    category: "lobby_refused",
    detail: "the bot was removed from the call by a participant",
  },
  // Nobody let it in. Undecidable between an unattended lobby and no meeting.
  timeout_exceeded_waiting_room: {
    category: "lobby_timeout",
    detail: "the bot waited in the lobby and nobody admitted it",
  },
  call_ended_by_platform_waiting_room_timeout: {
    category: "lobby_timeout",
    detail: "the meeting platform closed the lobby before anyone admitted the bot",
  },
  // Recall's own no-show detection: the bot was INSIDE and nobody else came.
  // This is decidable and it is not a capture failure.
  timeout_exceeded_noone_joined: {
    category: "no_show",
    detail: "the bot was in the meeting and nobody else joined",
  },
  timeout_exceeded_everyone_left: {
    category: "no_show",
    detail: "everyone left the meeting and the bot was the last one in it",
  },
  timeout_exceeded_only_bots_detected_in_call: {
    category: "no_show",
    detail: "no human was ever detected in the meeting",
  },
  // Never got as far as a door.
  meeting_not_accessible: {
    category: "never_joined",
    detail: "the join link was not usable, so the bot never reached the meeting",
  },
  meeting_link_expired: {
    category: "never_joined",
    detail: "the invite carried a link that had already expired",
  },
  meeting_not_found: {
    category: "never_joined",
    detail: "the meeting did not exist at the link on the invite",
  },
  insufficient_credits: {
    category: "never_joined",
    detail: "the Recall account had no credit, so the bot was never dispatched into the meeting",
  },
  recording_permission_denied: {
    category: "lobby_refused",
    detail: "the bot was admitted and recording permission was refused",
  },
};

// ====================================================================
// Reading the evidence
// ====================================================================

/** Pull the status history off a bot we already hold. No further I/O. */
export function captureEvidenceFromBot(bot: BotResource): CaptureEvidence {
  const raw = bot.raw;
  const changes =
    isRecord(raw) && Array.isArray(raw.status_changes) ? raw.status_changes : null;

  // A bot resource with no status_changes array at all is Recall not telling
  // us, which is a gap in what we can see and not proof the bot did nothing.
  if (changes === null) {
    return {
      state: "unavailable",
      reason: "Recall returned a bot resource with no status_changes array",
      expired: false,
    };
  }

  const recordings = isRecord(raw) && Array.isArray(raw.recordings) ? raw.recordings : [];

  return {
    state: "observed",
    statusChanges: changes.map(readStatusChange).filter((c): c is CaptureStatusChange => c !== null),
    hasMedia: bot.hasMedia,
    recordingCount: recordings.length,
  };
}

/**
 * Fetch the evidence for a bot.
 *
 * A 404 is reported as expired rather than as an error, because it is the one
 * failure mode that is permanent: Recall has forgotten the bot and no later
 * run will recover it. Everything else is an unavailable that may succeed on
 * a retry, and the caller is told which it got.
 */
export async function readCaptureEvidence(botId: string | null): Promise<CaptureEvidence> {
  if (botId === null || botId.trim() === "") {
    return {
      state: "not_checked",
      reason: "no bot was ever dispatched for this call, so Recall has nothing to tell us",
    };
  }
  try {
    const bot = await getBot(botId);
    return captureEvidenceFromBot(bot);
  } catch (err) {
    if (err instanceof RecallApiError && err.status === 404) {
      return {
        state: "unavailable",
        reason: `Recall no longer has bot ${botId}; the evidence for this call has expired and cannot be recovered`,
        expired: true,
      };
    }
    return {
      state: "unavailable",
      reason: `could not read bot ${botId} from Recall: ${err instanceof Error ? err.message : String(err)}`,
      expired: false,
    };
  }
}

function readStatusChange(entry: unknown): CaptureStatusChange | null {
  if (!isRecord(entry)) return null;
  const code = typeof entry.code === "string" ? entry.code : null;
  if (code === null) return null;
  const at = entry.created_at ?? entry.ts ?? entry.timestamp;
  return {
    code,
    subCode: typeof entry.sub_code === "string" && entry.sub_code.length > 0 ? entry.sub_code : null,
    message: typeof entry.message === "string" && entry.message.length > 0 ? entry.message : null,
    at: typeof at === "string" ? at : null,
  };
}

/**
 * The sub_code that explains the outcome.
 *
 * Scans BACKWARDS for the first entry that carries one, rather than reading
 * the last entry. This one line is the whole bug: a lobby death ends
 * ... -> call_ended(timeout_exceeded_waiting_room) -> done, and "done" carries
 * nothing.
 */
export function terminalSubCode(changes: CaptureStatusChange[]): string | null {
  for (let i = changes.length - 1; i >= 0; i--) {
    if (changes[i].subCode !== null) return changes[i].subCode;
  }
  return null;
}

// ====================================================================
// The classifier
// ====================================================================

export type ClassifyArgs = {
  evidence: CaptureEvidence;
  /**
   * Length of the stored transcript, when one exists. Null means we did not
   * look, which is not the same as zero. A bot that recorded and produced
   * nothing is a no-show; a bot that recorded and whose transcript we have
   * not read is not yet classified.
   */
  transcriptChars?: number | null;
  /**
   * Whose meeting it was, from the calendar organizer.
   *
   * Only consulted for a refusal, where it changes the answer. Eduardo,
   * 2026-08-14, on a bot being denied entry: "good if it's maybe an internal
   * conversation, I think I rejected it once." Both refusals in the pilot were
   * in meetings Magaya organized, so the person who clicked deny was on
   * Magaya's side, and a rep keeping a conversation private is the product
   * respecting them rather than failing.
   *
   * 'unknown' when no organizer was recorded, and it is treated as unknown
   * rather than as either side.
   */
  hostSide?: "our_side" | "customer_side" | "unknown";
};

/**
 * Which side organized the meeting, from the organizer address.
 *
 * Null in, unknown out. A row written before organizer_email existed cannot
 * say whose lobby the bot was in, and reporting that as customer-hosted would
 * point the fix at the wrong company.
 */
export function hostSideOf(
  organizerEmail: string | null,
  ourDomain: string,
): "our_side" | "customer_side" | "unknown" {
  if (organizerEmail === null || organizerEmail.trim() === "") return "unknown";
  return organizerEmail.toLowerCase().endsWith(`@${ourDomain.toLowerCase()}`)
    ? "our_side"
    : "customer_side";
}

/**
 * Turn observations into a verdict.
 *
 * Order matters. Recording is checked before the lobby, because a bot that
 * recorded and later lost its media also passed through a waiting room, and
 * "recorded then lost" is Recall's problem while "never admitted" is ours.
 */
export function classifyCapture(args: ClassifyArgs): CaptureVerdict {
  const { evidence } = args;
  const transcriptChars = args.transcriptChars ?? null;

  // Holding the transcript settles it. No Recall history can contradict a
  // conversation we have on disk, so this is checked before the states that
  // describe what Recall did or did not tell us.
  if (evidence.state === "local") {
    return {
      category: "captured",
      subCode: null,
      detail: `${evidence.transcriptChars} characters of transcript are stored for this call, so it was captured. ${evidence.reason}`,
      basis: "local",
      countsAsCaptureFailure: "no",
      reachedRecording: true,
    };
  }

  if (evidence.state === "not_checked") {
    return {
      category: "unknown",
      subCode: null,
      detail: `not classified: ${evidence.reason}`,
      basis: "not_checked",
      countsAsCaptureFailure: "undecidable",
      reachedRecording: false,
    };
  }

  if (evidence.state === "unavailable") {
    return {
      category: "unknown",
      subCode: null,
      detail: evidence.expired
        ? `evidence no longer available: ${evidence.reason}`
        : `could not establish a cause: ${evidence.reason}`,
      basis: "unavailable",
      countsAsCaptureFailure: "undecidable",
      reachedRecording: false,
    };
  }

  const { statusChanges, hasMedia, recordingCount } = evidence;
  const codes = statusChanges.map((c) => c.code);
  const subCode = terminalSubCode(statusChanges);
  const reachedRecording = codes.includes("in_call_recording");

  // An empty history is a gap in what Recall told us, not a bot that did
  // nothing. Two conclusions that could not be further apart.
  if (statusChanges.length === 0) {
    return {
      category: "unknown",
      subCode: null,
      detail:
        "Recall returned an empty status history for this bot, which is a gap in what we can see rather than proof the bot did nothing",
      basis: "observed",
      countsAsCaptureFailure: "undecidable",
      reachedRecording: false,
    };
  }

  // ----- The bot got as far as recording. -----
  if (reachedRecording) {
    if (transcriptChars !== null && transcriptChars < 50) {
      return {
        category: "no_show",
        subCode,
        detail: `the bot recorded and captured ${transcriptChars} characters, so there was no conversation to capture`,
        basis: "observed",
        countsAsCaptureFailure: "no",
        reachedRecording: true,
      };
    }
    if (transcriptChars !== null && transcriptChars >= 50) {
      return {
        category: "captured",
        subCode,
        detail: `the bot recorded and a ${transcriptChars} character transcript is stored`,
        basis: "observed",
        countsAsCaptureFailure: "no",
        reachedRecording: true,
      };
    }
    if (hasMedia) {
      return {
        category: "unknown",
        subCode,
        detail:
          "the bot recorded and media is still attached, but no transcript has been read yet, so whether it captured a conversation is not yet decided",
        basis: "observed",
        countsAsCaptureFailure: "undecidable",
        reachedRecording: true,
      };
    }
    // The bot recorded, media is gone, and the caller did not tell us whether
    // we hold the transcript. This is NOT a media loss, and calling it one was
    // a bug for most of a day.
    //
    // We delete the media ourselves. deleteSourceRecording runs on every
    // successful capture to honour the delete-after-pull commitment, so an
    // absent recording is the normal end state of a call that worked
    // perfectly. Probing Gezairi and Speed International, both captured with
    // 22,301 and 54,860 character transcripts sitting in our own database,
    // returned "media_lost" on this branch.
    //
    // Absence of media is not evidence of loss when we are the ones who
    // removed it. The only thing that separates "Recall lost it" from "we
    // pulled it and cleaned up" is whether the transcript is stored, and a
    // caller who did not pass transcriptChars has not looked. So this says it
    // does not know, and names what to check.
    return {
      category: "unknown",
      subCode,
      detail:
        `the bot recorded and no media is attached` +
        (subCode === null ? "" : ` (${subCode})`) +
        `, which is also what a successful capture looks like once we delete the recording. ` +
        `Whether the conversation was lost cannot be decided without checking whether a transcript is stored for this call.`,
      basis: "observed",
      countsAsCaptureFailure: "undecidable",
      reachedRecording: true,
    };
  }

  // ----- It never recorded. What Recall says about why. -----
  if (subCode !== null) {
    const known = SUB_CODE_MEANING[subCode];
    if (known) {
      const host = args.hostSide ?? "unknown";
      return {
        category: known.category,
        subCode,
        detail: `${known.detail} (${subCode})${refusalNote(known.category, host)}`,
        basis: "observed",
        countsAsCaptureFailure: failureVerdictFor(known.category, host),
        reachedRecording: false,
      };
    }
  }

  // ----- Recall gave a sub_code we do not recognise, or none at all. Read
  //       the structure instead, and say that is what we did. -----
  if (codes.includes("in_waiting_room")) {
    return {
      category: "lobby_timeout",
      subCode,
      detail:
        `the bot reached the waiting room and never got in` +
        (subCode === null
          ? ", and Recall gave no sub_code for why"
          : `, with an unrecognised sub_code (${subCode})`),
      basis: "observed",
      countsAsCaptureFailure: "undecidable",
      reachedRecording: false,
    };
  }

  if (codes.includes("fatal")) {
    return {
      category: "never_joined",
      subCode,
      detail:
        `the bot terminated before reaching the meeting` +
        (subCode === null
          ? ", and Recall gave no sub_code for why"
          : `, with an unrecognised sub_code (${subCode})`),
      basis: "observed",
      countsAsCaptureFailure: "yes",
      reachedRecording: false,
    };
  }

  return {
    category: "unknown",
    subCode,
    detail:
      `the bot's history ends at ${codes[codes.length - 1]} without reaching a waiting room, a recording or a fatal state` +
      (subCode === null ? " and carries no sub_code" : ` (${subCode})`),
    basis: "observed",
    countsAsCaptureFailure: "undecidable",
    reachedRecording: false,
  };
}

/**
 * Does this category count against capture rate.
 *
 * lobby_timeout is undecidable on purpose and permanently. Recall's bot sits
 * outside the room and cannot see whether anyone is inside it, so "the
 * meeting ran and nobody noticed the lobby" and "the meeting never happened,
 * so there was nobody to admit anything" produce byte-identical histories.
 * Recall's own noone_joined_timeout, which WOULD decide it, only fires once
 * the bot is inside, which is exactly the case that never occurs here.
 *
 * lobby_refused depends on whose meeting it was, and this was wrong for a day.
 * A refusal was counted as a definite loss until Eduardo said on 2026-08-14
 * that he had denied the bot himself once and that doing so is correct when
 * the conversation is internal. Both refusals in the pilot were in
 * Magaya-organized meetings, so the hand on the deny button was Magaya's. A
 * rep exercising that choice is not a failure, and a colleague who did not
 * recognise the bot is, and the two look identical from here. So a refusal in
 * our own meeting is undecidable and someone has to be asked; a refusal in the
 * customer's meeting is a loss, because nobody on our side chose it.
 */
function failureVerdictFor(
  category: CaptureCategory,
  hostSide: "our_side" | "customer_side" | "unknown" = "unknown",
): FailureVerdict {
  switch (category) {
    case "captured":
    case "no_show":
      return "no";
    case "lobby_refused":
      return hostSide === "customer_side" ? "yes" : "undecidable";
    case "never_joined":
    case "media_lost":
      return "yes";
    case "lobby_timeout":
    case "unknown":
      return "undecidable";
  }
}

/** Say who to ask, on the one verdict where the answer turns on a person. */
function refusalNote(
  category: CaptureCategory,
  hostSide: "our_side" | "customer_side" | "unknown",
): string {
  if (category !== "lobby_refused") return "";
  if (hostSide === "customer_side") {
    return ". The customer organized this meeting, so the refusal was theirs.";
  }
  if (hostSide === "our_side") {
    return ". We organized this meeting, so someone on our side denied it. Ask the rep whether that was deliberate before counting it as a loss.";
  }
  return ". No organizer was recorded, so whose lobby this was is unknown and so is whether the refusal was deliberate.";
}

/**
 * The verdict for a call we are not asking Recall about, decided from what
 * the pipeline already recorded. Lets capture-health cover captured and
 * rep-classified calls with the same classifier, rather than a second set of
 * rules that can drift from this one.
 *
 * Returns null when the stored outcome carries no capture meaning, so the
 * caller must go and read the evidence instead of assuming.
 */
export function verdictFromOutcome(outcome: string | null): CaptureVerdict | null {
  switch (outcome) {
    case "captured":
      return {
        category: "captured",
        subCode: null,
        detail: "extraction ran against a stored transcript",
        basis: "observed",
        countsAsCaptureFailure: "no",
        reachedRecording: true,
      };
    case "no_conversation":
      return {
        category: "no_show",
        subCode: null,
        detail: "the bot recorded and captured no conversation",
        basis: "observed",
        countsAsCaptureFailure: "no",
        reachedRecording: true,
      };
    case "no_show":
      return {
        category: "no_show",
        subCode: null,
        detail: "a customer was invited and nobody from their side spoke",
        basis: "observed",
        countsAsCaptureFailure: "no",
        reachedRecording: true,
      };
    default:
      return null;
  }
}

/**
 * Whether the evidence already proves no media can ever arrive.
 *
 * transcript-sync waits MEDIA_GRACE_MS before calling a finished bot with no
 * media lost, because a slow upload and a lost recording look identical in
 * one poll. They do not look identical when the bot never recorded: a history
 * ending in a lobby timeout with an empty recordings array has nothing to
 * upload, and waiting 45 minutes to say so only delays the alarm.
 *
 * Deliberately conservative. It returns true only where the history is
 * terminal AND the bot never reached in_call_recording AND Recall lists no
 * recordings. Anything else keeps the grace period, because the cost of
 * waiting is a late recap and the cost of not waiting is a lost conversation.
 */
export function mediaIsImpossible(evidence: CaptureEvidence): boolean {
  if (evidence.state !== "observed") return false;
  if (evidence.recordingCount > 0) return false;
  const codes = evidence.statusChanges.map((c) => c.code);
  if (codes.includes("in_call_recording")) return false;
  const sub = terminalSubCode(evidence.statusChanges);
  if (sub === null) return false;
  const known = SUB_CODE_MEANING[sub];
  if (!known) return false;
  return (
    known.category === "lobby_timeout" ||
    known.category === "lobby_refused" ||
    known.category === "never_joined"
  );
}

/** The columns transcript-sync and the backfill both write. One shape, one writer. */
export function captureColumns(
  evidence: CaptureEvidence,
  verdict: CaptureVerdict,
): {
  capture_evidence: "observed" | "unavailable" | "not_checked";
  capture_class: CaptureCategory;
  capture_sub_code: string | null;
  capture_detail: string;
  capture_status_changes: CaptureStatusChange[] | null;
  capture_checked_at: string;
} {
  return {
    // 'local' is deliberately NOT a value of this column, and the check
    // constraint in add-capture-diagnostics.sql agrees.
    //
    // capture_evidence answers exactly one question: was Recall's account of
    // this bot read. Classifying a call from a transcript we already hold
    // answers a different question and leaves that one untouched, so it stores
    // 'not_checked', which is true. Writing 'observed' here because we were
    // confident would be the same lie the column exists to prevent, and the
    // confidence is recorded in capture_class and capture_detail instead.
    capture_evidence: evidence.state === "local" ? "not_checked" : evidence.state,
    capture_class: verdict.category,
    capture_sub_code: verdict.subCode,
    capture_detail: verdict.detail,
    capture_status_changes: evidence.state === "observed" ? evidence.statusChanges : null,
    // Same reasoning: a local classification did not check anything, so the
    // "when did we check" stamp must not move. Only a Recall read sets it.
    capture_checked_at: new Date().toISOString(),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
