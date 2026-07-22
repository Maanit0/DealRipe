/**
 * Post-call recap email. Matches the in-app briefing view: light gray page,
 * clean white cards, small uppercase section labels. Pure function, no
 * external deps. No em-dashes.
 */

import type { PostCallSummary } from "../post-call-summary";

const BG = "#F4F6F9";
const CARD = "#FFFFFF";
const BORDER = "#E7EBF0";
const NAVY = "#0F172A";
const INK = "#1E293B";
const MUTED = "#5B6470"; // readable secondary text (was too light at #94A3B8)
const GREEN = "#10B981";
const AMBER = "#B45309";

const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const STAGE_LABELS: Record<string, string> = {
  SQL0: "Lead",
  SQL1: "Develop Opportunity",
  SQL2: "Solution Finalization",
  SQL3: "Proposal Validation",
  SQL4: "Negotiations",
  SQL5: "Agreement Formalization",
};

export type RenderedEmail = { subject: string; html: string; text: string };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function label(text: string, color: string): string {
  return `<div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${color};margin:0 0 10px 0;">${escapeHtml(text)}</div>`;
}

function bodyText(text: string): string {
  return `<div style="font-family:${SANS};font-size:15px;line-height:24px;color:${INK};">${escapeHtml(text)}</div>`;
}

function card(inner: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;">
    <tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:12px;padding:20px 22px;">${inner}</td></tr>
  </table>`;
}

function listRow(marker: string, markerColor: string, inner: string, first: boolean): string {
  return `<tr>
    <td valign="top" width="22" style="padding:${first ? "0" : "10px"} 10px 0 0;font-family:${SANS};font-size:15px;line-height:23px;color:${markerColor};font-weight:700;">${marker}</td>
    <td valign="top" style="padding:${first ? "0" : "10px"} 0 0 0;font-family:${SANS};font-size:15px;line-height:23px;color:${INK};">${inner}</td>
  </tr>`;
}

/** Action flags read from the call: no follow-up booked, NDA-before-demo. */
function buildFlags(summary: PostCallSummary): string[] {
  const flags: string[] = [];
  if (summary.noFollowupBooked) {
    const what = summary.nextStepCommitment ? `You agreed to ${summary.nextStepCommitment}, but` : "You expected a next meeting, but";
    flags.push(`No follow-up booked. ${what} nothing is on the calendar yet. Book it before it slips.`);
  }
  if (summary.nda) {
    if (summary.nda.demoIsNext && !summary.nda.ndaInPlace) {
      flags.push("NDA before demo. A demo is the next step but no signed NDA yet. Magaya's process wants a mutual NDA first.");
    }
    if (summary.nda.customerResisted) {
      flags.push("NDA pushback. The customer hesitated on signing an NDA. Worth watching as a seriousness signal.");
    }
  }
  return flags;
}

export function renderPostCallSummaryEmail(summary: PostCallSummary): RenderedEmail {
  const stageLabel = STAGE_LABELS[summary.stageKey] ?? summary.stageKey;
  const subject = `Recap: ${summary.account} call. ${summary.captured.length} captured, ${summary.stillOpen.length} still open`;
  const flags = buildFlags(summary);

  const flagsCard =
    flags.length === 0
      ? ""
      : card(
          `${label("Flags to act on", AMBER)}
           <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${flags
             .map((f, i) => listRow("&#9650;", AMBER, `<span style="color:${INK};">${escapeHtml(f)}</span>`, i === 0))
             .join("")}</table>`,
        );

  const coachingCard = summary.coaching
    ? card(`${label("Coaching", MUTED)}${bodyText(summary.coaching)}`)
    : "";

  const capturedRows =
    summary.captured.length === 0
      ? listRow("&middot;", MUTED, `<span style="color:${MUTED};">Nothing new was captured on this call.</span>`, true)
      : summary.captured
          .map((c, i) =>
            listRow(
              "&#10003;",
              GREEN,
              `<strong style="color:${NAVY};font-weight:600;">${escapeHtml(c.label)}:</strong> ${escapeHtml(c.answer)}`,
              i === 0,
            ),
          )
          .join("");

  const openRows =
    summary.stillOpen.length === 0
      ? listRow("&middot;", MUTED, `<span style="color:${MUTED};">No open gaps for this stage.</span>`, true)
      : summary.stillOpen
          .map((o, i) =>
            listRow(
              "&#9679;",
              "#CBD5E1",
              `<strong style="color:${NAVY};font-weight:600;">${escapeHtml(o.label)}.</strong> <span style="color:${MUTED};">${escapeHtml(o.question)}</span>`,
              i === 0,
            ),
          )
          .join("");

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">Recap of your ${escapeHtml(summary.account)} call.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:26px 0;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
      <tr><td style="padding:0 20px;">

        <div style="font-family:${SANS};font-size:12px;font-weight:700;margin:0 0 14px 2px;">
          <span style="color:${NAVY};">Deal</span><span style="color:${GREEN};">Ripe</span>
        </div>

        <div style="font-family:${SANS};font-size:18px;font-weight:700;color:${NAVY};margin:0 0 3px 2px;">Recap &middot; ${escapeHtml(summary.account)}</div>
        <div style="font-family:${SANS};font-size:13px;color:${MUTED};margin:0 0 18px 2px;">${escapeHtml(stageLabel)} &middot; ${summary.captured.length} captured &middot; ${summary.stillOpen.length} still open</div>

        ${card(`${label("What happened", MUTED)}${bodyText(summary.recap)}`)}

        ${card(
          `${label("Captured on this call", GREEN)}
           <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${capturedRows}</table>`,
        )}

        ${card(
          `${label("Still open", AMBER)}
           <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${openRows}</table>`,
        )}

        ${flagsCard}

        ${card(`${label("Suggested next step", MUTED)}${bodyText(summary.suggestedNextStep)}`)}

        ${coachingCard}

        <div style="font-family:${SANS};font-size:12px;line-height:19px;color:${MUTED};margin:6px 2px 0 2px;">
          DealRipe wrote this from your call so you don't have to. Reply to flag anything that looks wrong and I'll fix it.
        </div>

      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  return { subject, html, text: renderText(summary, stageLabel) };
}

function renderText(summary: PostCallSummary, stageLabel: string): string {
  const lines: string[] = [];
  lines.push(`Recap - ${summary.account}`);
  lines.push(`${stageLabel} - ${summary.captured.length} captured, ${summary.stillOpen.length} still open`);
  lines.push("");
  lines.push("WHAT HAPPENED");
  lines.push(summary.recap);
  lines.push("");
  lines.push("CAPTURED ON THIS CALL");
  if (summary.captured.length === 0) lines.push("- Nothing new was captured on this call.");
  else for (const c of summary.captured) lines.push(`- ${c.label}: ${c.answer}`);
  lines.push("");
  lines.push("STILL OPEN");
  if (summary.stillOpen.length === 0) lines.push("- No open gaps for this stage.");
  else for (const o of summary.stillOpen) lines.push(`- ${o.label}. ${o.question}`);
  lines.push("");
  const flags = buildFlags(summary);
  if (flags.length > 0) {
    lines.push("FLAGS TO ACT ON");
    for (const f of flags) lines.push(`- ${f}`);
    lines.push("");
  }
  lines.push("SUGGESTED NEXT STEP");
  lines.push(summary.suggestedNextStep);
  if (summary.coaching) {
    lines.push("");
    lines.push("COACHING");
    lines.push(summary.coaching);
  }
  lines.push("");
  lines.push("DealRipe wrote this from your call. Reply to flag anything wrong.");
  return lines.join("\n");
}
