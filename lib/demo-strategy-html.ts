/**
 * The demo strategy as the document that actually gets delivered.
 *
 * Salesforce ContentNote takes limited HTML, and a solution engineer often
 * wants a file rather than a note, so one renderer produces both: the note body
 * and a standalone page that prints to PDF. The plain-text renderer in
 * lib/demo-strategy.ts stays for the note fallback and for diffing.
 */

import type { DemoStrategyDoc } from "./demo-strategy";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The DealRipe palette, taken from lib/emails/general-recap.ts so this reads as
 * the same product as the recap a rep already gets every day: #10B981 as the
 * wordmark green, #0F172A ink, #F4F6F9 ground, white cards on #E7EBF0 at a 12px
 * radius, #5B6470 muted, #B45309 for anything the reader has to act on.
 *
 * NOT the 600px email width. The recap is an email; this is a five to six page
 * document that a solution engineer reads and prints, so it keeps document
 * measure and borrows the colour and type system rather than the layout.
 *
 * print-color-adjust because the section colour IS the information here: green
 * marks what is going for the deal, amber marks what must be resolved first,
 * and a printer that helpfully drops backgrounds would erase that distinction.
 */
const CSS = `@page{size:letter;margin:0.45in}
*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font:9.5pt/1.46 -apple-system,"Helvetica Neue",Segoe UI,Arial,sans-serif;color:#0F172A;background:#F4F6F9;padding:10pt}
.wrap{max-width:7.4in;margin:0 auto}
.mark{font-size:9pt;font-weight:700;letter-spacing:.10em;text-transform:uppercase;color:#10B981}
h1{font-size:18pt;font-weight:700;color:#0F172A;margin-top:3pt;letter-spacing:-.3pt}
.sub{font-size:9.5pt;color:#5B6470;margin-top:2pt;margin-bottom:10pt}
.obj{background:#FFFFFF;border:1.5pt solid #10B981;border-radius:9pt;padding:10pt 13pt;margin-bottom:9pt;font-size:11pt;font-weight:700;line-height:1.42;color:#0F172A;page-break-inside:avoid}
.obj .l{display:block;font-size:8.5pt;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#047857;margin-bottom:5pt}
.card{background:#FFFFFF;border:1pt solid #E7EBF0;border-radius:9pt;padding:9pt 12pt;margin-bottom:7pt}
.card>.l{font-size:8.5pt;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#5B6470;margin-bottom:6pt;page-break-after:avoid}
.card.warn{border-color:#F0D9B5;background:#FFFDF8}
.card.warn>.l{color:#B45309}
.card.good{border-color:#C7EBDC;background:#F8FDFB}
.card.good>.l{color:#047857}
p{margin-bottom:6pt}
ul{list-style:none}
li{padding:2.5pt 0 2.5pt 13pt;position:relative;line-height:1.5}
li::before{content:"";position:absolute;left:2pt;top:8.5pt;width:4pt;height:4pt;border-radius:50%;background:#CBD5E1}
.warn li::before{background:#B45309}
.good li::before{background:#10B981}
table{width:100%;border-collapse:collapse;font-size:9.5pt}
td{padding:4pt 8pt 4pt 0;border-bottom:1pt solid #F1F5F9;vertical-align:top;line-height:1.48}
td.k{font-weight:700;width:148pt;color:#1E293B}
tr:last-child td{border-bottom:none}
.sess{border:1pt solid #E7EBF0;border-left:4pt solid #10B981;border-radius:7pt;padding:11pt 13pt;margin-bottom:9pt;background:#FFFFFF;page-break-inside:avoid}
.sess .t{font-size:12.5pt;font-weight:700;color:#0F172A;margin-bottom:7pt;letter-spacing:-.15pt;line-height:1.3}
.sess .t span{font-weight:600;font-size:9pt;color:#047857}
.sess .n{color:#10B981}
.sess .why{font-size:8.8pt;color:#5B6470;margin-top:6pt;padding-top:6pt;border-top:1pt solid #F1F5F9}
.sess .why b{color:#1E293B}
.seclabel{font-size:8.5pt;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#5B6470;margin:12pt 0 7pt 2pt;page-break-after:avoid}
.note{font-size:9pt;color:#5B6470;margin:-3pt 0 7pt 2pt}
.foot{margin-top:10pt;font-size:8.5pt;color:#94A3B8;line-height:1.5}`;

