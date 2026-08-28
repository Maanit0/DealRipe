/**
 * Log a captured call to Salesforce as a completed Call activity.
 *
 * Why this exists. For a deal whose only CRM record is a Salesforce account,
 * DealRipe silently changed two to five qualification fields and left nothing
 * saying a call had happened. A rep opening that account saw Business Issues
 * populated with no idea where it came from. Rolldog deals get a note; these
 * got nothing, which is the difference between a write-back people trust and
 * one they find unsettling.
 *
 * What the reps actually do, surveyed 2026-08-13 across 29 linked accounts:
 * fifteen Tasks total, Type "Call" on nine of them, Status Completed, and the
 * Subject written as free text describing the meeting. Most were auto-logged
 * emails rather than call notes. So there is no strong convention to copy and
 * a real gap to fill: this follows the shape they use and supplies the content
 * they do not.
 *
 * Idempotency reads Salesforce, not our own log. We ask whether a Task created
 * by the integration user already exists on this account for this date, which
 * survives a re-ingest, a redeploy, and someone deleting the task by hand. Our
 * own record of having written would keep claiming success in all three cases.
 *
 * Every write goes through assertScopedAccountWrite and recordWrite, so it is
 * gated and audited exactly like the field write-back.
 */

import { getSalesforceClient } from "./salesforce";
import { assertScopedAccountWrite, runWithAuthorizedAccounts } from "./salesforce-scope";
import { recordWrite } from "./crm-scope";
import type { PostCallSummary } from "./post-call-summary";

const API = "v61.0";

/** Salesforce Task.Type values available in Magaya's org: Call, Meeting, Other. */
const TASK_TYPE = "Call";
const TASK_STATUS = "Completed";

/** Subject is a 255 character combobox. Reps write free text into it. */
const SUBJECT_MAX = 255;
/** Description is a 32,000 character textarea, so the recap fits comfortably. */
const DESCRIPTION_MAX = 30000;

export type CallLogResult =
  | { logged: true; taskId: string; ownerResolved: boolean }
  | { logged: false; reason: string; alreadyThere?: string };

type SfQuery<T> = { records?: T[] };

async function sf(instanceUrl: string, token: string, path: string, init?: RequestInit) {
  return fetch(`${instanceUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function query<T>(instanceUrl: string, token: string, soql: string): Promise<T[] | null> {
  const res = await sf(instanceUrl, token, `/services/data/${API}/query?q=${encodeURIComponent(soql)}`);
  if (!res.ok) return null; // null means "could not ask", never "none exist"
  return ((await res.json()) as SfQuery<T>).records ?? [];
}

/**
 * The user our Connected App authenticates as.
 *
 * Cached for the life of the process. Needed to ask "did WE already log this",
 * which is a different question from "has anyone logged anything".
 */
let integrationUserId: string | null = null;
export async function getIntegrationUserId(instanceUrl: string, token: string): Promise<string | null> {
  if (integrationUserId) return integrationUserId;
  const res = await sf(instanceUrl, token, `/services/oauth2/userinfo`);
  if (!res.ok) return null;
  const me = (await res.json()) as { user_id?: string };
  integrationUserId = me.user_id ?? null;
  return integrationUserId;
}

/**
 * The rep's Salesforce user, so the activity lands in their timeline rather
 * than reading as something a service account did to their account.
 *
 * Falls back to the integration user when the rep has no Salesforce login or
 * the lookup fails. A task owned by the wrong person is still better than no
 * task, and the caller is told which happened.
 */
async function resolveOwnerId(
  instanceUrl: string,
  token: string,
  repEmail: string | null,
): Promise<string | null> {
  const email = (repEmail ?? "").trim().toLowerCase();
  if (!email) return null;
  const rows = await query<{ Id: string }>(
    instanceUrl,
    token,
    `SELECT Id FROM User WHERE Email = '${email.replace(/'/g, "\\'")}' AND IsActive = true LIMIT 1`,
  );
  return rows?.[0]?.Id ?? null;
}

/**
 * Calendar titles carry scheduling noise that reads badly in a CRM timeline.
 *
 * Real examples from Magaya's own calendars: "Placeholder: Magaya | Medov |
 * Contract Review and Renewal" and "Confirmed - TQL | Laufer Demo Session -
 * Thursday, August 13th at 1:30 pm CST". The prefix is a scheduling state, not
 * part of the meeting, and the trailing date duplicates ActivityDate on the
 * record itself.
 *
 * Only strips what is unambiguously a label. A title that is nothing but a
 * prefix keeps its original text, because an empty subject is worse than an
 * untidy one.
 */
