/**
 * Generate demo strategies and put them beside the ones Eduardo wrote by hand.
 *
 *   npx tsx scripts/compare-demo-strategy.ts
 *
 * Writes .previews/demo-strategy-<deal>.html for each generated document, and
 * .previews/demo-strategy-compare.html holding both versions side by side.
 *
 * The cutoffs are not cosmetic. His Dunavant document says "prepared from the
 * August 12, 2026 discovery call", so generating ours from six later calls and
 * calling it a comparison measures nothing.
 *
 * READ ONLY. Nothing is posted, sent or written to a rep.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { buildDemoStrategyForDeal } from "../lib/demo-strategy";
import { renderDemoStrategyHtml } from "../lib/demo-strategy-html";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SRC = "Context/Magaya/Eduardo Feedback/9_4_2026";
const OUT = ".previews";

/** Deal, the file he wrote, and the date his version was written from. */
const CASES = [
  { match: "Dunavant", label: "Dunavant", his: "Dunavant_Magaya_Recap_Demo_Strategy (2).docx", asOf: "2026-08-12" },
  { match: "Abccargo", label: "ABC Cargo", his: "ABC_Company_Demo_Strategy.docx", asOf: undefined },
  { match: "Kestrel", label: "Kestrel", his: "Kestrel_Recap_Demo_Strategy (1).docx", asOf: undefined },
  { match: null, label: "Aqua Gulf", his: "Aqua Gulf _Magaya_Recap_Demo_Strategy (2).docx", asOf: undefined },
];

