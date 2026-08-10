/**
 * Welcome email for a rep joining the pilot.
 *
 * Rendered in the same visual language as the pre-call briefing on purpose. The
 * first thing a rep sees from DealRipe should look like the thing they will be
 * reading before every call. It also has to send from the same address as the
 * briefings: Outlook's Safe Senders is per address, so marking this one as not
 * junk is what stops the real briefings being filtered.
 *
 * One body size throughout, 15px. The briefing template uses a 13px muted grey
 * for secondary lines, which is fine when a rep is scanning a familiar format
 * but hard to read in a first email that is all new information.
 */

const BG = "#F4F6F9";
const CARD = "#FFFFFF";
const BORDER = "#E7EBF0";
const NAVY = "#0F172A";
const INK = "#1E293B";
const MUTED = "#5B6470";
const GREEN = "#10B981";
const GREEN_SOFT = "#F0FDF7";
const GREEN_BORDER = "#CCEFDF";
const AMBER = "#B45309";
const AMBER_SOFT = "#FFFBEB";
const AMBER_BORDER = "#FDE7B8";

const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const BODY = 15;

export type RenderedEmail = { subject: string; html: string; text: string };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Section heading. Takes raw HTML rather than escaping, because headings carry
 * entities like &middot; and escaping them prints "&MIDDOT;" on the screen.
 */
function label(rawHtml: string, color: string): string {
  return `<div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${color};margin:0 0 12px 0;">${rawHtml}</div>`;
}

function bodyText(text: string): string {
  return `<div style="font-family:${SANS};font-size:${BODY}px;line-height:24px;color:${INK};">${escapeHtml(text)}</div>`;
}

function card(inner: string, opts?: { bg?: string; border?: string }): string {
  const bg = opts?.bg ?? CARD;
  const border = opts?.border ?? BORDER;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;">
    <tr><td style="background:${bg};border:1px solid ${border};border-radius:12px;padding:20px 22px;">${inner}</td></tr>
  </table>`;
}

/** One size, one colour, one sentence per line. */
function bullets(items: ReadonlyArray<string>): string {
  const rows = items
    .map(
      (it, i) => `
      <tr>
        <td valign="top" width="18" style="padding:${i === 0 ? "0" : "12px"} 10px 0 0;font-family:${SANS};font-size:${BODY}px;color:${GREEN};line-height:24px;">&bull;</td>
        <td valign="top" style="padding:${i === 0 ? "0" : "12px"} 0 0 0;font-family:${SANS};font-size:${BODY}px;line-height:24px;color:${INK};">${escapeHtml(it)}</td>
      </tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
}

export type WelcomeEmailContext = {
  firstName?: string;
  crmName?: string;
  fromAddress?: string;
  /**
   * Start of the OAuth flow, /auth/microsoft/connect. Never link /callback:
   * that is where Microsoft returns the user afterwards, and opening it
   * directly fails with a state error that reads like a broken product.
   */
  connectUrl?: string;
};

