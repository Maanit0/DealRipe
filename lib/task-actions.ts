"use server";

/**
 * Server actions for the Actions tab: a rep starts or completes a task. Gated by
 * the same Basic Auth middleware that protects the app. Never throws to the
 * client.
 */

import { revalidatePath } from "next/cache";

import { setTaskStatus, type TaskStatus } from "./tasks";

const ALLOWED = new Set<TaskStatus>(["todo", "in_progress", "done"]);

export async function updateTaskStatusAction(
  taskId: string,
  status: TaskStatus,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!ALLOWED.has(status)) return { ok: false, error: `invalid status '${status}'` };
    await setTaskStatus(taskId, status);
    revalidatePath("/actions");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
