import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/AppShell";
import { ExtractView } from "@/components/ExtractView";
import { MagayaOpportunityControl } from "@/components/MagayaOpportunityControl";
import { TenantExtractView } from "@/components/TenantExtractView";
import { deriveDealState } from "@/lib/deal-state";
import { getDealHistory } from "@/lib/deal-history";
import { DEMO_DR_PROB } from "@/lib/forecast-room";
import { getFrameworkForDeal } from "@/lib/framework";
import { frameworkProgress } from "@/lib/framework-stages";
import { repDisplayName } from "@/lib/pilot-config";
import { getDealById, getStageForDeal } from "@/lib/seed-data";
import { getTranscriptById } from "@/lib/seed-transcript";
import { supabaseAdmin } from "@/lib/supabase";
import { getDealForTenant } from "@/lib/supabase-queries";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";
import { DEFAULT_TENANT_SLUG, pipelineHref, withTenant } from "@/lib/tenant-nav";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGE_LABELS: Record<string, string> = {
  SQL0: "Lead",
  SQL1: "Develop Opportunity",
  SQL2: "Solution Finalization",
  SQL3: "Proposal Validation",
  SQL4: "Negotiations",
  SQL5: "Agreement Formalization",
};
const CRM_SECTIONS = new Set(["Situation", "Timeline", "Budget", "Competition", "People"]);

function quarterLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}
function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
function forecastLine(pct: number, iso: string | null): string {
  const q = quarterLabel(iso);
  const s = shortDate(iso);
  return `${pct}% probability${q ? ` · ${q} close` : ""}${s ? ` · ${s}` : ""}`;
}