export function renderWelcomeEmail(ctx: WelcomeEmailContext = {}): RenderedEmail {
  const crm = ctx.crmName ?? "Rolldog";
  const from = ctx.fromAddress ?? "notify@send.dealripe.com";
  const connectUrl = ctx.connectUrl ?? "https://app.dealripe.com/auth/microsoft/connect";
  const subject = "Welcome to DealRipe";
  const greeting = ctx.firstName ? `Hi ${ctx.firstName},` : "Hi,";

  // Says what it does and how, before any of the benefit copy below. A rep who
  // reads only this paragraph should be able to explain DealRipe to a colleague.
  const intro =
    `We're glad to have you on. DealRipe joins your customer calls, listens, and then handles everything around them: getting you ready beforehand, writing up what was said afterwards, drafting your follow-up email, and keeping ${crm} current. What you get back is the time that usually disappears into prep and paperwork.`;

  const onCall = [
    "Jot down whatever you want, or nothing at all. Either way the full detail is captured, so you can give the customer your attention rather than your notepad.",
    "Nothing gets lost because you were still writing down the last thing they said. The number mentioned in passing, the name of the person who actually signs, all of it is there afterwards.",
    "You catch the buying signals you would otherwise hear a beat too late, because you are listening instead of transcribing.",
  ];

  const before = [
    "Walk in prepared in two minutes instead of fifteen. No hunting through the CRM for what the BDR wrote.",
    "You know exactly where the deal stands, in the customer's own words from the last call, so you never have to ask them to repeat themselves.",
    "You see what is still missing on the deal before you are on the call, not after: budget, timing, who signs, who else they are looking at.",
    "You get three questions that close those gaps, and the one commitment worth leaving the call with.",
  ];

  const after = [
    "Minutes after you hang up, you have a clean read on what was covered, while it is all still fresh.",
    "Everything they confirmed is captured in their own words, so nothing important depends on how well you remembered it.",
    "You can see what is still missing on the deal, which tells you what the next call has to close before you book it.",
    "What you committed to comes back to you with dates on it, so nothing slips through a busy week.",
  ];

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">Notes taken for you, briefings before your calls, recaps after, and your ${escapeHtml(crm)} fields filled in.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:26px 0;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
      <tr><td style="padding:0 20px;">

        <div style="font-family:${SANS};font-size:12px;font-weight:700;margin:0 0 14px 2px;">
          <span style="color:${NAVY};">Deal</span><span style="color:${GREEN};">Ripe</span>
        </div>

        <div style="font-family:${SANS};font-size:20px;font-weight:700;color:${NAVY};margin:0 0 6px 2px;">Welcome to DealRipe</div>
        <div style="font-family:${SANS};font-size:${BODY}px;line-height:23px;color:${MUTED};margin:0 0 18px 2px;">Everything arrives by email. There is no new tool to log into.</div>

        ${card(`${bodyText(greeting)}<div style="height:12px;"></div>${bodyText(intro)}`)}

        ${card(
          `${label("Step 1 &middot; Connect your calendar", GREEN)}
           ${bodyText("One minute, once, and then you never think about it again. Everything below starts arriving on its own.")}
           <div style="height:18px;"></div>
           <a href="${escapeHtml(connectUrl)}" style="display:inline-block;font-family:${SANS};font-size:${BODY}px;font-weight:600;color:#FFFFFF;background:${GREEN};border-radius:8px;padding:12px 22px;text-decoration:none;">Connect my calendar</a>`,
          { bg: GREEN_SOFT, border: GREEN_BORDER },
        )}

        ${card(`${label("Be fully present on every call", MUTED)}${bullets(onCall)}`)}

        ${card(`${label("Walk into every call already prepared", MUTED)}${bullets(before)}`)}

        ${card(`${label("Know where the deal stands the moment the call ends", MUTED)}${bullets(after)}`)}

        ${card(
          `${label("The follow-up email is already waiting for you", MUTED)}${bodyText(
            "Open your Outlook drafts after a call and the follow-up is sitting there, in your voice, about what you actually agreed. It has already checked your calendar, so the times it offers are ones you are free. Change what you want and hit send. It never goes to your customer without you.",
          )}`,
        )}

        ${card(
          `${label(`${escapeHtml(crm)} updates itself`, GREEN)}${bodyText(
            `Budget, timeline, competitors, who decides, next steps. The subfields you would sit down and type after every call are already filled in from what was said, so your pipeline is current without you spending an evening on it. Nothing is final until you have looked at it.`,
          )}`,
          { bg: GREEN_SOFT, border: GREEN_BORDER },
        )}

        ${card(
          `${label("One thing to do right now", AMBER)}${bodyText(
            `Find this email and mark it as not junk. It may have landed in your Junk folder rather than your inbox, and if it stays filtered you will not receive any of the above. Everything comes from ${from}, so marking this one is enough.`,
          )}`,
          { bg: AMBER_SOFT, border: AMBER_BORDER },
        )}

        <div style="font-family:${SANS};font-size:${BODY}px;line-height:24px;color:${INK};margin:10px 2px 0 2px;">
          See you on the call.
          <div style="height:14px;"></div>
          Maanit Sharma<br/>
          <span style="color:${MUTED};">Founder, DealRipe</span>
          <div style="height:16px;"></div>
          <span style="color:${MUTED};">P.S. Reply to any DealRipe email and it comes straight to me. If something looks wrong, or you want it to do something it does not yet do, tell me and I will fix it.</span>
        </div>

      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    "DealRipe",
    "",
    "Welcome to DealRipe",
    "Everything arrives by email. There is no new tool to log into.",
    "",
    greeting,
    "",
    intro,
    "",
    "STEP 1 - CONNECT YOUR CALENDAR",
    "One minute, once, and then you never think about it again.",
    connectUrl,
    "",
    "BE FULLY PRESENT ON EVERY CALL",
    ...onCall.map((s) => `  - ${s}`),
    "",
    "WALK INTO EVERY CALL ALREADY PREPARED",
    ...before.map((s) => `  - ${s}`),
    "",
    "KNOW WHERE THE DEAL STANDS THE MOMENT THE CALL ENDS",
    ...after.map((s) => `  - ${s}`),
    "",
    "THE FOLLOW-UP EMAIL IS ALREADY WAITING FOR YOU",
    "Open your Outlook drafts after a call and the follow-up is sitting there, in",
    "your voice, about what you actually agreed. It has already checked your",
    "calendar, so the times it offers are ones you are free. Change what you want",
    "and hit send. It never goes to your customer without you.",
    "",
    `${crm.toUpperCase()} UPDATES ITSELF`,
    "Budget, timeline, competitors, who decides, next steps. The subfields you",
    "would sit down and type after every call are already filled in, so your",
    "pipeline is current without you spending an evening on it.",
    "",
    "ONE THING TO DO RIGHT NOW",
    `Find this email and mark it as not junk. Everything comes from ${from},`,
    "so marking this one is enough.",
    "",
    "See you on the call.",
    "",
    "Maanit Sharma",
    "Founder, DealRipe",
    "",
    "P.S. Reply to any DealRipe email and it comes straight to me. If something",
    "looks wrong, or you want it to do something it does not yet do, tell me and",
    "I will fix it.",
  ].join("\n");

  return { subject, html, text };
}
