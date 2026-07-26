import { ActionsBoard } from "@/components/ActionsBoard";
import { ActionsList } from "@/components/ActionsList";
import { AppShell } from "@/components/AppShell";
import { getTasks, type TaskItem } from "@/lib/tasks";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";
import { DEFAULT_TENANT_SLUG, withTenant } from "@/lib/tenant-nav";

export const dynamic = "force-dynamic";

export default async function ActionsPage({ searchParams }: { searchParams: { deal?: string; tenant?: string } }) {
  const tenant = searchParams.tenant ?? DEFAULT_TENANT_SLUG;
  let tasks: TaskItem[] = [];
  try {
    const tenantId = await resolveTenantId(tenant);
    tasks = await getTasks(tenantId);
  } catch (err) {
    console.error("[actions] load failed:", err);
  }

  // Deep-link from the pipeline dashboard: scope to one deal's actions.
  const dealId = searchParams.deal;
  const shown = dealId ? tasks.filter((t) => t.dealId === dealId) : tasks;
  const dealName = dealId ? tasks.find((t) => t.dealId === dealId)?.account ?? "this deal" : null;
  const openCount = shown.filter((t) => t.status !== "done").length;

  return (
    <AppShell active="actions" tenant={tenant}>
      <div className="max-w-[1000px] mx-auto px-6 py-7">
        <div className="flex items-center justify-between">
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">Actions{dealName ? ` · ${dealName}` : ""}</h1>
          {dealName && <a href={withTenant("/actions", tenant)} className="text-[12px] text-accent hover:underline">Show all deals</a>}
        </div>
        <p className="text-[13px] text-muted mt-1">
          The concrete next steps DealRipe pulled from each call, prioritized and dated. Work them
          here, or from the recap in your inbox. {openCount} open{dealName ? ` for ${dealName}` : ""}.
        </p>

        {shown.length === 0 ? (
          <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
            No actions logged for {dealName ?? "this tenant"} yet. DealRipe adds them after each call.
          </div>
        ) : tenant === DEFAULT_TENANT_SLUG ? (
          // magaya (live pilot) keeps the exact Actions list, unchanged.
          <ActionsList tasks={shown} />
        ) : (
          // Non-magaya (demo) tenants get the interactive decision layer.
          <ActionsBoard tasks={shown} />
        )}
      </div>
    </AppShell>
  );
}