async function renderTenantExtract(id: string, tenantSlug: string, callId: string | undefined) {
  const tenantId = await resolveTenantId(tenantSlug);
  const deal = await getDealForTenant(tenantId, id);
  if (!deal) return null;
  const framework = await getFrameworkForDeal(deal.id);
  if (!framework) return null;

  const { confirmed, total } = frameworkProgress(framework, deal.extraction);
  const completion = total > 0 ? confirmed / total : 0;
  const dealState = deriveDealState(framework, deal.extraction, deal.stageKey);

  const repProb = deal.repForecastProbability ?? 0;
  const drProb = DEMO_DR_PROB[deal.account] ?? Math.round(repProb * completion * 100) / 100;
  const repPct = Math.round(repProb * 100);
  const drPct = Math.round(drProb * 100);
  const repClose = deal.repForecastCloseDate || null;
  const drClose =
    drProb < repProb - 0.05 && repClose
      ? new Date(new Date(repClose).getTime() + 45 * 86_400_000).toISOString().slice(0, 10)
      : repClose;

  const reachedRank = dealState.reachedStageKey ? parseInt(dealState.reachedStageKey.match(/(\d+)/)?.[1] ?? "0", 10) : -1;
  const ebRisk = reachedRank >= 3 && deal.contacts.some((c) => c.relationship === "economic_buyer" && !c.lastContactedAt);
  const cat = repProb >= 0.7 ? "Commit" : repProb >= 0.4 ? "Expect" : "Pipeline";

  const flags: string[] = [];
  if (drProb < repProb - 0.1) flags.push(`Rep has this at ${cat}, but only ${confirmed} of ${total} gates are confirmed by the calls.`);
  if (ebRisk) flags.push("The budget owner / economic buyer has never been on a call.");
  if (!dealState.nextStepAnswer) flags.push("No firm next step is captured. Lock a dated mutual action plan.");

  const openGates = dealState.topGaps.slice(0, 6).map((g) => ({ label: g.label }));
  const stakeholder = (() => {
    const eb = deal.contacts.find((c) => c.relationship === "economic_buyer");
    return eb ? { name: eb.name, role: eb.role } : null;
  })();
  const crmFields = (() => {
    const distinct = framework.fields
      .filter((f) => f.stageKey)
      .map((f) => (deal.extraction[f.fieldKey]?.status === "Yes" ? f.label : null))
      .filter((l): l is string => !!l && CRM_SECTIONS.has(l));
    const uniq = Array.from(new Set(distinct));
    return uniq.length > 0 ? uniq : ["Situation", "Budget", "Timeline"];
  })();
  const nextAction = ebRisk
    ? "Get the budget owner into the next call, they have not been in one yet."
    : !dealState.nextStepAnswer
      ? "No firm next step captured. Lock a dated mutual action plan."
      : dealState.topGaps.length > 0
        ? `Close ${dealState.topGaps[0].label} on the next call.`
        : "Well qualified. Confirm timeline and keep momentum.";

  // Resolve the call: prefer the passed id, else the deal's newest call. Falling
  // back keeps the page working when the link carries a stale call id (e.g. the
  // deal page was cached before a re-seed changed the call ids).
  const sortedCalls = [...deal.calls].filter((c) => c.date).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const call = (callId ? deal.calls.find((c) => c.id === callId) : null) ?? sortedCalls[0] ?? deal.calls[0] ?? null;

  let transcript = "";
  if (call) {
    const trRes = await supabaseAdmin().from("transcripts").select("body").eq("call_id", call.id).maybeSingle();
    transcript = (trRes.data?.body as string | undefined) ?? "";
  }
  // Last-resort fallback: any transcript on this deal's calls.
  if (!transcript && deal.calls.length > 0) {
    const ids = deal.calls.map((c) => c.id);
    const trRes2 = await supabaseAdmin().from("transcripts").select("body").in("call_id", ids).limit(1);
    transcript = (trRes2.data?.[0]?.body as string | undefined) ?? "";
  }
  if (!transcript) transcript = "No transcript captured for this call.";
  const callLabel = call?.date ? new Date(call.date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "the latest call";

  const history = await getDealHistory(tenantId, deal.id, framework).catch(() => ({ perGate: {}, timeline: [] }));
  const metaLine = `${deal.industry}${repDisplayName(deal.repEmail) ? ` · ${repDisplayName(deal.repEmail)}'s deal` : ""}`;

  // Open gates at or below the current stage — the gaps the call surfaced, badged
  // NEW GAP (red) in the extracted view.
  const stageRank = (k: string) => parseInt(k.match(/(\d+)/)?.[1] ?? "0", 10);
  const currentRank = stageRank(deal.stageKey);
  const openGateKeys = framework.fields
    .filter((f) => f.stageKey && stageRank(f.stageKey) <= currentRank && deal.extraction[f.fieldKey]?.status !== "Yes")
    .map((f) => f.fieldKey);
  const oc = (highlight: boolean) => (
    <MagayaOpportunityControl
      framework={framework}
      extraction={deal.extraction}
      currentStageKey={deal.stageKey}
      dealId={deal.id}
      capturedByField={history.perGate}
      labelName="Keelson"
      highlightNewCallId={highlight && call ? call.id : undefined}
      newGapKeys={highlight ? openGateKeys : undefined}
    />
  );

  // The notable signals this call surfaced — what DealRipe caught beyond a summary.
  const drCat = drProb >= 0.7 ? "Commit" : drProb >= 0.4 ? "Expect" : "Pipeline";
  const has = (k: string) => deal.extraction[k]?.status === "Yes";
  const ans = (k: string) => {
    const e = deal.extraction[k];
    return e && e.status === "Yes" ? e.answer : "";
  };
  const signals: { label: string; text: string }[] = [];
  if (drProb < repProb - 0.05) signals.push({ label: "Forecast mismatch", text: `the rep has this at ${cat}, but the calls support ${drCat} (${drPct}%).` });
  if (ebRisk && stakeholder) signals.push({ label: "Stakeholder gap", text: `${stakeholder.name} (${stakeholder.role}) is the signer, but has never been on a call.` });
  if (has("close_date_validated")) signals.push({ label: "Timeline", text: `go-live confirmed — ${ans("close_date_validated") || "target date locked"}.` });
  if (has("competition_notes")) signals.push({ label: "Competitor", text: `${ans("competition_notes") || "a competing vendor was named"}.` });
  else if (openGateKeys.includes("competition_notes")) signals.push({ label: "Competitor", text: "no competing vendor surfaced yet — competition gate still open." });
  if (has("budget_range_stated")) signals.push({ label: "Budget", text: `${ans("budget_range_stated") || "budget range stated"}.` });
  const topSignals = signals.slice(0, 5);

  return (
    <AppShell active="deals" tenant={tenantSlug}>
      <div className="min-h-screen bg-bg">
        <main className="max-w-[1200px] mx-auto px-6 py-7">
          <Link
            href={withTenant(`/deals/${deal.id}`, tenantSlug)}
            className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
          >
            <span className="text-base leading-none">←</span> Back to {deal.account}
          </Link>
          <TenantExtractView
            dealName={deal.account}
            metaLine={metaLine}
            arr={deal.arr}
            repForecast={forecastLine(repPct, repClose)}
            drForecast={forecastLine(drPct, drClose)}
            drSofter={drPct < repPct}
            callLabel={callLabel}
            transcript={transcript}
            confirmed={confirmed}
            total={total}
            stakeholder={stakeholder}
            crmFields={crmFields}
            openGates={openGates}
            flags={flags}
            signals={topSignals}
            nextAction={nextAction}
            actionHref={withTenant(`/actions?deal=${deal.id}`, tenantSlug)}
            backHref={withTenant(`/deals/${deal.id}`, tenantSlug)}
            control={oc(false)}
            controlExtracted={oc(true)}
          />
        </main>
      </div>
    </AppShell>
  );
}

export default async function ExtractPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { callId?: string; tenant?: string };
}) {
  const tenant = searchParams.tenant ?? DEFAULT_TENANT_SLUG;

  // Live tenant deal (keelson demo, magaya pilot): render the tenant extract page.
  if (UUID_RE.test(params.id)) {
    const node = await renderTenantExtract(params.id, tenant, searchParams.callId).catch(() => null);
    if (node) return node;
  }

  // Fallback: the original static TopSort demo extract view.
  const deal = getDealById(params.id);
  if (!deal) notFound();
  const stage = getStageForDeal(deal);
  if (!stage) notFound();
  const callId = searchParams.callId;
  const call = deal.calls.find((c) => c.id === callId);
  if (!call) notFound();
  const transcript = getTranscriptById(call.transcriptId);
  if (!transcript) notFound();

  return (
    <div className="min-h-screen bg-bg">
      <main className="max-w-[1200px] mx-auto px-6 py-7">
        <Link href={pipelineHref(tenant)} className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5">
          <span className="text-base leading-none">←</span> Back to {deal.account}
        </Link>
        <ExtractView deal={deal} call={call} initialTranscript={transcript} stage={stage} />
      </main>
    </div>
  );
}
