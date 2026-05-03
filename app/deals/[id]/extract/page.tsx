import Link from "next/link";
import { notFound } from "next/navigation";
import { ExtractView } from "@/components/ExtractView";
import { getDealById, getStageForDeal } from "@/lib/seed-data";
import { getTranscriptById } from "@/lib/seed-transcript";

export default function ExtractPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { callId?: string };
}) {
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
        <Link
          href={`/deals/${deal.id}`}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
        >
          <span className="text-base leading-none">←</span> Back to {deal.account}
        </Link>

        <ExtractView
          deal={deal}
          call={call}
          initialTranscript={transcript}
          stage={stage}
        />
      </main>
    </div>
  );
}
