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
                  <Th>Account</Th>
                  <Th>Rep</Th>
                  <Th>Type</Th>
                  <Th className="text-right pr-5">Length</Th>
                </tr>
              </thead>
              <tbody>
                {meetings.map((m, i) => {
                  const noContent = m.outcome ? NO_CONTENT.has(m.outcome) : false;
                  return (
                    <tr key={m.callId} className={i < meetings.length - 1 ? "border-b border-line" : undefined}>
                      <td className="pl-5 py-3.5 text-[12px] text-muted whitespace-nowrap">
                        {fmtDate(m.date)}
                      </td>
                      <td className="py-3.5">
                        <Link
                          href={`/meetings/${m.callId}`}
                          className="text-[14px] font-semibold text-ink hover:text-accent transition"
                        >
                          {m.account}
                        </Link>
                        {noContent && (
                          <span className="ml-2 text-[10px] uppercase tracking-wider font-bold text-danger">
                            No-show
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 text-[12px] text-ink">{m.rep ?? "—"}</td>
                      <td className="py-3.5 text-[12px]">
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
                      <td className="py-3.5 text-right pr-5 text-[12px] text-muted whitespace-nowrap">
                        {m.durationMin != null ? `${m.durationMin} min` : "—"}
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