type Tone = "" | "warn" | "good";

function list(title: string, items: string[], tone: Tone = ""): string {
  if (items.length === 0) return "";
  return (
    `<div class="card${tone ? ` ${tone}` : ""}"><div class=l>${esc(title)}</div>` +
    `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>`
  );
}

function rows(title: string, rs: Array<[string, string]>): string {
  if (rs.length === 0) return "";
  return (
    `<div class=card><div class=l>${esc(title)}</div><table>` +
    rs.map(([k, v]) => `<tr><td class=k>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("") +
    `</table></div>`
  );
}

export function renderDemoStrategyHtml(args: {
  account: string;
  doc: DemoStrategyDoc;
  preparedFrom?: string;
  standalone?: boolean;
}): string {
  const d = args.doc;
  const p: string[] = [];

  p.push(
    `<div class=mark>DealRipe</div>` +
      `<h1>${esc(args.account)} demo strategy</h1>` +
      `<div class=sub>${esc(args.preparedFrom ?? "Written from every captured call on this deal")}</div>`,
  );

  if (d.objective) p.push(`<div class=obj><span class=l>Objective</span>${esc(d.objective)}</div>`);

  p.push(rows("Call attendees", d.attendees.map((a) => [a.name, `${a.role}. ${a.controls}`] as [string, string])));
  p.push(rows("Magaya team", d.ourTeam.map((a) => [a.name, a.role] as [string, string])));
  p.push(list("Company overview", d.companyOverview));
  p.push(rows("Volumes", d.volumes.map((v) => [v.label, v.value] as [string, string])));
  p.push(
    rows(
      "Current system landscape",
      d.systemLandscape.map((s) => {
        const cur = s.current.replace(/\s*\.\s*$/, "");
        return [s.area, `${cur}${s.note ? `. ${s.note}` : ""}`] as [string, string];
      }),
    ),
  );
  p.push(list("Strategic goals", d.strategicGoals));
  p.push(list("Interests, not yet requirements", d.interests));
  p.push(list("Competitive position", d.competitive));
  p.push(list("Pricing signals", d.pricingSignals));

  if (d.sessions.length > 0) {
    p.push(`<div class=seclabel>Recommended demo strategy</div>`);
    if (d.buildsOnRepPlan) {
      p.push(`<p class=note>This builds on the plan the rep already proposed on the call.</p>`);
    }
    d.sessions.forEach((s, i) => {
      p.push(
        `<div class=sess><div class=t><span class=n>${i + 1}.</span> ${esc(s.name)}` +
          (s.minutes ? ` <span>(~${s.minutes} min)</span>` : "") +
          `</div><ul>${s.cover.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` +
          (s.why ? `<div class=why><b>Why:</b> ${esc(s.why)}</div>` : "") +
          `</div>`,
      );
    });
  }

  p.push(list("What to avoid", d.skip, "warn"));
  p.push(list("Resolve before the demo", d.validateInternally, "warn"));
  p.push(list("Risks", d.risks, "warn"));
  p.push(list("Deal strengths", d.strengths, "good"));
  for (const sec of d.additionalSections) p.push(list(sec.title, sec.items));
  if (d.positioning) p.push(`<div class=card><div class=l>Positioning</div><p>${esc(d.positioning)}</p></div>`);
  if (d.recommendation) p.push(`<div class=card><div class=l>Recommendation</div><p>${esc(d.recommendation)}</p></div>`);

  p.push(
    `<div class=foot>Written by DealRipe from every captured call on this deal. ` +
      `Facts are drawn from what the customer said; nothing here is inferred from an absent answer.</div>`,
  );

  const body = `<div class=wrap>\n${p.filter(Boolean).join("\n")}\n</div>`;
  return args.standalone === false
    ? body
    : `<!doctype html><meta charset=utf-8><title>Demo strategy, ${esc(args.account)}</title><style>${CSS}</style>\n${body}\n`;
}
