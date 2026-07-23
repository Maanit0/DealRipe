import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { CoverageFilterBar } from "@/components/CoverageFilterBar";
import { CoverageList } from "@/components/CoverageList";
import { getActivityLog, type ActivityEntry, type ActivityKind } from "@/lib/activity-log";
import { resolveRange, RANGE_LABELS, type RangeKey } from "@/lib/date-range";
import { getMeetingCoverage, type MeetingCoverage } from "@/lib/meeting-coverage";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const dynamic = "force-dynamic";

const KIND_META: Record<ActivityKind, { label: string; cls: string }> = {
  briefing: { label: "Briefing", cls: "bg-accent/10 text-accent" },
  recap: { label: "Recap", cls: "bg-ink/[0.06] text-ink" },
  no_show_draft: { label: "No-show draft", cls: "bg-warn/10 text-warn" },
  digest: { label: "Digest", cls: "bg-ink/[0.06] text-muted" },
  rolldog_write: { label: "Rolldog", cls: "bg-accent/10 text-accent" },
};

const TZ = "America/Chicago";
function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: TZ,
    });
  } catch {
    return "—";
  }
}

type SP = { view?: string; range?: string; from?: string; to?: string; kind?: string };

export default async function ActivityPage({ searchParams }: { searchParams: SP }) {
  const view = searchParams.view === "raw" ? "raw" : "coverage";
  const range = resolveRange(searchParams.range, searchParams.from, searchParams.to);
  const rangeLabel =
    range.key === "custom" && searchParams.from && searchParams.to
      ? `${searchParams.from} to ${searchParams.to}`
      : RANGE_LABELS[range.key as RangeKey];

  let coverage: MeetingCoverage[] = [];
  let entries: ActivityEntry[] = [];
  try {
    const tenantId = await resolveTenantId("magaya");
    if (view === "coverage") {
      [coverage, entries] = await Promise.all([
        getMeetingCoverage(tenantId, { sinceIso: range.sinceIso, untilIso: range.untilIso }),
        getActivityLog(tenantId),
      ]);
    } else {
      entries = await getActivityLog(tenantId);
    }
  } catch (err) {
    console.error("[activity] load failed:", err);
  }

  // Range filter for the flat entries (used by raw view + recurring section).
  const inRange = (at: string): boolean => {
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return false;
    if (range.sinceIso && t < Date.parse(range.sinceIso)) return false;
    if (range.untilIso && t > Date.parse(range.untilIso)) return false;
    return true;
  };

  // Recurring: weekly digests in range, with a light duplicate check (two within 3 days).
  const digests = entries.filter((e) => e.kind === "digest" && inRange(e.at)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const dupDigest = digests.some((d, i) => {
    const next = digests[i + 1];
    return next && Math.abs(Date.parse(d.at) - Date.parse(next.at)) < 3 * 86400000;
  });

  const rawRows = entries.filter((e) => inRange(e.at)).filter((e) => (searchParams.kind ? e.kind === searchParams.kind : true));

  const tabHref = (v: string) => {
    const sp = new URLSearchParams();
    sp.set("view", v);
    if (searchParams.range) sp.set("range", searchParams.range);
    if (searchParams.from) sp.set("from", searchParams.from);
    if (searchParams.to) sp.set("to", searchParams.to);
    return `/activity?${sp.toString()}`;
  };

  return (
    <AppShell active="activity">
      <div className="max-w-[1000px] mx-auto px-6 py-7">
        <h1 className="text-[24px] font-semibold tracking-tight text-ink">Activity</h1>
        <p className="text-[13px] text-muted mt-1">
          Per meeting, whether every step DealRipe owns actually fired, on time, once, and completely.
          Switch to the raw log for the literal event stream.
        </p>

        <div className="mt-4 flex items-center gap-1 border-b border-line">
          {[
            ["coverage", "Meeting coverage"],
            ["raw", "Raw log"],
          ].map(([v, label]) => (
            <Link
              key={v}
              href={tabHref(v)}
              className={`text-[13px] px-3 py-2 -mb-px border-b-2 transition ${
                view === v ? "border-ink text-ink font-medium" : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {label}
            </Link>
          ))}
        </div>

        <CoverageFilterBar />
        <div className="mt-2 text-[11px] text-muted">Showing {rangeLabel.toLowerCase()}.</div>

        {view === "coverage" ? (
          <>
            <CoverageList meetings={coverage} />

            <div className="mt-8">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-muted mb-2">
                Recurring
              </div>
              {digests.length === 0 ? (
                <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
                  No weekly digests sent in this range.
                </div>
              ) : (
                <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
                  {dupDigest && (
                    <div className="px-5 py-2 text-[11px] text-danger border-b border-line bg-danger/[0.03]">
                      Two digests landed within three days. Check the schedule for a double-send.
                    </div>
                  )}
                  {digests.map((d, i) => (
                    <div
                      key={d.id}
                      className={`px-5 py-3 flex items-center gap-3 text-[13px] ${
                        i < digests.length - 1 ? "border-b border-line" : ""
                      }`}
                    >
                      <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-ink/[0.06] text-muted">
                        Digest
                      </span>
                      <span className="text-ink">Weekly digest sent</span>
                      <span className="text-muted ml-auto text-[11px]">{fmt(d.at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <RawLog rows={rawRows} searchParams={searchParams} />
        )}
      </div>
    </AppShell>
  );
}

function RawLog({ rows, searchParams }: { rows: ActivityEntry[]; searchParams: SP }) {
  const kinds: Array<[string, string]> = [
    ["", "All"],
    ["briefing", "Briefings"],
    ["recap", "Recaps"],
    ["rolldog_write", "Rolldog"],
    ["no_show_draft", "No-show"],
    ["digest", "Digests"],
  ];
  const kindHref = (k: string) => {
    const sp = new URLSearchParams();
    sp.set("view", "raw");
    if (searchParams.range) sp.set("range", searchParams.range);
    if (searchParams.from) sp.set("from", searchParams.from);
    if (searchParams.to) sp.set("to", searchParams.to);
    if (k) sp.set("kind", k);
    return `/activity?${sp.toString()}`;
  };

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {kinds.map(([k, label]) => (
          <Link
            key={k || "all"}
            href={kindHref(k)}
            className={`text-[12px] px-2.5 py-1 rounded-full border transition ${
              (searchParams.kind ?? "") === k
                ? "bg-ink text-white border-ink"
                : "bg-white text-muted border-line hover:bg-bg"
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="mt-4 bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
          No activity matches these filters.
        </div>
      ) : (
        <div className="mt-4 bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
          {rows.map((e, i) => {
            const meta = KIND_META[e.kind];
            const expandable = !!e.bodyHtml || e.kind === "rolldog_write";
            const row = (
              <>
                <div className="text-[11px] text-muted w-[110px] shrink-0 pt-0.5 whitespace-nowrap">{fmt(e.at)}</div>
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
                    <Link href={`/meetings/${e.callId}`} className="text-[11px] text-accent hover:underline whitespace-nowrap">
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
    </>
  );
}
