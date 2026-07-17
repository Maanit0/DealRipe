/**
 * Read one call's stored transcript for the in-app viewer. Tenant-scoped so a
 * call from another tenant can't be opened. Returns null if the call or its
 * transcript isn't found.
 */

import { supabaseAdmin } from "./supabase";

export type CallTranscript = {
  callId: string;
  dealId: string;
  account: string;
  callDate: string | null;
  body: string;
};

export async function getCallTranscript(
  tenantId: string,
  callId: string,
): Promise<CallTranscript | null> {
  const db = supabaseAdmin();
  const call = await db
    .from("calls")
    .select("id, deal_id, scheduled_start, call_date")
    .eq("tenant_id", tenantId)
    .eq("id", callId)
    .maybeSingle();
  if (call.error || !call.data) return null;

  const t = await db
    .from("transcripts")
    .select("body")
    .eq("tenant_id", tenantId)
    .eq("call_id", callId)
    .maybeSingle();
  if (t.error || !t.data?.body) return null;

  const deal = await db
    .from("deals")
    .select("account")
    .eq("tenant_id", tenantId)
    .eq("id", call.data.deal_id)
    .maybeSingle();

  return {
    callId,
    dealId: call.data.deal_id,
    account: deal.data?.account ?? "",
    callDate: call.data.scheduled_start ?? call.data.call_date ?? null,
    body: t.data.body,
  };
}
