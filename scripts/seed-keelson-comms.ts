/**
 * Seed the CONTENT layer for the keelson demo tenant: the briefings, recaps,
 * and weekly digest that make DealRipe's differentiator (the content + decision
 * layer on every meeting) visible in the app.
 *
 * For each keelson deal it renders and ARCHIVES (never emails):
 *   - one pre-call briefing (kind "briefing") via the REAL briefing renderer
 *   - one strong post-call recap (kind "recap") authored deterministically from
 *     the deal's captured gates + open gates + prescribed next step, so it always
 *     exists and reads well in the demo (no model dependency).
 * Plus ONE weekly digest for the tenant (kind "digest") via the REAL digest
 * renderer.
 *
 * Guarantees, matching scripts/seed-keelson.ts:
 *   - Scoped: every write is scoped to the keelson tenant_id. Never touches magaya.
 *   - Idempotent: clears keelson's briefing/recap/digest sent_messages first.
 *   - Best-effort: a failure on one deal is logged and skipped, never aborts.
 *
 * Called at the end of scripts/seed-keelson.ts on --apply, and runnable
 * standalone:  npx tsx scripts/seed-keelson-comms.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { briefingStateFromContext, getDealContext } from "../lib/deal-context";
import { renderPreCallBriefingEmail } from "../lib/emails/pre-call-briefing";
import { getForecastRoom } from "../lib/forecast-room";
import { generateBriefingFromState } from "../lib/generate-briefing";
import { getPipelineChanges } from "../lib/pipeline-changes";
import { recordDigestSend } from "../lib/sent-messages";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "keelson";

const STAGE_LABEL: Record<string, string> = {
  SQL0: "Lead",
  SQL1: "Develop Opportunity",
  SQL2: "Solution Finalization",
  SQL3: "Proposal Validation",
  SQL4: "Negotiations",
  SQL5: "Agreement Formalization",
};

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function lower1(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

type Captured = { label: string; answer: string; evidence: string | null };
type OpenGate = { label: string; question: string };

// Compose a believable 2-4 sentence "what happened" from the captured answers.
function narrative(account: string, byKey: Record<string, string>): string {
  const s: string[] = [];
  if (byKey.why_looking) s.push(`${account} is moving to fix ${lower1(byKey.why_looking)}`);
  else s.push(`${account} walked the team through their current operation`);
  if (byKey.existing_systems) s.push(`today they run ${lower1(byKey.existing_systems)}`);
  if (byKey.budget_range_stated) s.push(lower1(byKey.budget_range_stated));
  if (byKey.competition_notes) s.push(`they are also ${lower1(byKey.competition_notes)}`);
  if (byKey.key_decision_maker_identified) s.push(lower1(byKey.key_decision_maker_identified));
  else if (byKey.budget_approver_named) s.push(lower1(byKey.budget_approver_named));
  const body = s.join(". ").replace(/\.\.+/g, ".");
  const close = byKey.next_step_confirmed ? ` The call ended with a commitment: ${lower1(byKey.next_step_confirmed)}.` : "";
  return `${body}.${close}`;
}

function buildRecap(args: {
  account: string;
  stageLabel: string;
  captured: Captured[];
  open: OpenGate[];
  narrativeText: string;
  nextStepTitle: string;
  nextStepDetail: string;
}): { subject: string; html: string; text: string } {
  const { account, stageLabel, captured, open, narrativeText, nextStepTitle, nextStepDetail } = args;
  const capturedRows = captured
    .map(
      (g) => `<tr>
        <td style="padding:7px 0;vertical-align:top;width:22px;color:#16a34a;font-weight:700">&#10003;</td>
        <td style="padding:7px 0">
          <span style="font-weight:600;color:#0f172a">${esc(g.label)}:</span>
          <span style="color:#334155"> ${esc(g.answer)}</span>
          ${g.evidence ? `<div style="color:#94a3b8;font-style:italic;font-size:13px;margin-top:3px">&ldquo;${esc(g.evidence)}&rdquo;</div>` : ""}
        </td></tr>`,
    )
    .join("");
  const openRows = open
    .map(
      (g) => `<tr>
        <td style="padding:6px 0;vertical-align:top;width:22px;color:#ef4444;font-weight:700">&bull;</td>
        <td style="padding:6px 0;color:#334155"><span style="font-weight:600;color:#0f172a">${esc(g.label)}.</span> ${esc(g.question)}</td></tr>`,
    )
    .join("");

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#0f172a;padding:8px 4px">
    <div style="font-weight:800;font-size:16px;margin-bottom:16px"><span style="color:#0f172a">Deal</span><span style="color:#16a34a">Ripe</span></div>
    <div style="font-size:22px;font-weight:700;margin-bottom:3px">Recap &middot; ${esc(account)}</div>
    <div style="color:#64748b;font-size:13px;margin-bottom:20px">${esc(stageLabel)} &middot; ${captured.length} captured &middot; ${open.length} still open</div>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px 18px;margin-bottom:18px">
      <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#64748b;margin-bottom:7px">What happened</div>
      <div style="font-size:14px;line-height:1.65;color:#334155">${esc(narrativeText)}</div>
    </div>
    <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#16a34a;margin:0 0 4px">Captured on this call &middot; written back to Rolldog</div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px">${capturedRows}</table>
    ${
      open.length
        ? `<div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#ef4444;margin:0 0 4px">Still open</div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px">${openRows}</table>`
        : ""
    }
    <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:16px 18px">
      <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#047857;margin-bottom:7px">Recommended next step</div>
      <div style="font-weight:600;font-size:15px;color:#0f172a;margin-bottom:4px">${esc(nextStepTitle)}</div>
      <div style="font-size:14px;line-height:1.65;color:#334155">${esc(nextStepDetail)}</div>
    </div>
  </div>`;

  const text = [
    `Recap · ${account}`,
    `${stageLabel} · ${captured.length} captured · ${open.length} still open`,
    ``,
    `WHAT HAPPENED`,
    narrativeText,
    ``,
    `CAPTURED ON THIS CALL (written back to Rolldog)`,
    ...captured.map((g) => `- ${g.label}: ${g.answer}`),
    ``,
    open.length ? `STILL OPEN\n${open.map((g) => `- ${g.label}. ${g.question}`).join("\n")}\n` : ``,
    `RECOMMENDED NEXT STEP`,
    nextStepTitle,
    nextStepDetail,
  ].join("\n");

  return { subject: `Recap: ${account} call. ${captured.length} captured, ${open.length} still open`, html, text };
}

function money(v: number): string {
  return Math.abs(v) >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v / 1000)}K`;
}
function shortClose(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

type DigestRow = {
  account: string;
  stageLabel: string;
  arr: number;
  closeLabel: string;
  repName: string;
  repCategory: string;
  drCategory: string;
  repPct: number;
  drPct: number;
  deltaPts: number;
  reason: string;
  blockers: string[];
  contact: string | null;
  nextStep: string | null;
  bestRepAction: string | null;
};

// A bespoke Keelson digest: ranked exactly like the Forecast Room (weighted risk),
// with a real header and, for every deal, the overcommit headline (where the rep's
// number runs ahead of what the calls support) plus what the best reps do there.
function buildKeelsonDigest(args: {
  weekLabel: string;
  pipelineTotal: number;
  repWeighted: number;
  drWeighted: number;
  overcommit: number;
  overcommitCount: number;
  rows: DigestRow[];
}): { subject: string; html: string; text: string } {
  const { weekLabel, pipelineTotal, repWeighted, drWeighted, overcommit, overcommitCount, rows } = args;
  const tile = (label: string, value: string, color = "#0f172a") =>
    `<td style="padding:0 14px 0 0;vertical-align:top"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;font-weight:700">${label}</div><div style="font-size:20px;font-weight:800;color:${color};margin-top:3px">${value}</div></td>`;

  const cards = rows
    .map((r) => {
      const softer = r.deltaPts < 0;
      const headline = softer
        ? `<b>${esc(r.repName)} has this at ${esc(r.repCategory)}, DealRipe rates it ${esc(r.drCategory)}.</b> ${esc(r.reason)}`
        : r.deltaPts > 0
          ? `<b>Advancing faster than the rep's number (${esc(r.repCategory)} on the board, DealRipe reads ${esc(r.drCategory)}).</b> ${esc(r.reason)}`
          : esc(r.reason);
      const banner = `<div style="background:${softer ? "#fef2f2" : "#ecfdf5"};border:1px solid ${softer ? "#fecaca" : "#a7f3d0"};border-radius:10px;padding:11px 13px;font-size:13px;line-height:1.55;color:${softer ? "#7f1d1d" : "#065f46"};margin-bottom:12px">${headline}</div>`;
      const blockers = r.blockers.length
        ? `<div style="text-transform:uppercase;letter-spacing:.06em;font-size:10px;font-weight:700;color:#ef4444;margin:10px 0 5px">What's blocking</div><ul style="margin:0;padding-left:16px;font-size:13px;color:#334155;line-height:1.6">${r.blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`
        : "";
      const contact = r.contact ? `<div style="text-transform:uppercase;letter-spacing:.06em;font-size:10px;font-weight:700;color:#64748b;margin:12px 0 4px">Main contact</div><div style="font-size:13px;color:#0f172a">${esc(r.contact)}</div>` : "";
      const onCall = `<div style="text-transform:uppercase;letter-spacing:.06em;font-size:10px;font-weight:700;color:#64748b;margin:12px 0 4px">On the last call</div><div style="font-size:13px;color:${r.nextStep ? "#0f172a" : "#ef4444"}">${r.nextStep ? esc(r.nextStep) : "No next step was agreed on this call."}</div>`;
      const bestRep = r.bestRepAction
        ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 13px;margin-top:13px"><div style="text-transform:uppercase;letter-spacing:.06em;font-size:10px;font-weight:700;color:#16a34a;margin-bottom:4px">What your best reps do here</div><div style="font-size:13px;color:#334155;line-height:1.6">${esc(r.bestRepAction)}</div></div>`
        : "";
      return `<div style="border:1px solid #e2e8f0;border-radius:14px;padding:16px 18px;margin-bottom:14px">
        <div style="font-size:16px;font-weight:700;color:#0f172a">${esc(r.account)}</div>
        <div style="font-size:12px;color:#64748b;margin:2px 0 12px">${esc(r.stageLabel)} &middot; ${money(r.arr)} &middot; rep ${r.repPct}% &rarr; DealRipe ${r.drPct}% &middot; closes ${esc(r.closeLabel)} &middot; ${esc(r.repName)}</div>
        ${banner}${blockers}${contact}${onCall}${bestRep}
      </div>`;
    })
    .join("");

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:660px;margin:0 auto;color:#0f172a;padding:8px 4px">
    <div style="font-weight:800;font-size:16px;margin-bottom:14px"><span style="color:#0f172a">Deal</span><span style="color:#16a34a">Ripe</span></div>
    <div style="font-size:22px;font-weight:700">Pipeline changes</div>
    <div style="color:#64748b;font-size:13px;margin-bottom:16px">Week of ${esc(weekLabel)} &middot; for Keelson RevOps</div>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px 18px;margin-bottom:14px">
      <table style="border-collapse:collapse"><tr>
        ${tile("Pipeline", money(pipelineTotal))}
        ${tile("Rep forecast", money(repWeighted), "#64748b")}
        ${tile("DealRipe forecast", money(drWeighted))}
        ${tile("Overcommit", money(overcommit), "#ef4444")}
      </tr></table>
    </div>
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:13px 16px;font-size:13.5px;line-height:1.55;color:#7f1d1d;margin-bottom:18px">
      Reps carry <b>${money(overcommit)}</b> more than the calls support this week, on ${overcommitCount} deal${overcommitCount === 1 ? "" : "s"} below. Ranked by weighted risk.
    </div>
    <div style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:700;color:#64748b;margin:0 0 10px">Deals to look at</div>
    ${cards}
    <div style="color:#94a3b8;font-size:12px;margin-top:6px">Ranked by weighted risk, from what your calls caught this week. Reply with anything you want tracked.</div>
  </div>`;

  const text = [
    `Pipeline changes — Week of ${weekLabel} — for Keelson RevOps`,
    `Pipeline ${money(pipelineTotal)} · Rep forecast ${money(repWeighted)} · DealRipe ${money(drWeighted)} · Overcommit ${money(overcommit)}`,
    ``,
    ...rows.map((r) => `${r.account} — ${r.stageLabel} · ${money(r.arr)} · rep ${r.repPct}% → DealRipe ${r.drPct}% · ${r.repName}\n${r.deltaPts < 0 ? `${r.repName} has this at ${r.repCategory}, DealRipe rates it ${r.drCategory}. ` : ""}${r.reason}`),
  ].join("\n\n");

  return { subject: `DealRipe pipeline digest, week of ${weekLabel}. ${overcommitCount} to look at`, html, text };
}

export type CommsSeedResult = { briefings: number; recaps: number; digests: number };

export async function seedKeelsonComms(opts?: {
  tenantId?: string;
  apply?: boolean;
  log?: (s: string) => void;
}): Promise<CommsSeedResult> {
  const apply = opts?.apply ?? true;
  const log = opts?.log ?? ((s: string) => console.log(s));
  const tenantId = opts?.tenantId ?? (await resolveTenantId(TENANT_SLUG));
  const db = supabaseAdmin();

  const result: CommsSeedResult = { briefings: 0, recaps: 0, digests: 0 };
  if (!apply) {
    log("  comms: DRY RUN (nothing archived)");
    return result;
  }

  // Idempotent: clear keelson's archived comms first (strictly tenant-scoped).
  const del = await db.from("sent_messages").delete().eq("tenant_id", tenantId).in("kind", ["briefing", "recap", "digest"]);
  if (del.error) log(`  comms: clear sent_messages failed: ${del.error.message}`);

  // Field label/question map for this tenant's framework (for the recap gate names).
  const fieldMeta = new Map<string, { label: string; question: string }>();
  const ff = await db.from("framework_fields").select("field_key, label, question").eq("tenant_id", tenantId);
  for (const r of (ff.data ?? []) as Array<{ field_key: string; label: string; question: string }>) {
    fieldMeta.set(r.field_key, { label: r.label, question: r.question });
  }

  const dealsRes = await db.from("deals").select("id, external_id, account, rep_email, stage_key").eq("tenant_id", tenantId);
  const deals = (dealsRes.data ?? []) as Array<{ id: string; external_id: string | null; account: string; rep_email: string | null; stage_key: string | null }>;

  for (const d of deals) {
    const callRes = await db
      .from("calls")
      .select("id, scheduled_start, call_date, duration_minutes")
      .eq("tenant_id", tenantId)
      .eq("deal_id", d.id)
      .order("call_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const callId = (callRes.data?.id as string | undefined) ?? null;
    const to = d.rep_email ?? "dana@keelson.example";
    // Call start/end, for timing the briefing (before start) and recap (after end)
    // so the Activity coverage reads them as sent on time.
    const startIso = (callRes.data?.scheduled_start as string | undefined) ?? (callRes.data?.call_date as string | undefined) ?? null;
    const durMin = (callRes.data?.duration_minutes as number | undefined) ?? 40;
    const startMs = startIso ? Date.parse(startIso) : null;
    const briefingAt = startMs ? new Date(startMs - 30 * 60_000).toISOString() : null;
    const recapAt = startMs ? new Date(startMs + (durMin + 12) * 60_000).toISOString() : null;

    // --- Pre-call briefing (real renderer) ---
    try {
      const ctx = await getDealContext(tenantId, d.id);
      if (ctx) {
        const briefing = await generateBriefingFromState(briefingStateFromContext(ctx));
        if (briefing) {
          const email = renderPreCallBriefingEmail(briefing, { account: ctx.account, stageKey: ctx.effectiveStageKey, attendees: ctx.attendees });
          await db.from("sent_messages").insert({
            tenant_id: tenantId,
            deal_id: d.id,
            call_id: callId,
            kind: "briefing",
            to_email: to,
            subject: email.subject,
            body_html: email.html,
            body_text: email.text,
            provider_id: `keelson-demo-briefing-${d.external_id ?? d.id}`,
            ...(briefingAt ? { sent_at: briefingAt } : {}),
          });
          result.briefings += 1;
          log(`  briefing archived: ${d.account}`);
        } else {
          log(`  briefing skipped (${d.account}): generation returned null`);
        }
      }
    } catch (err) {
      log(`  briefing failed (${d.account}): ${msg(err)}`);
    }

    // --- Post-call recap (deterministic, authored from captured/open gates) ---
    try {
      const fxRes = await db.from("field_extractions").select("framework_field_key, status, answer, evidence").eq("deal_id", d.id);
      const fx = (fxRes.data ?? []) as Array<{ framework_field_key: string; status: string; answer: string | null; evidence: string | null }>;
      const captured: Captured[] = [];
      const open: OpenGate[] = [];
      const byKey: Record<string, string> = {};
      for (const r of fx) {
        const meta = fieldMeta.get(r.framework_field_key);
        if (r.status === "Yes" && r.answer) {
          captured.push({ label: meta?.label ?? r.framework_field_key, answer: r.answer, evidence: r.evidence });
          byKey[r.framework_field_key] = r.answer;
        } else if (r.status === "No") {
          open.push({ label: meta?.label ?? r.framework_field_key, question: meta?.question ?? "Not yet confirmed on a call." });
        }
      }
      const task = await db.from("tasks").select("title, detail").eq("tenant_id", tenantId).eq("deal_id", d.id).limit(1).maybeSingle();
      const recap = buildRecap({
        account: d.account,
        stageLabel: STAGE_LABEL[d.stage_key ?? ""] ?? d.stage_key ?? "",
        captured,
        open: open.slice(0, 5),
        narrativeText: narrative(d.account, byKey),
        nextStepTitle: (task.data?.title as string | undefined) ?? "Confirm the next step and set a date.",
        nextStepDetail: (task.data?.detail as string | undefined) ?? "",
      });
      await db.from("sent_messages").insert({
        tenant_id: tenantId,
        deal_id: d.id,
        call_id: callId,
        kind: "recap",
        to_email: to,
        subject: recap.subject,
        body_html: recap.html,
        body_text: recap.text,
        provider_id: `keelson-demo-recap-${d.external_id ?? d.id}`,
        ...(recapAt ? { sent_at: recapAt } : {}),
      });
      result.recaps += 1;
      log(`  recap archived: ${d.account} (${captured.length} captured, ${open.length} open)`);
    } catch (err) {
      log(`  recap failed (${d.account}): ${msg(err)}`);
    }
  }

  // --- Weekly digest: ranked like the Forecast Room, with overcommit headlines. ---
  try {
    const untilIso = new Date().toISOString();
    const sinceIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const room = await getForecastRoom(tenantId);
    const pc = await getPipelineChanges(tenantId, { sinceIso, untilIso });

    const blockersByDeal = new Map(pc.deals.map((d) => [d.dealId, (d.blockers ?? []).slice(0, 4)]));
    const nextStepByDeal = new Map(pc.deals.map((d) => [d.dealId, d.agreedNextStep ?? null]));
    const actionByAccount = new Map(room.actions.map((a) => [a.account, a.detail ?? null]));

    const stageRes = await db.from("deals").select("id, stage_key").eq("tenant_id", tenantId);
    const stageByDeal = new Map((stageRes.data ?? []).map((d: { id: string; stage_key: string | null }) => [d.id, d.stage_key]));

    const contactsRes = await db.from("contacts").select("deal_id, name, role, relationship").eq("tenant_id", tenantId);
    const contactByDeal = new Map<string, string>();
    for (const c of (contactsRes.data ?? []) as Array<{ deal_id: string; name: string; role: string | null; relationship: string | null }>) {
      const label = `${c.name}${c.role ? `, ${c.role}` : ""}${c.relationship ? ` (${c.relationship.replace(/_/g, " ")})` : ""}`;
      if (!contactByDeal.has(c.deal_id) || c.relationship === "champion") contactByDeal.set(c.deal_id, label);
    }

    const weekLabel = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/Chicago" });
    const pipelineTotal = room.deals.reduce((s, d) => s + d.arr, 0);
    const overcommitCount = room.deals.filter((d) => d.deltaPts < 0).length;
    const ranked = room.changed.length ? room.changed : room.deals;
    const rows: DigestRow[] = ranked.slice(0, 6).map((d) => ({
      account: d.account,
      stageLabel: STAGE_LABEL[stageByDeal.get(d.dealId) ?? ""] ?? "Open opportunity",
      arr: d.arr,
      closeLabel: shortClose(d.closeDate),
      repName: d.repName,
      repCategory: d.repCategory,
      drCategory: d.drCategory,
      repPct: d.repProbPct,
      drPct: d.drProbPct,
      deltaPts: d.deltaPts,
      reason: d.reason,
      blockers: blockersByDeal.get(d.dealId) ?? [],
      contact: contactByDeal.get(d.dealId) ?? null,
      nextStep: nextStepByDeal.get(d.dealId) ?? d.agreedNextStep ?? null,
      bestRepAction: actionByAccount.get(d.account) ?? null,
    }));

    const email = buildKeelsonDigest({
      weekLabel,
      pipelineTotal,
      repWeighted: room.repWeightedUsd,
      drWeighted: room.drWeightedUsd,
      overcommit: room.overcommitUsd,
      overcommitCount,
      rows,
    });
    const toEmail = deals[0]?.rep_email ?? "revops@keelson.example";
    await recordDigestSend({ tenantId, toEmail, subject: email.subject, html: email.html, text: email.text, providerId: "keelson-demo-digest" });
    result.digests += 1;
    log(`  digest archived (${rows.length} deals, ranked by weighted risk)`);
  } catch (err) {
    log(`  digest failed: ${msg(err)}`);
  }

  return result;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`\nDealRipe keelson comms seed  (${apply ? "APPLY" : "DRY RUN, nothing archived"})\n`);
  const res = await seedKeelsonComms({ apply });
  console.log("");
  if (apply) {
    console.log(`comms seed complete: ${res.briefings} briefings, ${res.recaps} recaps, ${res.digests} digest.`);
    console.log(`View: a deal's Change Log, a meeting page, /digests?tenant=${TENANT_SLUG}`);
    console.log(`Re-run  npx tsx scripts/seed-keelson.ts --apply  afterwards to re-assert the deterministic prescribed actions.`);
  } else {
    console.log("Dry run only. Re-run with --apply to archive the comms.");
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
}
