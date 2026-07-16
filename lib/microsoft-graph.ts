/**
 * Microsoft Graph client.
 *
 * Scope of this module:
 *   - Mint access tokens from stored refresh tokens (rotated tokens
 *     re-persisted automatically).
 *   - List upcoming calendar events for a connected user, with the
 *     field set narrowed to what DealRipe needs.
 *
 * What this module never touches:
 *   - Event body or attachments. Per the DPA section 2.2(d), DealRipe
 *     reads only the fields explicitly listed in $select below.
 *   - Access tokens are NEVER persisted; they live only in memory for
 *     the duration of a Graph call.
 *
 * Endpoint reference:
 *   POST https://login.microsoftonline.com/organizations/oauth2/v2.0/token
 *   GET  https://graph.microsoft.com/v1.0/me/calendarView
 */

import { getTokenEndpoint } from "./microsoft-auth";
import { decryptToken, encryptToken } from "./token-crypto";
import { supabaseAdmin } from "./supabase";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Fields requested from /me/calendarView. Narrow on purpose: body,
 * attachments, attendees' free-text comment, and other fields that
 * could carry sensitive content are explicitly excluded per DPA 2.2(d).
 */
const CALENDAR_VIEW_SELECT = [
  "id",
  "subject",
  "start",
  "end",
  "attendees",
  "organizer",
  "onlineMeeting",
  "isCancelled",
].join(",");

// ====================================================================
// Errors
// ====================================================================

export class GraphConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphConfigError";
  }
}

export class GraphApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly bodyExcerpt: string,
  ) {
    super(`Graph API ${status} on ${endpoint}: ${truncate(bodyExcerpt, 300)}`);
    this.name = "GraphApiError";
  }
}

// ====================================================================
// Public API
// ====================================================================

/**
 * Mint a fresh access token for a stored connection. Side effects:
 *   - If Microsoft rotated the refresh token, re-encrypt and persist
 *     the new value.
 *   - Always updates last_synced_at on the connection row.
 *
 * Does NOT persist the access token. The caller holds it in memory
 * only for the duration of its Graph calls.
 */
