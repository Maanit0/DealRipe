/**
 * "Follow up on this meeting" - the rep's draft, with a button into it.
 *
 * Ariel Rodriguez asked for this by name on 2026-08-28, after twenty minutes of
 * the two of us failing to find a draft that Graph confirms is in his mailbox:
 * "that would be perfect, rather than you trying to find it and you don't know
 * where it is."
 *
 * WHY THE DRAFT IS HARD TO FIND, since the shape of this email follows from it.
 * A follow-up is written as a REPLY so it threads onto the customer
 * conversation, which is what makes it read as the rep's own email. Graph then
 * gives that draft the THREAD's subject and discards ours, so the one Ariel was
 * hunting is called "RE: Magaya / Grupo Orvia (Cost/Budget)" and every record we
 * held said "Following up on our call". He was searching for a subject that does
 * not exist. Hence: the subject is the loudest thing on the page after the
 * account, and it is the subject OUTLOOK gave it, never ours.
 *
 * Modelled on Sybill's "Follow up on this meeting" card, which Maanit pointed at
 * as the target: meeting and time at the top, the subject, an excerpt of the
 * draft rather than the whole thing, and one button.
 *
 * THE EXCERPT IS DELIBERATELY PARTIAL. A rep who can read the entire email here
 * has no reason to click, and the click is the whole point: the draft is only
 * editable and sendable in Outlook. Enough to judge whether it is worth opening,
 * not enough to substitute for opening it.
 *
 * Pure function, no external deps. No em-dashes (project convention).
 */

const BG = "#F4F6F9";
const CARD = "#FFFFFF";
const BORDER = "#E7EBF0";
const QUOTE_BG = "#F7F9FC";
const NAVY = "#0F172A";
const INK = "#1E293B";
const MUTED = "#5B6470";
const GREEN = "#10B981";
const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

export type RenderedEmail = { subject: string; html: string; text: string };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** How much of the draft the excerpt shows before it stops. */
const EXCERPT_LINES = 4;
const EXCERPT_CHARS = 340;

export type DraftReadyInput = {
  /** The company, as the CRM spells it. */
  account: string;
  /** "Aug 28, 2026 at 1:00 PM CT", already formatted for the rep's timezone. */
  meetingWhen?: string | null;
  /** Who the draft is addressed to. */
  to: string[];
  /**
   * The subject Outlook ACTUALLY gave the draft.
   *
   * Never the one we generated. On a reply Graph replaces ours with the
   * thread's, and printing our version sends the rep looking for something that
   * is not there, which is the bug this email exists to end.
   */
  draftSubject: string;
  /** The draft body. Only the opening is shown. */
  body: string;
  /** Opens the draft in Outlook on the web. */
  webLink?: string | null;
};

/** The opening of the draft: enough to judge it, not enough to replace it. */
function excerpt(body: string): { text: string; truncated: boolean } {
  const lines = body.split("\n").map((l) => l.trimEnd());
  const kept: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (kept.length >= EXCERPT_LINES) break;
    if (!line.trim()) {
      if (kept.length > 0) blanks += 1;
      continue;
    }
    kept.push(line.trim());
    if (blanks > 0) blanks = 0;
  }
  let text = kept.join("\n");
  const truncated = text.length > EXCERPT_CHARS || kept.length < lines.filter((l) => l.trim()).length;
  if (text.length > EXCERPT_CHARS) text = `${text.slice(0, EXCERPT_CHARS).trimEnd()}`;
  return { text, truncated };
}

export function renderDraftReadyEmail(input: DraftReadyInput): RenderedEmail {
  const to = input.to.filter(Boolean).join(", ");
  const subject = `Draft ready: ${input.account}`;
  const ex = excerpt(input.body);

  const excerptHtml = ex.text
    .split("\n")
    .map((l) => `<div style="font-family:${SANS};font-size:14px;line-height:22px;color:${INK};">${esc(l)}</div>`)
    .join("");

  const button = input.webLink
    ? `<a href="${esc(input.webLink)}" style="display:inline-block;background:${NAVY};color:#FFFFFF;font-family:${SANS};font-size:15px;font-weight:600;line-height:20px;padding:13px 26px;border-radius:7px;text-decoration:none;">Open draft in Outlook</a>
       <div style="font-family:${SANS};font-size:12.5px;line-height:19px;color:${MUTED};margin-top:9px;">This does not send it. It opens the draft in your Outlook, on the right thread, so you can edit it and send it yourself.</div>`
    : // A missing link is a different thing from a broken one. Say where to look
      // rather than render a dead button.
      `<div style="font-family:${SANS};font-size:13.5px;line-height:20px;color:${MUTED};">We could not get a direct link for this one. It is in your mailbox under the subject above. Nothing has been sent.</div>`;

  const html = `<div style="background:${BG};padding:24px 0;">
  <div style="max-width:600px;margin:0 auto;background:${CARD};border:1px solid ${BORDER};border-radius:10px;padding:24px 26px;">

    <div style="font-family:${SANS};font-size:21px;line-height:28px;color:${NAVY};font-weight:700;">${esc(input.account)}</div>
    ${
      input.meetingWhen
        ? `<div style="font-family:${SANS};font-size:12.5px;letter-spacing:0.4px;text-transform:uppercase;color:${MUTED};margin-top:4px;">${esc(input.meetingWhen)}</div>`
        : ""
    }

    <div style="height:1px;background:${BORDER};margin:18px 0 0 0;"></div>

    <div style="font-family:${SANS};font-size:12px;letter-spacing:0.7px;text-transform:uppercase;color:${GREEN};font-weight:700;margin-top:17px;">Follow up on this meeting</div>

    <div style="background:${QUOTE_BG};border:1px solid ${BORDER};border-radius:8px;padding:15px 17px;margin-top:11px;">
      <div style="font-family:${SANS};font-size:15px;line-height:22px;color:${NAVY};font-weight:700;">${esc(input.draftSubject)}</div>
      ${
        to
          ? `<div style="font-family:${SANS};font-size:13px;line-height:20px;color:${MUTED};margin-top:3px;">To ${esc(to)}</div>`
          : ""
      }
      <div style="height:1px;background:${BORDER};margin:12px 0;"></div>
      ${excerptHtml}
      ${
        ex.truncated
          ? `<div style="font-family:${SANS};font-size:14px;line-height:22px;color:${MUTED};margin-top:2px;">...</div>`
          : ""
      }
    </div>

    <div style="margin-top:18px;">${button}</div>

  </div>
</div>`;

  const text = [
    input.account,
    input.meetingWhen ?? null,
    ``,
    `FOLLOW UP ON THIS MEETING`,
    ``,
    `Subject: ${input.draftSubject}`,
    to ? `To: ${to}` : null,
    ``,
    ex.text,
    ex.truncated ? `...` : null,
    ``,
    input.webLink
      ? `Open draft in Outlook: ${input.webLink}`
      : `It is in your mailbox under that subject.`,
    `This does not send it. It opens the draft in your Outlook, on the right thread, so you can edit it and send it yourself.`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  return { subject, html, text };
}
