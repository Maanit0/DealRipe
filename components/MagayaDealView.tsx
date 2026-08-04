import Link from "next/link";
import { AttendanceCard } from "./AttendanceCard";
import { ContactsCard } from "./ContactsCard";
import { CroReadCard } from "./CroReadCard";
import { DealStateCard } from "./DealStateCard";
import { DealHistoryCard } from "./DealHistoryCard";
import { DealTabs } from "./DealTabs";
import { CallExtractFlow } from "./CallExtractFlow";
import { DealSavedArc } from "./DealSavedArc";
import { EarlierCallsCard } from "./EarlierCallsCard";
import { SentCommsCard } from "./SentCommsCard";
import { UpcomingCallCard } from "./UpcomingCallCard";
import { deriveDealState } from "@/lib/deal-state";
import { demoEmailDraft } from "@/lib/demo-drafts";
import { DEMO_DR_PROB } from "@/lib/forecast-room";
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
import { DEFAULT_TENANT_SLUG, withTenant } from "@/lib/tenant-nav";

const STAGE_LABELS: Record<string, string> = {
  SQL0: "Lead",
  SQL1: "Develop Opportunity",
  SQL2: "Solution Finalization",
  SQL3: "Proposal Validation",
  SQL4: "Negotiations",
  SQL5: "Agreement Formalization",
};

function quarterLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}
function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// Trim a captured answer to a clean one-liner for the Overview summary.
function oneLine(s: string, max = 90): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > 20 ? cut.slice(0, sp) : cut).replace(/[.,;]$/, "") + "…";
}

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

