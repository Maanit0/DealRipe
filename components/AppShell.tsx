import Link from "next/link";

export type NavKey = "deals" | "meetings" | "actions" | "review" | "audit";

const ITEMS: { key: NavKey; label: string; href: string }[] = [
  { key: "deals", label: "Deals", href: "/pipeline?tenant=magaya" },
  { key: "meetings", label: "Meetings", href: "/meetings" },
  { key: "actions", label: "Actions", href: "/actions" },
  { key: "review", label: "Review", href: "/review" },
];

/**
 * Persistent app chrome: a left sidebar with the five DealRipe sections and a
 * main content slot. Deals, Meetings, Actions, and Review are the primary tabs;
 * Audit sits apart at the bottom as an operator tool, not a rep/CRO view.
 */
export function AppShell({ active, children }: { active: NavKey; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg flex">
      <aside className="w-[184px] shrink-0 bg-white border-r border-line flex flex-col sticky top-0 h-screen px-3 py-4">
        <div className="px-2 mb-4 text-[15px] font-bold tracking-tight">
          <span className="text-ink">Deal</span>
          <span className="text-accent">Ripe</span>
        </div>
        <nav className="flex flex-col gap-0.5">
          {ITEMS.map((it) => (
            <NavLink key={it.key} label={it.label} href={it.href} active={active === it.key} />
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
