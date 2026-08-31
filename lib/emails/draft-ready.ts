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
 * editable and sendable in their mail client. Enough to judge whether it is worth opening,
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
  /** "AUGUST 28 2026 . 01:00 PM", already formatted for the rep's timezone. */
  meetingWhen?: string | null;
  /** The calendar subject, when it says something the account name does not. */
  meetingTitle?: string | null;
  /** Who the draft is addressed to. */
  to: string[];
  /**
   * The subject the MAIL CLIENT actually gave the draft.
   *
   * Never the one we generated. On a reply Graph replaces ours with the
   * thread's, and printing our version sends the rep looking for something that
   * is not there, which is the bug this email exists to end.
   */
  draftSubject: string;
  /** The draft body. Only the opening is shown. */
  body: string;
  /**
   * People who SPOKE on the call, were not on the invite, and whose address we
   * do not have anywhere.
   *
   * Named on the card because the draft cannot reach them and the rep can. On
   * the Orvia call five customer stakeholders spoke and exactly one of them,
   * Rafael, exists as an address: not on the invite, not in the account's
   * Salesforce contacts, and not in 120 days of the rep's mail with that domain.
   * The draft going only to Rafael is correct, and a rep who does not know that
   * will read it as the draft dropping people.
   */
  unaddressed?: string[];
  /**
   * Files the rep has to attach before sending.
   *
   * NAMED, NOT ATTACHED, and the card has to be honest about which. We do not
   * hold Juan's datasheet PDFs and Graph is never asked to attach anything, so
   * the draft goes into his mailbox with the links in the body and no file on
   * it. Until this line existed the only record of what was missing was
   * DealRipe's own archive row, which he never sees: he would have opened a
   * draft that reads as complete and sent it without the datasheet he promised
   * on the call.
   */
  attachmentsToAdd?: string[];
  /** Files already ON the draft. The rep does nothing about these. */
  attachedFiles?: string[];
  /** Opens the draft in the rep's mail client. */
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

/**
 * The card on its own, with no page wrapper.
 *
 * Used two ways: as the whole of the standalone draft-ready email, and prepended
 * to the top of the recap so the rep gets ONE email after a call instead of two.
 *
 * Two emails a minute apart about the same call is the version that existed
 * first, and it was wrong on volume alone. Measured over 17 days: a rep gets a
 * median of 4 DealRipe emails a day and Ariel Rodriguez had a 13-email day on
 * 2026-08-13. Adding a second post-call email would have made that 18.
 */
