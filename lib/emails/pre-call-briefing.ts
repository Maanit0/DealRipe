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
  /**
   * What to show instead of the SQL stage label, when the stage is not the
   * honest description of the relationship.
   *
   * Medov is a customer since 2023 with 111 licences at about $22,000 a month
   * and an open Active Renewal, and this header called them "Lead" because the
   * deal row sits at SQL0. The body of that briefing got it right and the line
   * above it did not, which is the first thing a rep reads. Set by
   * briefing-sync from the resolved meeting context; absent falls back to the
   * stage, which is correct for ordinary new business.
   */
  standingLabel?: string | null;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A section heading.
 *
 * Was 11px uppercase in MUTED grey, which reads as a caption rather than a
 * header: the sections ran together into one page of text and a rep scanning
 * for "what do I ask" had nothing to land on. Now 12.5px in NAVY with a short
 * accent rule above it, so the eye can find a section without reading it.
 */
function label(text: string, color: string): string {
  const accent = color === RED ? RED : GREEN;
  return `<div style="margin:0 0 11px 0;">
    <div style="width:22px;height:3px;background:${accent};border-radius:2px;margin:0 0 9px 0;font-size:0;line-height:0;">&nbsp;</div>
    <div style="font-family:${SANS};font-size:12.5px;font-weight:800;letter-spacing:0.07em;text-transform:uppercase;color:${color === RED ? RED : NAVY};">${escapeHtml(text)}</div>
  </div>`;
}

/**
 * A heading INSIDE a card, for the grouped layout.
 *
 * Twelve separate white boxes holding two lines each read as confetti: the eye
 * has to cross a border and a shadow to get from one fact to the next, and the
 * brief looks sparse even when it is dense. Three cards with internal headings
 * put related things next to each other, which is how they get used.
 */
function sub(text: string, color: string = NAVY): string {
  return `<div style="font-family:${SANS};font-size:11.5px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${color};margin:0 0 7px 0;">${escapeHtml(text)}</div>`;
}

function rule(): string {
  return `<div style="border-top:1px solid ${BORDER};margin:16px 0 15px 0;font-size:0;line-height:0;">&nbsp;</div>`;
}

/**
 * A zone divider. Three of them, splitting the brief into what a rep does in
 * order: ACT on this call, SAY these things, KNOW this background. Without them
 * twelve cards read as one undifferentiated stack.
 */
function zone(text: string): string {
  return `<div style="font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED};margin:22px 2px 10px 2px;">${escapeHtml(text)}</div>`;
}

function bodyText(text: string): string {
  return `<div style="font-family:${SANS};font-size:15px;line-height:24px;color:${INK};">${escapeHtml(text)}</div>`;
}