export function cleanMeetingTitle(raw: string): string {
  let t = raw.trim();
  const PREFIX = /^(placeholder|confirmed|tentative|hold|reschedule[d]?|updated|invitation)\s*[:\-–]\s*/i;
  // Twice: "Confirmed - Updated: ..." happens.
  for (let i = 0; i < 2; i++) t = t.replace(PREFIX, "").trim();
  // A trailing " - Thursday, August 13th at 1:30 pm CST" style tail.
  t = t.replace(
    /\s*[-–|]\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+[a-z]+\s+\d{1,2}(st|nd|rd|th)?.*$/i,
    "",
  ).trim();
  // A trailing bare date such as " - 08/13/2026 9:30 PM Korea".
  t = t.replace(/\s*[-–|]\s*\d{1,2}\/\d{1,2}\/\d{2,4}.*$/i, "").trim();
  return t.length > 0 ? t : raw.trim();
}

/** Date as Salesforce expects it for a Date field: YYYY-MM-DD, no timezone. */
function activityDate(d: Date | string | null): string {
  const dt = d ? new Date(d) : new Date();
  return Number.isNaN(dt.getTime()) ? new Date().toISOString().slice(0, 10) : dt.toISOString().slice(0, 10);
}

/**
 * The body a rep would want to find.
 *
 * Ordered the way someone reads a deal they have not touched in a month: what
 * happened, what we now know, what is still missing, what was agreed. The
 * footer says where it came from, because an unattributed note in a CRM is the
 * thing people distrust.
 */
