import Link from "next/link";
import { notFound } from "next/navigation";
import { DealView } from "@/components/DealView";
import { getDealById, getStageForDeal } from "@/lib/seed-data";

export default function DealPage({ params }: { params: { id: string } }) {
  const deal = getDealById(params.id);
  if (!deal) notFound();

  const stage = getStageForDeal(deal);
  if (!stage) notFound();

  return (
    <div className="min-h-screen bg-bg">
      <main className="max-w-[1200px] mx-auto px-6 py-7">
        <Link
          href="/pipeline"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
        >
          <span className="text-base leading-none">←</span> Back to pipeline
        </Link>

        <DealView deal={deal} stage={stage} />
      </main>
    </div>
  );
}
