import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { PrintButton } from "@/components/PrintButton";
import { getActivityLog } from "@/lib/activity-log";
import { getRolldogWritePreviewByDeals, type RolldogFieldWrite } from "@/lib/crm-preview";
import { repName } from "@/lib/display-names";
import { callSubtypeLabel } from "@/lib/meeting-classify";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const dynamic = "force-dynamic";

// Estimated rep time to manually locate and fill one Rolldog qualification
// subfield (separate from the note / next-step entry DealRipe also automates).
const SECONDS_PER_FIELD = 30;

const PRINT_CSS = `
@media print {
  aside { display: none !important; }
  .no-print { display: none !important; }
  main { width: 100% !important; }
  details { break-inside: avoid; }
  details[data-row] > summary::-webkit-details-marker { display: none; }
}
`;

const TZ = "America/Chicago";
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ });
  } catch {
    return "—";
  }
}
function fmtDuration(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `~${h} hr` : `~${h}h ${rem}m`;
}
const TYPE_LABEL: Record<string, string> = { new_opportunity: "New opportunity", existing_customer: "Customer", internal: "Internal" };
const GREEN_TYPES = new Set(["Discovery", "Demo", "Proposal", "Follow-up"]);
function resolveType(subtype: string | null, mtype: string | null): string | null {
  return callSubtypeLabel(subtype) ?? (mtype ? TYPE_LABEL[mtype] ?? null : null);
}
function typeCls(label: string | null): string {
  return label && GREEN_TYPES.has(label) ? "bg-accent/10 text-accent" : "bg-ink/[0.06] text-muted";
}

type Row = {
  dealId: string;
  account: string;
  rep: string;
  date: string | null;
  type: string | null;
  writes: RolldogFieldWrite[];
};

