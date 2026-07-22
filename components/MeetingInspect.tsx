"use client";

import Link from "next/link";
import { useState } from "react";

import { AttendanceCard } from "./AttendanceCard";
import { ContactsCard } from "./ContactsCard";
import { TranscriptView } from "./TranscriptView";
import type { CallAttendance } from "@/lib/attendance";
import { callSubtypeLabel } from "@/lib/meeting-classify";
import type { MeetingDetail } from "@/lib/meetings";
import type { Contact } from "@/lib/seed-data";

const TYPE_LABEL: Record<string, string> = {
  new_opportunity: "New opportunity",
  existing_customer: "Customer meeting",
  internal: "Internal",
};

const OPP_SUBTYPES = new Set(["discovery", "demo", "proposal", "follow_up"]);

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return "—";
  }
}

type Tab = "summary" | "transcript";

export function MeetingInspect({
  meeting,
  attendance,
  contacts,
  recapHtml,
}: {
  meeting: MeetingDetail;
  attendance: CallAttendance | null;
  contacts: Contact[];
  recapHtml: string | null;
}) {
  const [tab, setTab] = useState<Tab>("summary");
  const typeLabel =
    callSubtypeLabel(meeting.callSubtype) ??
    (meeting.meetingType ? TYPE_LABEL[meeting.meetingType] ?? meeting.meetingType : null);
  const isOpp =
    (meeting.callSubtype ? OPP_SUBTYPES.has(meeting.callSubtype) : false) ||
    meeting.meetingType === "new_opportunity";
  const headerTitle = meeting.title?.trim() || meeting.account;
  const showAccountSub = headerTitle !== meeting.account;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-white rounded-xl2 shadow-card border border-line px-6 py-5">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-[20px] font-semibold text-ink">{headerTitle}</h1>
              {typeLabel && (
                <span
                  className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                    isOpp ? "bg-accent/10 text-accent" : "bg-ink/[0.06] text-muted"
                  }`}
                >
                  {typeLabel}
                </span>
              )}
            </div>
            <p className="text-[13px] text-muted mt-1">
              {showAccountSub ? `${meeting.account} · ` : ""}
              {fmtDate(meeting.date)}
              {meeting.durationMin != null ? ` · ${meeting.durationMin} min` : ""}
              {meeting.rep ? ` · ${meeting.rep}'s deal` : ""}
            </p>
          </div>
          <Link
            href={`/deals/${meeting.dealId}`}
            className="text-[12px] font-semibold text-ink bg-bg border border-line hover:border-ink/30 rounded-md px-3 py-1.5 transition"
          >
            Open deal →
          </Link>
        </div>

        <div className="mt-4 flex items-center gap-5 border-t border-line pt-3">
          <TabBtn label="Summary" active={tab === "summary"} onClick={() => setTab("summary")} />
          <TabBtn label="Transcript" active={tab === "transcript"} onClick={() => setTab("transcript")} />
        </div>
      </div>

      {tab === "summary" ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
          <div className="space-y-5">
            {attendance ? (
              <AttendanceCard history={[attendance]} />
            ) : (
              <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
                No attendee list captured for this call.
              </div>
            )}
            <ContactsCard contacts={contacts} />
          </div>
          <div>
            {recapHtml ? (
              <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
                <div className="px-5 py-3 border-b border-line">
                  <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
                    DealRipe recap
                  </div>
                  <div className="text-[12px] text-muted mt-0.5">What the rep received after this call.</div>
                </div>
                <iframe
                  title="Recap"
                  srcDoc={recapHtml}
                  className="w-full"
                  style={{ height: 620, border: 0 }}
                />
              </div>
            ) : (
              <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
                No recap generated for this meeting yet.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl2 shadow-card border border-line px-6 py-5">
          {meeting.transcript.trim().length > 0 ? (
            <div className="max-h-[70vh] overflow-y-auto">
              <TranscriptView
                body={meeting.transcript}
                account={meeting.account}
                callDate={meeting.date}
              />
            </div>
          ) : (
            <div className="text-[13px] text-muted">No transcript available for this meeting.</div>
          )}
        </div>
      )}
    </div>
  );
}

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`text-[13px] pb-2 -mb-3 border-b-2 transition ${
        active ? "border-accent text-ink font-medium" : "border-transparent text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}
