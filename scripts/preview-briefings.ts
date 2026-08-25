/**
 * Generate real briefings across several deals and open them in a browser.
 *
 * Uses the PRODUCTION path end to end: resolvePreCallType decides the call type,
 * getDealContext assembles the context, generateBriefingFromState writes it. An
 * earlier version of this script guessed the call type from a title regex and
 * classified Treecorp, a customer, as discovery. A harness that builds its own
 * inputs proves nothing about what a rep receives.
 *
 *   npx tsx scripts/preview-briefings.ts
 *   npx tsx scripts/preview-briefings.ts --deal iff --deal dunavant
 *   npx tsx scripts/preview-briefings.ts --upcoming        only meetings ahead
 *
 * Writes .previews/briefings.html and opens it. That directory is gitignored:
 * Magaya is under NDA and these carry customer names and quotes.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { getDealContext, briefingStateFromContext } from "../lib/deal-context";
import { generateBriefingFromState, type MagayaBriefing } from "../lib/generate-briefing";
import { buildAttendeeContext } from "../lib/attendee-context";
import { resolvePreCallType } from "../lib/call-type-precall";
import { shapeForCallType } from "../lib/briefing-shapes";
import { countBriefingWords } from "../lib/briefing-lint";

const argv = process.argv.slice(2);
const wanted = argv.reduce<string[]>((a, v, i) => (v === "--deal" ? [...a, argv[i + 1]] : a), []);
const upcomingOnly = argv.includes("--upcoming");
const DEFAULT = ["dunavant", "iff", "ghy", "cargocleared", "ativzla", "protrans"];

type Card = {
  account: string;
  stage: string;
  type: string;
  typeReason: string;
  typeSource: string;
  meeting: string;
  when: string;
  words: number;
  budget: number;
  b: MagayaBriefing;
};

const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

function render(cards: Card[]): string {
  const section = (title: string, body: string) =>
    body ? `<section><h3>${esc(title)}</h3>${body}</section>` : "";
  const p = (v: unknown) => (v ? `<p>${esc(v)}</p>` : "");
  const ul = (xs: unknown[] | null | undefined, f: (x: never) => string) =>
    xs && xs.length ? `<ul>${xs.map((x) => `<li>${f(x as never)}</li>`).join("")}</ul>` : "";

  const cardHtml = cards.map((c) => {
    const over = c.words > c.budget;
    return `
<article>
  <header>
    <h2>${esc(c.account)}</h2>
    <div class="meta">
      <span class="pill">${esc(c.type)}</span>
      <span>${esc(c.stage)}</span>
      <span>${esc(c.meeting)} ${esc(c.when)}</span>
      <span class="${over ? "over" : "ok"}">${c.words} / ${c.budget} words</span>
    </div>
    <div class="why">call type from <b>${esc(c.typeSource)}</b>: ${esc(c.typeReason)}</div>
  </header>
  ${section("Commit to", p(c.b.callObjective))}
  ${section("If you don't", p(c.b.whatsAtRisk))}
  ${section("In the room", ul(c.b.inTheRoom, (x: { person: string; note: string }) => `<b>${esc(x.person)}</b> &middot; ${esc(x.note)}`))}
  ${section("Open items", [
    c.b.openItems?.us?.length ? `<div class="owe"><span>we owe</span>${ul(c.b.openItems.us, (x: string) => esc(x))}</div>` : "",
    c.b.openItems?.them?.length ? `<div class="owe"><span>they owe</span>${ul(c.b.openItems.them, (x: string) => esc(x))}</div>` : "",
  ].join(""))}
  ${section("Since last contact", p(c.b.sinceLastContact))}
  ${section("The numbers", ul(c.b.theNumbers, (x: string) => esc(x)))}
  ${section("Where it stands", p(c.b.whereItStands))}
  ${section("Show this", ul(c.b.showThis, (x: { item: string; why: string }) => `<b>${esc(x.item)}</b><br><span class="dim">${esc(x.why)}</span>`))}
  ${section("Ask", ul(c.b.questions, (x: { ask: string; why: string }) => `${esc(x.ask)}<br><span class="dim">${esc(x.why)}</span>`))}
  ${section("If they say", ul(c.b.fork?.branches, (x: { ifThey: string; then: string }) => `<b>${esc(x.ifThey)}</b> &rarr; ${esc(x.then)}`))}
  ${section("Do not", p(c.b.doNotDo))}
  ${section("Next step", p(c.b.nextStepCommitment))}
  ${c.b.signalFlag ? `<div class="flag">${esc(c.b.signalFlag)}</div>` : ""}
</article>`;
  }).join("");

  return `<!doctype html><meta charset=utf-8><title>DealRipe briefings</title><style>
:root{--ink:#111;--dim:#3f4652;--line:#e5e7eb;--accent:#1d4ed8;--warn:#b45309;--bg:#fafafa}
*{box-sizing:border-box}
body{margin:0;padding:28px;background:var(--bg);color:var(--ink);
 font:16px/1.6 -apple-system,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
h1{font-size:17px;letter-spacing:.4px;text-transform:uppercase;color:var(--dim);margin:0 0 18px}
article{background:#fff;border:1px solid var(--line);border-radius:10px;padding:22px 24px;margin:0 auto 20px;max-width:760px}
header{border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:6px}
h2{margin:0 0 6px;font-size:20px;letter-spacing:-.3px}
.meta{display:flex;gap:11px;flex-wrap:wrap;align-items:center;font-size:13.5px;color:var(--dim)}
.pill{background:var(--accent);color:#fff;border-radius:99px;padding:2px 9px;font-weight:600;letter-spacing:.3px}
.ok{color:#15803d}.over{color:var(--warn);font-weight:600}
.why{font-size:13px;color:var(--dim);margin-top:8px}
section{margin-top:15px}
h3{font-size:11.5px;letter-spacing:1.1px;text-transform:uppercase;color:var(--dim);margin:0 0 5px;font-weight:700}
p{margin:0}
ul{margin:0;padding-left:17px}li{margin-bottom:5px}
.dim{color:var(--dim);font-size:15px}
.owe{margin-bottom:8px}
.owe>span{display:inline-block;font-size:11.5px;letter-spacing:.8px;text-transform:uppercase;color:var(--warn);font-weight:700;margin-bottom:3px}
.flag{margin-top:16px;padding:11px 14px;background:#fffbeb;border-left:3px solid var(--warn);border-radius:4px;font-size:15px;color:#78350f}
@media (prefers-color-scheme:dark){
 .flag{color:#fbbf24}
 :root{--ink:#e9ebef;--dim:#c2c7d0;--line:#2b2b30;--bg:#0b0b0c}
 article{background:#141416}.flag{background:#1c1917}}
</style>
<h1>DealRipe pre-call briefings &middot; ${cards.length} deal(s)</h1>
${cardHtml}`;
}

(async () => {
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const deals = await db.from("deals").select("id, account, outcome_label").eq("tenant_id", tenantId);
  const all = (deals.data ?? []) as Array<{ id: string; account: string; outcome_label: string | null }>;
  const picks = (wanted.length ? wanted : DEFAULT)
    .map((n) => all.find((d) => d.account.toLowerCase().includes(n.toLowerCase())))
    .filter((d): d is (typeof all)[number] => !!d);

  const cards: Card[] = [];
  for (const d of picks) {
    const calls = await db
      .from("calls")
      .select("scheduled_start, participants, outcome, title")
      .eq("deal_id", d.id)
      .order("scheduled_start");
    const cs = (calls.data ?? []) as Array<{ scheduled_start: string; participants: unknown; outcome: string | null; title: string | null }>;
    const ahead = cs.find((c) => Date.parse(c.scheduled_start) > Date.now());
    const meeting = ahead ?? (upcomingOnly ? undefined : cs[cs.length - 1]);
    if (!meeting) { console.log(`  ${d.account}: no upcoming meeting, skipped`); continue; }

    const ctx = await getDealContext(tenantId, d.id, { withEmailBodies: true });
    if (!ctx) { console.log(`  ${d.account}: no context`); continue; }

    // The real resolver, on the real invite title.
    const callType = await resolvePreCallType({
      tenantId,
      dealId: d.id,
      subject: meeting.title,
      beforeIso: meeting.scheduled_start,
    });
    const shape = shapeForCallType(callType.type);

    const ac = buildAttendeeContext({
      thisMeeting: (Array.isArray(meeting.participants) ? meeting.participants : []) as never,
      priorCallAttendees: cs
        .filter((c) => c.outcome === "captured" && c !== meeting)
        .map((c) => (Array.isArray(c.participants) ? c.participants : [])) as never,
      internalDomain: "magaya.com",
    });

    process.stdout.write(`  ${d.account.padEnd(22)} ${callType.type.padEnd(18)} `);
    const b = await generateBriefingFromState({
      ...briefingStateFromContext(ctx),
      attendeeContext: ac.lines.join("\n"),
      meetingSubject: meeting.title,
      meetingDate: meeting.scheduled_start?.slice(0, 10) ?? null,
      callType,
    });
    if (!b) { console.log("SUPPRESSED"); continue; }
    const words = countBriefingWords(b);
    console.log(`${words} words`);
    cards.push({
      account: d.account,
      stage: ctx.effectiveStageKey,
      type: callType.type,
      typeReason: callType.reason,
      typeSource: callType.source,
      meeting: meeting.title ?? "(untitled)",
      when: meeting.scheduled_start?.slice(0, 10) ?? "",
      words,
      budget: shape.maxWords,
      b,
    });
  }

  mkdirSync(".previews", { recursive: true });
  const out = ".previews/briefings.html";
  writeFileSync(out, render(cards), "utf8");
  console.log(`\n  wrote ${out} (${cards.length} briefing(s))`);
  execFile("open", [out], () => {});
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
