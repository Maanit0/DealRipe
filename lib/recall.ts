/**
 * Recall.ai client.
 *
 * Source of truth for endpoint shapes:
 *
 *   POST   /api/v1/bot/                               docs.recall.ai/reference/bot_create
 *   GET    /api/v1/bot/{id}/                          docs.recall.ai/reference/bot_retrieve
 *   POST   /api/v1/recording/{id}/create_transcript/  docs.recall.ai/reference/recording_create_transcript_create
 *   GET    /api/v1/transcript/{id}/                   docs.recall.ai/reference/transcript_retrieve
 *   POST   /api/v1/bot/{id}/delete_media/             docs.recall.ai/reference/bot_delete_media_create
 *
 *   Retention shape:               docs.recall.ai/docs/storage-and-playback
 *   Async transcription provider:  docs.recall.ai/docs/async-transcription
 *   Transcript download schema:    docs.recall.ai/docs/download-schemas
 *
 * IMPORTANT divergence from the original integration brief: Recall does
 * NOT accept async transcription configuration inside recording_config at
 * bot creation time. The recording_config can only carry retention and a
 * handful of meeting-platform tweaks. To transcribe with the recallai_async
 * provider, you POST to /recording/{id}/create_transcript/ AFTER the meeting
 * ends. Full lifecycle:
 *
 *   1. createBot(meetingUrl)                              -> botId
 *   2. poll getBot(botId) until status === "done"
 *   3. createTranscript(botId)    (may be auto-triggered by Recall when
 *      retention is set; getTranscript() checks first and only kicks off
 *      if the recording has no transcript shortcut)
 *   4. poll getBot(botId) until recordings[0].media_shortcuts.transcript.status.code
 *      === "done", then fetch the embedded data.download_url
 *   5. deleteBotMedia(botId)
 *
 * getTranscript() encapsulates steps 3 and 4 so callers see a single
 * "retrieve completed transcript" call as the brief intended. The bot
 * resource itself carries the transcript status and download URL, so
 * there is no separate /transcript/{id} polling loop.
 *
 * Security:
 *   - All calls run server-side. RECALL_API_KEY is read from process.env
 *     and never written to any log line. Errors carry HTTP status and a
 *     truncated body excerpt but never the auth header.
 *   - Throws typed errors (RecallApiError, RecallTimeoutError,
 *     RecallConfigError) consistent with the codebase style.
 */

const BASE_URL = "https://us-west-2.recall.ai";

/** Bot display name used for every bot the system dispatches. */
const BOT_NAME = "DealRipe Notetaker";

/**
 * Retention window the API will hold media + transcript artifacts for.
 *
 * The docs do not publish a minimum but the example uses 144 hours.
 * 24 hours is short and well within published examples; the pipeline
 * calls deleteSourceRecording() immediately after extraction returns,
 * so this is a fallback ceiling, not the primary deletion mechanism.
 *
 * To go to true zero data retention, set this to null at the recording_config
 * level (per storage-and-playback docs).
 */
const RETENTION_HOURS = 24;

/** How long getTranscript() will poll before giving up. */
const TRANSCRIPT_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSCRIPT_POLL_INTERVAL_MS = 5_000;

// ====================================================================
// Errors
// ====================================================================

export class RecallConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecallConfigError";
  }
}

export class RecallApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly bodyExcerpt: string,
  ) {
    super(
      `Recall API ${status} on ${endpoint}: ${truncate(bodyExcerpt, 300)}`,
    );
    this.name = "RecallApiError";
  }
}

export class RecallTimeoutError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly waitedMs: number,
  ) {
    super(`Recall ${endpoint} did not complete within ${waitedMs}ms`);
    this.name = "RecallTimeoutError";
  }
}

// ====================================================================
// Public API
// ====================================================================

export type CreateBotArgs = {
  meetingUrl: string;
  /** ISO 8601 timestamp. Omit for immediate join. */
  joinAt?: string;
};

