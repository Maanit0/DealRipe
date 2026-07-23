/**
 * Rep tasks (Actions). DealRipe generates concrete next actions from each call,
 * tuned to what was discussed and the deal's stage: what to send, who to book,
 * which gap to close. Reps execute them. Distinct from the activity log (what
 * DealRipe itself did). Generation is best-effort and never blocks ingest.
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { supabaseAdmin } from "./supabase";

export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskActionType = "email" | "book_meeting" | "send_materials" | "internal" | "other";

export type GeneratedTask = {
  title: string;
  detail: string;
  actionType: TaskActionType;
  priority: "high" | "medium" | "low";
  dueInDays: number;
};

export type TaskItem = {
  id: string;
  dealId: string | null;
  callId: string | null;
  account: string | null;
  title: string;
  detail: string | null;
  actionType: string | null;
  priority: string;
  deadline: string | null;
  repEmail: string | null;
  status: TaskStatus;
  createdAt: string;
};

const MAX_CHARS = 14000;
const TYPES = new Set<TaskActionType>(["email", "book_meeting", "send_materials", "internal", "other"]);

/**
 * Turn a call into up to 3 concrete rep actions. Grounded in the transcript and
 * the deal's stage, with the recap's agreed next step as a strong hint. Returns
 * [] on any failure so the pipeline is never blocked.
 */
export async function generateTasksFromCall(args: {
  account: string;
  transcript: string;
  stageKey: string;
  nextStepHint?: string | null;
}): Promise<GeneratedTask[]> {
  if (!process.env.ANTHROPIC_API_KEY || args.transcript.trim().length < 50) return [];

  const system = `You generate the concrete next actions a B2B sales rep should take after a call to progress or unblock the deal. Output ONLY a JSON array (max 3 items), nothing else.

Each item:
{ "title": string, "detail": string, "actionType": "email"|"book_meeting"|"send_materials"|"internal"|"other", "priority": "high"|"medium"|"low", "dueInDays": number }

Rules:
- No em-dashes or en-dashes. Use commas or periods.
- title: an imperative action, at most about 12 words (e.g. "Email Ely the product videos and datasheet", "Book the follow-up demo").
- detail: ONE sentence on what and why, grounded in what was actually discussed.
- If the call agreed a clear next step, that is the first, highest-priority task.
- Add a task to book the next meeting if one is implied but was not scheduled.
- Add a task to close the single most important open gap (budget owner, decision process, NDA before demo) if relevant.
- dueInDays: sensible urgency (high 1-2, medium 3-5, low 6-10).
- If nothing meaningful is warranted, return [].`;

  const user = [
    `ACCOUNT: ${args.account}`,
    `STAGE: ${args.stageKey}`,
    args.nextStepHint ? `AGREED NEXT STEP (hint): ${args.nextStepHint}` : "",
    ``,
    `TRANSCRIPT:`,
    args.transcript.slice(0, MAX_CHARS),
    ``,
    `Return the JSON array of actions. Grounded in the transcript. JSON only.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const resp = await getAnthropicClient().messages.create({
      model: getAnthropicModel(),
      max_tokens: 800,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: user }],
    });
    const block = resp.content.find((b) => b.type === "text");
    const text = block && "text" in block ? block.text : "";
    const s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const arr = JSON.parse(s) as unknown[];
    if (!Array.isArray(arr)) return [];
    const out: GeneratedTask[] = [];
    for (const raw of arr.slice(0, 3)) {
      const o = raw as Record<string, unknown>;
      if (typeof o.title !== "string" || !o.title.trim()) continue;
      const actionType = (TYPES.has(o.actionType as TaskActionType) ? o.actionType : "other") as TaskActionType;
      const priority = (["high", "medium", "low"].includes(o.priority as string) ? o.priority : "medium") as GeneratedTask["priority"];
      const dueInDays = Number.isFinite(Number(o.dueInDays)) ? Math.max(0, Math.round(Number(o.dueInDays))) : 3;
      out.push({
        title: o.title.trim(),
        detail: typeof o.detail === "string" ? o.detail.trim() : "",
        actionType,
        priority,
        dueInDays,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Insert generated tasks for a call. Best-effort; replaces this call's prior
 *  tasks so a re-ingest does not duplicate them. */
export async function createTasksForCall(args: {
  tenantId: string;
  dealId: string;
  callId: string;
  repEmail: string | null;
  tasks: GeneratedTask[];
}): Promise<number> {
  if (args.tasks.length === 0) return 0;
  const db = supabaseAdmin();
  // Clear any prior tasks generated from this same call so re-processing is idempotent.
  await db.from("tasks").delete().eq("tenant_id", args.tenantId).eq("call_id", args.callId);

  const today = new Date();
  const rows = args.tasks.map((t) => {
    const d = new Date(today);
    d.setDate(d.getDate() + t.dueInDays);
    return {
      tenant_id: args.tenantId,
      deal_id: args.dealId,
      call_id: args.callId,
      title: t.title,
      detail: t.detail || null,
      action_type: t.actionType,
      priority: t.priority,
      deadline: d.toISOString().slice(0, 10),
      rep_email: args.repEmail,
      status: "todo",
      source: "call",
    };
  });
  const ins = await db.from("tasks").insert(rows);
  if (ins.error) {
    console.error(`[tasks] insert failed for call ${args.callId}: ${ins.error.message}`);
    return 0;
  }
  return rows.length;
}

const DISPLAY: Record<string, string> = {
  Corelogistics: "Core Logistics",
  Airamericas: "Air Americas",
  Cargocleared: "Cargo Cleared",
  Successchb: "Success CHB",
  Cbxglobal: "CBX Global",
  Fmgloballogistics: "FM Global Logistics",
  Mastercargoinc: "Master Cargo",
  Acecustomsinc: "Ace Customs",
  Cargoservicesgroup: "Cargo Services Group",
};

/** All tasks for a tenant, newest first, with deal account resolved. */
export async function getTasks(tenantId: string): Promise<TaskItem[]> {
  const db = supabaseAdmin();
  const [tasksRes, dealsRes] = await Promise.all([
    db
      .from("tasks")
      .select("id, deal_id, call_id, title, detail, action_type, priority, deadline, rep_email, status, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }),
    db.from("deals").select("id, account").eq("tenant_id", tenantId),
  ]);
  const accountById = new Map(
    ((dealsRes.data ?? []) as Array<{ id: string; account: string }>).map(
      (d) => [d.id, DISPLAY[d.account] ?? d.account] as const,
    ),
  );
  return ((tasksRes.data ?? []) as Array<Record<string, unknown>>).map((t) => ({
    id: String(t.id),
    dealId: (t.deal_id as string) ?? null,
    callId: (t.call_id as string) ?? null,
    account: t.deal_id ? accountById.get(t.deal_id as string) ?? null : null,
    title: String(t.title),
    detail: (t.detail as string) ?? null,
    actionType: (t.action_type as string) ?? null,
    priority: String(t.priority),
    deadline: (t.deadline as string) ?? null,
    repEmail: (t.rep_email as string) ?? null,
    status: (t.status as TaskStatus) ?? "todo",
    createdAt: String(t.created_at),
  }));
}

export async function setTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
  const db = supabaseAdmin();
  await db.from("tasks").update({ status, updated_at: new Date().toISOString() }).eq("id", taskId);
}
