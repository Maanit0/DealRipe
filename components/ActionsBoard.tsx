"use client";

import { useEffect, useMemo, useState } from "react";

import { demoEmailDraft, upcomingSlots } from "@/lib/demo-drafts";
import type { TaskItem } from "@/lib/tasks";

// The interactive Actions decision layer (non-magaya tenants only). Each action
// row opens a modal: a drafted email to review and "send", or a calendar broker
// to pick a slot and "book". Purely client-side mock, no network, no real send.
// Reuses the SentCommsCard overlay pattern (fixed overlay, Escape/backdrop close).

const PRIORITY: Record<string, { label: string; cls: string; order: number }> = {
  high: { label: "High", cls: "bg-danger/10 text-danger", order: 0 },
  medium: { label: "Medium", cls: "bg-warn/10 text-warn", order: 1 },
  low: { label: "Low", cls: "bg-ink/[0.06] text-muted", order: 2 },
};
const TYPE_LABEL: Record<string, string> = {
  email: "Email",
  book_meeting: "Book meeting",
  send_materials: "Send materials",
  internal: "Internal",
  other: "Action",
};

const PRESCRIBED_PREFIX = "DealRipe prescribed";

function isBooking(t: TaskItem): boolean {
  return t.actionType === "book_meeting";
}
// Prefer a grounded email (which already carries proposed times) over the raw
// calendar picker: asking a champion to broker a meeting is an email with times,
// not DealRipe silently booking. The picker is a fallback when no draft exists.
function actionIsEmail(t: TaskItem): boolean {
  return !!demoEmailDraft(t.account) || !isBooking(t);
}
function isPrescribed(t: TaskItem): boolean {
  return (t.detail ?? "").startsWith(PRESCRIBED_PREFIX);
}
// The task detail without the prescribed sentinel, for clean display.
function cleanDetail(t: TaskItem): string | null {
  if (!t.detail) return null;
  if (isPrescribed(t)) {
    const stripped = t.detail.replace(/^DealRipe prescribed this next step because [^.]*\.\s*/i, "").trim();
    return stripped || null;
  }
  return t.detail;
}

