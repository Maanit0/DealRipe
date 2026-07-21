import type { CallAttendance } from "@/lib/attendance";

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

function counts(call: CallAttendance) {
  const spoke = call.invitees.filter((i) => i.spoke).length;
  const total = call.invitees.length;
  // A "no-show" is only meaningful for someone who was actually invited. People
  // who joined without an invite are, by definition, present.
  const silent = call.invitees.filter((i) => i.onInvite && !i.spoke).length;
  return { spoke, total, silent };
}

/**
 * Who took part on each call, newest first. The latest call is shown in full
 * (invitees, RSVP, joined-not-invited); earlier calls stay as compact one-line
 * rows so the attendance trend accumulates instead of the newest call wiping the
 * last. A budget holder who engages on call 1 and goes silent on call 3 is
 * exactly what this should make visible.
 */
export function AttendanceCard({ history }: { history: CallAttendance[] }) {
  if (!history || history.length === 0) return null;
  const [latest, ...earlier] = history;
  const c = counts(latest);

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
          Meeting attendance
        </div>
        <div className="text-[11px] text-muted">{fmt(latest.callDate)} call</div>
      </div>

      <div className={`text-[13px] mt-1.5 ${c.silent > 0 ? "text-danger" : "text-ink"}`}>
        {c.spoke} of {c.total} customer stakeholder{c.total === 1 ? "" : "s"} took part
        {c.silent > 0 ? `, ${c.silent} invited but did not speak` : ""}
      </div>

      <div className="mt-3 space-y-2">
        {latest.invitees.map((i, idx) => {
          const label = i.name ?? i.email ?? "Unknown attendee";
          const resp = i.responseStatus ? RESP[i.responseStatus] ?? i.responseStatus : null;
          return (
            <div key={`${label}-${idx}`} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] text-ink font-medium truncate">{label}</div>
                {i.email && i.name && (
                  <div className="text-[11px] text-muted truncate">{i.email}</div>
                )}
                {i.onInvite ? (
                  resp && <div className="text-[11px] text-muted mt-0.5">RSVP: {resp}</div>
                ) : (
                  <div className="text-[11px] text-muted mt-0.5">Joined, not on invite</div>
                )}
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

      {c.silent > 0 && (
        <p className="text-[11px] text-muted mt-3 leading-snug">
          &ldquo;No-show&rdquo; means invited but never heard on the call. A silent
          attendee reads the same way. Worth confirming before the next step.
        </p>
      )}

      {earlier.length > 0 && (
        <div className="mt-4 pt-3 border-t border-line">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted mb-2">
            Earlier calls
          </div>
          <div className="space-y-1.5">
            {earlier.map((call) => {
              const ec = counts(call);
              return (
                <div
                  key={call.callId}
                  className="flex items-baseline justify-between gap-3 text-[12px]"
                >
                  <span className="text-muted">{fmt(call.callDate)}</span>
                  <span className={ec.silent > 0 ? "text-danger" : "text-ink"}>
                    {ec.spoke} of {ec.total} took part
                    {ec.silent > 0 ? ` · ${ec.silent} no-show` : ""}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
