import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { getMeetings, type MeetingListItem } from "@/lib/meetings";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  new_opportunity: "New opportunity",
  existing_customer: "Customer",
  internal: "Internal",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return "—";
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    });
  } catch {
    return "";
  }
}

function participantLabel(names: string[]): string {
  if (names.length === 0) return "No customer attendees";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled"]);

export default async function MeetingsPage() {
  let meetings: MeetingListItem[] = [];
  try {
    const tenantId = await resolveTenantId("magaya");
    meetings = await getMeetings(tenantId);
  } catch (err) {
    console.error("[meetings] load failed:", err);
  }

  return (
    <AppShell active="meetings">
      <div className="max-w-[1100px] mx-auto px-6 py-7">
        <h1 className="text-[24px] font-semibold tracking-tight text-ink">Meetings</h1>
        <p className="text-[13px] text-muted mt-1">
          Every call DealRipe captured, newest first. Click one to inspect what was said, who took
          part, and what it moved.
        </p>

        {meetings.length === 0 ? (
          <div className="mt-6 bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
            No captured meetings yet. They appear here after DealRipe joins and records a call.
          </div>
        ) : (
          <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
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
                {meetings.map((m, i) => {
                  const noContent = m.outcome ? NO_CONTENT.has(m.outcome) : false;
                  const meta = [fmtTime(m.date), m.durationMin != null ? `${m.durationMin} min` : ""]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <tr key={m.callId} className={i < meetings.length - 1 ? "border-b border-line" : undefined}>
                      <td className="pl-5 py-3.5 align-top whitespace-nowrap">
                        <div className="text-[13px] font-medium text-ink">{fmtDate(m.date)}</div>
                        {meta && <div className="text-[11px] text-muted mt-0.5">{meta}</div>}
                      </td>
                      <td className="py-3.5 align-top">
                        <Link
                          href={`/meetings/${m.callId}`}
                          className="text-[14px] font-semibold text-ink hover:text-accent transition"
                        >
                          {participantLabel(m.participants)}
                        </Link>
                        {noContent && (
                          <span className="ml-2 text-[10px] uppercase tracking-wider font-bold text-danger">
                            No-show
                          </span>
                        )}
                        <div className="text-[11px] text-muted mt-0.5">
                          {m.rep ? `${m.rep}'s call` : "Unassigned"}
                        </div>
                      </td>
                      <td className="py-3.5 align-top text-[12px]">
                        {m.meetingType ? (
                          <span
                            className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                              m.meetingType === "new_opportunity"
                                ? "bg-accent/10 text-accent"
                                : "bg-ink/[0.06] text-muted"
                            }`}
                          >
                            {TYPE_LABEL[m.meetingType] ?? m.meetingType}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
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
