/**
 * Weekly digest email for the sales leader. Renders the evidence-based digest
 * data (buildWeeklyDigestData) into clean cards: one flowing paragraph per
 * deal, the account name itself is the link (no crowding), no-shows in their
 * own section. Matches the recap style. No em-dashes.
 */

import type { DigestAttention, DigestMovement, DigestNoShow } from "../weekly-digest-data";

const BG = "#F4F6F9";
const CARD = "#FFFFFF";
const BORDER = "#E7EBF0";
const NAVY = "#0F172A";
const INK = "#1E293B";
const MUTED = "#5B6470";
const GREEN = "#10B981";
const AMBER = "#B45309";
const RED = "#B91C1C";
const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

export type RenderedEmail = { subject: string; html: string; text: string };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderWeeklyDigestEmail(args: {
  attention: DigestAttention[];
  movement: DigestMovement[];
  noShows: DigestNoShow[];
  weekLabel: string;
  recipientName?: string;
  baseUrl?: string;
}): RenderedEmail {
  const { weekLabel, recipientName } = args;
  const base = (args.baseUrl ?? "").replace(/\/$/, "");
  const attention = args.attention.slice(0, 6);
  const movement = args.movement.slice(0, 6);
  const noShows = args.noShows.slice(0, 6);

  // Account name as a subtle link when we have a base URL.
  const name = (account: string, dealId: string): string =>
    base
      ? `<a href="${base}/deals/${dealId}" style="color:${NAVY};text-decoration:none;">${esc(account)}</a>`
      : esc(account);

  const subject = `DealRipe weekly digest, week of ${weekLabel}${
    attention.length ? `. ${attention.length} need${attention.length === 1 ? "s" : ""} attention` : ""
  }`;

  const attentionCards = attention
    .map(
      (e, i) => `
      <div style="${i === 0 ? "" : `margin-top:18px;padding-top:18px;border-top:1px solid ${BORDER};`}">
        <div style="font-family:${SANS};font-size:16px;font-weight:600;color:${NAVY};line-height:23px;">${i + 1}. ${name(e.account, e.dealId)} &nbsp;&middot;&nbsp; ${esc(e.headline)}</div>
        <div style="font-family:${SANS};font-size:15px;line-height:24px;color:${INK};margin-top:8px;">${esc(e.detail)}</div>
      </div>`,
    )
    .join("");

  const movementRows = movement
    .map(
      (e, i) => `
      <tr>
        <td valign="top" width="18" style="padding-top:${i === 0 ? "0" : "10px"};font-family:${SANS};font-size:15px;line-height:23px;color:${GREEN};font-weight:700;">&#10003;</td>
        <td valign="top" style="padding-top:${i === 0 ? "0" : "10px"};font-family:${SANS};font-size:15px;line-height:23px;color:${INK};"><strong style="color:${NAVY};font-weight:600;">${name(e.account, e.dealId)}.</strong> ${esc(e.note)}</td>
      </tr>`,
    )
    .join("");

  const noShowRows = noShows
    .map(
      (e, i) => `
      <tr>
        <td valign="top" width="18" style="padding-top:${i === 0 ? "0" : "10px"};font-family:${SANS};font-size:15px;line-height:23px;color:${AMBER};font-weight:700;">&#9679;</td>
        <td valign="top" style="padding-top:${i === 0 ? "0" : "10px"};font-family:${SANS};font-size:15px;line-height:23px;color:${INK};"><strong style="color:${NAVY};font-weight:600;">${name(e.account, e.dealId)}.</strong> ${esc(e.note)}</td>
      </tr>`,
    )
    .join("");

  const spacer = `<tr><td style="height:14px;line-height:14px;">&nbsp;</td></tr>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:${BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:28px 0;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">

  <tr><td style="padding:0 4px 18px 4px;">
    <div style="font-family:${SANS};font-size:13px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;color:${GREEN};">DealRipe</div>
    <div style="font-family:${SANS};font-size:22px;font-weight:700;color:${NAVY};margin-top:6px;">Weekly digest</div>
    <div style="font-family:${SANS};font-size:14px;color:${MUTED};margin-top:4px;">Week of ${esc(weekLabel)}${recipientName ? ` &nbsp;&middot;&nbsp; for ${esc(recipientName)}` : ""}</div>
  </td></tr>

  <tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:12px;padding:20px 22px;">
    <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${RED};margin:0 0 ${attention.length ? "4px" : "0"} 0;">Needs your attention</div>
    ${
      attention.length
        ? attentionCards
        : `<div style="font-family:${SANS};font-size:15px;line-height:23px;color:${MUTED};margin-top:8px;">Nothing flagged this week. Every deal with a captured call is progressing.</div>`
    }
  </td></tr>

  ${spacer}

  <tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:12px;padding:20px 22px;">
    <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${GREEN};margin:0 0 14px 0;">Movement this week</div>
    ${
      movement.length
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${movementRows}</table>`
        : `<div style="font-family:${SANS};font-size:15px;line-height:23px;color:${MUTED};">No new calls captured since last week.</div>`
    }
  </td></tr>

  ${
    noShows.length
      ? `${spacer}
  <tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:12px;padding:20px 22px;">
    <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${AMBER};margin:0 0 14px 0;">No-shows</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${noShowRows}</table>
  </td></tr>`
      : ""
  }

  ${
    base
      ? `<tr><td style="padding:20px 6px 0 6px;">
    <a href="${base}/pipeline?tenant=magaya" style="display:inline-block;background:${NAVY};color:#FFFFFF;font-family:${SANS};font-size:14px;font-weight:600;text-decoration:none;padding:11px 22px;border-radius:10px;">Open the full pipeline in DealRipe</a>
  </td></tr>`
      : ""
  }

  <tr><td style="padding:18px 6px 0 6px;">
    <div style="font-family:${SANS};font-size:13px;line-height:21px;color:${MUTED};">Ranked by what needs you most, drawn from what your calls actually captured this week. Reply with anything you want the digest to track.</div>
  </td></tr>

</table>
</td></tr></table></body></html>`;

  const t: string[] = [`DealRipe weekly digest, week of ${weekLabel}`, "", "NEEDS YOUR ATTENTION"];
  if (attention.length) {
    attention.forEach((e, i) => t.push(`${i + 1}. ${e.account}: ${e.headline}. ${e.detail}`));
  } else {
    t.push("- Nothing flagged this week.");
  }
  t.push("", "MOVEMENT THIS WEEK");
  if (movement.length) for (const e of movement) t.push(`- ${e.account}: ${e.note}`);
  else t.push("- No new calls captured since last week.");
  if (noShows.length) {
    t.push("", "NO-SHOWS");
    for (const e of noShows) t.push(`- ${e.account}: ${e.note}`);
  }

  return { subject, html, text: t.join("\n") };
}
