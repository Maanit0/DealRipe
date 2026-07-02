import Link from "next/link";
import { notFound } from "next/navigation";
import { DealView } from "@/components/DealView";
import { MagayaDealView } from "@/components/MagayaDealView";
import { getFrameworkForDeal } from "@/lib/framework";
import { getDealById, getStageForDeal } from "@/lib/seed-data";
import { getDealForTenant } from "@/lib/supabase-queries";
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
    return { deal, framework };
  } catch (err) {
    console.error("[magaya deal] load failed:", err);
    return null; // Supabase not configured / magaya tenant absent -> demo path
  }
}

export default async function DealPage({ params }: { params: { id: string } }) {
  const live = UUID_RE.test(params.id) ? await loadLiveMagayaDeal(params.id) : null;

  let body: React.ReactNode;
  if (live) {
    body = <MagayaDealView deal={live.deal} framework={live.framework} />;
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
