import Link from "next/link";
import { DEFAULT_TENANT_SLUG, pipelineHref, withTenant } from "@/lib/tenant-nav";

export type NavKey = "deals" | "meetings" | "actions" | "activity" | "review" | "report" | "audit";

// Base paths. The Deals tab points at the pipeline, which always carries the
// tenant param; the rest are plain paths that withTenant leaves untouched for
// magaya and tags with ?tenant=<slug> for other tenants.
const ITEMS: Record<NavKey, { label: string; base: string }> = {
  deals: { label: "Deals", base: "/pipeline" },
  meetings: { label: "Meetings", base: "/meetings" },
  actions: { label: "Actions", base: "/actions" },
  activity: { label: "Activity", base: "/activity" },
  review: { label: "Review", base: "/review" },
  report: { label: "Report", base: "/report" },
  audit: { label: "Audit", base: "/audit" },
};

// Default (magaya / pilot) order.
const DEFAULT_ORDER: NavKey[] = ["deals", "meetings", "actions", "activity", "review", "report"];
// Demo order (keelson and other non-magaya tenants), sequenced to walk the story:
// the CRO's Forecast Room first, then the pre/post-call content the AE gets
// (Meetings), then the actions that close the gaps, then the CRM write-back, then
// the pipeline and the coverage log.
const DEMO_ORDER: NavKey[] = ["review", "deals", "meetings", "actions", "report", "activity"];

function navHref(base: string, tenant: string): string {
  return base === "/pipeline" ? pipelineHref(tenant) : withTenant(base, tenant);
}

/**
 * Persistent app chrome: a left sidebar with the five DealRipe sections and a
 * main content slot. Deals, Meetings, Actions, and Review are the primary tabs;
 * Audit sits apart at the bottom as an operator tool, not a rep/CRO view.
 *
 * `tenant` defaults to magaya so existing callers render identical links; other
 * tenants (e.g. the keelson demo) get every nav href tagged with ?tenant.
 */
export function AppShell({
  active,
  tenant = DEFAULT_TENANT_SLUG,
  children,
}: {
  active: NavKey;
  tenant?: string;
  children: React.ReactNode;
}) {
  const order = tenant === DEFAULT_TENANT_SLUG ? DEFAULT_ORDER : DEMO_ORDER;
  return (
    <div className="min-h-screen bg-bg flex">
      <aside className="w-[184px] shrink-0 bg-white border-r border-line flex flex-col sticky top-0 h-screen px-3 py-4">
        <div className="px-2 mb-4 text-[15px] font-bold tracking-tight">
          <span className="text-ink">Deal</span>
          <span className="text-accent">Ripe</span>
        </div>
        <nav className="flex flex-col gap-0.5">
          {order.map((key) => (
            <NavLink
              key={key}
              label={ITEMS[key].label}
              href={navHref(ITEMS[key].base, tenant)}
              active={active === key}
            />
          ))}
        </nav>
        <div className="flex-1" />
        <div className="border-t border-line pt-2">
          <NavLink label="Audit" href="/audit" active={active === "audit"} muted />
        </div>
      </aside>
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}

function NavLink({
  label,
  href,
  active,
  muted,
}: {
  label: string;
  href: string;
  active: boolean;
  muted?: boolean;
}) {
  const base = "block rounded-lg px-3 py-2 text-[13px] font-medium transition";
  const cls = active
    ? "bg-accent/10 text-accent"
    : muted
      ? "text-muted hover:text-ink hover:bg-bg"
      : "text-ink/80 hover:text-ink hover:bg-bg";
  return (
    <Link href={href} className={`${base} ${cls}`}>
      {label}
    </Link>
  );
}
