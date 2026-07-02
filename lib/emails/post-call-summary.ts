/**
 * Renders a PostCallSummary into an email (subject + html + text).
 *
 * Pure function, no external dependencies, so it can run in a dry-run preview
 * without the mailer or any API key.
 *
 * Visual style: calm, document-like, warm off-white, generous line height,
 * minimal color. Reads like a clean set of notes, not a dashboard. Email-safe
 * (inline styles, table rows for bullet alignment, web-safe fonts). No
 * em-dashes anywhere (project convention).
 */

import type { PostCallSummary } from "../post-call-summary";

const PAPER = "#F6F5F0";
const INK = "#3B3A36";
const STRONG = "#2A2925";
const MUTED = "#8B897F";
const FAINT = "#B8B6AC";
const GREEN = "#10B981";
const RULE = "#E4E2D9";

const SERIF = "Georgia, 'Times New Roman', serif";
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
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sectionHeader(label: string): string {
  return `<div style="font-family:${SANS};font-size:13px;font-weight:700;color:${STRONG};margin:26px 0 10px 0;">
    <span style="color:${FAINT};font-weight:400;">#</span>&nbsp; ${escapeHtml(label)}
  </div>`;
}

function bulletRow(marker: string, markerColor: string, inner: string): string {
  return `<tr>
    <td valign="top" style="padding:5px 12px 5px 0;font-family:${SANS};font-size:15px;line-height:24px;color:${markerColor};">${marker}</td>
    <td valign="top" style="padding:5px 0;font-family:${SANS};font-size:15px;line-height:24px;color:${INK};">${inner}</td>
  </tr>`;
}

export function renderPostCallSummaryEmail(summary: PostCallSummary): RenderedEmail {
  const stageLabel = STAGE_LABELS[summary.stageKey] ?? summary.stageKey;
  const subject = `Recap: ${summary.account} call. ${summary.captured.length} captured, ${summary.stillOpen.length} still open`;

  const capturedRows =
    summary.captured.length === 0
      ? bulletRow("&middot;", MUTED, `<span style="color:${MUTED};">Nothing new was captured on this call.</span>`)
      : summary.captured
          .map((c) =>
            bulletRow(
              "&#10003;",
              GREEN,
              `<strong style="color:${STRONG};font-weight:600;">${escapeHtml(c.label)}:</strong> ${escapeHtml(c.answer)}`,
            ),
          )
          .join("");

  const openRows =
    summary.stillOpen.length === 0
      ? bulletRow("&middot;", MUTED, `<span style="color:${MUTED};">No open gaps for this stage.</span>`)
      : summary.stillOpen
          .map((o) =>
            bulletRow(
              "&#8226;",
              FAINT,
              `<strong style="color:${STRONG};font-weight:600;">${escapeHtml(o.label)}.</strong> <span style="color:${MUTED};">${escapeHtml(o.question)}</span>`,
            ),
          )
          .join("");

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">Recap of your ${escapeHtml(summary.account)} call.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:28px 0;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
      <tr><td style="padding:0 34px;">

        <div style="font-family:${SANS};font-size:13px;font-weight:700;letter-spacing:0.01em;">
          <span style="color:${STRONG};">Deal</span><span style="color:${GREEN};">Ripe</span>
          <span style="color:${MUTED};font-weight:400;"> &nbsp;post-call recap</span>
        </div>

        <div style="font-family:${SERIF};font-size:28px;line-height:34px;color:${STRONG};margin:14px 0 2px 0;">${escapeHtml(summary.account)}</div>
        <div style="font-family:${SANS};font-size:14px;color:${MUTED};">${escapeHtml(stageLabel)}</div>

        ${sectionHeader("What happened")}
        <div style="font-family:${SANS};font-size:15px;line-height:25px;color:${INK};">${escapeHtml(summary.recap)}</div>

        ${sectionHeader("Captured on this call")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${capturedRows}</table>

        ${sectionHeader("Still open")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${openRows}</table>

        ${sectionHeader("Suggested next step")}
        <div style="font-family:${SANS};font-size:15px;line-height:25px;color:${STRONG};font-weight:600;">${escapeHtml(summary.suggestedNextStep)}</div>

        <div style="border-top:1px solid ${RULE};margin:30px 0 0 0;padding-top:16px;font-family:${SANS};font-size:13px;line-height:20px;color:${MUTED};">
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
  lines.push(`DealRipe post-call recap`);
  lines.push(`${summary.account} (${stageLabel})`);
  lines.push("");
  lines.push("# What happened");
  lines.push(summary.recap);
  lines.push("");
  lines.push("# Captured on this call");
  if (summary.captured.length === 0) lines.push("- Nothing new was captured on this call.");
  else for (const c of summary.captured) lines.push(`- ${c.label}: ${c.answer}`);
  lines.push("");
  lines.push("# Still open");
  if (summary.stillOpen.length === 0) lines.push("- No open gaps for this stage.");
  else for (const o of summary.stillOpen) lines.push(`- ${o.label}. ${o.question}`);
  lines.push("");
  lines.push("# Suggested next step");
  lines.push(summary.suggestedNextStep);
  lines.push("");
  lines.push("DealRipe wrote this from your call. Reply to flag anything wrong.");
  return lines.join("\n");
}
