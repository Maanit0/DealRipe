import Link from "next/link";
import { notFound } from "next/navigation";
import type { ExtractionMap } from "@/lib/briefing-magaya";
import { MagayaBriefingView } from "@/components/MagayaBriefingView";
import { PrepareBriefingView } from "@/components/PrepareBriefingView";
import { getFrameworkForDeal } from "@/lib/framework";
import { attendeesFrom, generateBriefingFromState } from "@/lib/generate-briefing";
import { rolldogOppIdForDeal } from "@/lib/pilot-config";
import { getRolldogSummary, stageKeyFromSummary } from "@/lib/rolldog-summary";
import { getDealById, getStageForDeal } from "@/lib/seed-data";
import { supabaseAdmin } from "@/lib/supabase";
import { getDealForTenant } from "@/lib/supabase-queries";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadLiveMagayaDeal(id: string) {
  try {
    const tenantId = await resolveTenantId("magaya");
    const deal = await getDealForTenant(tenantId, id);
    if (!deal) return null;
    const framework = await getFrameworkForDeal(deal.id);
    if (!framework) return null;

    // Confirmed-vs-gap comes from the deal's call-verified extraction only, so
    // the briefing matches the deal page and never treats a stale CRM entry as
    // covered. Rolldog is read (light) only for the current stage.
    const extraction = deal.extraction as unknown as ExtractionMap;
    let stageKey = deal.stageKey;
    try {
      const row = await supabaseAdmin()
        .from("deals")
        .select("external_id")
        .eq("id", id)
        .maybeSingle();
      const ext = row.data?.external_id ?? null;
      const opp = ext ? rolldogOppIdForDeal(ext) : null;
      if (opp) {
        stageKey = stageKeyFromSummary(await getRolldogSummary(opp)) ?? deal.stageKey;
      }
    } catch (err) {
      console.warn(
        "[magaya prepare] rolldog stage read skipped:",
        err instanceof Error ? err.message : err,
      );
    }

    return { deal, framework, extraction, stageKey };
  } catch (err) {
    console.error("[magaya prepare] load failed:", err);
    return null;
  }
}

export default async function PreparePage({ params }: { params: { id: string } }) {
  const live = UUID_RE.test(params.id) ? await loadLiveMagayaDeal(params.id) : null;

  if (live) {
    const briefing = await generateBriefingFromState({
      account: live.deal.account,
      stageKey: live.stageKey,
      closeDate: live.deal.repForecastCloseDate || undefined,
      attendees: attendeesFrom(live.deal),
      framework: live.framework,
      extraction: live.extraction,
    });
    return (
      <div className="min-h-screen bg-bg">
        <main className="max-w-[1200px] mx-auto px-6 py-7">
          <Link
            href={`/deals/${live.deal.id}`}
            className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
          >
            <span className="text-base leading-none">←</span> Back to {live.deal.account}
          </Link>
          <MagayaBriefingView
            account={live.deal.account}
            stageKey={live.stageKey}
            attendees={attendeesFrom(live.deal)}
            briefing={briefing}
          />
        </main>
      </div>
    );
  }

  const deal = getDealById(params.id);
  if (!deal) notFound();
  const stage = getStageForDeal(deal);
  if (!stage) notFound();

  return (
    <div className="min-h-screen bg-bg">
      <main className="max-w-[1200px] mx-auto px-6 py-7">
        <Link
          href={`/deals/${deal.id}`}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
        >
          <span className="text-base leading-none">←</span> Back to {deal.account}
        </Link>
        <PrepareBriefingView deal={deal} stage={stage} />
      </main>
    </div>
  );
}
