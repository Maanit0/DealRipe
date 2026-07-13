import Link from "next/link";
import { notFound } from "next/navigation";
import { DealView } from "@/components/DealView";
import { MagayaDealView } from "@/components/MagayaDealView";
import { getCroRead, type CroRead } from "@/lib/cro-read";
import { getFrameworkForDeal } from "@/lib/framework";
import { rolldogOppIdForDeal } from "@/lib/pilot-config";
import {
  daysSince,
  getRolldogSummary,
  stageKeyFromSummary,
  type RolldogSummary,
} from "@/lib/rolldog-summary";
import { getDealById, getStageForDeal } from "@/lib/seed-data";
import { supabaseAdmin } from "@/lib/supabase";
import { getDealForTenant, getUpcomingCallForDeal } from "@/lib/supabase-queries";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

// Live Magaya deals have UUID ids; the TopSort demo uses slug ids.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadLiveMagayaDeal(id: string) {
  try {
    const tenantId = await resolveTenantId("magaya");
    const deal = await getDealForTenant(tenantId, id);
    if (!deal) return null;
    const framework = await getFrameworkForDeal(deal.id);
    if (!framework) return null;

    // The SQL gates render from the deal's call-verified extraction only, so
    // the deal page and the briefings agree and never count a stale CRM entry
    // as confirmed. Rolldog is read (light) purely for reference signals shown
    // in the header (deal size, score, q-rank) and the current stage. A Rolldog
    // failure never blocks the page.
    let rolldogSummary: RolldogSummary | null = null;
    try {
      const row = await supabaseAdmin()
        .from("deals")
        .select("external_id")
        .eq("id", id)
        .maybeSingle();
      const ext = row.data?.external_id ?? null;
      const opp = ext ? rolldogOppIdForDeal(ext) : null;
      if (opp) {
        rolldogSummary = await getRolldogSummary(opp);
        const rStage = stageKeyFromSummary(rolldogSummary);
        if (rStage) deal.stageKey = rStage;
        if (rolldogSummary?.dealSize != null) deal.arr = rolldogSummary.dealSize;
        const dis = daysSince(rolldogSummary?.currentStageDate ?? null);
        if (dis != null) deal.daysInStage = dis;
      }
    } catch (err) {
      console.warn(
        "[magaya deal] rolldog summary read skipped:",
        err instanceof Error ? err.message : err,
      );
    }

    const upcomingCall = await getUpcomingCallForDeal(tenantId, deal.id);
    const croRead: CroRead | null = await getCroRead(deal.id).catch(() => null);
    return { deal, framework, upcomingCall, rolldogSummary, croRead };
  } catch (err) {
    console.error("[magaya deal] load failed:", err);
    return null; // Supabase not configured / magaya tenant absent -> demo path
  }
}

export default async function DealPage({ params }: { params: { id: string } }) {
  const live = UUID_RE.test(params.id) ? await loadLiveMagayaDeal(params.id) : null;

  let body: React.ReactNode;
  if (live) {
    body = (
      <MagayaDealView
        deal={live.deal}
        framework={live.framework}
        upcomingCall={live.upcomingCall}
        rolldogSummary={live.rolldogSummary}
        croRead={live.croRead}
      />
    );
  } else {
    const deal = getDealById(params.id);
    if (!deal) notFound();
    const stage = getStageForDeal(deal);
    if (!stage) notFound();
    body = <DealView deal={deal} stage={stage} />;
  }

  return (
    <div className="min-h-screen bg-bg">
      <main className="max-w-[1200px] mx-auto px-6 py-7">
        <Link
          href={live ? "/pipeline?tenant=magaya" : "/pipeline"}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
        >
          <span className="text-base leading-none">←</span> Back to pipeline
        </Link>
        {body}
      </main>
    </div>
  );
}
