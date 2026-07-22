import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { MeetingsFilterBar } from "@/components/MeetingsFilterBar";
import { callSubtypeLabel } from "@/lib/meeting-classify";
import { getMeetings, getUpcomingMeetings, type MeetingListItem } from "@/lib/meetings";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  new_opportunity: "New opportunity",
  existing_customer: "Customer",
  internal: "Internal",
};

const OPP_SUBTYPES = new Set(["discovery", "demo", "proposal", "follow_up"]);

function typeLabel(m: MeetingListItem): string | null {
  return callSubtypeLabel(m.callSubtype) ?? (m.meetingType ? TYPE_LABEL[m.meetingType] : null);
}
function isOppType(m: MeetingListItem): boolean {
  return (m.callSubtype ? OPP_SUBTYPES.has(m.callSubtype) : false) || m.meetingType === "new_opportunity";
}
function meetingLabel(m: MeetingListItem): string {
  return m.title?.trim() || participantLabel(m.participants);
}

const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled"]);

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  } catch {
    return "—";
  }
}
function fmtTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  } catch {
    return "";
  }
}
function participantLabel(names: string[]): string {
  if (names.length === 0) return "No customer attendees";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}
function isNoShow(m: MeetingListItem): boolean {
  return m.outcome ? NO_CONTENT.has(m.outcome) : false;
}

type SP = {
  view?: string;
  type?: string;
  rep?: string;
  deal?: string;
  range?: string;
  status?: string;
  q?: string;
};

function applyFilters(list: MeetingListItem[], sp: SP): MeetingListItem[] {
  const now = Date.now();
  const rangeMs =
    sp.range === "7d" ? 7 : sp.range === "30d" ? 30 : sp.range === "90d" ? 90 : null;
  const q = (sp.q ?? "").toLowerCase().trim();
  return list.filter((m) => {
    if (sp.type && m.callSubtype !== sp.type && m.meetingType !== sp.type) return false;
    if (sp.rep && (m.rep ?? "") !== sp.rep) return false;
    if (sp.deal && m.dealId !== sp.deal) return false;
    if (sp.status === "noshow" && !isNoShow(m)) return false;
    if (sp.status === "hide_noshow" && isNoShow(m)) return false;
    if (rangeMs != null) {
      const t = Date.parse(m.date ?? "");
      if (!Number.isFinite(t) || t < now - rangeMs * 86400000) return false;
    }
    if (q) {
      const hay = `${m.account} ${m.participants.join(" ")} ${m.rep ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export default async function MeetingsPage({ searchParams }: { searchParams: SP }) {
  const view = searchParams.view === "upcoming" ? "upcoming" : "recorded";
  let recorded: MeetingListItem[] = [];
  let upcoming: MeetingListItem[] = [];
  try {
    const tenantId = await resolveTenantId("magaya");
    [recorded, upcoming] = await Promise.all([getMeetings(tenantId), getUpcomingMeetings(tenantId)]);
  } catch (err) {
    console.error("[meetings] load failed:", err);
  }

  const all = [...recorded, ...upcoming];
  const reps = Array.from(new Set(all.map((m) => m.rep).filter((r): r is string => !!r))).sort();
  const deals = Array.from(new Map(all.map((m) => [m.dealId, m.account] as const)))
    .map(([id, account]) => ({ id, account }))
    .sort((a, b) => a.account.localeCompare(b.account));

  const active = view === "upcoming" ? upcoming : recorded;
  const rows = applyFilters(active, searchParams);

  return (
    <AppShell active="meetings">
      <div className="max-w-[1100px] mx-auto px-6 py-7">
        <h1 className="text-[24px] font-semibold tracking-tight text-ink">Meetings</h1>
        <p className="text-[13px] text-muted mt-1">
          {view === "upcoming"
            ? "Scheduled calls DealRipe is set to join, soonest first."
            : "Every call DealRipe captured, newest first. Click one to inspect what was said, who took part, and what it moved."}
        </p>

        <MeetingsFilterBar options={{ reps, deals }} />

        {rows.length === 0 ? (
          <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
            {view === "upcoming"
              ? "No upcoming meetings on the calendar."
              : "No meetings match these filters."}
          </div>
        ) : (
          <div className="mt-4 bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-line">
                  <Th className="pl-5">Date</Th>
                  <Th>Meeting</Th>
                  <Th>Type</Th>
                  <Th className="pr-5">Deal</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m, i) => {
                  const meta = [fmtTime(m.date), m.durationMin != null ? `${m.durationMin} min` : ""]
                    .filter(Boolean)
                    .join(" · ");
                  const clickable = view === "recorded";
                  return (
                    <tr key={m.callId} className={i < rows.length - 1 ? "border-b border-line" : undefined}>
                      <td className="pl-5 py-3.5 align-top whitespace-nowrap">
                        <div className="text-[13px] font-medium text-ink">{fmtDate(m.date)}</div>
                        {meta && <div className="text-[11px] text-muted mt-0.5">{meta}</div>}
                      </td>
                      <td className="py-3.5 align-top">
                        {clickable ? (
                          <Link
                            href={`/meetings/${m.callId}`}
                            className="text-[14px] font-semibold text-ink hover:text-accent transition"
                          >
                            {meetingLabel(m)}
                          </Link>
                        ) : (
                          <span className="text-[14px] font-semibold text-ink">{meetingLabel(m)}</span>
                        )}
                        {isNoShow(m) && (
                          <span className="ml-2 text-[10px] uppercase tracking-wider font-bold text-danger">
                            No-show
                          </span>
                        )}
                        <div className="text-[11px] text-muted mt-0.5 truncate max-w-[380px]">
                          {m.participants.length > 0 ? participantLabel(m.participants) + " · " : ""}
                          {m.rep ? `${m.rep}'s call` : "Unassigned"}
                        </div>
                      </td>
                      <td className="py-3.5 align-top text-[12px]">
                        {typeLabel(m) ? (
                          <span
                            className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                              isOppType(m) ? "bg-accent/10 text-accent" : "bg-ink/[0.06] text-muted"
                            }`}
                          >
                            {typeLabel(m)}
                          </span>
                        ) : (
                          <span className="text-muted">{view === "upcoming" ? "Scheduled" : "—"}</span>
                        )}
                      </td>
                      <td className="py-3.5 align-top pr-5">
                        <Link
                          href={`/deals/${m.dealId}`}
                          className="text-[13px] text-ink hover:text-accent transition"
                        >
                          {m.account}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`text-[10px] uppercase tracking-wider font-semibold text-muted py-2.5 ${className}`}>
      {children}
    </th>
  );
}
