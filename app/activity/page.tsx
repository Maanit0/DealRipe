import Link from "next/link";

import { ActivityFilterBar } from "@/components/ActivityFilterBar";
import { AppShell } from "@/components/AppShell";
import { getActivityLog, type ActivityEntry, type ActivityKind } from "@/lib/activity-log";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const dynamic = "force-dynamic";

const KIND_META: Record<ActivityKind, { label: string; cls: string }> = {
  briefing: { label: "Briefing", cls: "bg-accent/10 text-accent" },
  recap: { label: "Recap", cls: "bg-ink/[0.06] text-ink" },
  no_show_draft: { label: "No-show draft", cls: "bg-warn/10 text-warn" },
  digest: { label: "Digest", cls: "bg-ink/[0.06] text-muted" },
  rolldog_write: { label: "Rolldog", cls: "bg-accent/10 text-accent" },
};

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Chicago", // pilot timezone; UTC made times look hours late
    });
  } catch {
    return "—";
  }
}

type SP = { kind?: string; range?: string; deal?: string };

export default async function ActivityPage({ searchParams }: { searchParams: SP }) {
  let entries: ActivityEntry[] = [];
  try {
    const tenantId = await resolveTenantId("magaya");
    entries = await getActivityLog(tenantId);
  } catch (err) {
    console.error("[activity] load failed:", err);
  }

  const deals = Array.from(
    new Map(entries.filter((e) => e.dealId).map((e) => [e.dealId as string, e.account ?? ""])),
  )
    .map(([id, account]) => ({ id, account }))
    .sort((a, b) => a.account.localeCompare(b.account));

  const now = Date.now();
  const rangeDays = searchParams.range === "7d" ? 7 : searchParams.range === "30d" ? 30 : searchParams.range === "90d" ? 90 : null;
  const rows = entries.filter((e) => {
    if (searchParams.kind && e.kind !== searchParams.kind) return false;
    if (searchParams.deal && e.dealId !== searchParams.deal) return false;
    if (rangeDays != null) {
      const t = Date.parse(e.at);
      if (!Number.isFinite(t) || t < now - rangeDays * 86400000) return false;
    }
    return true;
  });

  return (
    <AppShell active="activity">
      <div className="max-w-[1000px] mx-auto px-6 py-7">
        <h1 className="text-[24px] font-semibold tracking-tight text-ink">Activity</h1>
        <p className="text-[13px] text-muted mt-1">
          A time-ordered log of everything DealRipe did: briefings and recaps sent, drafts written,
          digests, and what it wrote back to Rolldog.
        </p>

        <ActivityFilterBar deals={deals} />

        {rows.length === 0 ? (
          <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
            No activity matches these filters.
          </div>
        ) : (
          <div className="mt-4 bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
            {rows.map((e, i) => {
              const meta = KIND_META[e.kind];
              const expandable = !!e.bodyHtml || e.kind === "rolldog_write";
              const row = (
                <>
                  <div className="text-[11px] text-muted w-[110px] shrink-0 pt-0.5 whitespace-nowrap">
                    {fmt(e.at)}
                  </div>
                  <span className={`shrink-0 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full ${meta.cls}`}>
                    {meta.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-ink">
                      {e.title}
                      {e.account && (
                        <>
                          {" · "}
                          {e.dealId ? (
                            <Link href={`/deals/${e.dealId}`} className="text-accent hover:underline">
                              {e.account}
                            </Link>
                          ) : (
                            <span className="text-muted">{e.account}</span>
                          )}
                        </>
                      )}
                    </div>
                    {e.detail && <div className="text-[12px] text-muted mt-0.5">{e.detail}</div>}
                  </div>
                  <div className="shrink-0 w-[150px] text-right pt-0.5">
                    {e.callId && e.callDate ? (
                      <Link
                        href={`/meetings/${e.callId}`}
                        className="text-[11px] text-accent hover:underline whitespace-nowrap"
                      >
                        Call {fmt(e.callDate)}
                      </Link>
                    ) : (
                      <span className="text-[11px] text-muted/60">—</span>
                    )}
                  </div>
                  {expandable && (
                    <span className="text-[11px] text-muted shrink-0 group-open:rotate-180 transition-transform">⌄</span>
                  )}
                </>
              );
              const border = i < rows.length - 1 ? "border-b border-line" : "";
              if (!expandable) {
                return (
                  <div key={e.id} className={`px-5 py-3.5 flex items-start gap-4 ${border}`}>
                    {row}
                  </div>
                );
              }
              return (
                <details key={e.id} className={`group ${border}`}>
                  <summary className="px-5 py-3.5 flex items-start gap-4 cursor-pointer list-none hover:bg-bg/60 transition">
                    {row}
                  </summary>
                  <div className="px-5 pb-4">
                    {e.bodyHtml ? (
                      <iframe
                        title={e.title}
                        srcDoc={e.bodyHtml}
                        className="w-full rounded-lg border border-line bg-white"
                        style={{ height: 520 }}
                      />
                    ) : (
                      <div className="rounded-lg border border-line bg-bg px-4 py-3 text-[13px] text-ink">
                        Updated in Rolldog: <span className="font-medium">{e.fields ?? "fields"}</span>.
                        {e.dealId && (
                          <>
                            {" "}
                            <Link href={`/deals/${e.dealId}`} className="text-accent hover:underline">
                              Open the deal
                            </Link>{" "}
                            to see the current values.
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}
