import Link from "next/link";

import { LocalTime } from "@/components/LocalTime";
import { getDigestSends, type DigestSend } from "@/lib/sent-messages";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const dynamic = "force-dynamic";

export default async function DigestsPage() {
  let sends: DigestSend[] = [];
  try {
    const tenantId = await resolveTenantId("magaya");
    sends = await getDigestSends(tenantId);
  } catch (err) {
    console.error("[digests] load failed:", err);
  }

  return (
    <div className="min-h-screen bg-bg">
      <main className="max-w-[900px] mx-auto px-6 py-7">
        <Link
          href="/pipeline?tenant=magaya"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
        >
          <span className="text-base leading-none">←</span> Back to pipeline
        </Link>

        <h1 className="text-[22px] font-semibold text-ink">Sent digests</h1>
        <p className="text-[13px] text-muted mt-1">
          Every weekly digest DealRipe emailed, newest first. Click one to see exactly what went out.
        </p>

        {sends.length === 0 ? (
          <div className="mt-6 bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
            No digests sent yet. They appear here the moment one goes out, whether you send it or the 6am job does.
          </div>
        ) : (
          <div className="mt-5 space-y-2">
            {sends.map((s) => (
              <details key={s.id} className="group bg-white border border-line rounded-xl2 shadow-card overflow-hidden">
                <summary className="cursor-pointer list-none px-5 py-3.5 flex items-center justify-between gap-3 hover:bg-bg/50 transition">
                  <span className="min-w-0">
                    <span className="text-[13px] font-semibold text-ink truncate block">{s.subject}</span>
                    <span className="text-[11px] text-muted">to {s.toEmail}</span>
                  </span>
                  <span className="text-[11px] text-muted whitespace-nowrap flex items-center gap-2">
                    <LocalTime iso={s.sentAt} />
                    <span className="text-muted/70 group-open:rotate-180 transition-transform">⌄</span>
                  </span>
                </summary>
                <div className="border-t border-line">
                  <iframe
                    title={s.subject}
                    srcDoc={s.bodyHtml}
                    sandbox=""
                    className="w-full h-[560px] bg-white border-0 block"
                  />
                </div>
              </details>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