function card(inner: string, opts?: { bg?: string; border?: string }): string {
  const bg = opts?.bg ?? CARD;
  const border = opts?.border ?? BORDER;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px 0;">
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
  const stageLabel = ctx.standingLabel ?? STAGE_LABELS[ctx.stageKey] ?? ctx.stageKey;
  const subject = `Briefing for your ${ctx.account} call${
    typeof ctx.minutesUntil === "number" ? ` in ${ctx.minutesUntil} min` : ""
  }`;
  const subtitle = ctx.attendees
    ? `${stageLabel} &middot; on the call: ${escapeHtml(ctx.attendees)}`
    : escapeHtml(stageLabel);

  const questionRows = (briefing.questions ?? [])
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


  // BLOCK RENDERERS.
  //
  // Added 2026-08-25 with the shape work. Before this the email rendered six
  // fixed fields, so every new block was generated, counted against the word
  // budget, and then silently dropped before the rep saw it. A demo briefing,
  // which deliberately carries zero questions and a showThis instead, would
  // have arrived nearly empty. Generating a thing and not delivering it is
  // worse than never generating it.
  //
  // Every block is optional and renders only when present, so a call type whose
  // shape did not ask for it produces no empty card.
  const esc = (v: unknown) => escapeHtml(String(v ?? ""));
  const bullets = (items: string[]) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items
      .map(
        (t) =>
          `<tr><td style="font-family:${SANS};font-size:14px;line-height:21px;color:${NAVY};padding:0 0 7px 0;">&bull;&nbsp; ${t}</td></tr>`,
      )
      .join("")}</table>`;

  // The booking block. Given its own visual weight because it is the fix for the
  // most common failure in the book: a verbal next step that never reaches a
  // calendar. The "say" line is meant to be read aloud, so it is set apart.
  const bookBlock = briefing.bookThis
    ? `${sub("Book this before the call ends", GREEN)}${bodyText(
        `${briefing.bookThis.what}${briefing.bookThis.when ? ` \u2014 ${briefing.bookThis.when}` : ""}`.replace(" \u2014 ", ", "),
      )}${
        briefing.bookThis.say
          ? `<div style="margin:10px 0 0 0;padding:12px 14px;background:${CHIP_BG};border-left:3px solid ${GREEN};border-radius:6px;font-family:${SANS};font-size:15px;line-height:23px;color:${NAVY};">&ldquo;${esc(briefing.bookThis.say)}&rdquo;</div>`
          : ""
      }`
    : `${sub("Secure this next step")}${bodyText(briefing.nextStepCommitment)}`;

  const roomBlock = briefing.inTheRoom?.length
    ? `${sub("In the room")}${bullets(
        briefing.inTheRoom.map((r) => `<b>${esc(r.person)}</b> &middot; ${esc(r.note)}`),
      )}`
    : "";

  // Sub-bullets UNDER each side rather than a "We owe ·" prefix inline. There
  // can be several each way, and a prefix repeated three times reads as three
  // unrelated lines instead of one list with an owner.
  const side = (heading: string, items: string[]) =>
    items.length
      ? `<div style="font-family:${SANS};font-size:13px;font-weight:800;letter-spacing:0.05em;text-transform:uppercase;color:${SLATE};margin:0 0 6px 0;">${escapeHtml(heading)}</div>${bullets(items.map(esc))}`
      : "";
  const usItems = briefing.openItems?.us ?? [];
  const themItems = briefing.openItems?.them ?? [];
  const openItemsBlock =
    usItems.length || themItems.length
      ? `${sub("Open items", RED)}${side("We owe", usItems)}${
          usItems.length && themItems.length ? `<div style="height:12px;font-size:0;line-height:0;">&nbsp;</div>` : ""
        }${side("They owe", themItems)}`
      : "";

  const sinceBlock = briefing.sinceLastContact
    ? `${sub("Since last contact")}${bodyText(briefing.sinceLastContact)}`
    : "";

  const numbersBlock = briefing.theNumbers?.length
    ? `${sub("The numbers")}${bullets(briefing.theNumbers.map(esc))}`
    : "";

  const showThisBlock = briefing.showThis?.length
    ? `${sub(`Show this (${briefing.showThis.length})`)}${bullets(
        briefing.showThis.map(
          (x) => `<b>${esc(x.item)}</b><br><span style="color:${MUTED};">${esc(x.why)}</span>`,
        ),
      )}`
    : "";

  const forkBlock = briefing.fork?.branches?.length
    ? `${sub("If they say")}${bullets(
        briefing.fork.branches.map((b) => `<b>${esc(b.ifThey)}</b> &rarr; ${esc(b.then)}`),
      )}`
    : "";

  const doNotBlock = briefing.doNotDo ? `${sub("Do not", RED)}${bodyText(briefing.doNotDo)}` : "";

  // Zero questions is correct on a demo, so the block disappears rather than
  // rendering "Ask these (0)".
  const questionsBlock = briefing.questions?.length
    ? `${sub(`Ask these (${briefing.questions.length})`)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${questionRows}</table>`
    : "";

  const signalCard = briefing.signalFlag
    ? card(`${sub("Signal", RED)}${bodyText(briefing.signalFlag)}`, { bg: RED_SOFT, border: RED_BORDER })
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

        ${/* THREE CARDS, not twelve.
              ACT is what this call is for and is the only thing a rep may read
              if the customer joins early. SAY is the words. KNOW is background,
              in the order it gets used. */ ""}

        ${card(
          [
            `${sub("Commit to")}${bodyText(briefing.callObjective)}`,
            bookBlock,
            `${sub("If you don't", RED)}${bodyText(briefing.whatsAtRisk)}`,
          ]
            .filter(Boolean)
            .join(rule()),
        )}

        ${card(
          [
            showThisBlock,
            questionsBlock,
            forkBlock,
            doNotBlock,
          ]
            .filter(Boolean)
            .join(rule()),
        )}

        ${card(
          [
            roomBlock,
            openItemsBlock,
            sinceBlock,
            `${sub("Where it stands")}${bodyText(briefing.whereItStands)}`,
            numbersBlock,
          ]
            .filter(Boolean)
            .join(rule()),
        )}

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
  // Same block order as the HTML, and the same rule: a block the shape did not
  // ask for produces no heading. A plain-text fallback that silently held six
  // fields while the HTML held twelve would be a second place for the same bug.
  const sec = (heading: string, body: string | null | undefined) => {
    if (!body) return;
    lines.push("");
    lines.push(heading);
    lines.push(body);
  };
  const secList = (heading: string, items: string[] | null | undefined) => {
    if (!items?.length) return;
    lines.push("");
    lines.push(heading);
    for (const t of items) lines.push(`- ${t}`);
  };

  lines.push("CALL OBJECTIVE");
  lines.push(briefing.callObjective);
  if (briefing.bookThis) {
    lines.push("");
    lines.push("BOOK THIS BEFORE THE CALL ENDS");
    lines.push(`${briefing.bookThis.what}${briefing.bookThis.when ? `, ${briefing.bookThis.when}` : ""}`);
    if (briefing.bookThis.say) lines.push(`Say: "${briefing.bookThis.say}"`);
  }
  sec("WHAT'S AT RISK", briefing.whatsAtRisk);
  secList(
    "IN THE ROOM",
    briefing.inTheRoom?.map((r) => `${r.person}: ${r.note}`),
  );
  secList("OPEN ITEMS", [
    ...(briefing.openItems?.us ?? []).map((t) => `We owe: ${t}`),
    ...(briefing.openItems?.them ?? []).map((t) => `They owe: ${t}`),
  ]);
  sec("SINCE LAST CONTACT", briefing.sinceLastContact);
  secList("THE NUMBERS", briefing.theNumbers);
  sec("WHERE IT STANDS", briefing.whereItStands);
  secList(
    "SHOW THIS",
    briefing.showThis?.map((x) => `${x.item} - ${x.why}`),
  );
  if (briefing.questions?.length) {
    lines.push("");
    lines.push(`ASK THESE (${briefing.questions.length})`);
    briefing.questions.forEach((q, i) => {
      lines.push(`${i + 1}. ${q.ask}${q.targetLabel ? ` [${q.targetLabel}]` : ""}`);
      if (q.why) lines.push(`   ${q.why}`);
    });
  }
  secList(
    "IF THEY SAY",
    briefing.fork?.branches?.map((b) => `${b.ifThey} -> ${b.then}`),
  );
  sec("DO NOT", briefing.doNotDo);
  sec("SECURE THIS NEXT STEP", briefing.nextStepCommitment);
  if (briefing.signalFlag) {
    lines.push("");
    lines.push("SIGNAL");
    lines.push(briefing.signalFlag);
  }
  lines.push("");
  lines.push("DealRipe built this from the deal history. Sell how you sell; this points at the gaps.");
  return lines.join("\n");
}