export function buildCallLogBody(args: {
  summary: PostCallSummary;
  callDate: Date | string | null;
  attendees?: string | null;
}): string {
  const s = args.summary;
  const lines: string[] = [];

  lines.push(s.recap.trim());

  if (args.attendees) {
    lines.push("", "ON THE CALL", args.attendees);
  }

  if (s.captured.length > 0) {
    lines.push("", "CONFIRMED ON THIS CALL");
    for (const c of s.captured) lines.push(`- ${c.label}: ${c.answer}`);
  }

  if (s.stillOpen.length > 0) {
    // Dedupe by label. The framework has several fields under one heading, so
    // an untouched section produces "- Situation" three times over, which read
    // like a bug to anyone looking at the record and was one. Only the labels
    // are shown here, so two entries with the same label carry no more
    // information than one.
    const seen = new Set<string>();
    const open: string[] = [];
    for (const o of s.stillOpen) {
      const label = o.label.trim();
      if (label.length === 0 || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      open.push(label);
      if (open.length === 6) break;
    }
    if (open.length > 0) {
      lines.push("", "STILL OPEN");
      for (const label of open) lines.push(`- ${label}`);
    }
  }

  const next = s.nextStepCommitment ?? s.suggestedNextStep;
  if (next) {
    lines.push("", s.nextStepCommitment ? "AGREED NEXT STEP" : "SUGGESTED NEXT STEP", next.trim());
  }

  // Do not claim the fields were updated. They are refused by
  // Record_Triggered_ACCOUNT_Before_Save and have never landed, so this line
  // asserted something false on every task written since the feature shipped.
  lines.push("", `Logged by DealRipe from the call on ${activityDate(args.callDate)}.`);

  const body = lines.join("\n");
  return body.length > DESCRIPTION_MAX ? `${body.slice(0, DESCRIPTION_MAX - 3)}...` : body;
}

/**
 * Has the integration user already logged a call on this account for this date?
 *
 * Returns the Task Id when one exists, null when none does, and "unknown" when
 * Salesforce could not be asked. The third case must not be treated as the
 * second: a failed query that reads as "no task exists" produces a duplicate
 * on every retry.
 */
async function existingCallLog(
  instanceUrl: string,
  token: string,
  accountId: string,
  onDate: string,
): Promise<{ state: "found"; id: string } | { state: "none" } | { state: "unknown"; why: string }> {
  const userId = await getIntegrationUserId(instanceUrl, token);
  if (!userId) return { state: "unknown", why: "could not resolve the integration user" };
  const rows = await query<{ Id: string }>(
    instanceUrl,
    token,
    `SELECT Id FROM Task WHERE WhatId = '${accountId}' AND CreatedById = '${userId}' ` +
      `AND ActivityDate = ${onDate} LIMIT 1`,
  );
  if (rows === null) return { state: "unknown", why: "the Task query failed" };
  return rows[0] ? { state: "found", id: rows[0].Id } : { state: "none" };
}

/**
 * Create the activity. Never throws: this runs inside transcript-sync and must
 * not be able to break the pipeline that produced the recap.
 */
/**
 * Days from the call to the next step's due date, when the commitment does not
 * carry one of its own.
 *
 * A task with no date sits at the bottom of a list forever. Three working days
 * is short enough to still be about this call and long enough not to be
 * overdue before the rep reads it. It is a default, not a judgement, and the
 * description says so.
 */
const NEXT_STEP_DUE_DAYS = 3;

/**
 * Which Status a Task should carry to appear as open work.
 *
 * Task.Status is a picklist and the values are org-configurable. Guessing
 * "Open" would 400 in an org whose first value is "Not Started", and guessing
 * "Not Started" fails just as easily somewhere else. So this asks Salesforce.
 * Returns null when the picklist cannot be read, and the caller writes nothing
 * rather than inventing a value.
 */
async function openTaskStatus(instanceUrl: string, token: string): Promise<string | null> {
  const res = await sf(instanceUrl, token, `/services/data/${API}/sobjects/Task/describe`);
  if (!res.ok) return null;
  const desc = (await res.json()) as {
    fields?: Array<{ name: string; picklistValues?: Array<{ value: string; active: boolean; defaultValue?: boolean }> }>;
  };
  const status = (desc.fields ?? []).find((f) => f.name === "Status");
  const values = (status?.picklistValues ?? []).filter((p) => p.active).map((p) => p.value);
  if (values.length === 0) return null;
  const preferred = ["Not Started", "Open", "In Progress"];
  for (const p of preferred) {
    const hit = values.find((v) => v.toLowerCase() === p.toLowerCase());
    if (hit) return hit;
  }
  // Anything that is not a terminal state is better than refusing outright.
  const nonTerminal = values.find((v) => !/complete|closed|deferred/i.test(v));
  return nonTerminal ?? null;
}

export type NextStepResult =
  | { created: true; taskId: string; dueDate: string; ownerResolved: boolean }
  | { created: false; reason: string };

/**
 * Create the agreed next step as an open Task on the account.
 *
 * Eduardo asked for this directly on 2026-07-21, looking at the to-do list in
 * his CRM: "you might put like a task, hey you need to set up a call", and
 * "there's never too much reminders, I'd rather ignore it than forget
 * something".
 *
 * Two rules this follows, and they are the whole design:
 *
 * ONLY AN EXPLICIT COMMITMENT. A completed call log is a record of something
 * that happened, and being slightly wrong in one is harmless. An open task
 * appears in a rep's work queue and a wrong one has to be cleared by hand.
 * So this takes the commitment the call actually made and never a suggestion
 * DealRipe inferred. No commitment, no task.
 *
 * NEVER TWICE. Idempotency asks Salesforce, and a failed check refuses the
 * write rather than assuming nothing is there.
 */
export async function logNextStepToSalesforce(args: {
  tenantSlug: string;
  accountId: string;
  accountName: string;
  /** The commitment made on the call. Not a suggestion, not an inference. */
  commitment: string | null;
  callDate: Date | string | null;
  repEmail?: string | null;
  apply: boolean;
}): Promise<NextStepResult> {
  const commitment = (args.commitment ?? "").trim();
  if (commitment.length < 10) {
    return { created: false, reason: "no explicit next step was committed to on this call" };
  }

  try {
    const { token, instanceUrl } = await getSalesforceClient();

    const status = await openTaskStatus(instanceUrl, token);
    if (!status) {
      return { created: false, reason: "could not read Task.Status picklist, so no status was guessed" };
    }

    const callOn = activityDate(args.callDate);
    const due = new Date(`${callOn}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + NEXT_STEP_DUE_DAYS);
    const dueDate = due.toISOString().slice(0, 10);

    // Idempotency: one open next step per account per call date.
    const soql =
      `SELECT Id FROM Task WHERE WhatId = '${args.accountId}' AND Status != 'Completed' ` +
      `AND Subject LIKE 'Next step:%' AND ActivityDate = ${dueDate} LIMIT 1`;
    const check = await sf(instanceUrl, token, `/services/data/${API}/query?q=${encodeURIComponent(soql)}`);
    if (!check.ok) {
      return { created: false, reason: `could not check for an existing next step: ${check.status}` };
    }
    const found = ((await check.json()) as { records?: Array<{ Id: string }> }).records ?? [];
    if (found.length > 0) {
      return { created: false, reason: `a next step is already open on this account (${found[0].Id})` };
    }

    const oneLine = commitment.replace(/\s+/g, " ").trim();
    const subjectBase = `Next step: ${oneLine}`;
    const subject =
      subjectBase.length > SUBJECT_MAX ? `${subjectBase.slice(0, SUBJECT_MAX - 3)}...` : subjectBase;

    const description =
      `${oneLine}\n\n` +
      `Agreed on the call of ${callOn}. Due date is ${NEXT_STEP_DUE_DAYS} working days out, ` +
      `set by DealRipe rather than agreed on the call, so move it if the call implied something else.\n` +
      `Captured by DealRipe from the ${args.accountName} call.`;

    const ownerId = await resolveOwnerId(instanceUrl, token, args.repEmail ?? null);
    const body: Record<string, unknown> = {
      Subject: subject,
      Description: description.slice(0, DESCRIPTION_MAX),
      Status: status,
      ActivityDate: dueDate,
      WhatId: args.accountId,
    };
    if (ownerId) body.OwnerId = ownerId;

    if (!args.apply) {
      return { created: false, reason: `dry run: would create "${subject}" due ${dueDate}` };
    }

    const created = await runWithAuthorizedAccounts([args.accountId], async () =>
      recordWrite(
        [{ label: "Next step task", value: `${subject} (due ${dueDate})`, mode: "create" }],
        async () => {
          assertScopedAccountWrite(args.tenantSlug, args.accountId, ["sales_development"]);
          const res = await sf(instanceUrl, token, `/services/data/${API}/sobjects/Task`, {
            method: "POST",
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            throw new Error(`POST Task ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
          }
          return (await res.json()) as { id: string };
        },
      ),
    );

    return { created: true, taskId: created.id, dueDate, ownerResolved: Boolean(ownerId) };
  } catch (err) {
    return { created: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function logCallToSalesforce(args: {
  tenantSlug: string;
  accountId: string;
  accountName: string;
  summary: PostCallSummary;
  callDate: Date | string | null;
  /** Calendar subject, so the activity reads like the meeting it describes. */
  meetingTitle?: string | null;
  repEmail?: string | null;
  attendees?: string | null;
  apply: boolean;
}): Promise<CallLogResult> {
  try {
    const { token, instanceUrl } = await getSalesforceClient();
    const onDate = activityDate(args.callDate);

    const already = await existingCallLog(instanceUrl, token, args.accountId, onDate);
    if (already.state === "found") {
      return { logged: false, reason: "already logged for this date", alreadyThere: already.id };
    }
    if (already.state === "unknown") {
      // Refusing to write is right here. A duplicate call log in a rep's
      // timeline is worse than a missing one, and we can try again next run.
      return { logged: false, reason: `could not check for an existing log: ${already.why}` };
    }

    const titled = cleanMeetingTitle(args.meetingTitle ?? "");
    const subjectBase = titled || `Call with ${args.accountName}`;
    const subject = subjectBase.length > SUBJECT_MAX ? `${subjectBase.slice(0, SUBJECT_MAX - 3)}...` : subjectBase;
    const description = buildCallLogBody({
      summary: args.summary,
      callDate: args.callDate,
      attendees: args.attendees ?? null,
    });

    const ownerId = await resolveOwnerId(instanceUrl, token, args.repEmail ?? null);

    const body: Record<string, unknown> = {
      Subject: subject,
      Description: description,
      Type: TASK_TYPE,
      Status: TASK_STATUS,
      ActivityDate: onDate,
      WhatId: args.accountId,
    };
    if (ownerId) body.OwnerId = ownerId;

    if (!args.apply) {
      return { logged: false, reason: `dry run: would create "${subject}" (${description.length} chars)` };
    }

    // Same gate and same audit as the field write-back. A Task on a customer's
    // account is a write into their CRM and gets no special treatment.
    const created = await runWithAuthorizedAccounts([args.accountId], async () =>
      recordWrite(
        [{ label: "Call activity", value: `${subject} (${description.length} chars)`, mode: "create" }],
        async () => {
          assertScopedAccountWrite(args.tenantSlug, args.accountId, ["sales_development"]);
          const res = await sf(instanceUrl, token, `/services/data/${API}/sobjects/Task`, {
            method: "POST",
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            throw new Error(`POST Task ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
          }
          return (await res.json()) as { id: string };
        },
      ),
    );

    return { logged: true, taskId: created.id, ownerResolved: Boolean(ownerId) };
  } catch (err) {
    return { logged: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
