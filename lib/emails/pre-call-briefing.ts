/**
 * Pre-call briefing email. The artifact the rep actually receives.
 *
 * Three cards, in the order a rep uses them: what to DO on this call, what to
 * SAY, and the background to KNOW. The shape decides the order, because on a
 * discovery call the state has to come before the asks. Above them sits a
 * header card carrying who is on the call and what kind of call it is.
 *
 * Pure function, no external deps. No em-dashes (project convention).
 */

import type { MagayaBriefing } from "../generate-briefing";
import { dealNumbers, standPoints } from "../briefing-blocks";
import { shapeForCallType } from "../briefing-shapes";
import type { BriefingAttendee } from "../attendees";

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

/**
 * What kind of call this is, in the words a rep uses for it.
 *
 * "follow_up" is a database value. Unknown prints nothing at all rather than a
 * chip reading "Unknown", which asserts confusion where the honest answer is
 * that this dimension simply is not shown.
 */
const CALL_TYPE_LABELS: Record<string, string> = {
  discovery: "Discovery call",
  demo: "Demo",
  proposal: "Proposal call",
  follow_up: "Follow-up call",
  customer: "Existing customer",
};

export type RenderedEmail = { subject: string; html: string; text: string };

export type BriefingEmailContext = {
  account: string;
  stageKey: string;
  /** Legacy one-line attendee sentence. Used only when no roster is supplied. */
  attendees?: string;
  /**
   * Who is on the call, as rows.
   *
   * The sentence version ran to four wrapped lines of grey text directly under
   * the account name, which is the first thing a rep sees and the easiest thing
   * to skip. Build it with briefingRoster in lib/attendees.ts.
   */
  roster?: ReadonlyArray<BriefingAttendee>;
  /** What kind of call, from resolvePreCallType. Drives the chip and the card order. */
  callType?: string | null;
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
 * A heading INSIDE a card.
 *
 * Twelve separate white boxes holding two lines each read as confetti: the eye
 * has to cross a border and a shadow to get from one fact to the next, and the
 * brief looks sparse even when it is dense. Three cards with internal headings
 * put related things next to each other, which is how they get used. 11.5px
 * navy rather than the 11px grey caption these started as, which a rep scanning
 * for "what do I ask" had nothing to land on.
 */
function sub(text: string, color: string = NAVY): string {
  return `<div style="font-family:${SANS};font-size:11.5px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${color};margin:0 0 7px 0;">${escapeHtml(text)}</div>`;
}

function rule(): string {
  return `<div style="border-top:1px solid ${BORDER};margin:16px 0 15px 0;font-size:0;line-height:0;">&nbsp;</div>`;
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

/** A header chip: the kind of call, the stage, the countdown. */
function chip(text: string, opts?: { strong?: boolean }): string {
  const color = opts?.strong ? NAVY : SLATE;
  const bg = opts?.strong ? "#ECFDF5" : CHIP_BG;
  const border = opts?.strong ? "#BBF7D9" : BORDER;
  return `<span style="display:inline-block;font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${color};background:${bg};border:1px solid ${border};border-radius:20px;padding:4px 11px;margin:0 6px 0 0;white-space:nowrap;">${escapeHtml(text)}</span>`;
}

/**
 * The relationship pill next to a name.
 *
 * Colour carries the one distinction a rep needs at a glance: the person who
 * signs, and the person who argues for us internally. Everyone else is grey,
 * and a person we have not placed gets no pill rather than a grey "unknown".
 */
function relationshipPill(relationship: string): string {
  const key = relationship.toLowerCase();
  const strong =
    key.includes("economic") || key.includes("buyer")
      ? { fg: "#7C2D12", bg: "#FFF7ED", br: "#FED7AA" }
      : key.includes("champion")
        ? { fg: "#065F46", bg: "#ECFDF5", br: "#BBF7D9" }
        : { fg: SLATE, bg: CHIP_BG, br: BORDER };
  return `<span style="display:inline-block;font-family:${SANS};font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:${strong.fg};background:${strong.bg};border:1px solid ${strong.br};border-radius:6px;padding:2px 7px;margin-left:7px;white-space:nowrap;">${escapeHtml(relationship)}</span>`;
}

export function renderPreCallBriefingEmail(
  briefing: MagayaBriefing,
  ctx: BriefingEmailContext,
): RenderedEmail {
  const stageLabel = ctx.standingLabel ?? STAGE_LABELS[ctx.stageKey] ?? ctx.stageKey;
  const callTypeLabel = CALL_TYPE_LABELS[String(ctx.callType ?? "").toLowerCase()] ?? null;
  const subject = `Briefing for your ${ctx.account} call${
    typeof ctx.minutesUntil === "number" ? ` in ${ctx.minutesUntil} min` : ""
  }`;

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

  // WHO IS ON THE CALL, as rows rather than a sentence.
  //
  // The roster is the deterministic half: name, title, and the relationship we
  // have decided from the calls. inTheRoom is the model's half, one line on
  // what that person cares about, joined to the roster by name so a name is
  // printed once. A person the model wrote about who is not on the invite still
  // appears, because the invite is not the only way someone ends up on a call.
  const rosterEntries = (ctx.roster ?? []).filter((r) => r.side === "customer");
  const notes = new Map(
    (briefing.inTheRoom ?? []).map((r) => [String(r.person ?? "").trim().toLowerCase(), String(r.note ?? "").trim()]),
  );
  const noteFor = (name: string): string => {
    const key = name.trim().toLowerCase();
    const direct = notes.get(key);
    if (direct) return direct;
    // The model writes the name it was given, which is usually but not always
    // the invite spelling. Fall back to a first-name or containment match, and
    // never to a positional one: the third row matching the third note is how a
    // briefing tells a rep that the CIO is the one worried about warehousing.
    for (const [person, note] of notes) {
      if (!person || !note) continue;
      if (person.includes(key) || key.includes(person)) return note;
      const [a] = person.split(/\s+/);
      const [b] = key.split(/\s+/);
      if (a && b && a === b && a.length >= 3) return note;
    }
    return "";
  };
  const namedInRoster = new Set(rosterEntries.map((r) => r.name.trim().toLowerCase()));
  const orphanNotes = (briefing.inTheRoom ?? []).filter((r) => {
    const key = String(r.person ?? "").trim().toLowerCase();
    if (!key) return false;
    if (namedInRoster.has(key)) return false;
    return ![...namedInRoster].some((n) => n.includes(key) || key.includes(n));
  });

  const personRow = (name: string, title: string | null, relationship: string | null, note: string) =>
    `<tr><td style="padding:0 0 ${note ? "11px" : "8px"} 0;">
      <div style="font-family:${SANS};font-size:14.5px;line-height:21px;color:${NAVY};font-weight:700;">${escapeHtml(name)}${
        relationship ? relationshipPill(relationship) : ""
      }</div>
      ${title ? `<div style="font-family:${SANS};font-size:13px;line-height:19px;color:${SLATE};margin-top:1px;">${escapeHtml(title)}</div>` : ""}
      ${note ? `<div style="font-family:${SANS};font-size:13.5px;line-height:20px;color:${INK};margin-top:4px;">${escapeHtml(note)}</div>` : ""}
    </td></tr>`;

  const colleagues = (ctx.roster ?? []).filter((r) => r.side === "colleague").map((r) => r.name);
  const mailboxes = (ctx.roster ?? []).filter((r) => r.side === "mailbox").map((r) => r.name);
  const asideLine = (text: string) =>
    `<div style="font-family:${SANS};font-size:12.5px;line-height:19px;color:${MUTED};margin-top:9px;">${escapeHtml(text)}</div>`;

  const rosterBlock =
    rosterEntries.length || orphanNotes.length
      ? `${sub("On the call")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${[
          ...rosterEntries.map((r) => personRow(r.name, r.title, r.relationship, noteFor(r.name))),
          ...orphanNotes.map((r) => personRow(String(r.person), null, null, String(r.note ?? ""))),
        ].join("")}</table>${colleagues.length ? asideLine(`Also from Magaya: ${colleagues.join(", ")}`) : ""}${
          mailboxes.length ? asideLine(`Also copied, shared inboxes rather than people: ${mailboxes.join(", ")}`) : ""
        }`
      : ctx.attendees
        ? `${sub("On the call")}${bodyText(ctx.attendees)}`
        : "";

  // The booking block. Given its own visual weight because it is the fix for the
  // most common failure in the book: a verbal next step that never reaches a
  // calendar. The "say" line is meant to be read aloud, so it is set apart.
  const bookBlock = briefing.bookThis
    ? `${sub("Book this before the call ends", GREEN)}${bodyText(
        `${briefing.bookThis.what}${briefing.bookThis.when ? `, ${briefing.bookThis.when}` : ""}`,
      )}${
        briefing.bookThis.say
          ? `<div style="margin:10px 0 0 0;padding:12px 14px;background:${CHIP_BG};border-left:3px solid ${GREEN};border-radius:6px;font-family:${SANS};font-size:15px;line-height:23px;color:${NAVY};">&ldquo;${esc(briefing.bookThis.say)}&rdquo;</div>`
          : ""
      }`
    : `${sub("Secure this next step")}${bodyText(briefing.nextStepCommitment)}`;

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

  // WHERE IT STANDS, one labelled line per fact.
  //
  // Same sentences it always carried. As a paragraph it was the block most
  // likely to hold the thing that changes how the call opens and the block most
  // likely to be skimmed, because nothing joined its facts except being true.
  const stand = standPoints(briefing.whereItStands);
  const standBlock = stand.length
    ? `${sub("Where it stands")}${bullets(
        stand.map((p) => (p.label ? `<b>${esc(p.label)}</b><br><span style="color:${INK};">${esc(p.point)}</span>` : esc(p.point))),
      )}`
    : "";

  // THE NUMBERS, each one told what it is.
  //
  // "$34,400 per month" answers nothing on its own: is that what they pay
  // CargoWise today, what we quoted, or what they said they could spend? A rep
  // reading an unlabelled figure will say it out loud, so the label is the
  // block and the figure is the detail.
  const numbers = dealNumbers(briefing.theNumbers);
  const numbersBlock = numbers.length
    ? `${sub("The numbers")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${numbers
        .map(
          (n) => `<tr><td style="padding:0 0 10px 0;">
            <div style="font-family:${SANS};font-size:14.5px;line-height:21px;color:${NAVY};">${
              n.label ? `<b>${esc(n.label)}</b>&nbsp; ` : ""
            }${esc(n.value)}</div>
            ${n.note ? `<div style="font-family:${SANS};font-size:13px;line-height:19px;color:${MUTED};margin-top:2px;">${esc(n.note)}</div>` : ""}
          </td></tr>`,
        )
        .join("")}</table>`
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

  // COACHING. In the ACT card, last, because it is about what the rep does and
  // not about what they say. Two lines: what was asked for last time and what
  // happened, then the move that closes it today. Deliberately quiet styling:
  // this is the one block a rep can read as being about them, and a red box
  // around it would turn a reminder into a performance review.
  const coachBlock = briefing.coachThis?.thisTime
    ? `${sub("Last time")}${bodyText(briefing.coachThis.lastTime)}<div style="font-family:${SANS};font-size:15px;line-height:24px;color:${NAVY};font-weight:600;margin-top:7px;">${esc(
        briefing.coachThis.thisTime,
      )}</div>`
    : "";

  // Zero questions is correct on a demo, so the block disappears rather than
  // rendering "Ask these (0)".
  const questionsBlock = briefing.questions?.length
    ? `${sub(`Ask these (${briefing.questions.length})`)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${questionRows}</table>`
    : "";

  const signalCard = briefing.signalFlag
    ? card(`${sub("Signal", RED)}${bodyText(briefing.signalFlag)}`, { bg: RED_SOFT, border: RED_BORDER })
    : "";

  const stack = (blocks: string[]) => blocks.filter(Boolean).join(rule());

  // THE THREE CARDS, in the order this call type wants them.
  //
  // Default is act, say, know. Discovery inverts the last two: the asks on a
  // first real conversation are the output of what we already know, so a rep
  // reading them above the state is reading them blind.
  const CARDS: Record<"act" | "say" | "know", string> = {
    act: stack([
      `${sub("Commit to")}${bodyText(briefing.callObjective)}`,
      bookBlock,
      `${sub("If you don't", RED)}${bodyText(briefing.whatsAtRisk)}`,
      coachBlock,
    ]),
    say: stack([showThisBlock, questionsBlock, forkBlock, doNotBlock]),
    know: stack([openItemsBlock, sinceBlock, standBlock, numbersBlock]),
  };
  const order = shapeForCallType(ctx.callType).cardOrder ?? ["act", "say", "know"];

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

        ${/* THE HEADER CARD.
              Was the account name and then one run-on grey sentence carrying
              the stage and five people with their titles and relationships,
              which wrapped to four lines and read as boilerplate to scroll
              past. The stage and the kind of call are chips, and the people
              are rows. */ ""}
        ${card(
          `<div style="font-family:${SANS};font-size:22px;font-weight:700;line-height:28px;color:${NAVY};margin:0 0 10px 0;">${escapeHtml(ctx.account)}</div>
           <div style="margin:0 0 2px 0;line-height:26px;">${[
             callTypeLabel ? chip(callTypeLabel, { strong: true }) : "",
             chip(stageLabel),
             typeof ctx.minutesUntil === "number" ? chip(`starts in ${ctx.minutesUntil} min`) : "",
           ]
             .filter(Boolean)
             .join("")}</div>
           ${rosterBlock ? `${rule()}${rosterBlock}` : ""}`,
        )}

        ${order.map((k) => (CARDS[k] ? card(CARDS[k]) : "")).join("\n")}

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

  return { subject, html, text: renderText(briefing, ctx, stageLabel, callTypeLabel) };
}

function renderText(
  briefing: MagayaBriefing,
  ctx: BriefingEmailContext,
  stageLabel: string,
  callTypeLabel: string | null,
): string {
  const lines: string[] = [];
  lines.push(`Briefing for next call - ${ctx.account}`);
  lines.push([callTypeLabel, stageLabel].filter(Boolean).join(" - "));
  const roster = (ctx.roster ?? []).filter((r) => r.side === "customer");
  if (roster.length) {
    lines.push("");
    lines.push("ON THE CALL");
    for (const r of roster) {
      lines.push(`- ${r.name}${r.title ? `, ${r.title}` : ""}${r.relationship ? ` (${r.relationship})` : ""}`);
    }
  } else if (ctx.attendees) {
    lines.push(`On the call: ${ctx.attendees}`);
  }
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
  if (briefing.coachThis?.thisTime) {
    lines.push("");
    lines.push("LAST TIME");
    lines.push(briefing.coachThis.lastTime);
    lines.push(briefing.coachThis.thisTime);
  }
  secList(
    "WHAT THEY CARE ABOUT",
    briefing.inTheRoom?.map((r) => `${r.person}: ${r.note}`),
  );
  secList("OPEN ITEMS", [
    ...(briefing.openItems?.us ?? []).map((t) => `We owe: ${t}`),
    ...(briefing.openItems?.them ?? []).map((t) => `They owe: ${t}`),
  ]);
  sec("SINCE LAST CONTACT", briefing.sinceLastContact);
  secList(
    "THE NUMBERS",
    dealNumbers(briefing.theNumbers).map(
      (n) => `${n.label ? `${n.label}: ` : ""}${n.value}${n.note ? ` (${n.note})` : ""}`,
    ),
  );
  secList(
    "WHERE IT STANDS",
    standPoints(briefing.whereItStands).map((p) => (p.label ? `${p.label}: ${p.point}` : p.point)),
  );
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
