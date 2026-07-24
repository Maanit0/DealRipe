/**
 * Weekly digest email for the sales leader. Renders the evidence-based digest
 * data (buildWeeklyDigestData) into clean cards: one flowing paragraph per
 * deal, the account name itself is the link (no crowding), no-shows in their
 * own section. Matches the recap style. No em-dashes.
 */

import type { DigestAttention, DigestMovement, DigestNoShow } from "../weekly-digest-data";
import type { ChangeEvent, DealChangeRecord, PipelineChanges } from "../pipeline-changes";

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

// The rep's Rolldog forecast, compact: "Commit · close Dec 8".
function fmtForecast(f: { category: string | null; closeDate: string | null }): string {
  const parts: string[] = [];
  if (f.category) parts.push(f.category);
  if (f.closeDate) {
    try {
      parts.push(
        `close ${new Date(f.closeDate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`,
      );
    } catch {
      /* skip bad date */
    }
  }
  return parts.join(" · ");
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
        ${
          e.repForecast && fmtForecast(e.repForecast)
            ? `<div style="font-family:${SANS};font-size:12px;color:${MUTED};margin-top:4px;">Rep forecast: <span style="color:${INK};font-weight:600;">${esc(fmtForecast(e.repForecast))}</span></div>`
            : ""
        }
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

// ===========================================================================
// Engine-based digest (getPipelineChanges). The new hero: headline metrics,
// deal-centric "needs attention" with the Rolldog state and the call-caught
// flags, then the Kent-style "what moved" grid. Renders structured records, so
// the copy lives here, not in the data layer.
// ===========================================================================

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
}
function dstr(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" });
  } catch {
    return "";
  }
}
const SEV_COLOR: Record<string, string> = { high: "#B91C1C", med: "#B45309", low: "#5B6470" };

/** A concrete unblock action, grounded in the agreed next step and the gaps. */
function doThisText(d: DealChangeRecord): string {
  if (d.isNoShow) return "Confirm whether this is still live, then re-engage the champion.";

  const buyer = d.economicBuyer && !d.economicBuyer.engaged ? d.economicBuyer.name ?? "the economic buyer" : null;
  const confirm = d.missing.filter((m) => m !== "Economic buyer").slice(0, 2).map((m) => m.toLowerCase());
  const gapParts: string[] = [];
  if (buyer) gapParts.push(`get ${buyer} in the room`);
  if (confirm.length) gapParts.push(`confirm ${confirm.join(" and ")}`);
  const gap = gapParts.join(" and ");

  // The ball is in the customer's court: don't push a meeting, set a check-in.
  if (d.nextStepIsCustomerWait) {
    const by = d.followUpBy ? ` by ${dstr(d.followUpBy)}` : "";
    const chase = d.followUpBy ? ` Set a check-in for ${dstr(d.followUpBy)} to follow up if you have not heard.` : "";
    return `Customer to respond${by}.${chase}${gap ? ` Use the window to ${gap}.` : ""}`.trim();
  }
  // The rep owed a meeting and none is booked.
  if (!d.nextMeetingBooked) {
    return `No follow-up is booked. Book the next meeting${gap ? ` and ${gap}` : ""}.`;
  }
  return gap ? `${gap.charAt(0).toUpperCase()}${gap.slice(1)}.` : "Confirm the next-stage gates are progressing.";
}
const CHANGE_ORDER: Array<{ kind: ChangeEvent["kind"]; title: string }> = [
  { kind: "stage", title: "Stage" },
  { kind: "amount", title: "Amount" },
  { kind: "close_date", title: "Close date" },
  { kind: "new", title: "New opportunity" },
  { kind: "won", title: "Closed won" },
  { kind: "lost", title: "Closed lost" },
];

