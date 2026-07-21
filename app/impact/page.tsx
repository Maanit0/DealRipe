import Link from "next/link";

import { buildImpactScoreboard, type ImpactScoreboard } from "@/lib/impact";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const dynamic = "force-dynamic";

function fmtHours(h: number): string {
  if (h >= 1) return `${h.toFixed(1)}`;
  return `${Math.round(h * 60)}`;
}

export default async function ImpactPage() {
  let data: ImpactScoreboard | null = null;
  try {
    const tenantId = await resolveTenantId("magaya");
    data = await buildImpactScoreboard(tenantId);
  } catch (err) {
    console.error("[impact] load failed:", err);
  }

  const hours = data?.hoursSaved ?? 0;
  const hoursIsMinutes = hours < 1;

  return (
    <div className="min-h-screen bg-bg">
      <main className="max-w-[1000px] mx-auto px-6 py-7">
        <Link
          href="/pipeline?tenant=magaya"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
        >
          <span className="text-base leading-none">←</span> Back to pipeline
        </Link>

        <div className="text-[11px] uppercase tracking-wider font-semibold text-accent">DealRipe impact</div>
        <h1 className="text-[24px] font-semibold text-ink mt-1">Pilot to date</h1>
        <p className="text-[13px] text-muted mt-1">
          What DealRipe has taken off the team&rsquo;s plate and caught, so far.
        </p>

        {!data ? (
          <div className="mt-6 bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
            Nothing to show yet. Numbers appear as calls are captured.
          </div>
        ) : (
          <>
            {/* Headline */}
            <div className="mt-6 bg-ink rounded-xl2 shadow-card px-7 py-6 text-white">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-white/60">
                Rep time saved, pilot to date
              </div>
              <div className="text-[44px] font-bold tracking-tight leading-none mt-2">
                {fmtHours(hours)}{" "}
                <span className="text-[20px] font-semibold text-white/70">
                  {hoursIsMinutes ? "minutes" : "hours"}
                </span>
              </div>
              <div className="text-[12px] text-white/60 mt-2">
                Prep and post-call admin the reps did not have to do.
              </div>
            </div>

            {/* Activity tiles */}
            <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Tile n={data.callsCaptured} label="Calls captured" />
              <Tile n={data.recapsSent} label="Recaps auto-written" />
              <Tile n={data.briefingsSent} label="Briefings prepared" />
              <Tile n={data.fieldsAutoLogged} label="Fields captured for reps" />
            </div>

            {/* Risks caught */}
            <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line px-6 py-5">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-danger">
                Risks caught before they cost
              </div>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-4">
                <RiskTile n={data.darkBuyersSurfaced} label="Budget owners flagged as never engaged" />
                <RiskTile n={data.noShowsCaught} label="No-show meetings caught" />
                <RiskTile n={data.dealsWrittenBack} label="Deals with CRM updated automatically" />
              </div>
            </div>

            {/* Time-saved breakdown + assumptions */}
            <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line px-6 py-5">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-muted">
                How the time saved is counted
              </div>
              <table className="w-full mt-3 text-[13px]">
                <tbody>
                  {data.breakdown.map((b) => (
                    <tr key={b.label} className="border-b border-line last:border-0">
                      <td className="py-2 text-ink">{b.label}</td>
                      <td className="py-2 text-right text-muted whitespace-nowrap">
                        {b.count} &times; {b.minEach} min
                      </td>
                      <td className="py-2 text-right font-semibold text-ink whitespace-nowrap w-20">
                        {b.hours < 1 ? `${Math.round(b.hours * 60)} min` : `${b.hours.toFixed(1)} hr`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-muted mt-3 leading-snug">
                Conservative estimates: 10 minutes per recap, 15 minutes per briefing, 1 minute per
                field. Forecast accuracy (DealRipe&rsquo;s read vs. actual outcome) accrues as deals
                close and will be added here over the pilot.
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Tile({ n, label }: { n: number; label: string }) {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-4 py-4">
      <div className="text-[28px] font-bold tracking-tight text-ink leading-none">{n}</div>
      <div className="text-[11px] text-muted mt-1.5 leading-snug">{label}</div>
    </div>
  );
}

function RiskTile({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <div className="text-[24px] font-bold tracking-tight text-ink leading-none">{n}</div>
      <div className="text-[11px] text-muted mt-1 leading-snug">{label}</div>
    </div>
  );
}
