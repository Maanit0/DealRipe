import Link from "next/link";

import type { CallRecord } from "@/lib/seed-data";
import { withTenant } from "@/lib/tenant-nav";

const SUBTYPE_LABEL: Record<string, string> = {
  discovery: "Discovery",
  demo: "Demo",
  proposal: "Proposal",
  follow_up: "Follow-up",
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * The deal's earlier calls (the history before the latest, extracted one). Each
 * links to the meeting so you can open its transcript. Shows that the current
 * qualification was built across several calls, not one.
 */
export function EarlierCallsCard({ calls, tenant }: { calls: CallRecord[]; tenant: string }) {
  if (calls.length === 0) return null;
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
      <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Earlier calls</div>
      <div className="mt-2.5 space-y-2">
        {calls.map((c) => (
          <Link
            key={c.id}
            href={withTenant(`/meetings/${c.id}`, tenant)}
            className="block border border-line rounded-lg px-3 py-2.5 hover:bg-bg/60 transition"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] text-ink font-medium">
                {(c.callSubtype && SUBTYPE_LABEL[c.callSubtype]) || "Call"} · {fmtDate(c.date)}
              </span>
              <span className="text-[10px] uppercase tracking-wider font-semibold text-accent">Extracted ✓</span>
            </div>
            {c.participants.length > 0 && (
              <div className="text-[11px] text-muted mt-0.5 truncate">{c.participants.join(", ")}</div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