// Winning plays learned from won/lost freight & customs deals, shown at the
// bottom of the deal so the rep sees the move a top rep would make, not just the gap.
function PlaysCard({ account, nextAction }: { account: string; nextAction: string }) {
  const plays = [
    {
      objection: "“We can keep doing the manual entry through peak.”",
      play: "Quantify the re-keying hours against one missed peak week. The deals that close lead with the cost of delay, not the feature list.",
      proof: "Won on 4 of 6 freight deals",
    },
    {
      objection: "“The economic buyer does not need to be on the call.”",
      play: "Frame the session as a 15-minute risk review for the signer, not a demo. Single-threaded deals this size stall at procurement.",
      proof: "Won on Harborview and Anchor",
    },
    {
      objection: "“We are also looking at our incumbent WMS.”",
      play: "Name the switching cost first and show the two lanes where the manual work disappears. Do not let the incumbent frame it as parity.",
      proof: "Won on competitive displacements",
    },
  ];
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-6 py-5">
      <h2 className="text-[15px] font-semibold text-ink">How deals like {account} were won and lost</h2>
      <p className="text-[12.5px] text-muted mt-0.5">The move a top rep would make, learned from won and lost freight and customs deals.</p>
      <div className="mt-4 space-y-3">
        {plays.map((p, i) => (
          <div key={i} className="border border-line rounded-lg px-4 py-3">
            <div className="text-[12.5px] italic text-muted">{p.objection}</div>
            <div className="text-[13.5px] text-ink leading-relaxed mt-1.5">
              <span className="text-[10px] uppercase tracking-wider font-semibold text-accent mr-1.5">Winning play</span>
              {p.play}
            </div>
            <div className="text-[11px] text-muted mt-1.5">{p.proof}</div>
          </div>
        ))}
      </div>
      <div className="mt-4 pt-3 border-t border-line">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-accent">What this means for {account}</div>
        <div className="text-[13.5px] text-ink leading-relaxed mt-1">{nextAction}</div>
      </div>
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
  tenant = DEFAULT_TENANT_SLUG,
}: {
  deal: Deal;
  framework: Framework;
  upcomingCall?: UpcomingCall | null;
  rolldogSummary?: RolldogSummary | null;
  croRead?: CroRead | null;
  sentMessages?: SentMessage[];
  history?: DealHistory;
  attendance?: CallAttendance[];
  /** Active tenant slug; drives ?tenant on internal links. Defaults to magaya. */
  tenant?: string;
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

  // Explicit risk callouts for the Signals & Risk tab.
  const risks: string[] = [];
  if (forecastMismatch)
    risks.push(`Rep has this at ${repCategory}, but only ${confirmed} of ${total} gates are confirmed by the calls.`);
  if (ebRisk) risks.push("The budget owner / economic buyer has never been on a call.");
  if (attSilent > 0)
    risks.push(`${attSilent} invited stakeholder${attSilent > 1 ? "s" : ""} did not speak on the last call.`);
  if (!dealState.nextStepAnswer)
    risks.push("No firm next step is captured. Lock a dated mutual action plan.");

  // What the calls actually captured, top gates first, for the Overview lead card.
  const capturedGates = framework.fields
    .filter((f) => f.stageKey)
    .map((f) => {
      const ex = deal.extraction[f.fieldKey];
      return ex && ex.status === "Yes" && ex.answer ? { label: f.label, answer: ex.answer } : null;
    })
    .filter((g): g is { label: string; answer: string } => g !== null)
    .slice(0, 4);

  // The captured-summary lead card is gated to non-magaya tenants so the live
  // pilot's Overview stays byte-identical to today. Keelson (and any demo tenant)
  // gets the richer lead. isDemo also switches the whole page to the single-scroll
  // AE-flow layout (no tabs, no Mark's read).
  const showCaptureLead = tenant !== DEFAULT_TENANT_SLUG;
  const isDemo = showCaptureLead;

  // The pre-call briefing DealRipe prepared, for the upcoming-call card.
  const briefing = sentMessages.find((m) => m.kind === "briefing") ?? null;
  // A plausible near-future weekday for the next call (or the real upcoming one).
  const upcomingWhen =
    upcoming?.when ??
    (() => {
      const d = new Date();
      let added = 0;
      while (added < 3) {
        d.setDate(d.getDate() + 1);
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) added += 1;
      }
      return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    })();
  const upcomingSubtitle = briefing
    ? "Pre-call briefing prepared by DealRipe"
    : upcoming?.briefing ?? "No briefing prepared yet";

  // Inputs for the interactive "extract this call" flow (demo only).
  const latestCall = [...deal.calls]
    .filter((c) => c.date)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
  const latestCallLabel = latestCall
    ? new Date(latestCall.date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : "Most recent";
  const callParticipants = (latestCall?.participants ?? []).join(", ") || "Customer stakeholders";
  const extractGates = framework.fields
    .filter((f) => f.stageKey)
    .map((f) => {
      const ex = deal.extraction[f.fieldKey];
      return ex && ex.status === "Yes" && ex.answer ? { label: f.label, answer: oneLine(ex.answer, 64) } : null;
    })
    .filter((g): g is { label: string; answer: string } => g !== null)
    .slice(0, 8);
  const extractStakeholder = (() => {
    const eb = deal.contacts.find((c) => c.relationship === "economic_buyer");
    return eb ? { name: eb.name, role: eb.role } : null;
  })();
  const CRM_SECTIONS = new Set(["Situation", "Timeline", "Budget", "Competition", "People"]);
  const crmFields = (() => {
    // Salesforce-framework tenants (NEAT): the exact opportunity fields written.
    const sf = framework.fields
      .filter((f) => {
        const wt = f.writeTarget as { system?: string; field?: string } | null;
        return wt?.system === "salesforce" && wt.field && deal.extraction[f.fieldKey]?.status === "Yes";
      })
      .map((f) => String((f.writeTarget as { field?: string }).field));
    if (sf.length > 0) return Array.from(new Set(sf));
    const distinct = Array.from(new Set(extractGates.map((g) => g.label))).filter((l) => CRM_SECTIONS.has(l));
    return distinct.length > 0 ? distinct : ["Situation", "Budget", "Timeline"];
  })();
  // Open gaps + risk flags the call did NOT close, so the extraction shows the
  // work still outstanding, not only what was captured.
  const extractOpenGates = dealState.topGaps.slice(0, 6).map((g) => ({ label: g.label }));
  const extractFlags = risks;

  const overviewPanel = (
    <div className="space-y-5">
      {/* Lead: what DealRipe captured on the last call + the prescribed next action. */}
      {showCaptureLead && (
        <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
              What DealRipe captured on the last call
            </div>
            <div className="text-[11px] text-muted whitespace-nowrap">{confirmed} of {total} gates confirmed</div>
          </div>
          {capturedGates.length > 0 ? (
            <ul className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
              {capturedGates.map((g, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px] leading-snug">
                  <span className="mt-[5px] h-1.5 w-1.5 rounded-full bg-accent shrink-0" />
                  <span className="text-ink">
                    <span className="font-medium">{g.label}:</span> <span className="text-muted">{oneLine(g.answer)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[13px] text-muted mt-1.5">No qualification gates confirmed from calls yet.</div>
          )}
          <div className="mt-3 pt-3 border-t border-line">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-accent">Prescribed next action</div>
            <div className="text-[13.5px] text-ink leading-relaxed mt-1">{nextAction}</div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-5 items-stretch">
        <DealStateCard state={dealState} />
        <div className="bg-white rounded-xl2 shadow-card border-2 border-accent/40 px-5 py-4 flex flex-col">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-accent">Do next</div>
          <div className="text-[14px] text-ink leading-relaxed mt-1.5 flex-1">{nextAction}</div>
          <Link
            href={withTenant(`/deals/${deal.id}/prepare`, tenant)}
            className="mt-3 block w-full text-center px-4 py-2.5 rounded-xl2 bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 transition"
          >
            Prepare next call
          </Link>
        </div>
      </div>

      <CroReadCard dealId={deal.id} initial={croRead ?? null} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Upcoming call</div>
          {upcoming ? (
            <>
              <div className="text-[15px] font-semibold text-ink mt-1.5">{upcoming.when}</div>
              <div className={`text-[12px] mt-1 ${upcomingCall?.briefingSentAt ? "text-accent font-medium" : "text-muted"}`}>
                {upcomingCall?.briefingSentAt ? "✓ " : ""}
                {upcoming.briefing}
              </div>
            </>
          ) : (
            <div className="text-[13px] text-muted mt-1.5">
              No upcoming meeting synced yet. It appears once the rep schedules a call with this customer.
            </div>
          )}
        </div>
        <ContactsCard contacts={deal.contacts} />
      </div>
    </div>
  );

  const signalsPanel = (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SignalChip
          label="Forecast"
          value={forecastMismatch ? `Rep ${repCategory}, evidence lags` : `Rep ${repCategory}`}
          tone={forecastMismatch ? "danger" : "muted"}
        />
        <SignalChip
          label="Attendance"
          value={latestAtt ? `${attSpoke} took part${attSilent > 0 ? `, ${attSilent} no-show` : ""}` : "No call captured yet"}
          tone={attSilent > 0 ? "danger" : latestAtt ? "accent" : "muted"}
        />
        <SignalChip
          label="Budget owner"
          value={ebRisk ? "Never engaged" : "No gap flagged"}
          tone={ebRisk ? "danger" : "muted"}
        />
      </div>

      <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-muted mb-2">Open risks</div>
        {risks.length === 0 ? (
          <div className="text-[13px] text-muted">No open risks flagged. The calls back the current forecast.</div>
        ) : (
          <ul className="space-y-2">
            {risks.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] text-ink">
                <span className="mt-[3px] h-1.5 w-1.5 rounded-full bg-danger shrink-0" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {attendance && attendance.length > 0 && <AttendanceCard history={attendance} />}
    </div>
  );

  const progressPanel = (
    <div className="space-y-5">
      <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-3.5 flex items-center justify-between">
        <span className="text-[13px] text-ink">
          <span className="font-semibold">{confirmed}</span> of {total} qualification gates confirmed from calls
        </span>
        <span className="text-[12px] text-muted">
          Furthest stage: {STAGE_LABELS[dealState.reachedStageKey ?? deal.stageKey] ?? dealState.reachedStageKey ?? deal.stageKey}
        </span>
      </div>
      <MagayaOpportunityControl
        framework={framework}
        extraction={deal.extraction}
        currentStageKey={deal.stageKey}
        dealId={deal.id}
        capturedByField={history?.perGate ?? {}}
      />
    </div>
  );

  const changeLogPanel = (
    <div className="space-y-5">
      {history && history.timeline.length > 0 ? (
        <DealHistoryCard dealId={deal.id} timeline={history.timeline} />
      ) : (
        <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
          No captured calls have moved this deal yet.
        </div>
      )}
      <TeamsCallsCard dealId={deal.id} calls={deal.calls} />
      <SentCommsCard messages={sentMessages} />
    </div>
  );

  // Demo header inputs: rep vs DealRipe as a probability + close date. No Rolldog.
  const demoRepProb = deal.repForecastProbability ?? 0;
  const demoDrProb = DEMO_DR_PROB[deal.account] ?? Math.round(demoRepProb * completion * 100) / 100;
  const demoRepPct = Math.round(demoRepProb * 100);
  const demoDrPct = Math.round(demoDrProb * 100);
  const demoRepClose = deal.repForecastCloseDate || null;
  // DealRipe pushes the close date when it reads the deal softer than the rep.
  const demoDrClose =
    demoDrProb < demoRepProb - 0.05 && demoRepClose
      ? new Date(new Date(demoRepClose).getTime() + 45 * 86_400_000).toISOString().slice(0, 10)
      : demoRepClose;

  // Header: the rep, the money, and what DealRipe is saying. Shared by both layouts.
  const header = (
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
            <div className="text-[22px] font-semibold text-ink">${deal.arr.toLocaleString()}</div>
            <div className="text-[12px] text-muted mt-0.5">
              {STAGE_LABELS[deal.stageKey] ?? deal.stageKey}
              {deal.daysInStage ? ` · ${deal.daysInStage} days in stage` : ""}
            </div>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-line grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Rep category</div>
            <div className="text-[13px] text-ink mt-1">
              {repCategory}
              {deal.repForecastCloseDate ? ` · close ${deal.repForecastCloseDate}` : ""}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Rolldog score</div>
            <div className="text-[13px] text-ink mt-1">
              {rolldogSummary?.score ?? "—"}
              {rolldogSummary?.qRank ? ` · rank ${rolldogSummary.qRank}` : ""}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">DealRipe read</div>
            <div className="text-[13px] text-ink mt-1">
              {confirmed} of {total} gates confirmed
            </div>
          </div>
        </div>
      </div>
  );

  // Demo tenant: the clean deal view. Header shows only Rep forecast vs DealRipe
  // forecast (no Rolldog). Opportunity Control on the left; Contacts, Recent calls
  // (click to watch the extraction), and the Upcoming call on the right. Nothing else.
  if (isDemo) {
    return (
      <div className="space-y-5">
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
              <div className="text-[22px] font-semibold text-ink">${deal.arr.toLocaleString()}</div>
              <div className="text-[12px] text-muted mt-0.5">
                {STAGE_LABELS[deal.stageKey] ?? deal.stageKey}
                {deal.daysInStage ? ` · ${deal.daysInStage} days in stage` : ""}
              </div>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-line grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Rep forecast</div>
              <div className="text-[13px] text-ink mt-1">
                {demoRepPct}% probability
                {quarterLabel(demoRepClose) ? ` · ${quarterLabel(demoRepClose)} close` : ""}
                {shortDate(demoRepClose) ? ` · ${shortDate(demoRepClose)}` : ""}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">DealRipe forecast</div>
              <div className={`text-[13px] font-semibold mt-1 ${demoDrPct < demoRepPct ? "text-danger" : "text-ink"}`}>
                {demoDrPct}% probability
                {quarterLabel(demoDrClose) ? ` · ${quarterLabel(demoDrClose)} close` : ""}
                {shortDate(demoDrClose) ? ` · ${shortDate(demoDrClose)}` : ""}
              </div>
            </div>
          </div>
        </div>

        {ebRisk && (
          <DealSavedArc
            repPct={demoRepPct}
            drBeforePct={demoDrPct}
            drAfterPct={Math.min(demoRepPct - 4, demoDrPct + 27)}
            gapAtRiskUsd={Math.round((demoRepProb - demoDrProb) * deal.arr)}
            stakeholderName={extractStakeholder?.name ?? "the economic buyer"}
            stakeholderRole={extractStakeholder?.role ?? "signer"}
            championName={deal.contacts.find((c) => c.relationship === "champion")?.name ?? "your champion"}
            actionTitle={`Book a short risk review with ${extractStakeholder?.name ?? "the signer"} before the proposal ages, the way your top closers get the signer in the room.`}
            bestRepNote="Learned from your last 6 won deals of this shape: every one had the economic buyer in a call by this stage."
            motionNote="At Keelson, mid-market deals that reach proposal without the signer engaged slip a quarter two times out of three."
            draft={demoEmailDraft(deal.account)}
          />
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1.55fr_1fr] gap-5 items-start">
          <MagayaOpportunityControl
            framework={framework}
            extraction={deal.extraction}
            currentStageKey={deal.stageKey}
            dealId={deal.id}
            capturedByField={history?.perGate ?? {}}
            labelName="Keelson"
          />
          <div className="space-y-5">
            <ContactsCard contacts={deal.contacts} />
            <CallExtractFlow
              callLabel={latestCallLabel}
              participants={callParticipants}
              gates={extractGates}
              openGates={extractOpenGates}
              flags={extractFlags}
              stakeholder={extractStakeholder}
              crmFields={crmFields}
              nextAction={nextAction}
              actionHref={withTenant(`/actions?deal=${deal.id}`, tenant)}
              extractHref={latestCall ? withTenant(`/deals/${deal.id}/extract?callId=${latestCall.id}`, tenant) : undefined}
            />
            <EarlierCallsCard
              calls={[...deal.calls].filter((c) => c.date && c.id !== latestCall?.id).sort((a, b) => Date.parse(b.date) - Date.parse(a.date))}
              tenant={tenant}
            />
            <UpcomingCallCard when={upcomingWhen} subtitle={upcomingSubtitle} briefing={briefing} />
          </div>
        </div>

        <PlaysCard account={deal.account} nextAction={nextAction} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {header}
      {/* Tabbed detail. */}
      <DealTabs
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "signals", label: "Signals & Risk" },
          { key: "progress", label: "Progress" },
          { key: "changelog", label: "Change Log" },
        ]}
        panels={{
          overview: overviewPanel,
          signals: signalsPanel,
          progress: progressPanel,
          changelog: changeLogPanel,
        }}
      />
    </div>
  );
}
