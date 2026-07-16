"use server";

/**
 * Server action for the rep to classify a no-conversation call from the deal
 * page (no-show, rescheduled, or placeholder). Gated by the same Basic Auth
 * middleware that protects /deals. Only refines a call already flagged
 * no_conversation; never throws to the client.
 */

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

const ALLOWED = new Set(["no_show", "rescheduled", "placeholder", "no_conversation"]);

export async function classifyCall(
  callId: string,
  outcome: string,
  dealId?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!ALLOWED.has(outcome)) {
      return { ok: false, error: `invalid outcome '${outcome}'` };
    }
    const tenantId = await resolveTenantId("magaya");
    const db = supabaseAdmin();
    // Only refine a call that produced no conversation; never override a
    // captured call from the UI.
    const res = await db
      .from("calls")
      .update({ outcome })
      .eq("tenant_id", tenantId)
      .eq("id", callId)
      .in("outcome", ["no_conversation", "no_show", "rescheduled", "placeholder"]);
    if (res.error) return { ok: false, error: res.error.message };
    if (dealId) revalidatePath(`/deals/${dealId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
