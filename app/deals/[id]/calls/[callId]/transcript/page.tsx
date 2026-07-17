import Link from "next/link";
import { notFound } from "next/navigation";
import { TranscriptView } from "@/components/TranscriptView";
import { getCallTranscript } from "@/lib/transcript-view";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const dynamic = "force-dynamic";

export default async function TranscriptPage({
  params,
  searchParams,
}: {
  params: { id: string; callId: string };
  searchParams: { q?: string };
}) {
  let data = null;
  try {
    const tenantId = await resolveTenantId("magaya");
    data = await getCallTranscript(tenantId, params.callId);
  } catch (err) {
    console.error("[transcript] load failed:", err);
  }
  if (!data) notFound();

  return (
    <div className="min-h-screen bg-bg">
      <main className="max-w-[900px] mx-auto px-6 py-7">
        <Link
          href={`/deals/${params.id}`}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
        >
          <span className="text-base leading-none">←</span> Back to {data.account}
        </Link>
        <TranscriptView
          body={data.body}
          highlight={searchParams.q}
          account={data.account}
          callDate={data.callDate}
        />
      </main>
    </div>
  );
}
