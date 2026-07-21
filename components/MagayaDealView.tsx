import Link from "next/link";
import { AttendanceCard } from "./AttendanceCard";
import { ContactsCard } from "./ContactsCard";
import { CroReadCard } from "./CroReadCard";
import { DealStateCard } from "./DealStateCard";
import { DealHistoryCard } from "./DealHistoryCard";
import { SentCommsCard } from "./SentCommsCard";
import { deriveDealState } from "@/lib/deal-state";
import type { DealHistory } from "@/lib/deal-history";
import type { CallAttendance } from "@/lib/attendance";
import { TeamsCallsCard } from "./TeamsCallsCard";
import { MagayaOpportunityControl } from "./MagayaOpportunityControl";
import type { CroRead } from "@/lib/cro-read";
import type { SentMessage } from "@/lib/sent-messages";
import type { Framework } from "@/lib/framework";
import { frameworkProgress } from "@/lib/framework-stages";
import type { Deal } from "@/lib/seed-data";
import { describeUpcomingCall, type UpcomingCall } from "@/lib/supabase-queries";
import type { RolldogSummary } from "@/lib/rolldog-summary";
import { repDisplayName } from "@/lib/pilot-config";

const STAGE_LABELS: Record<string, string> = {
  SQL0: "Lead",
  SQL1: "Develop Opportunity",
  SQL2: "Solution Finalization",
  SQL3: "Proposal Validation",
  SQL4: "Negotiations",
  SQL5: "Agreement Formalization",
};

function SignalChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "danger" | "accent" | "muted";
}) {
  const valueCls =
    tone === "danger" ? "text-danger" : tone === "accent" ? "text-accent" : "text-ink";
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">{label}</div>
      <div className={`text-[13px] mt-1 font-medium ${valueCls}`}>{value}</div>
    </div>
  );
}