function fmtDeadline(iso: string | null): { text: string; overdue: boolean; soon: boolean } {
  if (!iso) return { text: "No date", overdue: false, soon: false };
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${iso}T00:00:00`);
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  const text = due.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (days < 0) return { text: `${text} (overdue)`, overdue: true, soon: false };
  if (days === 0) return { text: `${text} (today)`, overdue: false, soon: true };
  if (days === 1) return { text: `${text} (tomorrow)`, overdue: false, soon: true };
  return { text, overdue: false, soon: days <= 2 };
}

// A real customer-facing email draft for an email/materials action. Uses the
// grounded per-account draft for demo deals; otherwise a neutral scheduling email
// (never the internal coaching note, which reads like an instruction to the rep).
function draftEmail(t: TaskItem): { subject: string; body: string; to: string } {
  const demo = demoEmailDraft(t.account);
  if (demo) return demo;
  const account = t.account ?? "the account";
  const body = [
    "Hi,",
    "",
    `I wanted to follow up on where we are with ${account} and find time to connect.`,
    "",
    "A few windows that work on my side:",
    ...upcomingSlots(3).map((s) => `  •  ${s}`),
    "",
    "Let me know what works and I will get it on the calendar.",
    "",
    "Best,",
    t.repEmail ? t.repEmail.split("@")[0] : "the team",
  ].join("\n");
  return { subject: `Following up, ${account}`, body, to: `${account} contact` };
}

// 4 proposed slots over the next business days, for the calendar broker.
function proposeSlots(): Array<{ label: string; se: boolean }> {
  const times = ["10:00 AM PT", "1:30 PM PT", "9:00 AM PT", "3:00 PM PT"];
  const out: Array<{ label: string; se: boolean }> = [];
  const d = new Date();
  let added = 0;
  while (added < 4) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // weekdays only
    const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    out.push({ label: `${day} · ${times[added]}`, se: added % 2 === 0 });
    added += 1;
  }
  return out;
}

export function ActionsBoard({ tasks }: { tasks: TaskItem[] }) {
  const [open, setOpen] = useState<TaskItem | null>(null);
  const [done, setDone] = useState<Record<string, "sent" | "booked">>({});
  const [slot, setSlot] = useState<string | null>(null);
  const slots = useMemo(() => proposeSlots(), []);

  useEffect(() => {
    if (!open) return;
    setSlot(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const openTasks = tasks.filter((t) => t.status !== "done");
  const sortOpen = [...openTasks].sort((a, b) => {
    const pa = PRIORITY[a.priority]?.order ?? 1;
    const pb = PRIORITY[b.priority]?.order ?? 1;
    if (pa !== pb) return pa - pb;
    return (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999");
  });

  function confirm() {
    if (!open) return;
    setDone((prev) => ({ ...prev, [open.id]: actionIsEmail(open) ? "sent" : "booked" }));
    setOpen(null);
  }

  return (
    <div className="mt-5">
      <div className="text-[11px] uppercase tracking-wider font-semibold text-muted mb-2">Open ({openTasks.length})</div>
      <div className="bg-white rounded-xl2 shadow-card border border-line divide-y divide-line overflow-hidden">
        {sortOpen.map((t) => {
          const p = PRIORITY[t.priority] ?? PRIORITY.medium;
          const dl = fmtDeadline(t.deadline);
          const state = done[t.id];
          return (
            <button
              key={t.id}
              onClick={() => setOpen(t)}
              className="w-full text-left px-5 py-4 flex items-start gap-4 hover:bg-bg/50 transition"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full ${p.cls}`}>{p.label}</span>
                  {t.actionType && (
                    <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-ink/[0.05] text-muted">
                      {TYPE_LABEL[t.actionType] ?? t.actionType}
                    </span>
                  )}
                  {isPrescribed(t) && (
                    <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-accent/10 text-accent">
                      DealRipe prescribed
                    </span>
                  )}
                  {state && (
                    <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-accent/10 text-accent">
                      {state === "sent" ? "Sent" : "Booked"}
                    </span>
                  )}
                </div>
                <div className="text-[14px] mt-1.5 text-ink font-medium">{t.title}</div>
                {cleanDetail(t) && <div className="text-[12px] text-muted mt-0.5">{cleanDetail(t)}</div>}
                <div className="text-[11px] text-muted mt-1.5 flex items-center gap-2 flex-wrap">
                  {t.account && <span>{t.account}</span>}
                  {t.repEmail && (
                    <>
                      <span className="text-muted/40">·</span>
                      <span>{t.repEmail}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="shrink-0 flex flex-col items-end gap-2">
                <span className={`text-[11px] whitespace-nowrap ${dl.overdue ? "text-danger font-medium" : dl.soon ? "text-warn" : "text-muted"}`}>{dl.text}</span>
                <span className="text-[11px] font-semibold text-accent">{isBooking(t) ? "Book →" : "Review draft →"}</span>
              </div>
            </button>
          );
        })}
      </div>

      {open && (
        <div onClick={() => setOpen(null)} className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl2 shadow-lg w-full max-w-[560px] max-h-[88vh] flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-4 shrink-0">
              <div>
                <div className="text-[10px] uppercase tracking-wider font-bold text-accent">
                  {isPrescribed(open) ? "DealRipe prescribed" : "Drafted by DealRipe"}
                </div>
                <div className="text-[16px] font-semibold text-ink mt-0.5">{actionIsEmail(open) ? "Follow-up email" : "Book the meeting"}</div>
                {open.account && <div className="text-[12px] text-muted mt-0.5">{open.account}</div>}
              </div>
              <button onClick={() => setOpen(null)} aria-label="Close" className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-bg transition text-[15px]">✕</button>
            </div>

            <div className="px-5 py-4 overflow-auto">
              {isPrescribed(open) && (
                <div className="mb-4 text-[12.5px] text-ink leading-snug bg-accent/5 border border-accent/20 rounded-lg p-3">
                  No next step was agreed on the call, so DealRipe prescribed this one.
                </div>
              )}

              {actionIsEmail(open) ? (
                <EmailBody task={open} />
              ) : (
                <BookingBody task={open} slots={slots} selected={slot} onPick={setSlot} />
              )}
            </div>

            <div className="px-5 py-4 border-t border-line flex items-center justify-between gap-3 shrink-0">
              <span className="text-[11.5px] text-muted">DealRipe drafted this. Review, then {actionIsEmail(open) ? "send" : "book"}.</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setOpen(null)} className="text-[13px] font-semibold text-muted hover:text-ink transition px-2">Cancel</button>
                <button
                  onClick={confirm}
                  disabled={!actionIsEmail(open) && !slot}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-accent text-white text-[13px] font-semibold hover:bg-accent/90 transition disabled:opacity-40"
                >
                  {actionIsEmail(open) ? "Send email" : "Book it"} <span aria-hidden>&rarr;</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmailBody({ task }: { task: TaskItem }) {
  const email = draftEmail(task);
  return (
    <div className="space-y-3">
      <Field label="To" value={email.to} />
      <Field label="Subject" value={email.subject} />
      <div>
        <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">Body</div>
        <div className="text-[13px] text-ink leading-relaxed whitespace-pre-wrap bg-bg rounded-lg border border-line p-3.5">{email.body}</div>
      </div>
    </div>
  );
}

function BookingBody({
  task,
  slots,
  selected,
  onPick,
}: {
  task: TaskItem;
  slots: Array<{ label: string; se: boolean }>;
  selected: string | null;
  onPick: (s: string) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Meeting" value={task.title} />
      <div>
        <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1.5">Proposed times</div>
        <div className="flex flex-col gap-2">
          {slots.map((s) => (
            <button
              key={s.label}
              onClick={() => onPick(s.label)}
              className={`text-left px-3.5 py-2.5 rounded-lg border text-[13px] font-medium transition flex items-center justify-between gap-3 ${
                selected === s.label ? "border-ink bg-ink text-white" : "border-line text-ink hover:border-ink/40"
              }`}
            >
              <span>{s.label}</span>
              {s.se && <span className={`text-[10.5px] ${selected === s.label ? "text-white/80" : "text-muted"}`}>your solutions engineer is free</span>}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[12px] text-muted leading-snug">DealRipe checked both calendars. Pick a slot and it sends the invite.</p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">{label}</div>
      <div className="text-[13px] text-ink font-medium leading-snug">{value}</div>
    </div>
  );
}
