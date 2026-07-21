/**
 * General (non-sales) meeting recap email. Same clean card style as the
 * post-call sales recap, but framed as takeaways + next steps, for a customer
 * or internal meeting where qualification framing doesn't fit. No em-dashes.
 */

import type { GeneralRecap, MeetingType } from "../meeting-classify";

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

const TYPE_LABEL: Record<MeetingType, string> = {
  new_opportunity: "sales call",
  existing_customer: "customer call",
  internal: "internal meeting",
};

export function renderGeneralRecapEmail(args: {
  account: string;
  recap: GeneralRecap;
  meetingType: MeetingType;
}): RenderedEmail {
  const { account, recap, meetingType } = args;
  const typeLabel = TYPE_LABEL[meetingType];
  const subject = `Recap: ${account} ${typeLabel}. ${recap.nextSteps.length} next step${recap.nextSteps.length === 1 ? "" : "s"}`;

  const rows = (items: string[], marker: string, color: string): string =>
    items
      .map(
        (t, i) => `
      <tr>
        <td valign="top" width="18" style="padding-top:${i === 0 ? "0" : "10px"};font-family:${SANS};font-size:15px;line-height:23px;color:${color};font-weight:700;">${marker}</td>
        <td valign="top" style="padding-top:${i === 0 ? "0" : "10px"};font-family:${SANS};font-size:15px;line-height:23px;color:${INK};">${esc(t)}</td>
      </tr>`,
      )
      .join("");

  const card = (labelText: string, labelColor: string, inner: string): string => `
  <tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:12px;padding:20px 22px;">
    <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${labelColor};margin:0 0 14px 0;">${labelText}</div>
    ${inner}
  </td></tr>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:${BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:28px 0;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">

  <tr><td style="padding:0 4px 18px 4px;">
    <div style="font-family:${SANS};font-size:13px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;color:${GREEN};">DealRipe</div>
    <div style="font-family:${SANS};font-size:22px;font-weight:700;color:${NAVY};margin-top:6px;">${esc(account)} recap</div>
    <div style="font-family:${SANS};font-size:14px;color:${MUTED};margin-top:4px;">Captured from a ${esc(typeLabel)}, not a new-opportunity call.</div>
  </td></tr>

  ${card(
    "What this call was about",
    NAVY,
    `<div style="font-family:${SANS};font-size:15px;line-height:24px;color:${INK};">${esc(recap.summary || "See takeaways below.")}</div>`,
  )}

  <tr><td style="height:14px;line-height:14px;">&nbsp;</td></tr>

  ${card(
    "Key takeaways",
    NAVY,
    recap.takeaways.length
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows(recap.takeaways, "&bull;", MUTED)}</table>`
      : `<div style="font-family:${SANS};font-size:15px;color:${MUTED};">Nothing notable captured.</div>`,
  )}

  <tr><td style="height:14px;line-height:14px;">&nbsp;</td></tr>

  ${card(
    "Next steps",
    GREEN,
    recap.nextSteps.length
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows(recap.nextSteps, "&#8594;", GREEN)}</table>`
      : `<div style="font-family:${SANS};font-size:15px;color:${MUTED};">No next steps were set on this call.</div>`,
  )}

  <tr><td style="padding:18px 6px 0 6px;">
    <div style="font-family:${SANS};font-size:13px;line-height:21px;color:${MUTED};">DealRipe joined this meeting from your calendar invite. Reply if it should not have.</div>
  </td></tr>

</table>
</td></tr></table></body></html>`;

  const t: string[] = [`${account} recap (${typeLabel})`, "", recap.summary, "", "KEY TAKEAWAYS"];
  for (const x of recap.takeaways) t.push(`- ${x}`);
  t.push("", "NEXT STEPS");
  if (recap.nextSteps.length) for (const x of recap.nextSteps) t.push(`- ${x}`);
  else t.push("- None set on this call.");

  return { subject, html, text: t.join("\n") };
}
