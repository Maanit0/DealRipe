import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { loadPortfolioRead, type DealRead } from "@/lib/deal-read-portfolio";
import { repName } from "@/lib/display-names";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";
import { DEFAULT_TENANT_SLUG, withTenant } from "@/lib/tenant-nav";

export const dynamic = "force-dynamic";

const MOMENTUM: Record<DealRead["assessment"]["momentum"], { label: string; cls: string }> = {
  advancing: { label: "Advancing", cls: "bg-accent/10 text-accent" },
  steady: { label: "Steady", cls: "bg-ink/[0.06] text-muted" },
  stalling: { label: "Losing momentum", cls: "bg-warn/10 text-warn" },
  unknown: { label: "Unknown", cls: "bg-ink/[0.04] text-muted" },
};

const SEVERITY: Record<string, string> = {
  critical: "bg-warn/10 text-warn",
  warning: "bg-amber-500/10 text-amber-700",
  watch: "bg-ink/[0.05] text-muted",
};

export default async function ReadPage({
  searchParams,
}: {
  searchParams: { tenant?: string; filter?: string };
}) {
  const tenant = searchParams.tenant ?? DEFAULT_TENANT_SLUG;
  const filter = searchParams.filter ?? "action";

  let rows: DealRead[] = [];
  let error: string | null = null;
  try {
    const tenantId = await resolveTenantId(tenant);
    rows = await loadPortfolioRead({ tenantId });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const needsAction = rows.filter((r) => r.flags.some((f) => f.severity === "critical"));
  const shown = filter === "all" ? rows : needsAction;

  const stalling = rows.filter((r) => r.assessment.momentum === "stalling").length;
  const unreadable = rows.filter((r) => r.assessment.confidence === "low").length;

  return (
    <AppShell active="review" tenant={tenant}>
      <div className="max-w-[1100px] mx-auto px-6 py-7">
        <h1 className="text-[24px] font-semibold tracking-tight text-ink">The read</h1>
        <p className="text-[13px] text-muted mt-1 max-w-[760px]">
          DealRipe&apos;s own read on every open deal, computed from what the buyer did: meetings held
          and booked, who spoke and who stayed silent, what the calls proved, and what the CRM&apos;s own
          history recorded. The rep&apos;s forecast band is <span className="text-ink">not an input</span>,
          which is what makes agreeing with it mean something.
        </p>

        {error && (
          <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-warn">
            Could not load the read: {error}
          </div>
        )}

        {!error && (
          <>
            <div className="mt-5 flex flex-wrap items-center gap-3 text-[12px]">
              <Link
                href={withTenant("/read?filter=action", tenant)}
                className={`px-3 py-1.5 rounded-lg border ${filter !== "all" ? "bg-ink text-white border-ink" : "border-line text-muted hover:text-ink"}`}
              >
                Needs a person ({needsAction.length})
              </Link>
              <Link
                href={withTenant("/read?filter=all", tenant)}
                className={`px-3 py-1.5 rounded-lg border ${filter === "all" ? "bg-ink text-white border-ink" : "border-line text-muted hover:text-ink"}`}
              >
                All open ({rows.length})
              </Link>
              <span className="text-muted">
                {stalling} losing momentum · {unreadable} with too little evidence to judge
              </span>
            </div>

            {/* A short list because the deals are clean and a short list because we
                cannot see them are different facts, so the second is said out loud. */}
            {unreadable > 0 && (
              <p className="mt-2 text-[12px] text-muted">
                {unreadable} deal{unreadable === 1 ? "" : "s"} could not be judged, mostly for having no
                captured call. Absence of flags there means unknown, not clean.
              </p>
            )}

            <div className="mt-5 space-y-3">
              {shown.length === 0 && (
                <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
                  Nothing needs a person right now.
                </div>
              )}

              {shown.map((r) => {
                const m = MOMENTUM[r.assessment.momentum];
                const critical = r.flags.filter((f) => f.severity === "critical");
                const rest = r.flags.filter((f) => f.severity !== "critical");
                return (
                  <div
                    key={r.dealId}
                    className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4"
                  >
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <Link
                        href={withTenant(`/read/${r.dealId}`, tenant)}
                        className="text-[15px] font-semibold text-ink hover:text-accent"
                      >
                        {r.account}
                      </Link>
                      <span className="text-[12px] text-muted">{repName(r.repEmail)}</span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-md ${m.cls}`}>{m.label}</span>
                      <span className="text-[12px] text-muted ml-auto">
                        rep says{" "}
                        <span className="text-ink">{r.crm?.forecastCategory ?? "no band"}</span>
                        {"  ·  "}
                        DealRipe says <span className="text-ink">{r.assessment.band ?? "no read"}</span>
                        {r.crm?.closeDate ? `  ·  closing ${r.crm.closeDate}` : ""}
                      </span>
                    </div>

                    {critical.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {critical.map((f, i) => (
                          <div key={i} className="border-l-2 border-warn/40 pl-3">
                            <div className="text-[13px] font-medium text-ink">{f.title}</div>
                            <div className="text-[12px] text-muted mt-0.5">{f.evidence}</div>
                            {/* Kiddom's rule, and the reason `move` is a required
                                field: not a list of red items, but the next action. */}
                            <div className="text-[12px] text-accent mt-0.5">{f.move}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {rest.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {rest.map((f, i) => (
                          <span
                            key={i}
                            title={f.evidence}
                            className={`text-[11px] px-2 py-0.5 rounded-md ${SEVERITY[f.severity] ?? SEVERITY.watch}`}
                          >
                            {f.title}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
