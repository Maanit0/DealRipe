import Link from "next/link";

import { DigestList } from "@/components/DigestList";
import { getDigestSends, type DigestSend } from "@/lib/sent-messages";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";
import { DEFAULT_TENANT_SLUG, pipelineHref } from "@/lib/tenant-nav";

export const dynamic = "force-dynamic";

export default async function DigestsPage({ searchParams }: { searchParams: { tenant?: string } }) {
  // Tenant-aware: magaya is unchanged (default), keelson (and any demo tenant)
  // reads its own archived digests via ?tenant=<slug>.
  const tenant = searchParams.tenant ?? DEFAULT_TENANT_SLUG;
  let sends: DigestSend[] = [];
  try {
    const tenantId = await resolveTenantId(tenant);
    sends = await getDigestSends(tenantId);
  } catch (err) {
    console.error("[digests] load failed:", err);
  }

  return (
    <div className="min-h-screen bg-bg">
      <main className="max-w-[900px] mx-auto px-6 py-7">
        <Link
          href={pipelineHref(tenant)}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
        >
          <span className="text-base leading-none">←</span> Back to pipeline
        </Link>

        <h1 className="text-[22px] font-semibold text-ink">Sent digests</h1>
        <p className="text-[13px] text-muted mt-1">
          Every weekly digest DealRipe emailed, newest first. Click one to see exactly what went out.
        </p>

        <DigestList sends={sends} />
      </main>
    </div>
  );
}
