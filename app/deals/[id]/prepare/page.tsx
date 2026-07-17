import Link from "next/link";
import { notFound } from "next/navigation";
import { MagayaBriefingView } from "@/components/MagayaBriefingView";
import { PrepareBriefingView } from "@/components/PrepareBriefingView";
import { briefingStateFromContext, getDealContext } from "@/lib/deal-context";
import { generateBriefingFromState } from "@/lib/generate-briefing";
import { getDealById, getStageForDeal } from "@/lib/seed-data";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

// Always generate from live data (see the deal page for the caching rationale).
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadLiveContext(id: string) {
  try {
    const tenantId = await resolveTenantId("magaya");
    return await getDealContext(tenantId, id);
  } catch (err) {
    console.error("[magaya prepare] load failed:", err);
    return null;
  }
}

export default async function PreparePage({ params }: { params: { id: string } }) {
  // The briefing now reads the canonical deal context: calls-first stage,
  // call-verified extraction, contact-derived attendees. Rolldog only informs
  // the stage as a fallback, never overrides what the calls show.
  const ctx = UUID_RE.test(params.id) ? await loadLiveContext(params.id) : null;

  if (ctx) {
    const briefing = await generateBriefingFromState(briefingStateFromContext(ctx));
    return (
      <div className="min-h-screen bg-bg">
        <main className="max-w-[1200px] mx-auto px-6 py-7">
          <Link
            href={`/deals/${ctx.dealId}`}
            className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
          >
            <span className="text-base leading-none">←</span> Back to {ctx.account}
          </Link>
          <MagayaBriefingView
            account={ctx.account}
            stageKey={ctx.effectiveStageKey}
            attendees={ctx.attendees}
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
