"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { updateTaskStatusAction } from "@/lib/task-actions";
import type { TaskItem, TaskStatus } from "@/lib/tasks";

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

function fmtDeadline(iso: string | null): { text: string; overdue: boolean; soon: boolean } {
  if (!iso) return { text: "No date", overdue: false, soon: false };
  // Parse the date-only value in the pilot timezone; compare against today there.
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

function TaskRow({ t }: { t: TaskItem }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const p = PRIORITY[t.priority] ?? PRIORITY.medium;
  const dl = fmtDeadline(t.deadline);
  const done = t.status === "done";

  function move(status: TaskStatus) {
    setError(null);
    startTransition(async () => {
      const res = await updateTaskStatusAction(t.id, status);
      if (!res.ok) setError(res.error ?? "Could not update");
      else router.refresh();
    });
  }

  return (
    <div className={`px-5 py-4 flex items-start gap-4 ${done ? "opacity-60" : ""}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full ${p.cls}`}>
            {p.label}
          </span>
          {t.actionType && (
            <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-ink/[0.05] text-muted">
              {TYPE_LABEL[t.actionType] ?? t.actionType}
            </span>
          )}
          {t.status === "in_progress" && (
            <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-accent/10 text-accent">
              In progress
            </span>
          )}
        </div>
        <div className={`text-[14px] mt-1.5 ${done ? "text-muted line-through" : "text-ink font-medium"}`}>
          {t.title}
        </div>
        {t.detail && <div className="text-[12px] text-muted mt-0.5">{t.detail}</div>}
        <div className="text-[11px] text-muted mt-1.5 flex items-center gap-2 flex-wrap">
          {t.dealId && t.account ? (
            <Link href={`/deals/${t.dealId}`} className="text-accent hover:underline">
              {t.account}
            </Link>
          ) : (
            t.account && <span>{t.account}</span>
          )}
          {t.callId && (
            <>
              <span className="text-muted/40">·</span>
              <Link href={`/meetings/${t.callId}`} className="text-accent hover:underline">
                Source call
              </Link>
            </>
          )}
          {t.repEmail && (
            <>
              <span className="text-muted/40">·</span>
              <span>{t.repEmail}</span>
            </>
          )}
        </div>
        {error && <div className="text-[11px] text-danger mt-1.5">{error}</div>}
      </div>

      <div className="shrink-0 flex flex-col items-end gap-2">
        <span
          className={`text-[11px] whitespace-nowrap ${
            !done && dl.overdue ? "text-danger font-medium" : !done && dl.soon ? "text-warn" : "text-muted"
          }`}
        >
          {dl.text}
        </span>
        <div className="flex items-center gap-1.5">
          {t.status === "todo" && (
            <button
              onClick={() => move("in_progress")}
              disabled={pending}
              className="text-[11px] font-medium px-2.5 py-1 rounded-md border border-line text-ink hover:bg-bg disabled:opacity-50"
            >
              Start
            </button>
          )}
          {!done && (
            <button
              onClick={() => move("done")}
              disabled={pending}
              className="text-[11px] font-medium px-2.5 py-1 rounded-md bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
            >
              Complete
            </button>
          )}
          {done && (
            <button
              onClick={() => move("todo")}
              disabled={pending}
              className="text-[11px] font-medium px-2.5 py-1 rounded-md border border-line text-muted hover:bg-bg disabled:opacity-50"
            >
              Reopen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ActionsList({ tasks }: { tasks: TaskItem[] }) {
  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  const sortOpen = [...open].sort((a, b) => {
    const pa = PRIORITY[a.priority]?.order ?? 1;
    const pb = PRIORITY[b.priority]?.order ?? 1;
    if (pa !== pb) return pa - pb;
    const da = a.deadline ?? "9999";
    const db = b.deadline ?? "9999";
    return da.localeCompare(db);
  });

  return (
    <div className="mt-5 space-y-6">
      <section>
        <div className="text-[11px] uppercase tracking-wider font-semibold text-muted mb-2">
          Open ({open.length})
        </div>
        {sortOpen.length === 0 ? (
          <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
            Nothing open. DealRipe generates actions from each qualification call.
          </div>
        ) : (
          <div className="bg-white rounded-xl2 shadow-card border border-line divide-y divide-line overflow-hidden">
            {sortOpen.map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
          </div>
        )}
      </section>

      {done.length > 0 && (
        <section>
          <div className="text-[11px] uppercase tracking-wider font-semibold text-muted mb-2">
            Done ({done.length})
          </div>
          <div className="bg-white rounded-xl2 shadow-card border border-line divide-y divide-line overflow-hidden">
            {done.map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
