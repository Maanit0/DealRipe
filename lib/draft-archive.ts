/**
 * The archived copy of a draft, rendered for the Activity log's detail panel.
 *
 * ONE RENDERER, used by every kind of draft we write into a rep's mailbox.
 * There were two before and only one of them was right: the follow-up path
 * built this and re-engagement passed `html: ""`, so seven re-engagement rows
 * on 2026-08-31 could be seen in the list and not opened. A row that names a
 * customer, lists their addresses and cannot show what we wrote to them is the
 * one row you most want to read.
 *
 * Kept in its own file rather than exported from `followup-draft.ts` because
 * this codebase has already paid twice for two renderers of the same artifact
 * drifting apart: the draft card against the preview, and the archive against
 * the card over which files the rep still owes.
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type DraftArchive = {
  /** Recipients as the rep will see them. */
  to: ReadonlyArray<string>;
  /** The body exactly as it sits in the mailbox. */
  body: string;
  /**
   * The thread this went onto, null for a fresh email, UNDEFINED for a row
   * where we never recorded it.
   *
   * Three states, not two. A backfilled row passed null and rendered "New email
   * to ...", which is a claim about who sees the message that nothing in the
   * archive supports. Unknown prints the recipients and asserts nothing.
   */
  replyToMessageId?: string | null;
  /**
   * Files the rep still has to attach BEFORE SENDING.
   *
   * Only what they still owe. A file we attached ourselves is not a chore, and
   * printing it here tells a rep to do work that is already done: this line
   * read "Rep must attach: Magaya datasheet" on drafts that already carried the
   * datasheet, because the caller passed the pre-attachment list.
   */
  attachmentsToAdd?: ReadonlyArray<string>;
  /**
   * Why this draft exists, for a draft no call produced.
   *
   * A follow-up is explained by the call it followed. A re-engagement is
   * explained by a flag, and without it the reader cannot tell a deliberate
   * sweep from a stray send.
   */
  reason?: { title: string; evidence: string } | null;
};

export function draftArchiveHtml(d: DraftArchive): string {
  const recipients = d.to.join(", ") || "(no recipients resolved)";
  const meta =
    d.replyToMessageId === undefined
      ? `To ${recipients}`
      : d.replyToMessageId
        ? "Reply on the existing customer thread"
        : `New email to ${recipients}`;
  const reason = d.reason
    ? `<p style="margin:0 0 12px;padding:8px 10px;background:#FEF3C7;border-radius:6px;color:#78350F;font-size:12px;">` +
      `<strong>${esc(d.reason.title)}</strong><br/>${esc(d.reason.evidence)}</p>`
    : "";
  const attach = d.attachmentsToAdd?.length
    ? `<p style="margin:12px 0 0;color:#b45309;font-size:12px;">Rep must attach: ${esc(d.attachmentsToAdd.join(", "))}</p>`
    : "";
  return [
    `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:13px;color:#0F172A;">`,
    `<p style="margin:0 0 4px;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.05em;">Draft, not sent</p>`,
    `<p style="margin:0 0 12px;color:#334155;font-size:12px;">${esc(meta)}</p>`,
    reason,
    `<div style="white-space:pre-wrap;">${esc(d.body)}</div>`,
    attach,
    `</div>`,
  ].join("");
}