export function renderDraftCardBlock(input: DraftReadyInput): { html: string; text: string } {
  const to = input.to.filter(Boolean).join(", ");
  const ex = excerpt(input.body);

  const excerptHtml = ex.text
    .split("\n")
    .map((l) => `<div style="font-family:${SANS};font-size:14px;line-height:22px;color:${NAVY};">${esc(l)}</div>`)
    .join("");

  const button = input.webLink
    ? `<a href="${esc(input.webLink)}" style="display:inline-block;background:${NAVY};color:#FFFFFF;font-family:${SANS};font-size:15px;font-weight:600;line-height:20px;padding:13px 26px;border-radius:7px;text-decoration:none;">Open draft</a>
       <div style="font-family:${SANS};font-size:12.5px;line-height:19px;color:${INK};margin-top:9px;">This does not send it. It opens the draft in your mailbox, on the right thread, so you can edit it and send it yourself.</div>`
    : `<div style="font-family:${SANS};font-size:13.5px;line-height:20px;color:${INK};">We could not get a direct link for this one. It is in your mailbox under the subject above. Nothing has been sent.</div>`;

  // The "Follow up on this meeting" label is the SECTION heading and belongs to
  // whatever is placing this block, not to the block. Inside the recap it sits
  // above the card with the RECAP label as its sibling; the standalone email
  // renders its own. Emitting it here too printed it twice.
  const html = `<div style="background:${QUOTE_BG};border:1px solid ${BORDER};border-radius:8px;padding:15px 17px;margin-top:11px;">
      <div style="font-family:${SANS};font-size:15px;line-height:23px;color:${NAVY};font-weight:700;">Subject: ${esc(input.draftSubject)}</div>
      ${
        to
          ? `<div style="font-family:${SANS};font-size:13.5px;line-height:20px;color:${INK};margin-top:4px;">To ${esc(to)}</div>`
          : ""
      }
      ${
        (input.unaddressed ?? []).length > 0
          ? `<div style="font-family:${SANS};font-size:13px;line-height:19px;color:${INK};margin-top:6px;">Also spoke, not on the invite and no address on file: ${esc((input.unaddressed ?? []).join(", "))}. Add them yourself if they should get this.</div>`
          : ""
      }
      ${
        (input.attachedFiles ?? []).length > 0
          ? `<div style="font-family:${SANS};font-size:13px;line-height:19px;color:${INK};margin-top:6px;"><b>Attached:</b> ${esc((input.attachedFiles ?? []).join(", "))}</div>`
          : ""
      }
      ${
        (input.attachmentsToAdd ?? []).length > 0
          ? `<div style="font-family:${SANS};font-size:13px;line-height:19px;color:${INK};margin-top:6px;"><b>Attach before sending:</b> ${esc((input.attachmentsToAdd ?? []).join(", "))}. Nothing is attached yet.</div>`
          : ""
      }
      <div style="height:1px;background:${BORDER};margin:12px 0;"></div>
      ${excerptHtml}
      ${
        ex.truncated
          ? `<div style="font-family:${SANS};font-size:14px;line-height:22px;color:${INK};margin-top:2px;">...</div>`
          : ""
      }
    </div>

    <div style="margin-top:18px;">${button}</div>`;

  const text = [
    `Subject: ${input.draftSubject}`,
    to ? `To: ${to}` : null,
    (input.attachedFiles ?? []).length > 0 ? `Attached: ${(input.attachedFiles ?? []).join(", ")}` : null,
    (input.attachmentsToAdd ?? []).length > 0
      ? `Attach before sending: ${(input.attachmentsToAdd ?? []).join(", ")}. Nothing is attached yet.`
      : null,
    (input.unaddressed ?? []).length > 0
      ? `Also spoke, not on the invite and no address on file: ${(input.unaddressed ?? []).join(", ")}. Add them yourself if they should get this.`
      : null,
    ``,
    ex.text,
    ex.truncated ? `...` : null,
    ``,
    input.webLink ? `Open draft: ${input.webLink}` : `It is in your mailbox under that subject.`,
    `This does not send it. It opens the draft in your mailbox, on the right thread, so you can edit it and send it yourself.`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  return { html, text };
}

export function renderDraftReadyEmail(input: DraftReadyInput): RenderedEmail {
  // BUILT FROM THE SAME BLOCK the recap embeds, not from a second copy of it.
  //
  // These were two renderers of one card and they drifted the moment anything
  // changed: the "Attached:" line was added to the block and this kept its own
  // markup, so the preview showed no attachment while production showed one. A
  // card rendered two ways will disagree, and the disagreement surfaces as a
  // preview that lies about the artifact.
  const card = renderDraftCardBlock(input);
  const subject = `Draft ready: ${input.account}`;

  const html = `<div style="background:${BG};padding:24px 0;">
  <div style="max-width:600px;margin:0 auto;background:${CARD};border:1px solid ${BORDER};border-radius:10px;padding:24px 26px;">
    <div style="font-family:${SANS};font-size:21px;line-height:28px;color:${NAVY};font-weight:700;">${esc(input.account)}</div>
    ${
      input.meetingTitle
        ? `<div style="font-family:${SANS};font-size:14.5px;line-height:21px;color:${INK};margin-top:3px;">${esc(input.meetingTitle)}</div>`
        : ""
    }
    ${
      input.meetingWhen
        ? `<div style="font-family:${SANS};font-size:12.5px;letter-spacing:0.6px;font-weight:600;color:${INK};margin-top:5px;">${esc(input.meetingWhen)}</div>`
        : ""
    }
    <div style="height:1px;background:${BORDER};margin:18px 0 17px 0;"></div>
    <div style="font-family:${SANS};font-size:18px;line-height:24px;color:${NAVY};font-weight:700;margin:0 0 9px 0;">Follow up on this meeting</div>
    ${card.html}
  </div>
</div>`;

  const text = [input.account, input.meetingTitle ?? null, input.meetingWhen ?? null, ``, `FOLLOW UP ON THIS MEETING`, ``, card.text]
    .filter((l) => l !== null)
    .join("\n");

  return { subject, html, text };
}

