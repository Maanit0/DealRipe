import type { DealAttendance } from "@/lib/attendance";

function fmt(iso: string | null): string {
  if (!iso) return "the last";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return "the last";
  }
}

// Calendar RSVP -> plain label. Exact, from the invite; not inferred.
const RESP: Record<string, string> = {
  accepted: "Accepted",
  tentativelyAccepted: "Tentative",
  declined: "Declined",
  notResponded: "No response",
  none: "No response",
  organizer: "Organizer",
};

/**
 * Who was invited to the last real call and who actually took part. The invite
 * list and RSVP come straight from the calendar; "spoke" is read from the
 * transcript. A customer who was invited but never speaks is the signal a rep
 * misses: the budget holder was in the room on paper, not in practice.
 */
export function AttendanceCard({ attendance }: { attendance: DealAttendance }) {
  if (!attendance || attendance.invitees.length === 0) return null;

  const spoke = attendance.invitees.filter((i) => i.spoke).length;
  const total = attendance.invitees.length;
  const silent = total - spoke;

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
          Meeting attendance
        </div>
        <div className="text-[11px] text-muted">{fmt(attendance.callDate)} call</div>
      </div>

      <div className={`text-[13px] mt-1.5 ${silent > 0 ? "text-danger" : "text-ink"}`}>
        {spoke} of {total} invited customer{total === 1 ? "" : "s"} took part
        {silent > 0 ? `, ${silent} invited but did not speak` : ""}
      </div>

      <div className="mt-3 space-y-2">
        {attendance.invitees.map((i, idx) => {
          const label = i.name ?? i.email ?? "Unknown invitee";
          const resp = i.responseStatus ? RESP[i.responseStatus] ?? i.responseStatus : null;
          return (
            <div key={`${label}-${idx}`} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] text-ink font-medium truncate">{label}</div>
                {i.email && i.name && (
                  <div className="text-[11px] text-muted truncate">{i.email}</div>
                )}
                {resp && <div className="text-[11px] text-muted mt-0.5">RSVP: {resp}</div>}
              </div>
              <span
                className={`shrink-0 text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-full ${
                  i.spoke ? "bg-accent/10 text-accent" : "bg-danger/10 text-danger"
                }`}
              >
                {i.spoke ? "Spoke" : "No-show"}
              </span>
            </div>
          );
        })}
      </div>

      {silent > 0 && (
        <p className="text-[11px] text-muted mt-3 leading-snug">
          &ldquo;No-show&rdquo; means invited but never heard on the call. A silent
          attendee reads the same way. Worth confirming before the next step.
        </p>
      )}
    </div>
  );
}
