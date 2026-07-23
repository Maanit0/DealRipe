import { ActionsList } from "@/components/ActionsList";
import { AppShell } from "@/components/AppShell";
import { getTasks, type TaskItem } from "@/lib/tasks";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const dynamic = "force-dynamic";

export default async function ActionsPage() {
  let tasks: TaskItem[] = [];
  try {
    const tenantId = await resolveTenantId("magaya");
    tasks = await getTasks(tenantId);
  } catch (err) {
    console.error("[actions] load failed:", err);
  }

  const openCount = tasks.filter((t) => t.status !== "done").length;

  return (
    <AppShell active="actions">
      <div className="max-w-[1000px] mx-auto px-6 py-7">
        <h1 className="text-[24px] font-semibold tracking-tight text-ink">Actions</h1>
        <p className="text-[13px] text-muted mt-1">
          The concrete next steps DealRipe pulled from each call, prioritized and dated. Work them
          here, or from the recap in your inbox. {openCount} open.
        </p>

        <ActionsList tasks={tasks} />
      </div>
    </AppShell>
  );
}
