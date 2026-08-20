import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/AppShell";
import { loadPortfolioRead } from "@/lib/deal-read-portfolio";
import { describeForecastRead } from "@/lib/salesforce-stage";
import { buildDealTimeline, type TimelineEntry } from "@/lib/deal-timeline";
import { repName } from "@/lib/display-names";
import { readEmailEngagement } from "@/lib/email-log";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";
import { DEFAULT_TENANT_SLUG, withTenant } from "@/lib/tenant-nav";

export const dynamic = "force-dynamic";

const d10 = (iso: string) => (iso ? iso.slice(0, 10) : "?");

const FOLLOWED: Record<string, { label: string; cls: string }> = {
  yes: { label: "done", cls: "text-accent" },
  no: { label: "not done", cls: "text-warn" },
  unknown: { label: "unscored", cls: "text-muted" },
};

function Entry({ e }: { e: TimelineEntry }) {
  return (
    <div className="relative pl-6 pb-6 border-l border-line last:border-transparent">
      <span className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full bg-line" />
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[13px] font-medium text-ink">{d10(e.at)}</span>
        {e.upcoming && (
          <span className="text-[11px] px-2 py-0.5 rounded-md bg-accent/10 text-accent">Upcoming</span>
        )}
        <span className="text-[12px] text-muted">{e.kind}</span>
        {e.outcome && e.outcome !== "captured" && (
          <span className="text-[11px] px-2 py-0.5 rounded-md bg-warn/10 text-warn">{e.outcome}</span>
        )}
      </div>
      {e.title && <div className="text-[12px] text-muted mt-0.5 italic">{e.title}</div>}

      <div className="mt-2 space-y-1.5">
        <div className="text-[12px]">
          <span className="text-muted">before </span>
          {e.briefingLeadMinutes !== null ? (
            <span className="text-ink">briefing sent {e.briefingLeadMinutes} min ahead</span>
          ) : (
            <span className="text-warn">no briefing</span>
          )}
        </div>

        {e.prescriptions.map((p, i) => {
          const f = FOLLOWED[p.followed] ?? FOLLOWED.unknown;
          return (
            <div key={i} className="text-[12px] pl-[3.4rem] -mt-0.5">
              <span className="text-muted">asked: </span>
              <span className="text-ink">{p.text}</span>{" "}
              <span className={f.cls}>[{f.label}]</span>
            </div>
          );
        })}

        {!e.upcoming && (
          <>
            {e.artifacts.length > 0 && (
              <div className="text-[12px]">
                <span className="text-muted">after </span>
                <span className="text-ink">delivered: {e.artifacts.join(", ")}</span>
              </div>
            )}
            {e.outcomes.map((o, i) => (
              <div key={i} className="text-[12px] pl-[3.4rem] text-accent">
                {o}
              </div>
            ))}
            {(e.emailOut > 0 || e.emailIn > 0) && (
              <div className="text-[12px] pl-[3.4rem] text-muted">
                email after: {e.emailOut} out, {e.emailIn} back from the customer
              </div>
            )}
            {e.crmMoves.map((m, i) => (
              <div key={i} className="text-[12px] pl-[3.4rem] text-ink">
                CRM: {m}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export default async function DealReadPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { tenant?: string };
}) {
  const tenant = searchParams.tenant ?? DEFAULT_TENANT_SLUG;
  const tenantId = await resolveTenantId(tenant);

  const dealRes = await supabaseAdmin()
    .from("deals")
    .select("id, account, salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", tenantId)
    .eq("id", params.id)
    .maybeSingle();
  if (dealRes.error || !dealRes.data) notFound();
  const deal = dealRes.data as {
    id: string;
    account: string;
    salesforce_account_id: string | null;
    salesforce_link_confidence: string | null;
  };
  const accountId =
    deal.salesforce_link_confidence === "confirmed" ? deal.salesforce_account_id : null;

  const [reads, timeline, mail] = await Promise.all([
    loadPortfolioRead({ tenantId, dealIds: [deal.id] }),
    buildDealTimeline({ tenantId, dealId: deal.id, accountId }),
    readEmailEngagement({ tenantId, dealId: deal.id }),
  ]);
  const read = reads[0];
  const rep = describeForecastRead(read?.crmRead);

  return (
    <AppShell active="review" tenant={tenant}>
      <div className="max-w-[900px] mx-auto px-6 py-7">
        <Link href={withTenant("/read", tenant)} className="text-[12px] text-accent hover:underline">
          Back to the read
        </Link>
        <h1 className="text-[24px] font-semibold tracking-tight text-ink mt-2">{deal.account}</h1>

        {read && (
          <p className="text-[13px] text-muted mt-1">
            {repName(read.repEmail)} · rep says{" "}
            <span
              title={rep.detail || undefined}
              className={rep.tone === "suspect" ? "text-warn" : rep.tone === "absent" ? "text-muted italic" : "text-ink"}
            >
              {rep.label}
            </span> · DealRipe says{" "}
            <span className="text-ink">{read.assessment.band ?? "no read"}</span>,{" "}
            {read.assessment.momentum}
            {read.crm?.closeDate ? ` · closing ${read.crm.closeDate}` : ""} · confidence{" "}
            {read.assessment.confidence}
          </p>
        )}

        {read && read.flags.length > 0 && (
          <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
            <div className="text-[11px] uppercase tracking-wide text-muted">Flags</div>
            <div className="mt-3 space-y-3">
              {read.flags.map((f, i) => (
                <div
                  key={i}
                  className={`border-l-2 pl-3 ${f.severity === "critical" ? "border-warn/40" : "border-line"}`}
                >
                  <div className="text-[13px] font-medium text-ink">{f.title}</div>
                  <div className="text-[12px] text-muted mt-0.5">{f.evidence}</div>
                  <div className="text-[12px] text-accent mt-0.5">{f.move}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 bg-white rounded-xl2 shadow-card border border-line px-5 py-5">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            Call by call: what we asked for, what happened
          </div>
          <div className="mt-4">
            {timeline.entries.length === 0 ? (
              <div className="text-[13px] text-muted">No calls captured on this deal.</div>
            ) : (
              timeline.entries.map((e) => <Entry key={e.callId} e={e} />)
            )}
          </div>

          <div className="mt-2 pt-3 border-t border-line text-[12px] text-muted">
            {/* "No email record" and "the customer is silent" are different
                facts, and the log is what separates them. */}
            email:{" "}
            {!timeline.emailLogged
              ? "no log yet for this tenant"
              : mail
                ? mail.evidence
                : "nothing logged on this deal"}
          </div>
        </div>

        {read && read.assessment.notChecked.length > 0 && (
          <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
            <div className="text-[11px] uppercase tracking-wide text-muted">What could not be checked</div>
            <ul className="mt-2 space-y-1">
              {read.assessment.notChecked.map((n, i) => (
                <li key={i} className="text-[12px] text-muted">
                  {n}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </AppShell>
  );
}
