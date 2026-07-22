/**
 * No-show follow-up email to the REP. Contains a ready-to-send draft the rep can
 * copy, tweak, and send to the prospect who missed the call. Matches the recap
 * email styling. Pure function, no external deps. No em-dashes.
 */

import type { NoShowDraft } from "../no-show-followup";

const BG = "#F4F6F9";
const CARD = "#FFFFFF";
const BORDER = "#E7EBF0";
const NAVY = "#0F172A";
const INK = "#1E293B";
const MUTED = "#5B6470";
const GREEN = "#10B981";
const AMBER = "#B45309";

const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

export type RenderedEmail = { subject: string; html: string; text: string };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "the";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  } catch {
    return "the";
  }
}

export function renderNoShowDraftEmail(args: {
  account: string;
  contactName: string | null;
  callDate: string | null;
  draft: NoShowDraft;
}): RenderedEmail {
  const { account, draft } = args;
  const who = args.contactName ? escapeHtml(args.contactName) : "the customer";
  const when = fmtDate(args.callDate);
  const subject = `No-show follow-up draft: ${account}`;

  const bodyHtmlLines = draft.body
    .split(/\n+/)
    .map((p) => `<div style="font-family:${SANS};font-size:15px;line-height:24px;color:${INK};margin:0 0 12px 0;">${escapeHtml(p)}</div>`)
    .join("");

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">A follow-up you can send after the ${account} no-show.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:26px 0;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
      <tr><td style="padding:0 20px;">

        <div style="font-family:${SANS};font-size:12px;font-weight:700;margin:0 0 14px 2px;">
          <span style="color:${NAVY};">Deal</span><span style="color:${GREEN};">Ripe</span>
        </div>

        <div style="font-family:${SANS};font-size:18px;font-weight:700;color:${NAVY};margin:0 0 3px 2px;">No-show follow-up &middot; ${escapeHtml(account)}</div>
        <div style="font-family:${SANS};font-size:13px;color:${MUTED};margin:0 0 18px 2px;">${who} did not join the ${escapeHtml(when)} call. Here is a follow-up you can send.</div>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;">
          <tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:12px;padding:20px 22px;">
            <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};margin:0 0 10px 0;">Subject</div>
            <div style="font-family:${SANS};font-size:15px;line-height:22px;color:${NAVY};font-weight:600;margin:0 0 16px 0;">${escapeHtml(draft.subject)}</div>
            <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};margin:0 0 10px 0;">Draft</div>
            ${bodyHtmlLines}
          </td></tr>
        </table>

        <div style="font-family:${SANS};font-size:12px;line-height:19px;color:${AMBER};margin:6px 2px 0 2px;">
          This is a draft, not sent. Copy it, make it yours, and send from your own inbox.
        </div>

      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    `No-show follow-up - ${account}`,
    `${args.contactName ?? "The customer"} did not join the ${when} call. Here is a follow-up you can send.`,
    ``,
    `SUBJECT: ${draft.subject}`,
    ``,
    draft.body,
    ``,
    `This is a draft, not sent. Copy it, make it yours, and send from your own inbox.`,
  ].join("\n");

  return { subject, html, text };
}