export function renderPipelineDigestEmail(args: {
  pc: PipelineChanges;
  weekLabel: string;
  recipientName?: string;
  baseUrl?: string;
}): RenderedEmail {
  const { pc, weekLabel, recipientName } = args;
  const base = (args.baseUrl ?? "").replace(/\/$/, "");
  const name = (account: string, dealId: string): string =>
    base ? `<a href="${base}/deals/${dealId}" style="color:${NAVY};text-decoration:none;">${esc(account)}</a>` : esc(account);

  const fcat = (c: string | null): number => {
    if (!c) return -1;
    const l = c.toLowerCase();
    return /commit/.test(l) ? 3 : /expect/.test(l) ? 2 : /pipeline/.test(l) ? 1 : /omit/.test(l) ? 0 : -1;
  };
  // Mark triages by revenue first: the biggest deals to look at lead.
  const attention = pc.deals
    .filter((d) => d.needsAttention)
    .sort((a, b) => (b.dealSizeAnnual ?? 0) - (a.dealSizeAnnual ?? 0))
    .slice(0, 6);
  const noShows = pc.deals.filter((d) => d.isNoShow);
  const h = pc.headline;

  // Forecast reality: how much of the reps' Commit + Expect DealRipe rates softer
  // than the forecast, so Mark sees the risk to his number up front.
  const committedDeals = pc.deals.filter((d) => !d.archived && fcat(d.forecastCategory) >= 2);
  const repForecast = committedDeals.reduce((n, d) => n + (d.dealSizeAnnual ?? 0), 0);
  const softDeals = committedDeals.filter((d) => fcat(d.dealRipeCategory) >= 0 && fcat(d.dealRipeCategory) < fcat(d.forecastCategory));
  const softAmount = softDeals.reduce((n, d) => n + (d.dealSizeAnnual ?? 0), 0);
  const RED_TINT = "#FEF2F2";

  const subject = `DealRipe pipeline digest, week of ${weekLabel}${attention.length ? `. ${attention.length} to look at` : ""}`;

  const metric = (label: string, value: string, color = INK) =>
    `<td valign="top" style="padding:0 8px;"><div style="font-family:${SANS};font-size:11px;color:${MUTED};">${label}</div><div style="font-family:${SANS};font-size:19px;font-weight:700;color:${color};">${esc(value)}</div></td>`;

  const mixChips = h.forecastMix
    .filter((b) => b.annual > 0 && !/uncategor/i.test(b.category))
    .map((b) => `<span style="font-family:${SANS};font-size:11px;color:${MUTED};background:${CARD};border:1px solid ${BORDER};border-radius:20px;padding:3px 9px;margin-right:6px;white-space:nowrap;"><strong style="color:${NAVY};">${esc(b.category)}</strong> ${b.deals} &middot; ${esc(money(b.annual))}</span>`)
    .join("");

  // The forecast-reality line: reps' Commit+Expect and how much DealRipe rates softer.
  const forecastLine =
    softAmount > 0
      ? `<tr><td style="padding:4px 6px 0 6px;"><div style="font-family:${SANS};font-size:14px;line-height:21px;color:${INK};background:${RED_TINT};border-radius:10px;padding:12px 15px;">Reps have <strong>${esc(money(repForecast))}</strong> in Commit and Expect this week. DealRipe rates <strong style="color:${RED};">${esc(money(softAmount))}</strong> of it softer than the forecast, on ${softDeals.length} deal${softDeals.length === 1 ? "" : "s"} below.</div></td></tr>`
      : "";

  // One readable card per deal: big name, the deal facts, THE risk in a tinted
  // box, the contact and what was agreed, and the rep's next move in its own
  // box. Full detail (captured, every flag) lives on /review.
  // Sybill-clean: each deal is its own white card, floating with breathing room.
  // No alert boxes. Bold dark section labels (Risk / Main contact / On the call),
  // the risk marked by a small colored dot, and the rep's next move in a subtle
  // grey box. Restrained color; full detail lives on /review.
  const GREYBOX = "#F5F7FA";
  const LABEL = `font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.03em;color:${NAVY};text-transform:uppercase;`;
  const VALUE = `font-family:${SANS};font-size:15px;line-height:22px;color:${INK};margin-top:4px;`;
  const attentionCards = attention
    .map((d: DealChangeRecord, i) => {
      const sev = d.flags[0]?.severity ?? "high";
      const dot = sev === "high" ? RED : sev === "med" ? AMBER : MUTED;
      const moveColor = d.movement.direction === "forward" ? GREEN : d.movement.direction === "backward" ? RED : MUTED;
      const facts = d.inRolldog
        ? `${esc(d.stageName ?? "—")} &middot; ${esc(d.forecastCategory ?? "—")} &middot; closes ${esc(dstr(d.closeDate) || "—")} &middot; ${d.dealSizeAnnual ? esc(money(d.dealSizeAnnual)) + "/yr" : "size —"} &middot; ${esc(d.repName)}`
        : `Not in Rolldog yet &middot; ${esc(d.repName)}`;
      // The hero when it exists: DealRipe rates the deal below the rep's forecast.
      // This is the "you're committing this but it's soft" moment Mark cares most about.
      const diverges = d.inRolldog && fcat(d.dealRipeCategory) >= 0 && fcat(d.dealRipeCategory) < fcat(d.forecastCategory);
      const divergeHtml = diverges
        ? `<div style="background:${RED_TINT};border-radius:10px;padding:12px 15px;margin-top:14px;"><div style="font-family:${SANS};font-size:15px;line-height:22px;color:${INK};"><strong style="color:${RED};">${esc(d.repName)} has this at ${esc(d.forecastCategory ?? "")}, DealRipe rates it ${esc(d.dealRipeCategory ?? "")}.</strong> ${esc(d.blockers[0] ?? "")}</div></div>`
        : "";
      const toneColor = (t: "up" | "down" | "neutral") => (t === "up" ? GREEN : t === "down" ? RED : MUTED);
      const whatChangedHtml = d.whatChanged.length
        ? d.whatChanged
            .map(
              (w) =>
                `<div style="font-family:${SANS};font-size:14px;line-height:21px;color:${INK};margin-top:6px;"><span style="color:${toneColor(w.tone)};font-size:10px;">&#9679;</span>&nbsp; ${w.label ? `<strong style="color:${NAVY};">${esc(w.label)}:</strong> ` : ""}${esc(w.text)}</div>`,
            )
            .join("")
        : "";
      // On diverging cards the top blocker is already the divergence reason, so
      // drop it here to avoid saying it twice.
      const shownBlockers = diverges && d.blockers.length > 1 ? d.blockers.slice(1) : d.blockers;
      const blockersHtml = (shownBlockers.length ? shownBlockers : ["Worth a look."])
        .map(
          (b) =>
            `<div style="font-family:${SANS};font-size:14px;line-height:21px;color:${INK};margin-top:6px;"><span style="color:${dot};font-size:10px;">&#9679;</span>&nbsp; ${esc(b)}</div>`,
        )
        .join("");
      const contactBlock = d.primaryContact && !d.isNoShow
        ? `<div style="${LABEL}margin-top:17px;">Main contact</div>
           <div style="${VALUE}">${esc(d.primaryContact.name)}${d.primaryContact.role ? `, ${esc(d.primaryContact.role)}` : ""}${d.primaryContact.relationship ? ` <span style="color:${MUTED};">(${esc(d.primaryContact.relationship)})</span>` : ""}</div>`
        : "";
      // "On the [date] call": the agreed next step, plus whether the follow-up
      // call it promised is actually on the calendar. When no step was agreed,
      // say so rather than hiding the section.
      let agreedBlock = "";
      if (d.lastConversationAt && !d.isNoShow) {
        let body: string;
        if (d.agreedNextStep) {
          const booking = d.nextStepIsMeeting
            ? d.nextMeetingBooked
              ? ` <span style="color:${GREEN};font-weight:600;">The call is on the calendar.</span>`
              : ` <span style="color:${RED};font-weight:600;">But no call has been booked on the calendar.</span>`
            : "";
          body = `${esc(d.agreedNextStep)}${booking}`;
        } else {
          body = `<span style="color:${RED};font-weight:600;">No next step was agreed on this call.</span>`;
        }
        agreedBlock = `<div style="${LABEL}margin-top:15px;">On the ${esc(dstr(d.lastConversationAt) || "last")} call</div>
           <div style="${VALUE}">${body}</div>`;
      }
      return `
      <tr><td style="padding-top:12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:1px solid ${BORDER};border-radius:14px;">
          <tr><td style="padding:20px 22px;">
            <div style="font-family:${SANS};font-size:17px;font-weight:700;color:${NAVY};line-height:23px;">${name(d.account, d.dealId)}${d.isRenewal ? ` <span style="font-size:11px;color:${MUTED};font-weight:500;">renewal</span>` : ""}</div>
            <div style="font-family:${SANS};font-size:13px;color:${MUTED};margin-top:4px;">${facts}</div>
            ${divergeHtml}

            <div style="${LABEL}margin-top:18px;">Moved this week</div>
            <div style="font-family:${SANS};font-size:15px;line-height:22px;color:${moveColor};font-weight:600;margin-top:4px;">${esc(d.movement.summary)}</div>
            ${whatChangedHtml}

            <div style="${LABEL}margin-top:18px;">What's blocking</div>
            ${blockersHtml}
            ${contactBlock}
            ${agreedBlock}

            <div style="background:${GREYBOX};border-radius:10px;padding:13px 15px;margin-top:18px;">
              <div style="${LABEL}color:${GREEN};">Rep's next move</div>
              <div style="font-family:${SANS};font-size:15px;line-height:22px;color:${INK};margin-top:4px;">${esc(d.doThis ?? doThisText(d))}</div>
            </div>
          </td></tr>
        </table>
      </td></tr>`;
    })
    .join("");

  const noShowRows = noShows
    .map((d, i) => {
      const what = d.noShowTitle ? `"${esc(d.noShowTitle)}" ` : "";
      const invitees = d.noShowInvitees.length ? d.noShowInvitees.join(", ") : d.primaryContact?.name ?? "";
      const who = invitees ? ` with ${esc(invitees)}` : "";
      const when = dstr(d.lastConversationAt) || "recently";
      return `<tr><td valign="top" width="18" style="padding-top:${i === 0 ? "0" : "10px"};font-family:${SANS};font-size:15px;color:${AMBER};font-weight:700;">&#9679;</td><td valign="top" style="padding-top:${i === 0 ? "0" : "10px"};font-family:${SANS};font-size:15px;line-height:23px;color:${INK};"><strong style="color:${NAVY};font-weight:600;">${name(d.account, d.dealId)}.</strong> The ${esc(when)} ${what}meeting${who} was a no-show. ${d.repName} should confirm it is still live and reschedule.</td></tr>`;
    })
    .join("");

  const spacer = `<tr><td style="height:14px;line-height:14px;">&nbsp;</td></tr>`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:${BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:28px 0;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
  <tr><td style="padding:0 4px 16px 4px;">
    <div style="font-family:${SANS};font-size:13px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;color:${GREEN};">DealRipe</div>
    <div style="font-family:${SANS};font-size:22px;font-weight:700;color:${NAVY};margin-top:6px;">Pipeline changes</div>
    <div style="font-family:${SANS};font-size:14px;color:${MUTED};margin-top:4px;">Week of ${esc(weekLabel)}${recipientName ? ` &middot; for ${esc(recipientName)}` : ""}</div>
  </td></tr>

  <tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:12px;padding:18px 14px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      ${metric("Pipeline", money(h.totalPipelineAnnual))}
      ${metric("Changed", `${h.dealsChanged}`)}
      ${metric("To look at", `${h.dealsNeedingAttention}`, h.dealsNeedingAttention ? RED : INK)}
      ${metric("Won / lost", `${h.closedWon} / ${h.closedLost}`)}
    </tr></table>
    ${mixChips ? `<div style="margin-top:12px;">${mixChips}</div>` : ""}
  </td></tr>

  ${forecastLine ? `${spacer}${forecastLine}` : ""}

  ${spacer}

  <tr><td style="padding:4px 6px 0 6px;">
    <div style="font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${NAVY};">Deals to look at${h.dealsNeedingAttention > attention.length ? ` &middot; top ${attention.length} of ${h.dealsNeedingAttention}` : ""}</div>
  </td></tr>
  ${attention.length ? attentionCards : `<tr><td style="padding-top:12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:1px solid ${BORDER};border-radius:14px;"><tr><td style="padding:20px 22px;font-family:${SANS};font-size:15px;line-height:23px;color:${MUTED};">Nothing needs your attention this week.</td></tr></table></td></tr>`}

  ${
    noShows.length
      ? `${spacer}<tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:12px;padding:20px 22px;">
    <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${AMBER};margin:0 0 14px 0;">No-shows</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${noShowRows}</table>
  </td></tr>`
      : ""
  }

  ${base ? `<tr><td style="padding:20px 6px 0 6px;"><a href="${base}/review" style="display:inline-block;background:${NAVY};color:#FFFFFF;font-family:${SANS};font-size:14px;font-weight:600;text-decoration:none;padding:11px 22px;border-radius:10px;">Open pipeline changes in DealRipe</a></td></tr>` : ""}
  <tr><td style="padding:18px 6px 0 6px;"><div style="font-family:${SANS};font-size:13px;line-height:21px;color:${MUTED};">Ranked by what needs you most, from what your calls caught this week. Reply with anything you want tracked.</div></td></tr>
</table>
</td></tr></table></body></html>`;

  const t: string[] = [`DealRipe pipeline changes, week of ${weekLabel}`, "", `Pipeline ${money(h.totalPipelineAnnual)} · ${h.dealsChanged} changed · ${h.dealsNeedingAttention} to look at · won/lost ${h.closedWon}/${h.closedLost}`];
  if (softAmount > 0) t.push("", `Reps have ${money(repForecast)} in Commit and Expect. DealRipe rates ${money(softAmount)} of it softer than the forecast, on ${softDeals.length} deal(s).`);
  t.push("", "DEALS TO LOOK AT");
  if (attention.length)
    attention.forEach((d, i) => {
      t.push(`${i + 1}. ${d.account} (${d.stageName ?? "—"}, ${d.forecastCategory ?? "—"}, closes ${dstr(d.closeDate) || "—"})`);
      if (fcat(d.dealRipeCategory) >= 0 && fcat(d.dealRipeCategory) < fcat(d.forecastCategory)) t.push(`   ${d.repName} has this at ${d.forecastCategory}, DealRipe rates it ${d.dealRipeCategory}: ${d.blockers[0] ?? ""}`);
      t.push(`   Moved this week: ${d.movement.summary}`);
      for (const w of d.whatChanged) t.push(`     - ${w.label ? `${w.label}: ` : ""}${w.text}`);
      t.push(`   Blocking:`);
      for (const b of (d.blockers.length ? d.blockers : ["Worth a look."])) t.push(`     - ${b}`);
      t.push(`   Rep's next move: ${d.doThis ?? doThisText(d)}`);
    });
  else t.push("- Nothing needs attention.");
  if (noShows.length) {
    t.push("", "NO-SHOWS");
    for (const d of noShows) t.push(`- ${d.account}: ${dstr(d.lastConversationAt) || "recent"} meeting${d.primaryContact ? ` with ${d.primaryContact.name}` : ""} was a no-show.`);
  }
  return { subject, html, text: t.join("\n") };
}
