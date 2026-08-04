/**
 * Seed the CONTENT layer for the second-nature demo tenant: the pre-call
 * briefings, post-call recaps, and weekly digest, all authored deterministically
 * (no model dependency) and tuned to NEAT + Salesforce so they read right for a
 * property-management sales team.
 *
 * For each deal:
 *   - a post-call recap (kind "recap") authored from the deal's captured/open
 *     NEAT gates, attached to the most recent recorded call.
 *   - a pre-call briefing (kind "briefing"): if the deal has an UPCOMING call,
 *     the briefing is for that next meeting; otherwise it is attached to the
 *     recorded call (the brief that preceded it).
 * Plus one weekly digest (kind "digest") for the tenant.
 *
 * Scoped to the second-nature tenant, idempotent (clears briefing/recap/digest
 * first), best-effort. Called by seed-second-nature.ts, runnable standalone:
 *   npx tsx scripts/seed-second-nature-comms.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { recordDigestSend } from "../lib/sent-messages";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "second-nature";

// NEAT stage labels for a property-management funnel.
const STAGE_LABEL: Record<string, string> = {
  SQL1: "Discovery",
  SQL2: "Evaluation",
  SQL3: "Vendor of Choice",
  SQL4: "Contract Out",
  SQL5: "Signed",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function money(v: number): string {
  return Math.abs(v) >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v / 1000)}K`;
}

// The best-rep NEAT question to fill each open gate (how your top reps ask it).
const QUESTION_FOR_GATE: Record<string, string> = {
  N1: "Where does your team lose the most time on resident issues that a benefits package would absorb?",
  N2: "What's the make-ready and vacancy cost doing to you per turn right now?",
  E1: "If we lifted retention even two points and cut the filter tickets, what's that worth per door per year across the portfolio?",
  E2: "Which number does ownership judge the portfolio on, and how would this move it? Let's build that one-pager together.",
  A1: "When it's time to sign across the portfolio, who owns that call, and are they aware of this yet?",
  A2: "What would make you comfortable getting the owner on the next 30 minutes with us, introduce us or have us frame the numbers?",
  A3: "Other than you, who has to be a yes for a portfolio-wide rollout, finance included?",
  T1: "What's forcing the timing, the leasing season, a renewal cycle, a portfolio change?",
  T2: "Working back from go-live, when would we need a signature to hit September renewals?",
  T3: "Walk me through how a deal this size gets papered and approved on your side.",
};

// NEAT category for each gate, so the briefing tags each question.
const CATEGORY_FOR_GATE: Record<string, string> = {
  N1: "Need", N2: "Need",
  E1: "Economic Impact", E2: "Economic Impact",
  A1: "Access to Authority", A2: "Access to Authority", A3: "Access to Authority",
  T1: "Timeline", T2: "Timeline", T3: "Timeline",
};

// One-line "why ask / what to listen for" per gate. This is Linus's point: a good
// rep doesn't just fire the question, they've already thought through the answer
// and how to position off it.
const RATIONALE_FOR_GATE: Record<string, string> = {
  N1: "Anchors the pain in their words before any pricing talk. Listen for the turnover or ticket number.",
  N2: "Quantifies make-ready cost so the ROI case writes itself later.",
  E1: "Puts a per-door dollar figure on the table, a hard number, not a pitch. If they don't have it, offer to model it live.",
  E2: "Ties value to the metric ownership already judges the portfolio on. If they name NOI or retention, build the one-pager around that number.",
  A1: "Surfaces the real signer early so you don't spend weeks selling someone who can't buy.",
  A2: "Gets you to the owner without going around your champion. Give them the easy option: introduce us, or let us frame the numbers.",
  A3: "Maps the full yes so finance doesn't veto at signature.",
  T1: "Separates a real compelling event from a soft 'sometime.' If it's leasing season, work back from renewals.",
  T2: "Converts a go-live wish into a signature deadline you can hold the deal to.",
  T3: "Exposes the procurement path so the close date is real, not hopeful.",
};

// Authored "what happened" narratives for the hero deals (others fall back to a
// derived one). This is the paragraph that makes a recap read like a human wrote
// it, not a field dump.
const WHAT_HAPPENED: Record<string, string> = {
  "Rowan Hill Residential":
    "Casey ran the evaluation call with Renee, the ops lead and champion. Renee confirmed the core pain, retention and filter-driven maintenance tickets, and named the compelling event: live before September renewals. But she surfaced the two gaps that decide this deal, no dollar figure on the per-door impact yet, and Greg, the owner who signs, has never been on a call. She's bought in, but after the failed Beagle rollout she needs the numbers tight before she'll take it to him.",
  "Kestrel Property Group":
    "Casey reconnected with Priya on the 352-door evaluation. Need and timeline are solid, but the per-door ROI model Casey promised is six days overdue while Priya has quietly reopened the pricing page twice. The momentum is there; the follow-through is the risk.",
  "Meridian Property Management":
    "Marcus's vendor-of-choice call with Owen slid into the per-door cost-modeling spiral, the exact conversation that has killed six of the last seven upsells here. Economic impact and owner engagement are confirmed, but the close date now predates the real decision.",
};

// Short prescribed move per open NEAT category, for the "your next actions" list.
const MOVE_FOR_CATEGORY: Record<string, string> = {
  Need: "Quantify the resident-experience cost in their own numbers before the next call.",
  "Economic Impact": "Build the per-door impact one-pager and get it in front of the signer.",
  "Access to Authority": "Get the owner or principal into the next working session, before pricing.",
  Timeline: "Pin a real go-live date and work back to a signature deadline.",
};

type FieldMeta = { label: string; question: string };

// NEAT category order for grouped recap sections.
const NEAT_ORDER = ["Need", "Economic Impact", "Access to Authority", "Timeline"];
function neatRank(label: string): number {
  const i = NEAT_ORDER.indexOf(label);
  return i === -1 ? NEAT_ORDER.length : i;
}

function buildRecap(args: {
  account: string;
  stageLabel: string;
  whatHappened: string;
  captured: Array<{ label: string; answer: string; evidence: string | null }>;
  open: Array<{ label: string; question: string }>;
  actions: Array<{ title: string; detail: string; due: string }>;
  nextStepTitle: string;
  nextStepDetail: string;
}): { subject: string; html: string; text: string } {
  const { account, stageLabel, whatHappened, captured, open, actions, nextStepTitle, nextStepDetail } = args;
  // Group captured gates into one section per NEAT category, so the recap reads
  // Need -> Economic Impact -> Access to Authority -> Timeline with bullets,
  // not a flat list that repeats the category on every line.
  const byCat = new Map<string, Array<{ answer: string; evidence: string | null }>>();
  for (const g of [...captured].sort((a, b) => neatRank(a.label) - neatRank(b.label))) {
    const list = byCat.get(g.label) ?? [];
    list.push({ answer: g.answer, evidence: g.evidence });
    byCat.set(g.label, list);
  }
  const capturedRows = Array.from(byCat.entries())
    .map(([cat, items]) => {
      const bullets = items
        .map(
          (it) => `<div style="margin:0 0 8px"><span style="color:#334155">${esc(it.answer)}</span>${it.evidence ? `<div style="color:#94a3b8;font-style:italic;font-size:13px;margin-top:2px">&ldquo;${esc(it.evidence)}&rdquo;</div>` : ""}</div>`,
        )
        .join("");
      return `<tr>
      <td style="padding:9px 0 2px;vertical-align:top;width:22px;color:#16a34a;font-weight:700">&#10003;</td>
      <td style="padding:9px 0 2px"><div style="font-weight:700;color:#0f172a;margin-bottom:4px">${esc(cat)}</div>${bullets}</td></tr>`;
    })
    .join("");
  const openRows = [...open]
    .sort((a, b) => neatRank(a.label) - neatRank(b.label))
    .map(
      (g) => `<tr><td style="padding:6px 0;vertical-align:top;width:22px;color:#ef4444;font-weight:700">&bull;</td>
      <td style="padding:6px 0;color:#334155"><span style="font-weight:600;color:#0f172a">${esc(g.label)}.</span> ${esc(g.question)}</td></tr>`,
    )
    .join("");
  const actionRows = actions
    .map(
      (a) => `<tr><td style="padding:6px 0;vertical-align:top;width:22px;color:#94a3b8">&#9744;</td>
      <td style="padding:6px 0;color:#334155;font-size:14px;line-height:1.55"><b style="color:#0f172a">${esc(a.title)}</b>${a.detail ? ` ${esc(a.detail)}` : ""} <span style="color:#94a3b8">(${esc(a.due)})</span></td></tr>`,
    )
    .join("");
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#0f172a;padding:8px 4px">
    <div style="font-weight:800;font-size:16px;margin-bottom:16px"><span style="color:#0f172a">Deal</span><span style="color:#16a34a">Ripe</span></div>
    <div style="font-size:22px;font-weight:700;margin-bottom:3px">Recap &middot; ${esc(account)}</div>
    <div style="color:#64748b;font-size:13px;margin-bottom:18px">${esc(stageLabel)} &middot; ${captured.length} captured &middot; ${open.length} still open</div>
    ${whatHappened ? `<div style="margin-bottom:18px"><div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#64748b;margin:0 0 5px">What happened</div><div style="font-size:14px;line-height:1.65;color:#334155">${esc(whatHappened)}</div></div>` : ""}
    <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#16a34a;margin:0 0 4px">Captured on this call &middot; written back to Salesforce</div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px">${capturedRows}</table>
    ${open.length ? `<div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#ef4444;margin:0 0 4px">Still open</div><table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px">${openRows}</table>` : ""}
    ${actions.length ? `<div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#64748b;margin:0 0 4px">Your next actions</div><table style="width:100%;border-collapse:collapse;margin-bottom:20px">${actionRows}</table>` : ""}
    <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:16px 18px">
      <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#047857;margin-bottom:7px">Suggested next step</div>
      <div style="font-weight:600;font-size:15px;color:#0f172a;margin-bottom:4px">${esc(nextStepTitle)}</div>
      <div style="font-size:14px;line-height:1.65;color:#334155">${esc(nextStepDetail)}</div>
    </div>
    <div style="font-size:11.5px;color:#94a3b8;margin-top:12px">DealRipe wrote this from your call so you don't have to. Reply to flag anything that looks wrong and I'll fix it.</div>
    </div>`;
  const text = [
    `Recap · ${account}`,
    `${stageLabel} · ${captured.length} captured · ${open.length} still open`,
    ``,
    whatHappened ? `WHAT HAPPENED\n${whatHappened}\n` : ``,
    `CAPTURED (written back to Salesforce)`,
    ...captured.map((g) => `- ${g.label}: ${g.answer}`),
    ``,
    open.length ? `STILL OPEN\n${open.map((g) => `- ${g.label}. ${g.question}`).join("\n")}\n` : ``,
    actions.length ? `YOUR NEXT ACTIONS\n${actions.map((a) => `- ${a.title}${a.detail ? `: ${a.detail}` : ""} (${a.due})`).join("\n")}\n` : ``,
    `SUGGESTED NEXT STEP`,
    nextStepTitle,
    nextStepDetail,
  ].join("\n");
  return { subject: `Recap: ${account} call. ${captured.length} captured, ${open.length} still open`, html, text };
}

function buildBriefing(args: {
  account: string;
  stageLabel: string;
  objective: string;
  whereItStands: string;
  questions: Array<{ category: string; question: string; rationale: string }>;
  secureNextStep: string;
  signal: string;
  risk: string;
}): { subject: string; html: string; text: string } {
  const { account, stageLabel, objective, whereItStands, questions, secureNextStep, signal, risk } = args;
  const qRows = questions
    .map(
      (q, i) => `<tr><td style="padding:9px 0;vertical-align:top;width:22px;color:#64748b;font-family:monospace">${i + 1}.</td>
      <td style="padding:9px 0">
        <div style="color:#0f172a;font-size:14px;line-height:1.5">${esc(q.question)}</div>
        <div style="margin-top:4px">
          <span style="display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#475569;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:5px;padding:1px 6px;margin-right:6px">${esc(q.category)}</span>
          <span style="color:#64748b;font-size:12.5px;line-height:1.5">${esc(q.rationale)}</span>
        </div>
      </td></tr>`,
    )
    .join("");
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#0f172a;padding:8px 4px">
    <div style="font-weight:800;font-size:16px;margin-bottom:16px"><span style="color:#0f172a">Deal</span><span style="color:#16a34a">Ripe</span></div>
    <div style="font-size:22px;font-weight:700;margin-bottom:3px">Pre-call briefing &middot; ${esc(account)}</div>
    <div style="color:#64748b;font-size:13px;margin-bottom:20px">${esc(stageLabel)} &middot; nothing to log into</div>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px 18px;margin-bottom:14px">
      <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#64748b;margin-bottom:6px">Objective</div>
      <div style="font-size:14px;line-height:1.6;color:#334155">${esc(objective)}</div>
    </div>
    <div style="margin-bottom:16px">
      <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#64748b;margin-bottom:5px">Where it stands</div>
      <div style="font-size:13.5px;line-height:1.6;color:#334155">${esc(whereItStands)}</div>
    </div>
    <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#64748b;margin:0 0 4px">Ask these &middot; the moves your best reps make</div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px">${qRows}</table>
    <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:14px 16px;margin-bottom:14px">
      <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#047857;margin-bottom:5px">Secure this next step</div>
      <div style="font-size:14px;line-height:1.6;color:#334155">${esc(secureNextStep)}</div>
    </div>
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:14px 16px;margin-bottom:12px">
      <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#b91c1c;margin-bottom:5px">What's at risk</div>
      <div style="font-size:14px;line-height:1.6;color:#7f1d1d">${esc(risk)}</div>
    </div>
    <div style="border-top:1px solid #e2e8f0;padding-top:10px;font-size:12.5px;color:#64748b;line-height:1.55"><b style="color:#334155">Signal &middot;</b> ${esc(signal)}</div>
    <div style="font-size:11.5px;color:#94a3b8;margin-top:12px">DealRipe built this from the deal history. Sell how you sell; this points at the gaps.</div>
    </div>`;
  const text = [
    `Pre-call briefing · ${account}`,
    `${stageLabel} · nothing to log into`,
    ``,
    `OBJECTIVE`, objective,
    ``,
    `WHERE IT STANDS`, whereItStands,
    ``,
    `ASK THESE (the moves your best reps make)`,
    ...questions.map((q, i) => `${i + 1}. [${q.category}] ${q.question}\n   ${q.rationale}`),
    ``,
    `SECURE THIS NEXT STEP`, secureNextStep,
    ``,
    `WHAT'S AT RISK`, risk,
    ``,
    `SIGNAL: ${signal}`,
  ].join("\n");
  return { subject: `Briefing: ${account} · ${stageLabel}`, html, text };
}

export type CommsSeedResult = { briefings: number; recaps: number; digests: number };

export async function seedSecondNatureComms(opts?: { tenantId?: string; apply?: boolean; log?: (s: string) => void }): Promise<CommsSeedResult> {
  const apply = opts?.apply ?? true;
  const log = opts?.log ?? ((s: string) => console.log(s));
  const tenantId = opts?.tenantId ?? (await resolveTenantId(TENANT_SLUG));
  const db = supabaseAdmin();
  const result: CommsSeedResult = { briefings: 0, recaps: 0, digests: 0 };
  if (!apply) {
    log("  comms: DRY RUN");
    return result;
  }

  const del = await db.from("sent_messages").delete().eq("tenant_id", tenantId).in("kind", ["briefing", "recap", "digest"]);
  if (del.error) log(`  comms: clear failed: ${del.error.message}`);

  const fieldMeta = new Map<string, FieldMeta>();
  const ff = await db.from("framework_fields").select("field_key, label, question").eq("tenant_id", tenantId);
  for (const r of (ff.data ?? []) as Array<{ field_key: string; label: string; question: string }>) fieldMeta.set(r.field_key, { label: r.label, question: r.question });

  const dealsRes = await db.from("deals").select("id, external_id, account, rep_email, stage_key, arr, rep_forecast_probability").eq("tenant_id", tenantId);
  const deals = (dealsRes.data ?? []) as Array<{ id: string; external_id: string | null; account: string; rep_email: string | null; stage_key: string | null; arr: number | null; rep_forecast_probability: number | null }>;

  const nowMs = Date.now();

  for (const d of deals) {
    const to = d.rep_email ?? "casey@secondnature.example";
    const stageLabel = STAGE_LABEL[d.stage_key ?? ""] ?? d.stage_key ?? "";

    // Post-close lifecycle account: onboarding recap, not a qualification recap.
    if (d.account === "Brightline Property Management") {
      const callRes = await db
        .from("calls")
        .select("id, scheduled_start, call_date, duration_minutes")
        .eq("tenant_id", tenantId)
        .eq("deal_id", d.id)
        .order("call_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      const cid = (callRes.data?.id as string | undefined) ?? null;
      const startMs2 = callRes.data?.scheduled_start ? Date.parse(callRes.data.scheduled_start as string) : null;
      const recapAt2 = startMs2 ? new Date(startMs2 + (((callRes.data?.duration_minutes as number | undefined) ?? 24) + 12) * 60_000).toISOString() : null;
      const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#0f172a;padding:8px 4px">
        <div style="font-weight:800;font-size:16px;margin-bottom:16px"><span style="color:#0f172a">Deal</span><span style="color:#16a34a">Ripe</span></div>
        <div style="font-size:22px;font-weight:700;margin-bottom:3px">Onboarding recap &middot; Brightline Property Management</div>
        <div style="color:#64748b;font-size:13px;margin-bottom:20px">Closed won Jul 6 &middot; kickoff held &middot; account-level tracking</div>
        <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#16a34a;margin:0 0 6px">On track</div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:14px">
          <tr><td style="padding:6px 0;width:22px;color:#16a34a;font-weight:700">&#10003;</td><td style="padding:6px 0;color:#334155"><b style="color:#0f172a">Resident notices:</b> going out next week. <span style="color:#94a3b8;font-style:italic">&ldquo;Notices we can send next week.&rdquo;</span></td></tr>
          <tr><td style="padding:6px 0;color:#16a34a;font-weight:700">&#10003;</td><td style="padding:6px 0;color:#334155"><b style="color:#0f172a">Filter schedule:</b> confirmed straightforward for the 228 doors.</td></tr>
        </table>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:14px 16px;margin-bottom:16px">
          <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#b91c1c;margin-bottom:5px">Stalled &middot; sales should re-engage</div>
          <div style="font-size:14px;line-height:1.6;color:#7f1d1d"><b>No one owns the resident and unit data export.</b> Their ops coordinator left two weeks ago and the role was never backfilled. This gates the go-live date, and go-live gates when this revenue actualizes. <span style="font-style:italic">&ldquo;That's the open question... nobody has picked that up yet.&rdquo;</span></div>
        </div>
        <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:14px 16px">
          <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#047857;margin-bottom:5px">Recommended next step</div>
          <div style="font-size:14px;line-height:1.6;color:#334155">Erin re-engages Monica this week with a one-line ask: name the data-export owner, or Second Nature lends a hand with the export directly. Everything else stays on schedule.</div>
        </div></div>`;
      const text = [
        "Onboarding recap · Brightline Property Management",
        "Closed won Jul 6 · kickoff held",
        "",
        "ON TRACK: resident notices (next week), filter schedule (confirmed).",
        "STALLED — SALES RE-ENGAGE: no one owns the resident/unit data export (ops coordinator left, never backfilled). Gates go-live, which gates revenue actualization.",
        "NEXT STEP: Erin asks Monica to name the export owner, or we lend a hand directly.",
      ].join("\n");
      const ins = await db.from("sent_messages").insert({
        tenant_id: tenantId,
        deal_id: d.id,
        call_id: cid,
        kind: "recap",
        to_email: to,
        subject: "Onboarding recap: Brightline. Notices on track, data migration has no owner",
        body_html: html,
        body_text: text,
        provider_id: `sn-demo-recap-${d.external_id ?? d.id}`,
        ...(recapAt2 ? { sent_at: recapAt2 } : {}),
      });
      if (!ins.error) {
        result.recaps += 1;
        log(`  onboarding recap archived: ${d.account}`);
      } else log(`  onboarding recap failed: ${ins.error.message}`);
      continue;
    }

    // Recorded call (extracted) and upcoming call (future, not extracted).
    const callsRes = await db
      .from("calls")
      .select("id, scheduled_start, call_date, duration_minutes, has_been_extracted")
      .eq("tenant_id", tenantId)
      .eq("deal_id", d.id)
      .order("call_date", { ascending: false });
    const calls = (callsRes.data ?? []) as Array<{ id: string; scheduled_start: string | null; call_date: string | null; duration_minutes: number | null; has_been_extracted: boolean | null }>;
    const recorded = calls.find((c) => c.has_been_extracted);
    const upcoming = calls.find((c) => !c.has_been_extracted && c.scheduled_start && Date.parse(c.scheduled_start) > nowMs);

    // Gates for recap + briefing.
    const fxRes = await db.from("field_extractions").select("framework_field_key, status, answer, evidence").eq("deal_id", d.id);
    const fx = (fxRes.data ?? []) as Array<{ framework_field_key: string; status: string; answer: string | null; evidence: string | null }>;
    const captured: Array<{ label: string; answer: string; evidence: string | null }> = [];
    const open: Array<{ label: string; question: string }> = [];
    const openKeys: string[] = [];
    for (const r of fx) {
      const meta = fieldMeta.get(r.framework_field_key);
      if (r.status === "Yes" && r.answer) captured.push({ label: meta?.label ?? r.framework_field_key, answer: r.answer, evidence: r.evidence });
      else if (r.status === "No") {
        open.push({ label: meta?.label ?? r.framework_field_key, question: meta?.question ?? "Not yet confirmed on a call." });
        openKeys.push(r.framework_field_key);
      }
    }
    const task = await db.from("tasks").select("title, detail").eq("tenant_id", tenantId).eq("deal_id", d.id).limit(1).maybeSingle();
    const nextStepTitle = (task.data?.title as string | undefined) ?? "Confirm the next step and set a date.";
    const nextStepDetail = (task.data?.detail as string | undefined) ?? "";

    // Deduped NEAT categories (E1 + E2 both map to "Economic Impact"): shared by
    // the recap and the briefing so both read like a human wrote them.
    const capturedCats = [...new Set(captured.map((g) => g.label))];
    const openCats = [...new Set(open.map((g) => g.label))];
    const repFirst = (d.rep_email ?? "").split("@")[0].split(".")[0];
    const repName = repFirst ? repFirst.charAt(0).toUpperCase() + repFirst.slice(1) : "The rep";
    const whatHappened =
      WHAT_HAPPENED[d.account] ??
      `On the ${stageLabel} call, ${repName} confirmed ${capturedCats.join(", ") || "the core need"}. Still open: ${openCats.join(", ") || "nothing major"}. Next: ${nextStepTitle.charAt(0).toLowerCase() + nextStepTitle.slice(1)}`;
    const actions: Array<{ title: string; detail: string; due: string }> = [];
    if (nextStepTitle) actions.push({ title: nextStepTitle, detail: nextStepDetail, due: "due in 1 day" });
    openCats.slice(0, 2).forEach((cat, i) => actions.push({ title: `Close ${cat}`, detail: MOVE_FOR_CATEGORY[cat] ?? "", due: `due in ${i + 2} days` }));

    // --- Recap on the recorded call ---
    if (recorded) {
      const startMs = recorded.scheduled_start ? Date.parse(recorded.scheduled_start) : recorded.call_date ? Date.parse(recorded.call_date) : null;
      const recapAt = startMs ? new Date(startMs + ((recorded.duration_minutes ?? 30) + 12) * 60_000).toISOString() : null;
      const recap = buildRecap({ account: d.account, stageLabel, whatHappened, captured, open: open.slice(0, 5), actions, nextStepTitle, nextStepDetail });
      const ins = await db.from("sent_messages").insert({
        tenant_id: tenantId,
        deal_id: d.id,
        call_id: recorded.id,
        kind: "recap",
        to_email: to,
        subject: recap.subject,
        body_html: recap.html,
        body_text: recap.text,
        provider_id: `sn-demo-recap-${d.external_id ?? d.id}`,
        ...(recapAt ? { sent_at: recapAt } : {}),
      });
      if (!ins.error) {
        result.recaps += 1;
        log(`  recap archived: ${d.account}`);
      } else log(`  recap failed (${d.account}): ${ins.error.message}`);
    }

    // --- Briefing: for the upcoming meeting if present, else for the recorded call ---
    const briefCall = upcoming ?? recorded;
    if (briefCall) {
      const topGates = (openKeys.length ? openKeys.slice(0, 3) : ["T2", "A2"]);
      const questions = topGates
        .map((k) => ({
          category: CATEGORY_FOR_GATE[k] ?? fieldMeta.get(k)?.label ?? "",
          question: QUESTION_FOR_GATE[k] ?? fieldMeta.get(k)?.question ?? "",
          rationale: RATIONALE_FOR_GATE[k] ?? "",
        }))
        .filter((q) => q.question);
      const objective = nextStepTitle;
      const whereItStands = `${money(d.arr ?? 0)} CARR · ${stageLabel}. Confirmed so far: ${capturedCats.join(", ") || "nothing yet"}. Still open: ${openCats.join(", ") || "none"}.`;
      const risk = openCats.length
        ? `If this call doesn't close ${openCats.join(" and ")}, the deal can't advance cleanly and the ${stageLabel} clock keeps running.`
        : `Keep the momentum: confirm the signing path so nothing slips before go-live.`;
      const signal = openCats.length
        ? `${openCats.join(" and ")} still open. This is the gate for ${stageLabel}; the deal can't move until ${openCats.length === 1 ? "it is" : "they are"} closed on a call.`
        : `All gates confirmed for ${stageLabel}; the next step is procedural, not qualification.`;
      const secureNextStep = nextStepDetail || nextStepTitle;
      const briefing = buildBriefing({ account: d.account, stageLabel, objective, whereItStands, questions: questions.slice(0, 3), secureNextStep, signal, risk });
      const startMs = briefCall.scheduled_start ? Date.parse(briefCall.scheduled_start) : null;
      const briefingAt = startMs ? new Date(startMs - 30 * 60_000).toISOString() : null;
      const ins = await db.from("sent_messages").insert({
        tenant_id: tenantId,
        deal_id: d.id,
        call_id: briefCall.id,
        kind: "briefing",
        to_email: to,
        subject: briefing.subject,
        body_html: briefing.html,
        body_text: briefing.text,
        provider_id: `sn-demo-briefing-${d.external_id ?? d.id}`,
        ...(briefingAt ? { sent_at: briefingAt } : {}),
      });
      if (!ins.error) {
        result.briefings += 1;
        log(`  briefing archived: ${d.account}${upcoming ? " (upcoming)" : ""}`);
      } else log(`  briefing failed (${d.account}): ${ins.error.message}`);
    }
  }

  // --- Weekly digest (grounded in gate completion) ---
  try {
    const rows = [];
    let repWeighted = 0;
    let drWeighted = 0;
    for (const d of deals) {
      const arr = d.arr ?? 0;
      const repProb = d.rep_forecast_probability ?? 0;
      const fxRes = await db.from("field_extractions").select("status").eq("deal_id", d.id).eq("status", "Yes");
      const confirmed = (fxRes.data ?? []).length;
      const completion = Math.min(1, confirmed / 10);
      // DealRipe read: rep probability tempered by how much the calls confirm.
      const drProb = Math.max(0.05, Math.min(repProb, repProb * (0.5 + 0.5 * completion)));
      repWeighted += arr * repProb;
      drWeighted += arr * drProb;
      rows.push({ account: d.account, arr, repPct: Math.round(repProb * 100), drPct: Math.round(drProb * 100), stage: STAGE_LABEL[d.stage_key ?? ""] ?? "", confirmed });
    }
    const overcommit = repWeighted - drWeighted;
    rows.sort((a, b) => b.repPct - b.drPct - (a.repPct - a.drPct));
    const weekLabel = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/Chicago" });
    const cards = rows
      .map(
        (r) => `<div style="border:1px solid #e2e8f0;border-radius:12px;padding:13px 15px;margin-bottom:10px">
        <div style="font-size:15px;font-weight:700">${esc(r.account)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px">${esc(r.stage)} &middot; ${money(r.arr)} CARR &middot; rep ${r.repPct}% &rarr; <b style="color:${r.drPct < r.repPct ? "#ef4444" : "#16a34a"}">DealRipe ${r.drPct}%</b> &middot; ${r.confirmed}/10 gates confirmed</div>
      </div>`,
      )
      .join("");
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:660px;margin:0 auto;color:#0f172a;padding:8px 4px">
      <div style="font-weight:800;font-size:16px;margin-bottom:14px"><span style="color:#0f172a">Deal</span><span style="color:#16a34a">Ripe</span></div>
      <div style="font-size:22px;font-weight:700">Pipeline changes</div>
      <div style="color:#64748b;font-size:13px;margin-bottom:16px">Week of ${esc(weekLabel)} &middot; for Second Nature</div>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:13px 16px;font-size:13.5px;line-height:1.55;color:#7f1d1d;margin-bottom:16px">Reps carry <b>${money(overcommit)}</b> more than the calls confirm this week. Rep forecast ${money(repWeighted)}, DealRipe ${money(drWeighted)}.</div>
      ${cards}</div>`;
    const text = [`Pipeline changes — Week of ${weekLabel} — Second Nature`, `Rep ${money(repWeighted)} · DealRipe ${money(drWeighted)} · Overcommit ${money(overcommit)}`, ``, ...rows.map((r) => `${r.account} — ${r.stage} · ${money(r.arr)} · rep ${r.repPct}% → DealRipe ${r.drPct}%`)].join("\n");
    await recordDigestSend({ tenantId, toEmail: deals[0]?.rep_email ?? "revops@secondnature.example", subject: `DealRipe pipeline digest, week of ${weekLabel}`, html, text, providerId: "sn-demo-digest" });
    result.digests += 1;
    log(`  digest archived`);
  } catch (err) {
    log(`  digest failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`\nDealRipe second-nature comms seed  (${apply ? "APPLY" : "DRY RUN"})\n`);
  const res = await seedSecondNatureComms({ apply });
  console.log(`\ncomms seed: ${res.briefings} briefings, ${res.recaps} recaps, ${res.digests} digest.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
}