/**
 * POST /api/v1/bot/
 *
 * Dispatches a Notetaker bot to the meeting. Retention is set on the
 * recording_config; the brief explicitly excludes output_media and chat,
 * so those keys are omitted (the API defaults to no output media and no
 * chat when the keys are absent).
 */
export async function createBot(
  args: CreateBotArgs,
): Promise<{ id: string }> {
  type Body = {
    bot_name: string;
    meeting_url: string;
    join_at?: string;
    recording_config: {
      retention: { type: "timed"; hours: number };
    };
  };
  const body: Body = {
    bot_name: BOT_NAME,
    meeting_url: args.meetingUrl,
    recording_config: {
      retention: { type: "timed", hours: RETENTION_HOURS },
    },
  };
  if (args.joinAt) body.join_at = args.joinAt;

  const res = await recallFetch("/api/v1/bot/", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { id?: string };
  if (typeof json.id !== "string" || !json.id) {
    throw new RecallApiError(
      res.status,
      "/api/v1/bot/",
      `response missing id: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return { id: json.id };
}

/**
 * Status codes emitted by the bot lifecycle. Empirically verified against
 * a live GET /api/v1/bot/{id}/ response (2026-06-03). Recall's docs list
 * a partial set; the real status_changes array also includes intermediate
 * codes like joining_call, in_call_not_recording, recording_done.
 */
export type BotStatus =
  | "joining_call"
  | "in_waiting_room"
  | "in_call_not_recording"
  | "in_call_recording"
  | "call_ended"
  | "recording_done"
  | "done"
  | "fatal"
  | "unknown";

export type BotResource = {
  id: string;
  status: BotStatus;
  rawStatusCode: string;
  /** First recording id, if any. Async transcription kicks off on this. */
  recordingId: string | null;
  /** Convenience: true if the bot resource shows any media artifact. */
  hasMedia: boolean;
  raw: unknown;
};

/**
 * GET /api/v1/bot/{id}/
 *
 * The full bot resource is large and varies by call platform. We parse
 * out the three fields the pipeline actually needs:
 *   - status (latest status_changes entry, normalized)
 *   - recordingId (first recording's id, if uploaded)
 *   - hasMedia (any media artifact reference still attached)
 *
 * The unparsed raw payload is exposed for debugging. The docs for the
 * full response shape are interactive-only; the parser below is
 * defensive on the field names that are documented (status_changes,
 * recordings).
 */
export async function getBot(botId: string): Promise<BotResource> {
  const endpoint = `/api/v1/bot/${encodeURIComponent(botId)}/`;
  const res = await recallFetch(endpoint, { method: "GET" });
  const json = (await res.json()) as Record<string, unknown>;

  const rawStatusCode = extractLatestStatusCode(json);
  const recordingId = extractFirstRecordingId(json);
  const hasMedia = recordingId !== null && !looksDeleted(json);

  return {
    id: String(json.id ?? botId),
    status: normalizeStatus(rawStatusCode),
    rawStatusCode,
    recordingId,
    hasMedia,
    raw: json,
  };
}

/**
 * Recording duration in whole minutes, computed from the bot's status_changes
 * timestamps: from when recording started (in_call_recording) to when it ended
 * (recording_done, or call_ended as a fallback). Returns null if the timestamps
 * aren't both present. Defensive on the timestamp field name across Recall
 * response shapes (created_at / ts / timestamp).
 */
export function recordingDurationMinutes(bot: BotResource): number | null {
  const raw = bot.raw;
  if (!isRecord(raw)) return null;
  const changes = raw.status_changes;
  if (!Array.isArray(changes)) return null;

  const tsOf = (code: string): number | null => {
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i];
      if (!isRecord(c) || c.code !== code) continue;
      const t = c.created_at ?? c.ts ?? c.timestamp;
      if (typeof t === "string") {
        const ms = Date.parse(t);
        if (!Number.isNaN(ms)) return ms;
      }
    }
    return null;
  };

  const start = tsOf("in_call_recording");
  const end = tsOf("recording_done") ?? tsOf("call_ended");
  if (start === null || end === null || end <= start) return null;
  return Math.max(1, Math.round((end - start) / 60_000));
}

/**
 * POST /api/v1/recording/{recording_id}/create_transcript/
 *
 * Kicks off async transcription on a completed recording. Uses Recall's
 * own async provider (recallai_async) with language auto-detect.
 *
 * Throws RecallConfigError if the bot has not yet produced a recording
 * (i.e. the meeting did not happen or has not finished uploading).
 */
export async function createTranscript(botId: string): Promise<{
  transcriptId: string;
}> {
  const bot = await getBot(botId);
  if (!bot.recordingId) {
    throw new RecallConfigError(
      `Bot ${botId} has no recording yet (status=${bot.rawStatusCode}). ` +
        `Wait until status is "done" before kicking off transcription.`,
    );
  }

  const endpoint = `/api/v1/recording/${encodeURIComponent(bot.recordingId)}/create_transcript/`;
  const body = {
    provider: {
      recallai_async: { language_code: "auto" },
    },
    diarization: { use_separate_streams_when_available: true },
  };
  const res = await recallFetch(endpoint, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { id?: string };
  if (typeof json.id !== "string" || !json.id) {
    throw new RecallApiError(
      res.status,
      endpoint,
      `response missing transcript id: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return { transcriptId: json.id };
}

/**
 * Retrieve the completed transcript for a bot, normalized to a single
 * speaker-labeled plain-text string ready for ingestTranscript().
 *
 * Flow:
 *   1. getBot(botId). The bot resource embeds the transcript shortcut at
 *      recordings[0].media_shortcuts.transcript with its own status.code
 *      and data.download_url. No separate /transcript/{id} polling needed.
 *   2. If the shortcut is missing entirely, the recording has not been
 *      transcribed yet -- call createTranscript() to kick one off, then
 *      keep polling getBot.
 *   3. Poll getBot until the shortcut's status.code === "done".
 *   4. Fetch the signed download_url and normalize the participant/words
 *      array into "Name: utterance" lines (one line per speaker turn).
 *
 * The brief gives a single-call surface (getTranscript(botId)); steps 2-4
 * are encapsulated here so callers don't have to know about the
 * recording_id intermediate.
 */
export async function getTranscript(botId: string): Promise<string> {
  const start = Date.now();
  const deadline = start + TRANSCRIPT_POLL_TIMEOUT_MS;
  let kickedOff = false;

  while (Date.now() < deadline) {
    const bot = await getBot(botId);
    if (!bot.recordingId) {
      throw new RecallConfigError(
        `Bot ${botId} has no recording (status=${bot.rawStatusCode}).`,
      );
    }

    const transcriptStatus = extractTranscriptStatusCode(bot.raw);

    if (transcriptStatus === null) {
      // No transcript shortcut on the recording yet. Kick one off the
      // first time we see this; on subsequent polls just wait for the
      // shortcut to appear.
      if (!kickedOff) {
        await createTranscript(botId);
        kickedOff = true;
      }
      await sleep(TRANSCRIPT_POLL_INTERVAL_MS);
      continue;
    }

    if (transcriptStatus === "done") {
      const downloadUrl = extractTranscriptDownloadUrl(bot.raw);
      if (!downloadUrl) {
        throw new RecallApiError(
          200,
          `/api/v1/bot/${botId}/`,
          "transcript shortcut status=done but data.download_url missing",
        );
      }
      const rawTranscript = await fetchDownloadUrl(downloadUrl);
      return normalizeTranscript(rawTranscript);
    }

    if (transcriptStatus === "failed") {
      throw new RecallApiError(
        200,
        `/api/v1/bot/${botId}/`,
        `transcript shortcut reports status=failed`,
      );
    }

    // Still processing. Wait and re-poll.
    await sleep(TRANSCRIPT_POLL_INTERVAL_MS);
  }

  throw new RecallTimeoutError(`/api/v1/bot/${botId}/ (transcript)`, TRANSCRIPT_POLL_TIMEOUT_MS);
}

/**
 * POST /api/v1/bot/{id}/delete_media/
 *
 * Permanently removes recording media from Recall storage. The DPA
 * delete-after-pull call. Empty request body. 200 on success; 409 if
 * deletion is already in progress or media is already gone.
 *
 * Returns void; callers verify deletion by refetching getBot() and
 * checking hasMedia.
 */
export async function deleteBotMedia(botId: string): Promise<void> {
  const endpoint = `/api/v1/bot/${encodeURIComponent(botId)}/delete_media/`;
  await recallFetch(endpoint, { method: "POST" });
}

/**
 * DELETE /api/v1/bot/{id}/
 *
 * Removes the bot resource entirely. Distinct from deleteBotMedia,
 * which only purges recorded media but leaves the bot row. Use this
 * to cancel a scheduled bot before it joins, or to retire a bot whose
 * meeting time changed (the calendar-sync reschedule path).
 */
export async function deleteBot(botId: string): Promise<void> {
  const endpoint = `/api/v1/bot/${encodeURIComponent(botId)}/`;
  await recallFetch(endpoint, { method: "DELETE" });
}

// ====================================================================
// Internals
// ====================================================================

type RecallFetchInit = { method: "GET" | "POST" | "DELETE"; body?: string };

async function recallFetch(
  path: string,
  init: RecallFetchInit,
): Promise<Response> {
  if (typeof window !== "undefined") {
    throw new RecallConfigError("Recall client must not be called from the browser");
  }
  const key = process.env.RECALL_API_KEY;
  if (!key) {
    throw new RecallConfigError("RECALL_API_KEY is not set");
  }
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: init.method,
    headers: {
      // Token-scheme auth per the brief. Never logged.
      Authorization: `Token ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init.body,
  });
  if (!res.ok) {
    const text = await safeReadText(res);
    throw new RecallApiError(res.status, path, text);
  }
  return res;
}

async function fetchDownloadUrl(url: string): Promise<unknown> {
  // download_url is a signed URL pointing at object storage. It does NOT
  // take the Recall auth header (the signature is the auth). Plain fetch.
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const text = await safeReadText(res);
    throw new RecallApiError(res.status, "(transcript download_url)", text);
  }
  return await res.json();
}

/**
 * Normalize the Recall async transcript download to "Name: utterance"
 * lines, one line per segment in the order Recall returned them.
 *
 * Input shape (verified against a live download payload 2026-06-03):
 *   [
 *     {
 *       "participant": { "id": 1, "name": "Alice Smith", ... },
 *       "language_code": "en",
 *       "words": [
 *         { "text": "Hello", "start_timestamp": { "relative": 9.73, "absolute": null }, ... },
 *         ...
 *       ]
 *     },
 *     ...
 *   ]
 *
 * The top-level array is already in segment order. Each segment is one
 * speaker turn; we emit exactly one line per segment, joining its words
 * with single spaces. No global sort and no speaker-turn merging across
 * adjacent segments by the same participant (a single speaker can hold
 * the floor across multiple segments, and we preserve those boundaries).
 *
 * Output: speaker-labeled lines suitable for ingestTranscript().
 */
export function normalizeTranscript(raw: unknown): string {
  if (!Array.isArray(raw)) return "";

  const lines: string[] = [];
  for (const segment of raw) {
    if (!isRecord(segment)) continue;

    const participant = isRecord(segment.participant) ? segment.participant : null;
    const speaker = String(
      (participant && typeof participant.name === "string" && participant.name) ||
        (participant && participant.id !== undefined && participant.id !== null
          ? participant.id
          : "Unknown"),
    );

    const words = Array.isArray(segment.words) ? segment.words : [];
    const text = words
      .map((w) => (isRecord(w) && typeof w.text === "string" ? w.text : ""))
      .filter((t) => t !== "")
      .join(" ");

    if (text) lines.push(`${speaker}: ${text}`);
  }
  return lines.join("\n");
}

// ----- Response field extraction. Defensive on the documented shape. -----

function extractLatestStatusCode(bot: Record<string, unknown>): string {
  const changes = bot.status_changes;
  if (Array.isArray(changes) && changes.length > 0) {
    const last = changes[changes.length - 1];
    if (isRecord(last) && typeof last.code === "string") return last.code;
  }
  // Some responses surface a top-level status object.
  if (isRecord(bot.status) && typeof bot.status.code === "string") {
    return bot.status.code;
  }
  return "unknown";
}

function normalizeStatus(code: string): BotStatus {
  const known: BotStatus[] = [
    "joining_call",
    "in_waiting_room",
    "in_call_not_recording",
    "in_call_recording",
    "call_ended",
    "recording_done",
    "done",
    "fatal",
  ];
  return (known as string[]).includes(code) ? (code as BotStatus) : "unknown";
}

function extractFirstRecordingId(bot: Record<string, unknown>): string | null {
  const recordings = bot.recordings;
  if (Array.isArray(recordings) && recordings.length > 0) {
    const r = recordings[0];
    if (isRecord(r) && typeof r.id === "string") return r.id;
  }
  return null;
}

/**
 * The transcript lives at recordings[0].media_shortcuts.transcript, NOT
 * recordings[0].transcripts[]. Empirically verified against a live bot
 * response (2026-06-03).
 */
function extractFirstTranscriptId(bot: unknown): string | null {
  const t = getTranscriptShortcut(bot);
  if (t && typeof t.id === "string") return t.id;
  return null;
}

function extractTranscriptStatusCode(bot: unknown): string | null {
  const t = getTranscriptShortcut(bot);
  if (!t) return null;
  if (isRecord(t.status) && typeof t.status.code === "string") return t.status.code;
  return null;
}

function extractTranscriptDownloadUrl(bot: unknown): string | null {
  const t = getTranscriptShortcut(bot);
  if (!t) return null;
  if (isRecord(t.data) && typeof t.data.download_url === "string") {
    return t.data.download_url;
  }
  return null;
}

function getTranscriptShortcut(bot: unknown): Record<string, unknown> | null {
  if (!isRecord(bot)) return null;
  const recordings = bot.recordings;
  if (!Array.isArray(recordings) || recordings.length === 0) return null;
  const r = recordings[0];
  if (!isRecord(r)) return null;
  const ms = r.media_shortcuts;
  if (!isRecord(ms)) return null;
  if (isRecord(ms.transcript)) return ms.transcript;
  return null;
}

/**
 * Detect whether media has been deleted from Recall's storage. Heuristic
 * because the post-delete bot shape is not in the static docs:
 *
 *   - recordings array empty                       -> deleted
 *   - recordings[0].media_shortcuts missing        -> deleted
 *   - neither video_mixed nor audio_mixed carries  -> media gone (transcript
 *     a data.download_url                             metadata may remain)
 *   - recordings[0].expires_at is in the past      -> expired (Recall TTL)
 */
function looksDeleted(bot: Record<string, unknown>): boolean {
  const recordings = bot.recordings;
  if (!Array.isArray(recordings) || recordings.length === 0) return true;

  for (const r of recordings) {
    if (!isRecord(r)) continue;

    if (
      typeof r.expires_at === "string" &&
      r.expires_at &&
      Date.parse(r.expires_at) < Date.now()
    ) {
      return true;
    }

    const ms = r.media_shortcuts;
    if (!isRecord(ms)) return true;

    const hasVideo = hasDownloadUrl(ms.video_mixed);
    const hasAudio = hasDownloadUrl(ms.audio_mixed);
    if (!hasVideo && !hasAudio) return true;
  }
  return false;
}

function hasDownloadUrl(media: unknown): boolean {
  if (!isRecord(media)) return false;
  if (!isRecord(media.data)) return false;
  return typeof media.data.download_url === "string" && media.data.download_url !== "";
}

// ----- Misc -----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(response body unreadable)";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