/** docx is a zip of XML. Headings become h2 so the two columns read alike. */
function docxToHtml(file: string): string {
  const buf = fs.readFileSync(file);
  // Minimal zip reader: find the deflated word/document.xml entry.
  let xml = "";
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString();
    if (name !== "word/document.xml") continue;
    const start = i + 30 + nameLen + extraLen;
    const method = buf.readUInt16LE(i + 8);
    let size = buf.readUInt32LE(i + 18);
    if (size === 0) size = buf.length - start;
    const raw = buf.subarray(start, start + size);
    try {
      xml = method === 0 ? raw.toString("utf8") : zlib.inflateRawSync(raw).toString("utf8");
    } catch {
      xml = zlib.inflateRawSync(buf.subarray(start)).toString("utf8");
    }
    break;
  }
  if (!xml) return "<p>could not read</p>";

  const out: string[] = [];
  for (const m of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const p = m[1];
    const text = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join("");
    const clean = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    if (!clean) continue;
    const esc = clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (/w:val="Heading[12]"/.test(p)) out.push(`<h2>${esc}</h2>`);
    else if (/<w:numPr>/.test(p)) out.push(`<li>${esc}</li>`);
    else out.push(`<p>${esc}</p>`);
  }
  return out.join("\n").replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const tenantId = await resolveTenantId("magaya");
  const panels: string[] = [];

  for (const c of CASES) {
    let ours = `<p class=none>Not generated. DealRipe holds no transcript for this deal, so there is nothing to build from. Saying so is different from producing a thin document.</p>`;
    let meta = "";

    if (c.match) {
      // Exact account, not a LIKE. "Kestrel " matched nothing while "Kestrel"
      // and "Kestrel Property Group" both exist, and the miss was SILENT: the
      // log line sat inside the if, so a skipped deal looked like a deal that
      // was never configured. Say when a deal is not found.
      const { data } = await supabaseAdmin()
        .from("deals").select("id, account").eq("tenant_id", tenantId).eq("account", c.match).limit(1);
      const deal = (data ?? [])[0] as { id: string; account: string } | undefined;
      if (!deal) {
        console.log(`${c.label}: NO DEAL named exactly "${c.match}"`);
        ours = `<p class=none>No deal named "${c.match}" in this tenant.</p>`;
      }
      if (deal) {
        // Cache the generated document. Each one costs a couple of minutes and
        // the reason to re-run this script is usually the layout, not the
        // content. --fresh forces regeneration.
        const slug = c.label.toLowerCase().replace(/\s+/g, "-");
        const cacheFile = path.join(OUT, `demo-strategy-${slug}.json`);
        const fresh = process.argv.includes("--fresh");
        let res: Awaited<ReturnType<typeof buildDemoStrategyForDeal>>;
        if (!fresh && fs.existsSync(cacheFile)) {
          res = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
          console.log(`${c.label}: reused cached document (--fresh to regenerate)`);
        } else {
          process.stdout.write(`generating ${c.label}${c.asOf ? ` as of ${c.asOf}` : ""}... `);
          res = await buildDemoStrategyForDeal({ dealId: deal.id, asOf: c.asOf });
          if (res.status === "ok") fs.writeFileSync(cacheFile, JSON.stringify(res, null, 2));
        }
        if (res.status === "ok") {
          const html = renderDemoStrategyHtml({
            account: deal.account,
            doc: res.doc,
            preparedFrom: c.asOf
              ? `Prepared from the calls captured on or before ${c.asOf}`
              : `Prepared from every captured call on this deal`,
          });
          fs.writeFileSync(path.join(OUT, `demo-strategy-${slug}.html`), html);
          ours = renderDemoStrategyHtml({ account: deal.account, doc: res.doc, standalone: false,
            preparedFrom: c.asOf ? `Prepared from the calls captured on or before ${c.asOf}` : undefined });
          meta = `${res.sources.transcripts} of ${res.sources.calls} calls, ${res.sources.transcriptChars.toLocaleString()} chars`;
          if (!fs.existsSync(cacheFile) || fresh) console.log(`ok (${meta})`);
        } else {
          ours = `<p class=none>${res.status}: ${res.reason}</p>`;
          console.log(res.status);
        }
      }
    }

    const hisPath = path.join(SRC, c.his);
    const his = fs.existsSync(hisPath) ? docxToHtml(hisPath) : "<p class=none>file not found</p>";

    panels.push(
      `<section><div class=deal><h1>${c.label}</h1>` +
        `<div class=sub>${c.asOf ? `Both versions limited to calls on or before ${c.asOf}. ` : ""}${meta ? `DealRipe read ${meta}.` : ""}</div></div>` +
        `<div class=cols><div class=col><div class=lbl>DealRipe</div><div class=doc>${ours}</div></div>` +
        `<div class=col><div class=lbl>Eduardo, written by hand</div><div class=doc>${his}</div></div></div></section>`,
    );
  }

  const page = `<!doctype html><meta charset=utf-8><title>Demo strategy, DealRipe against Eduardo</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font:13px/1.5 -apple-system,"Helvetica Neue",Arial,sans-serif;color:#111;background:#F4F4F2;padding:22px}
section{margin-bottom:40px}
.deal h1{font-size:21px;letter-spacing:-.3px}
.deal .sub{font-size:12px;color:#555;margin:3px 0 12px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start}
.col{background:#fff;border:1px solid #D6D6D2;border-radius:6px;overflow:hidden}
.lbl{background:#111;color:#fff;padding:7px 14px;font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;position:sticky;top:0}
.doc{padding:16px 18px;max-height:78vh;overflow-y:auto;font-size:12.5px}
.doc h1{font-size:16px;margin-bottom:4px}
.doc h2{font-size:10.5px;letter-spacing:.7px;text-transform:uppercase;margin:14px 0 5px;padding-bottom:3px;border-bottom:1px solid #000}
.doc p{margin-bottom:6px}
.doc ul{list-style:none;margin:0 0 6px}
.doc li{padding:2px 0 2px 12px;position:relative}
.doc li::before{content:"\\2013";position:absolute;left:0}
.doc table{width:100%;border-collapse:collapse;margin-bottom:6px}
.doc td{padding:4px 7px;border-bottom:1px solid #DDD;vertical-align:top}
.doc td.k{font-weight:700;width:130px}
.doc .hd{border-bottom:2px solid #000;padding-bottom:7px;margin-bottom:10px}
.doc .obj{border:2px solid #000;padding:9px 11px;margin-bottom:6px;font-weight:700}
.doc .sess{border:1px solid #000;padding:8px 10px;margin-bottom:7px}
.doc .sess .t{font-weight:700;margin-bottom:3px}
.doc .why{font-size:11.5px;margin-top:5px;padding-top:5px;border-top:1px solid #CCC}
.doc .foot{margin-top:12px;padding-top:7px;border-top:1px solid #000;font-size:11px}
.none{color:#666;font-style:italic}
</style>
<h1 style="font-size:15px;margin-bottom:4px">Demo strategy: DealRipe against the documents Eduardo wrote</h1>
<p style="font-size:12px;color:#555;margin-bottom:22px">Generated ${new Date().toISOString().slice(0, 10)}. Where a cutoff is stated, DealRipe was restricted to the same calls his version was written from.</p>
${panels.join("\n")}`;
  fs.writeFileSync(path.join(OUT, "demo-strategy-compare.html"), page);
  console.log(`\nWrote ${OUT}/demo-strategy-compare.html`);
}

main().catch((e) => { console.error("Unexpected error:", e); process.exit(1); });