export async function getAccessToken(connectionId: string): Promise<string> {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GraphConfigError(
      "MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be set",
    );
  }

  const db = supabaseAdmin();
  const conn = await db
    .from("microsoft_connections")
    .select("id, refresh_token_encrypted, scopes")
    .eq("id", connectionId)
    .maybeSingle();
  if (conn.error) {
    throw new GraphConfigError(
      `failed to load connection ${connectionId}: ${conn.error.message}`,
    );
  }
  if (!conn.data) {
    throw new GraphConfigError(`no connection with id ${connectionId}`);
  }

  const refreshToken = decryptToken(conn.data.refresh_token_encrypted);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope:
      conn.data.scopes ??
      "openid profile offline_access https://graph.microsoft.com/Calendars.Read",
  });

  const tokenEndpoint = getTokenEndpoint();
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await safeReadText(res);
    throw new GraphApiError(res.status, tokenEndpoint, text);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new GraphApiError(
      res.status,
      tokenEndpoint,
      `response missing access_token: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }

  const updates: {
    last_synced_at: string;
    refresh_token_encrypted?: string;
  } = {
    last_synced_at: new Date().toISOString(),
  };
  if (typeof json.refresh_token === "string" && json.refresh_token) {
    // Microsoft rotated the refresh token. Re-encrypt and persist.
    updates.refresh_token_encrypted = encryptToken(json.refresh_token);
  }

  const update = await db
    .from("microsoft_connections")
    .update(updates)
    .eq("id", connectionId);
  if (update.error) {
    // Non-fatal: we still have the access token in memory. Log loudly
    // and continue. A future getAccessToken call will re-encounter the
    // old refresh token; if it has been revoked by then, that call
    // will fail with a clear Microsoft error.
    console.error(
      `[microsoft-graph] failed to persist token update for connection ${connectionId}: ${update.error.message}`,
    );
  }

  return json.access_token;
}

export type NormalizedAttendee = {
  name: string | null;
  email: string | null;
  responseStatus: string | null;
};

export type NormalizedMeeting = {
  eventId: string;
  subject: string | null;
  start: { dateTime: string; timeZone: string } | null;
  end: { dateTime: string; timeZone: string } | null;
  attendees: NormalizedAttendee[];
  organizerEmail: string | null;
  joinUrl: string | null;
  isCancelled: boolean;
};

/**
 * List upcoming calendar events between now and now+days.
 *
 * Only the fields enumerated in CALENDAR_VIEW_SELECT are requested.
 * Body and attachments are explicitly NOT included (DPA 2.2(d)).
 *
 * Paginates @odata.nextLink internally; returns the flattened, normalized
 * list. A hard cap of 200 pages protects against runaway loops.
 */
export async function listUpcomingMeetings(
  connectionId: string,
  days: number,
): Promise<NormalizedMeeting[]> {
  if (!Number.isFinite(days) || days <= 0) {
    throw new GraphConfigError(
      `listUpcomingMeetings: days must be a positive number, got ${days}`,
    );
  }
  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return listMeetingsBetween(connectionId, now, end);
}

/**
 * List calendar events between an explicit start and end. Same field selection
 * and pagination as listUpcomingMeetings, but the window is caller-controlled
 * so it can look backward (diagnostics/backfill) as well as forward.
 */
export async function listMeetingsBetween(
  connectionId: string,
  start: Date,
  end: Date,
): Promise<NormalizedMeeting[]> {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new GraphConfigError("listMeetingsBetween: start and end must be valid dates");
  }

  const accessToken = await getAccessToken(connectionId);

  const initial = new URL(`${GRAPH_BASE}/me/calendarView`);
  initial.searchParams.set("startDateTime", start.toISOString());
  initial.searchParams.set("endDateTime", end.toISOString());
  initial.searchParams.set("$select", CALENDAR_VIEW_SELECT);
  initial.searchParams.set("$orderby", "start/dateTime");
  initial.searchParams.set("$top", "50");

  const collected: NormalizedMeeting[] = [];
  let url: string | null = initial.toString();
  let pages = 0;

  while (url && pages < 200) {
    pages += 1;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        // Prefer outlook timezone tags as UTC so dateTime+timeZone is
        // unambiguous. Without this header, Graph returns the user's
        // configured timezone.
        Prefer: 'outlook.timezone="UTC"',
      },
    });
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new GraphApiError(res.status, "/me/calendarView", text);
    }
    const json = (await res.json()) as {
      value?: unknown[];
      "@odata.nextLink"?: string;
    };
    const items = Array.isArray(json.value) ? json.value : [];
    for (const ev of items) {
      const norm = normalizeEvent(ev);
      if (norm) collected.push(norm);
    }
    url = typeof json["@odata.nextLink"] === "string" ? json["@odata.nextLink"] : null;
  }

  return collected;
}

// ====================================================================
// Internals
// ====================================================================

function normalizeEvent(raw: unknown): NormalizedMeeting | null {
  if (!isRecord(raw)) return null;
  const eventId = typeof raw.id === "string" ? raw.id : null;
  if (!eventId) return null;

  const attendees: NormalizedAttendee[] = [];
  if (Array.isArray(raw.attendees)) {
    for (const a of raw.attendees) {
      if (!isRecord(a)) continue;
      const emailObj = isRecord(a.emailAddress) ? a.emailAddress : null;
      const statusObj = isRecord(a.status) ? a.status : null;
      attendees.push({
        name: emailObj && typeof emailObj.name === "string" ? emailObj.name : null,
        email: emailObj && typeof emailObj.address === "string" ? emailObj.address : null,
        responseStatus:
          statusObj && typeof statusObj.response === "string" ? statusObj.response : null,
      });
    }
  }

  const organizerObj = isRecord(raw.organizer) ? raw.organizer : null;
  const organizerEmailObj =
    organizerObj && isRecord(organizerObj.emailAddress) ? organizerObj.emailAddress : null;
  const organizerEmail =
    organizerEmailObj && typeof organizerEmailObj.address === "string"
      ? organizerEmailObj.address
      : null;

  const onlineObj = isRecord(raw.onlineMeeting) ? raw.onlineMeeting : null;
  const joinUrl =
    onlineObj && typeof onlineObj.joinUrl === "string" ? onlineObj.joinUrl : null;

  return {
    eventId,
    subject: typeof raw.subject === "string" ? raw.subject : null,
    start: extractDateTimeBlock(raw.start),
    end: extractDateTimeBlock(raw.end),
    attendees,
    organizerEmail,
    joinUrl,
    isCancelled: raw.isCancelled === true,
  };
}

function extractDateTimeBlock(
  raw: unknown,
): { dateTime: string; timeZone: string } | null {
  if (!isRecord(raw)) return null;
  const dateTime = typeof raw.dateTime === "string" ? raw.dateTime : null;
  if (!dateTime) return null;
  const timeZone = typeof raw.timeZone === "string" ? raw.timeZone : "UTC";
  return { dateTime, timeZone };
}

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
