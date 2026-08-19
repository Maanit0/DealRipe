/**
 * Post the recap into Salesforce as a Note.
 *
 * WHY A NOTE AND NOT JUST THE TASK. Eduardo, 2026-08-14: he pasted our recap
 * into a Note by hand the day after the call, then shared that Note with the
 * solution engineer to prep the demo. The Task is the activity record; the Note
 * is the artifact a second person actually reads. renderRecapNote has produced
 * the body since the three-pass rebuild and nothing has ever posted it.
 *
 * Modern Salesforce Notes are ContentNote, which is a two-step write: create
 * the note, then link it to the record with a ContentDocumentLink. The legacy
 * `Note` sobject takes a ParentId directly but is not what the Notes related
 * list on a Lightning page shows, so posting there would look to Eduardo like
 * nothing happened.
 *
 * Same gates as every other Salesforce write: SALESFORCE_WRITEBACK_ENABLED and
 * SALESFORCE_PILOT_ACCOUNT_IDS via assertScopedAccountWrite, wrapped in
 * runWithAuthorizedAccounts and audited through recordWrite. A Note on a
 * customer's account is a write into their CRM and gets no special treatment.
 */

import { getSalesforceClient } from "./salesforce";
import { assertScopedAccountWrite, runWithAuthorizedAccounts } from "./salesforce-scope";
import { recordWrite } from "./crm-scope";

const API = "v60.0";

/** ContentNote.Content is a base64 blob and Salesforce caps it well above this. */
const NOTE_MAX = 30000;
/** ContentNote.Title is 255, and a truncated title breaks idempotency matching. */
const TITLE_MAX = 120;

export type NotePostResult =
  | { posted: true; contentNoteId: string; linkedTo: string }
  | { posted: false; reason: string; alreadyThere?: string };

async function sf(instanceUrl: string, token: string, path: string, init?: RequestInit) {
  return fetch(`${instanceUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * A stable, human-readable title that doubles as the idempotency key.
 *
 * Deliberately contains the call date rather than a run timestamp: re-running
 * recap-sync for the same call must produce the same title, or every retry
 * leaves another Note in the customer's CRM.
 */
export function recapNoteTitle(account: string, callAt: string | null): string {
  const day = (callAt ?? new Date().toISOString()).slice(0, 10);
  const t = `DealRipe recap: ${account} ${day}`;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 3)}...` : t;
}

/**
 * Is this note already on the record.
 *
 * Three-way on purpose. "unknown" must never be treated as "no": a failed
 * lookup that falls through to a write puts a duplicate recap in front of the
 * customer's solution engineer, and a missing Note is far cheaper than that.
 */
async function existingNote(
  instanceUrl: string,
  token: string,
  linkedEntityId: string,
  title: string,
): Promise<{ state: "found"; id: string } | { state: "absent" } | { state: "unknown"; why: string }> {
  const soql =
    `SELECT ContentDocumentId, ContentDocument.Title FROM ContentDocumentLink ` +
    `WHERE LinkedEntityId = '${linkedEntityId.replace(/'/g, "")}'`;
  const res = await sf(instanceUrl, token, `/services/data/${API}/query?q=${encodeURIComponent(soql)}`);
  if (!res.ok) {
    return { state: "unknown", why: `query ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}` };
  }
  const records = ((await res.json()) as {
    records?: Array<{ ContentDocumentId: string; ContentDocument?: { Title?: string } }>;
  }).records ?? [];
  const hit = records.find((r) => (r.ContentDocument?.Title ?? "") === title);
  return hit ? { state: "found", id: hit.ContentDocumentId } : { state: "absent" };
}

/** ContentNote.Content is base64-encoded HTML, not plain text. */
function toNoteContent(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "<br/>");
  return Buffer.from(escaped, "utf8").toString("base64");
}

/**
 * Create the Note and link it to the record.
 *
 * `apply` false renders and checks everything, including the duplicate lookup,
 * and writes nothing. Every caller starts there.
 */
export async function postRecapNote(args: {
  tenantSlug: string;
  /** The gated account. Always required: it is what authorises the write. */
  accountId: string;
  /**
   * Where the Note is attached. Defaults to the account. Eduardo wants it on
   * the opportunity when there is one, since that is what he shares with the
   * SE, but authorisation is still checked against the account.
   */
  linkedEntityId?: string | null;
  account: string;
  callAt: string | null;
  body: string;
  apply: boolean;
}): Promise<NotePostResult> {
  try {
    if (!args.body.trim()) {
      return { posted: false, reason: "recap body is empty, nothing to post" };
    }
    const { token, instanceUrl } = await getSalesforceClient();
    const target = args.linkedEntityId || args.accountId;
    const title = recapNoteTitle(args.account, args.callAt);

    const already = await existingNote(instanceUrl, token, target, title);
    if (already.state === "found") {
      return { posted: false, reason: "a recap note for this call is already on the record", alreadyThere: already.id };
    }
    if (already.state === "unknown") {
      return { posted: false, reason: `could not check for an existing note: ${already.why}` };
    }

    const body = args.body.length > NOTE_MAX ? `${args.body.slice(0, NOTE_MAX - 20)}\n\n[truncated]` : args.body;

    if (!args.apply) {
      return {
        posted: false,
        reason: `dry run: would create note "${title}" (${body.length} chars) on ${target}`,
      };
    }

    const created = await runWithAuthorizedAccounts([args.accountId], async () =>
      recordWrite(
        [{ label: "Recap note", value: `${title} (${body.length} chars)`, mode: "create" }],
        async () => {
          assertScopedAccountWrite(args.tenantSlug, args.accountId, ["sales_development"]);

          const noteRes = await sf(instanceUrl, token, `/services/data/${API}/sobjects/ContentNote`, {
            method: "POST",
            body: JSON.stringify({ Title: title, Content: toNoteContent(body) }),
          });
          if (!noteRes.ok) {
            throw new Error(
              `POST ContentNote ${noteRes.status}: ${(await noteRes.text().catch(() => "")).slice(0, 300)}`,
            );
          }
          const note = (await noteRes.json()) as { id: string };

          // The link is what makes the note visible on the record. If it fails
          // the note exists but is orphaned, so say exactly that rather than
          // reporting a clean failure: someone has to go and delete it.
          const linkRes = await sf(instanceUrl, token, `/services/data/${API}/sobjects/ContentDocumentLink`, {
            method: "POST",
            body: JSON.stringify({ ContentDocumentId: note.id, LinkedEntityId: target, ShareType: "V" }),
          });
          if (!linkRes.ok) {
            throw new Error(
              `note ${note.id} was created but linking it to ${target} failed ` +
                `(${linkRes.status}: ${(await linkRes.text().catch(() => "")).slice(0, 200)}). ` +
                `The note exists and is not attached to anything.`,
            );
          }
          return note;
        },
      ),
    );

    return { posted: true, contentNoteId: created.id, linkedTo: target };
  } catch (err) {
    return { posted: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