export default async function ReportPage() {
  let fieldsWritten = 0;
  let dealsEnriched = 0;
  let callsProcessed = 0;
  let rows: Row[] = [];

  try {
    const tenantId = await resolveTenantId("magaya");
    const [entries, dealsRes, callsRes] = await Promise.all([
      getActivityLog(tenantId),
      supabaseAdmin().from("deals").select("id, account, rep_email").eq("tenant_id", tenantId),
      supabaseAdmin().from("calls").select("deal_id, scheduled_start, call_date, meeting_type, call_subtype").eq("tenant_id", tenantId),
    ]);

    const writes = entries.filter((e) => e.kind === "rolldog_write" && e.dealId);
    const fieldPairs = new Set<string>();
    const callSet = new Set<string>();
    for (const e of writes) {
      if (e.callId) callSet.add(e.callId);
      for (const f of (e.fields ?? "").split(",").map((s) => s.trim()).filter(Boolean)) fieldPairs.add(`${e.dealId}::${f}`);
    }
    fieldsWritten = fieldPairs.size;
    callsProcessed = callSet.size;

    const dealsById = new Map(
      ((dealsRes.data ?? []) as Array<{ id: string; account: string; rep_email: string | null }>).map((d) => [d.id, d] as const),
    );
    const latestCall = new Map<string, { date: string | null; type: string | null }>();
    for (const c of (callsRes.data ?? []) as Array<{ deal_id: string | null; scheduled_start: string | null; call_date: string | null; meeting_type: string | null; call_subtype: string | null }>) {
      if (!c.deal_id) continue;
      const date = c.scheduled_start ?? c.call_date;
      const prev = latestCall.get(c.deal_id);
      if (!prev || (date && prev.date && Date.parse(date) > Date.parse(prev.date)) || (date && !prev.date)) {
        latestCall.set(c.deal_id, { date, type: resolveType(c.call_subtype, c.meeting_type) });
      }
    }

    const dealIds = Array.from(new Set(writes.map((e) => e.dealId as string)));
    const writesByDeal = await getRolldogWritePreviewByDeals("magaya", dealIds);
    rows = Array.from(writesByDeal.entries())
      .map(([dealId, w]) => {
        const deal = dealsById.get(dealId);
        const call = latestCall.get(dealId);
        return {
          dealId,
          account: deal?.account ?? "Deal",
          rep: repName(deal?.rep_email ?? null),
          date: call?.date ?? null,
          type: call?.type ?? null,
          writes: w,
        };
      })
      .filter((r) => r.writes.length > 0)
      .sort((a, b) => (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0));
    dealsEnriched = rows.length;
  } catch (err) {
    console.error("[report] load failed:", err);
  }

  const minutesSaved = (fieldsWritten * SECONDS_PER_FIELD) / 60;
  const tiles = [
    { label: "Qualification fields written", value: String(fieldsWritten) },
    { label: "Deals enriched", value: String(dealsEnriched) },
    { label: "Calls processed", value: String(callsProcessed) },
  ];

  return (
    <AppShell active="report">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      <div className="max-w-[1040px] mx-auto px-6 py-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[13px]">
              <span className="font-semibold text-ink">DealRipe</span>
              <span className="text-muted">to Rolldog</span>
            </div>
            <h1 className="text-[24px] font-semibold tracking-tight text-ink mt-1">Post-call write-back</h1>
            <p className="text-[13px] text-muted mt-1 max-w-[660px]">
              Every qualification field DealRipe captured from your calls and wrote back to Rolldog, automatically. Click a row to see exactly what was written. These fields were blank before the call.
            </p>
          </div>
          <PrintButton />
        </div>

        <div className="grid grid-cols-3 gap-3 mt-5">
          {tiles.map((t) => (
            <div key={t.label} className="bg-white rounded-xl2 border border-line px-4 py-3.5">
              <div className="text-[12px] text-muted">{t.label}</div>
              <div className="text-[24px] font-semibold text-ink mt-0.5">{t.value}</div>
            </div>
          ))}
        </div>

        {rows.length === 0 ? (
          <div className="mt-6 bg-white rounded-xl2 border border-line px-5 py-4 text-[13px] text-muted">
            No Rolldog write-backs recorded yet.
          </div>
        ) : (
          <div className="mt-6 bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
            <div className="flex items-center gap-4 px-5 py-2.5 border-b border-line text-[11px] uppercase tracking-wider font-semibold text-muted">
              <div className="w-[120px] shrink-0">Date</div>
              <div className="flex-1 min-w-0">Wrote back</div>
              <div className="w-[104px] shrink-0">Type</div>
              <div className="w-[150px] shrink-0">Deal</div>
              <div className="w-[80px] shrink-0">Rep</div>
            </div>
            {rows.map((r, i) => (
              <details key={r.dealId} data-row className={`group ${i < rows.length - 1 ? "border-b border-line" : ""}`}>
                <summary className="flex items-center gap-4 px-5 py-3 cursor-pointer list-none hover:bg-bg/60 transition">
                  <div className="w-[120px] shrink-0 text-[12px] text-muted whitespace-nowrap">{fmtDate(r.date)}</div>
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="text-[10px] text-muted group-open:rotate-180 transition-transform shrink-0">⌄</span>
                    <span className="text-[13px] text-ink truncate">
                      {r.writes.map((w) => w.label).join(" · ")}
                    </span>
                    <span className="text-[11px] text-muted shrink-0">{r.writes.length} fields</span>
                  </div>
                  <div className="w-[104px] shrink-0">
                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${typeCls(r.type)}`}>{r.type ?? "—"}</span>
                  </div>
                  <div className="w-[150px] shrink-0 text-[13px] truncate">
                    <Link href={`/deals/${r.dealId}`} className="text-accent hover:underline">{r.account}</Link>
                  </div>
                  <div className="w-[80px] shrink-0 text-[12px] text-muted truncate">{r.rep}</div>
                </summary>
                <div className="px-5 pb-4 pt-1 pl-[calc(120px+2rem)]">
                  <div className="flex flex-col gap-3 border-l-2 border-accent/30 pl-4">
                    {r.writes.map((w) => (
                      <div key={w.subResource}>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[12px] font-medium text-ink">{w.label}</span>
                          <span className="text-[11px] text-muted">{w.target}</span>
                        </div>
                        <div className="text-[13px] text-ink/85 leading-relaxed whitespace-pre-wrap">{w.payload}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}

        <p className="text-[11px] text-muted mt-4">
          Estimated rep time saved on subfield entry: {fmtDuration(minutesSaved)} ({SECONDS_PER_FIELD} seconds per field to manually locate and fill each Rolldog qualification subfield, times {fieldsWritten} fields). Separate from the note-taking and next-step entry DealRipe also automates.
        </p>
      </div>
    </AppShell>
  );
}
