/**
 * "Your follow-up draft is ready" - a short email to the REP with a link
 * straight into the draft.
 *
 * Ariel Rodriguez asked for this by name on 2026-08-28, after twenty minutes of
 * the two of us failing to find a draft that Graph confirms is in his mailbox:
 * "that would be perfect... rather than you trying to find it and you don't know
 * where it is."
 *
 * The findability problem is real and has more than one cause, which is exactly
 * why this is the right fix. A follow-up draft is written as a REPLY so it
 * threads onto the customer conversation, which is what makes it read as the
 * rep's own email; Graph then gives it the thread's subject, so the draft Ariel
 * was hunting was not called "Following up on our call" but "RE: Magaya / Grupo
 * Orvia (Cost/Budget)". It did not appear in his Drafts FOLDER listing either,
 * and he could not find that thread in his mailbox at all. A link does not care
 * which of those is true.
 *
 * Deliberately tiny. This is a notification, not a second copy of the draft: a
 * rep who reads the whole email here has no reason to click through, and the
 * click is the point because that is where they can edit and send it.
 *
 * Pure function, no external deps. No em-dashes (project convention).
 */

const BG = "#F4F6F9";
const CARD = "#FFFFFF";
const BORDER = "#E7EBF0";
const NAVY = "#0F172A";
const INK = "#1E293B";
const MUTED = "#5B6470";
const GREEN = "#10B981";
const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

export type RenderedEmail = { subject: string; html: string; text: string };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type DraftReadyInput = {
  /** The company, as the CRM spells it. Falls back to the deal label. */
  account: string;
  /** Who the draft is addressed to. */
  to: string[];
  /**
   * The subject Outlook actually gave the draft.
   *
   * NOT the subject we generated. On a reply Graph replaces ours with the
   * thread's, and printing our version here would send the rep looking for a
   * subject that does not exist, which is the bug this email exists to end.
   */
  draftSubject: string;
  /** Opens the draft directly in Outlook on the web. */
  webLink?: string | null;
  /** First line or two, so the rep can tell at a glance whether to bother. */
  preview?: string | null;
};

export function renderDraftReadyEmail(input: DraftReadyInput): RenderedEmail {
  const to = input.to.filter(Boolean).join(", ");
  const subject = `Your follow-up draft for ${input.account} is ready`;

  const button = input.webLink
    ? `<tr><td style="padding:16px 0 4px 0;">
        <a href="${esc(input.webLink)}" style="display:inline-block;background:${NAVY};color:#FFFFFF;font-family:${SANS};font-size:14px;font-weight:600;line-height:20px;padding:11px 20px;border-radius:6px;text-decoration:none;">Open the draft</a>
      </td></tr>`
    : // No link is a different thing from a broken one. Say where to look instead
      // of rendering a dead button.
      `<tr><td style="padding:14px 0 4px 0;font-family:${SANS};font-size:13.5px;line-height:20px;color:${MUTED};">
        We could not get a direct link for this one. It is in your mailbox under the subject above.
      </td></tr>`;

  const html = `<div style="background:${BG};padding:22px 0;">
  <div style="max-width:560px;margin:0 auto;background:${CARD};border:1px solid ${BORDER};border-radius:10px;padding:22px 24px;">
    <div style="font-family:${SANS};font-size:12px;letter-spacing:0.7px;text-transform:uppercase;color:${GREEN};font-weight:700;">Draft ready</div>
    <div style="font-family:${SANS};font-size:19px;line-height:26px;color:${NAVY};font-weight:700;margin-top:5px;">${esc(input.account)}</div>
    <div style="font-family:${SANS};font-size:14px;line-height:21px;color:${INK};margin-top:12px;">
      Your follow-up is written and sitting in your mailbox. Nothing has been sent.
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">
      <tr><td style="font-family:${SANS};font-size:13px;line-height:20px;color:${MUTED};padding:0 0 3px 0;">To</td></tr>
      <tr><td style="font-family:${SANS};font-size:14px;line-height:21px;color:${NAVY};padding:0 0 9px 0;">${esc(to || "the customer")}</td></tr>
      <tr><td style="font-family:${SANS};font-size:13px;line-height:20px;color:${MUTED};padding:0 0 3px 0;">Subject in Outlook</td></tr>
      <tr><td style="font-family:${SANS};font-size:14px;line-height:21px;color:${NAVY};padding:0 0 2px 0;">${esc(input.draftSubject)}</td></tr>
      ${button}
    </table>
    ${
      input.preview
        ? `<div style="font-family:${SANS};font-size:13.5px;line-height:20px;color:${MUTED};margin-top:14px;padding-top:13px;border-top:1px solid ${BORDER};">${esc(input.preview)}</div>`
        : ""
    }
    <div style="font-family:${SANS};font-size:12.5px;line-height:19px;color:${MUTED};margin-top:16px;">
      Read it, change what you want, send it if it is worth sending. DealRipe never sends anything itself.
    </div>
  </div>
</div>`;

  const text = [
    `Your follow-up draft for ${input.account} is ready.`,
    ``,
    `To: ${to || "the customer"}`,
    `Subject in Outlook: ${input.draftSubject}`,
    input.webLink ? `Open it: ${input.webLink}` : `It is in your mailbox under that subject.`,
    input.preview ? `` : null,
    input.preview ?? null,
    ``,
    `Nothing has been sent. DealRipe never sends anything itself.`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  return { subject, html, text };
}
