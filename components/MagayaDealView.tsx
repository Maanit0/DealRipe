import Link from "next/link";
import { ContactsCard } from "./ContactsCard";
import { TeamsCallsCard } from "./TeamsCallsCard";
import { MagayaOpportunityControl } from "./MagayaOpportunityControl";
import type { Framework } from "@/lib/framework";
import { frameworkProgress } from "@/lib/framework-stages";
import type { Deal } from "@/lib/seed-data";

const STAGE_LABELS: Record<string, string> = {
  SQL0: "Lead",
  SQL1: "Develop Opportunity",
  SQL2: "Solution Finalization",
  SQL3: "Proposal Validation",
  SQL4: "Negotiations",
  SQL5: "Agreement Formalization",
};

export function MagayaDealView({
  deal,
  framework,
}: {
  deal: Deal;
  framework: Framework;
}) {
  const { confirmed, total } = frameworkProgress(framework, deal.extraction);
  // Magaya reps use forecast categories, not percentages. Derive the category
  // from the seeded number until the live Rolldog read provides it directly.
  const repCategory =
    deal.repForecastProbability >= 0.7
      ? "Commit"
      : deal.repForecastProbability >= 0.4
        ? "Expect"
        : "Pipeline";

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-white rounded-xl2 shadow-card border border-line px-6 py-5">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-[22px] font-semibold text-ink">{deal.account}</h1>
            <p className="text-[13px] text-muted mt-0.5">{deal.industry}</p>
          </div>
          <div className="text-right">
            <div className="text-[22px] font-semibold text-ink">
              ${deal.arr.toLocaleString()}
            </div>
            <div className="text-[12px] text-muted mt-0.5">
              {STAGE_LABELS[deal.stageKey] ?? deal.stageKey}
              {deal.daysInStage ? ` · ${deal.daysInStage} days in stage` : ""}
            </div>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-line grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
              Rep category
            </div>
            <div className="text-[13px] text-ink mt-1">
              {repCategory}
              {deal.repForecastCloseDate ? ` · close ${deal.repForecastCloseDate}` : ""}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
              DealRipe read
            </div>
            <div className="text-[13px] text-ink mt-1">
              {confirmed} of {total} gates confirmed
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-5 items-start">
        <MagayaOpportunityControl
          framework={framework}
          extraction={deal.extraction}
          currentStageKey={deal.stageKey}
        />
        <div className="space-y-5">
          <ContactsCard contacts={deal.contacts} />
          <TeamsCallsCard dealId={deal.id} calls={deal.calls} />
          <Link
            href={`/deals/${deal.id}/prepare`}
            className="block w-full text-center px-4 py-3 rounded-xl2 bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 transition"
          >
            Prepare next call
          </Link>
        </div>
      </div>
    </div>
  );
}
