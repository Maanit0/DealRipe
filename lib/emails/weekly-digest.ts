/**
 * Weekly digest email for the sales leader. Renders the ranked DigestEntry list
 * from lib/digest.ts (getPilotDigest) into the same clean card style as the
 * recap. Leads with what needs attention, then what moved. No em-dashes.
 *
 * Pure function: takes already-built entries, returns { subject, html, text }.
 */

import type { DigestEntry } from "../digest";

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

function money(n: number): string {
  return n > 0 ? `$${n.toLocaleString()}` : "";
}

// A "movement" line is a real change, not a baseline or a no-op.
function isMovement(line: string): boolean {
  return !/^Baseline|^No change/.test(line);
}

export function renderWeeklyDigestEmail(args: {
  entries: DigestEntry[];
  weekLabel: string;
  recipientName?: string;
  /** Absolute app URL (e.g. https://dealripe.vercel.app). When set, each deal
   *  links to its inspection page and a pipeline button appears. Omit and the
   *  digest renders as plain text with no links. */
  baseUrl?: string;
}): RenderedEmail {
  const { entries, weekLabel, recipientName } = args;
  const base = (args.baseUrl ?? "").replace(/\/$/, "");
  const dealHref = (id: string) => `${base}/deals/${id}`;

  // Attention = deals with real risk, ranked (getPilotDigest already sorted).
  const attention = entries.filter((e) => e.attention > 0).slice(0, 5);
  // Movement = deals that actually changed this week, not already in attention.
  const attentionIds = new Set(attention.map((e) => e.dealId));
  const movement = entries
    .filter((e) => !attentionIds.has(e.dealId) && e.changed.some(isMovement))
    .slice(0, 6);

  const subject = `DealRipe weekly digest, week of ${weekLabel}${
    attention.length ? `. ${attention.length} need${attention.length === 1 ? "s" : ""} attention` : ""
  }`;

  const attentionCards = attention
    .map((e) => {
      const topRisk = e.risks[0] ?? "Needs review";
      const sub = [e.stage, money(e.amount)].filter(Boolean).join("  ·  ");
      const changed = e.changed.filter(isMovement);
      return `
      <div style="margin-top:16px;padding-top:16px;border-top:1px solid ${BORDER};">
        <div style="font-family:${SANS};font-size:16px;font-weight:600;color:${NAVY};">${esc(e.account)} &nbsp;&middot;&nbsp; ${esc(topRisk.toLowerCase())}</div>
        <div style="font-family:${SANS};font-size:12px;color:${MUTED};margin-top:2px;">${esc(sub)}</div>
        <div style="font-family:${SANS};font-size:15px;line-height:23px;color:${INK};margin-top:8px;">${esc(e.coaching)}</div>
        ${
          changed.length
            ? `<div style="font-family:${SANS};font-size:13px;line-height:21px;color:${MUTED};margin-top:6px;">This week: ${esc(changed.join(" "))}</div>`
            : ""
        }
        ${
          base
            ? `<div style="margin-top:8px;"><a href="${dealHref(e.dealId)}" style="font-family:${SANS};font-size:13px;font-weight:600;color:${GREEN};text-decoration:none;">Inspect this deal &rarr;</a></div>`
            : ""
        }
      </div>`;
    })
    .join("");

  const movementRows = movement
    .map(
      (e, i) => `
      <tr>
        <td valign="top" width="18" style="padding-top:${i === 0 ? "0" : "10px"};font-family:${SANS};font-size:15px;line-height:23px;color:${GREEN};font-weight:700;">&#10003;</td>
        <td valign="top" style="padding-top:${i === 0 ? "0" : "10px"};font-family:${SANS};font-size:15px;line-height:23px;color:${INK};"><strong style="color:${NAVY};font-weight:600;">${base ? `<a href="${dealHref(e.dealId)}" style="color:${NAVY};text-decoration:none;">${esc(e.account)}</a>` : esc(e.account)}.</strong> ${esc(e.changed.filter(isMovement).join(" "))}</td>
      </tr>`,
    )
    .join("");

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
    <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${RED};margin:0;">Needs your attention</div>
    ${
      attention.length
        ? attentionCards
        : `<div style="font-family:${SANS};font-size:15px;line-height:23px;color:${MUTED};margin-top:12px;">Nothing flagged this week. Every active deal is progressing or newly captured.</div>`
    }
  </td></tr>

  <tr><td style="height:14px;line-height:14px;">&nbsp;</td></tr>

  <tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:12px;padding:20px 22px;">
    <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${GREEN};margin:0 0 14px 0;">Movement this week</div>
    ${
      movement.length
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${movementRows}</table>`
        : `<div style="font-family:${SANS};font-size:15px;line-height:23px;color:${MUTED};">No stage changes or new confirmations since last week.</div>`
    }
  </td></tr>

  ${
    base
      ? `<tr><td style="padding:20px 6px 0 6px;">
    <a href="${base}/pipeline?tenant=magaya" style="display:inline-block;background:${NAVY};color:#FFFFFF;font-family:${SANS};font-size:14px;font-weight:600;text-decoration:none;padding:11px 22px;border-radius:10px;">Open the full pipeline in DealRipe</a>
  </td></tr>`
      : ""
  }

  <tr><td style="padding:18px 6px 0 6px;">
    <div style="font-family:${SANS};font-size:13px;line-height:21px;color:${MUTED};">Ranked by what needs you most, drawn from every call captured this week. Reply to this email with anything you want the digest to track.</div>
  </td></tr>

</table>
</td></tr></table></body></html>`;

  const textLines: string[] = [`DealRipe weekly digest, week of ${weekLabel}`, ""];
  textLines.push("NEEDS YOUR ATTENTION");
  if (attention.length) {
    for (const e of attention) {
      textLines.push(`- ${e.account} (${e.stage}): ${e.risks[0] ?? "review"}. ${e.coaching}`);
    }
  } else {
    textLines.push("- Nothing flagged this week.");
  }
  textLines.push("", "MOVEMENT THIS WEEK");
  if (movement.length) {
    for (const e of movement) textLines.push(`- ${e.account}: ${e.changed.filter(isMovement).join(" ")}`);
  } else {
    textLines.push("- No changes since last week.");
  }

  return { subject, html, text: textLines.join("\n") };
}
