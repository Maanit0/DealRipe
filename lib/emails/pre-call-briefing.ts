/**
 * Pre-call briefing email. Mirrors the Magaya in-app briefing view exactly:
 * light gray page, clean white cards, small uppercase labels. Leads with the
 * call objective (the commitment to secure), then the state, then usable
 * questions (each with an inline tag and a "why it closes" line), the next
 * step to secure, what's at risk, and a red SIGNAL card at the bottom.
 *
 * Built to be read at a glance and referenced during the call. Pure function,
 * no external deps. No em-dashes (project convention).
 */

import type { MagayaBriefing } from "../generate-briefing";

const BG = "#F4F6F9";
const CARD = "#FFFFFF";
const BORDER = "#E7EBF0";
const NAVY = "#0F172A";
const INK = "#1E293B";
const MUTED = "#5B6470"; // readable secondary text (was too light at #94A3B8)
const SLATE = "#475569";
const CHIP_BG = "#F8FAFC";
const GREEN = "#10B981";
const RED = "#EF4444";
const RED_SOFT = "#FEF2F2";
const RED_BORDER = "#FADCDC";

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

export type BriefingEmailContext = {
  account: string;
  stageKey: string;
  attendees?: string;
  minutesUntil?: number;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function label(text: string, color: string): string {
  return `<div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${color};margin:0 0 10px 0;">${escapeHtml(text)}</div>`;
}

function bodyText(text: string): string {
  return `<div style="font-family:${SANS};font-size:15px;line-height:24px;color:${INK};">${escapeHtml(text)}</div>`;
}

function card(inner: string, opts?: { bg?: string; border?: string }): string {
  const bg = opts?.bg ?? CARD;
  const border = opts?.border ?? BORDER;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;">
    <tr><td style="background:${bg};border:1px solid ${border};border-radius:12px;padding:20px 22px;">${inner}</td></tr>
  </table>`;
}

function tagPill(text: string): string {
  return `<span style="display:inline-block;font-family:${SANS};font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:${SLATE};background:${CHIP_BG};border:1px solid ${BORDER};border-radius:6px;padding:2px 7px;margin-left:6px;white-space:nowrap;">${escapeHtml(text)}</span>`;
}

export function renderPreCallBriefingEmail(
  briefing: MagayaBriefing,
  ctx: BriefingEmailContext,
): RenderedEmail {
  const stageLabel = STAGE_LABELS[ctx.stageKey] ?? ctx.stageKey;
  const subject = `Briefing for your ${ctx.account} call${
    typeof ctx.minutesUntil === "number" ? ` in ${ctx.minutesUntil} min` : ""
  }`;
  const subtitle = ctx.attendees
    ? `${stageLabel} &middot; on the call: ${escapeHtml(ctx.attendees)}`
    : escapeHtml(stageLabel);

  const questionRows = briefing.questions
    .map(
      (q, i) => `
      <tr>
        <td valign="top" width="26" style="padding:${i === 0 ? "0" : "18px"} 10px 0 0;font-family:${SANS};font-size:14px;color:${MUTED};line-height:23px;">${i + 1}.</td>
        <td valign="top" style="padding:${i === 0 ? "0" : "18px"} 0 0 0;">
          <div style="font-family:${SANS};font-size:15px;line-height:23px;color:${NAVY};font-weight:500;">${escapeHtml(q.ask)}${q.targetLabel ? tagPill(q.targetLabel) : ""}</div>
          ${q.why ? `<div style="font-family:${SANS};font-size:13px;line-height:20px;color:${MUTED};margin-top:5px;">${escapeHtml(q.why)}</div>` : ""}
        </td>
      </tr>`,
    )
    .join("");

  const signalCard = briefing.signalFlag
    ? card(`${label("Signal", RED)}${bodyText(briefing.signalFlag)}`, { bg: RED_SOFT, border: RED_BORDER })
    : "";

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">Your prep for the ${escapeHtml(ctx.account)} call.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:26px 0;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
      <tr><td style="padding:0 20px;">

        <div style="font-family:${SANS};font-size:12px;font-weight:700;margin:0 0 14px 2px;">
          <span style="color:${NAVY};">Deal</span><span style="color:${GREEN};">Ripe</span>
        </div>

        <div style="font-family:${SANS};font-size:19px;font-weight:700;color:${NAVY};margin:0 0 4px 2px;">Briefing for next call &middot; ${escapeHtml(ctx.account)}</div>
        <div style="font-family:${SANS};font-size:13px;line-height:19px;color:${MUTED};margin:0 0 18px 2px;">${subtitle}</div>

        ${card(`${label("Call objective", MUTED)}${bodyText(briefing.callObjective)}`)}

        ${card(`${label("Where it stands", MUTED)}${bodyText(briefing.whereItStands)}`)}

        ${card(
          `${label(`Ask these (${briefing.questions.length})`, MUTED)}
           <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${questionRows}</table>`,
        )}

        ${card(`${label("Secure this next step", MUTED)}${bodyText(briefing.nextStepCommitment)}`)}

        ${card(`${label("What's at risk", RED)}${bodyText(briefing.whatsAtRisk)}`)}

        ${signalCard}

        <div style="font-family:${SANS};font-size:12px;line-height:19px;color:${MUTED};margin:6px 2px 0 2px;">
          DealRipe built this from the deal history. Sell how you sell; this points at the gaps.
        </div>

      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  return { subject, html, text: renderText(briefing, ctx, stageLabel) };
}

function renderText(briefing: MagayaBriefing, ctx: BriefingEmailContext, stageLabel: string): string {
  const lines: string[] = [];
  lines.push(`Briefing for next call - ${ctx.account}`);
  lines.push(ctx.attendees ? `${stageLabel} - on the call: ${ctx.attendees}` : stageLabel);
  lines.push("");
  lines.push("CALL OBJECTIVE");
  lines.push(briefing.callObjective);
  lines.push("");
  lines.push("WHERE IT STANDS");
  lines.push(briefing.whereItStands);
  lines.push("");
  lines.push(`ASK THESE (${briefing.questions.length})`);
  briefing.questions.forEach((q, i) => {
    lines.push(`${i + 1}. ${q.ask}${q.targetLabel ? ` [${q.targetLabel}]` : ""}`);
    if (q.why) lines.push(`   ${q.why}`);
  });
  lines.push("");
  lines.push("SECURE THIS NEXT STEP");
  lines.push(briefing.nextStepCommitment);
  lines.push("");
  lines.push("WHAT'S AT RISK");
  lines.push(briefing.whatsAtRisk);
  if (briefing.signalFlag) {
    lines.push("");
    lines.push("SIGNAL");
    lines.push(briefing.signalFlag);
  }
  lines.push("");
  lines.push("DealRipe built this from the deal history. Sell how you sell; this points at the gaps.");
  return lines.join("\n");
}