export function MagayaDealView({
  deal,
  framework,
  upcomingCall,
  rolldogSummary,
  croRead,
  sentMessages = [],
  history,
  attendance,
}: {
  deal: Deal;
  framework: Framework;
  upcomingCall?: UpcomingCall | null;
  rolldogSummary?: RolldogSummary | null;
  croRead?: CroRead | null;
  sentMessages?: SentMessage[];
  history?: DealHistory;
  attendance?: CallAttendance[];
}) {
  const upcoming = upcomingCall ? describeUpcomingCall(upcomingCall) : null;
  const { confirmed, total } = frameworkProgress(framework, deal.extraction);
  const dealState = deriveDealState(framework, deal.extraction, deal.stageKey);
  // Magaya reps use forecast categories, not percentages. Derive the category
  // from the seeded number until the live Rolldog read provides it directly.
  const repCategory =
    deal.repForecastProbability >= 0.7
      ? "Commit"
      : deal.repForecastProbability >= 0.4
        ? "Expect"
        : "Pipeline";

  // Signals for the compact chip row and the "Do next" action.
  const completion = total > 0 ? confirmed / total : 0;
  const forecastMismatch = repCategory !== "Pipeline" && completion < 0.6;
  const reachedRank = dealState.reachedStageKey
    ? parseInt(dealState.reachedStageKey.match(/(\d+)/)?.[1] ?? "0", 10)
    : -1;
  const ebRisk =
    reachedRank >= 3 &&
    deal.contacts.some((c) => c.relationship === "economic_buyer" && !c.lastContactedAt);
  const latestAtt = attendance && attendance.length > 0 ? attendance[0] : null;
  const attSpoke = latestAtt ? latestAtt.invitees.filter((i) => i.spoke).length : 0;
  const attSilent = latestAtt
    ? latestAtt.invitees.filter((i) => i.onInvite && !i.spoke).length
    : 0;

  // The single most important next action, prioritised.
  const nextAction = ebRisk
    ? "Get the budget owner into the next call, they have not been in one yet."
    : !dealState.nextStepAnswer
      ? "No firm next step captured. Lock a dated mutual action plan."
      : dealState.topGaps.length > 0
        ? `Close ${dealState.topGaps[0].label} on the next call.`
        : "Well qualified. Confirm timeline and keep momentum.";

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-white rounded-xl2 shadow-card border border-line px-6 py-5">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-[22px] font-semibold text-ink">{deal.account}</h1>
            <p className="text-[13px] text-muted mt-0.5">
              {deal.industry}
              {repDisplayName(deal.repEmail) ? (
                <>
                  {deal.industry ? " · " : ""}
                  <span className="text-ink font-medium">{repDisplayName(deal.repEmail)}</span>
                  {"'s deal"}
                </>
              ) : null}
            </p>
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
        <div className="mt-4 pt-4 border-t border-line grid grid-cols-1 sm:grid-cols-3 gap-4">
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
              Rolldog score
            </div>
            <div className="text-[13px] text-ink mt-1">
              {rolldogSummary?.score ?? "—"}
              {rolldogSummary?.qRank ? ` · rank ${rolldogSummary.qRank}` : ""}
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

      {/* Action band: where it stands, and the single next action. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-5 items-stretch">
        <DealStateCard state={dealState} />
        <div className="bg-white rounded-xl2 shadow-card border-2 border-accent/40 px-5 py-4 flex flex-col">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-accent">
            Do next
          </div>
          <div className="text-[14px] text-ink leading-relaxed mt-1.5 flex-1">{nextAction}</div>
          <Link
            href={`/deals/${deal.id}/prepare`}
            className="mt-3 block w-full text-center px-4 py-2.5 rounded-xl2 bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 transition"
          >
            Prepare next call
          </Link>
        </div>
      </div>

      {/* Compact signals. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SignalChip
          label="Forecast"
          value={forecastMismatch ? `Rep ${repCategory}, evidence lags` : `Rep ${repCategory}`}
          tone={forecastMismatch ? "danger" : "muted"}
        />
        <SignalChip
          label="Attendance"
          value={
            latestAtt
              ? `${attSpoke} took part${attSilent > 0 ? `, ${attSilent} no-show` : ""}`
              : "No call captured yet"
          }
          tone={attSilent > 0 ? "danger" : latestAtt ? "accent" : "muted"}
        />
        <SignalChip
          label="Budget owner"
          value={ebRisk ? "Never engaged" : "No gap flagged"}
          tone={ebRisk ? "danger" : "muted"}
        />
      </div>

      <CroReadCard dealId={deal.id} initial={croRead ?? null} />

      {/* Supporting detail. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <div className="space-y-5">
          <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
              Upcoming call
            </div>
            {upcoming ? (
              <>
                <div className="text-[15px] font-semibold text-ink mt-1.5">{upcoming.when}</div>
                <div
                  className={`text-[12px] mt-1 ${
                    upcomingCall?.briefingSentAt ? "text-accent font-medium" : "text-muted"
                  }`}
                >
                  {upcomingCall?.briefingSentAt ? "✓ " : ""}
                  {upcoming.briefing}
                </div>
              </>
            ) : (
              <div className="text-[13px] text-muted mt-1.5">
                No upcoming meeting synced yet. It appears once the rep schedules a call
                with this customer.
              </div>
            )}
          </div>
          <ContactsCard contacts={deal.contacts} />
        </div>
        <div className="space-y-5">
          {attendance && attendance.length > 0 && <AttendanceCard history={attendance} />}
          <TeamsCallsCard dealId={deal.id} calls={deal.calls} />
        </div>
      </div>

      {/* Full qualification detail, collapsed by default (reference, not the lead). */}
      <details className="group bg-white rounded-xl2 shadow-card border border-line">
        <summary className="cursor-pointer select-none list-none flex items-center justify-between gap-4 px-6 py-4">
          <span className="text-[15px] font-semibold text-ink">
            Full qualification detail{" "}
            <span className="text-[12px] text-muted font-normal">
              · {total} gates, extracted from calls
            </span>
          </span>
          <span className="text-[12px] text-muted group-open:hidden">Show ›</span>
          <span className="text-[12px] text-muted hidden group-open:inline">Hide ⌄</span>
        </summary>
        <div className="px-4 pb-4">
          <MagayaOpportunityControl
            framework={framework}
            extraction={deal.extraction}
            currentStageKey={deal.stageKey}
            dealId={deal.id}
            capturedByField={history?.perGate ?? {}}
          />
        </div>
      </details>

      {history && history.timeline.length > 0 && (
        <DealHistoryCard dealId={deal.id} timeline={history.timeline} />
      )}

      <SentCommsCard messages={sentMessages} />
    </div>
  );
}
