/**
 * Containment for meetings DealRipe should never have been in.
 *
 * The join gate is the first line and it will not be perfect. This is the
 * second: once a transcript exists we can tell for certain whether the
 * conversation was Magaya selling to a customer, and if it was not, the
 * recording should leave no trace. No extraction, no CRM write-back, no recap
 * in a rep's inbox, no transcript on disk, and nothing feeding the playbook.
 *
 * Why a second classifier rather than reusing classifyMeetingType: that one
 * asks which KIND of sales call this was, and its three answers all assume a
 * sales call. A benefits vendor pitching Magaya has a customer-sounding voice
 * on the line and classifies as new_opportunity. The question that separates it
 * is direction, who is selling to whom, and nothing currently asks that.
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { supabaseAdmin } from "./supabase";

export type CommercialDirection =
  | "we_are_selling" // Magaya selling to a prospect or serving a customer
  | "we_are_buying" // a vendor selling TO Magaya: payroll, benefits, IT, recruiting
  | "internal" // Magaya people only, or a candidate interview
  | "unknown"; // classifier unavailable; treated as selling, see below

const MAX_CHARS = 6000;

/**
 * Who was selling to whom.
 *
 * Abstains toward "we_are_selling" on any failure, which is the opposite of the
 * join gate's bias and is deliberate. The gate errs toward not recording,
 * because not recording is cheap. Here the recording already exists and a
 * rep may be waiting on the recap, so an outage must not silently delete a real
 * customer call. Deleting real work is worse than keeping one vendor call.
 */
export async function classifyCommercialDirection(
  transcript: string,
  opts?: { sellerName?: string },
): Promise<CommercialDirection> {
  if (!process.env.ANTHROPIC_API_KEY || transcript.trim().length < 200) return "unknown";
  const seller = opts?.sellerName ?? "the seller";

  const system = `You are given a call transcript from a sales rep who works at ${seller}. Decide the DIRECTION of the conversation. Reply with exactly one word.

we_are_selling: ${seller} is selling to, demoing for, negotiating with, onboarding or supporting a prospect or customer.
we_are_buying: someone is selling TO ${seller}, or providing ${seller} a service. Payroll, benefits, insurance, recruiting agencies, IT and software vendors, consultants, banks.
internal: only ${seller} employees are present, OR it is a job interview with a candidate, OR it is a personal or social conversation.

When genuinely unsure, answer we_are_selling.`;

  try {
    const resp = await getAnthropicClient().messages.create({
      model: getAnthropicModel(),
      max_tokens: 8,
      temperature: 0,
      system,
      messages: [{ role: "user", content: `Transcript:\n\n${transcript.slice(0, MAX_CHARS)}` }],
    });
    const text = resp.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .toLowerCase();
    if (text.includes("we_are_buying")) return "we_are_buying";
    if (text.includes("internal")) return "internal";
    return "we_are_selling";
  } catch {
    return "unknown";
  }
}

export type QuarantineResult = {
  purged: boolean;
  transcriptDeleted: boolean;
  dealDeleted: boolean;
  reason: string;
};

/**
 * Erase what we captured from a meeting that was not ours to capture.
 *
 * Deletes the transcript body, marks the call discarded, and removes the
 * auto-created deal when this was its only call. The calls row itself is kept
 * with an explicit outcome rather than deleted, so the calendar sync does not
 * cheerfully re-join the same recurring meeting next week, and so there is an
 * auditable record that we recorded something and then destroyed it.
 */
export async function quarantineCall(args: {
  tenantId: string;
  callId: string;
  direction: CommercialDirection;
}): Promise<QuarantineResult> {
  const db = supabaseAdmin();
  const reason = args.direction === "we_are_buying" ? "vendor selling to Magaya" : "internal or interview";

  const tr = await db.from("transcripts").delete().eq("call_id", args.callId);
  const transcriptDeleted = !tr.error;
  if (tr.error) console.error(`[quarantine] transcript delete failed for ${args.callId}: ${tr.error.message}`);

  const upd = await db
    .from("calls")
    .update({ outcome: "discarded", meeting_type: "internal", call_subtype: "internal" })
    .eq("id", args.callId);
  if (upd.error) console.error(`[quarantine] call update failed for ${args.callId}: ${upd.error.message}`);

  // Remove the auto-created deal if this was the only thing on it. A deal with
  // other calls is a real customer whose classification we got wrong on one
  // meeting, and deleting it would destroy genuine history.
  let dealDeleted = false;
  const call = await db.from("calls").select("deal_id").eq("id", args.callId).maybeSingle();
  const dealId = call.data?.deal_id ?? null;
  if (dealId) {
    const deal = await db
      .from("deals")
      .select("id, external_id, rolldog_opportunity_id")
      .eq("id", dealId)
      .maybeSingle();
    const isAuto = (deal.data?.external_id ?? "").startsWith("auto:");
    const mapped = Boolean(deal.data?.rolldog_opportunity_id);
    if (isAuto && !mapped) {
      const others = await db
        .from("calls")
        .select("id", { count: "exact", head: true })
        .eq("deal_id", dealId)
        .neq("id", args.callId);
      if ((others.count ?? 0) === 0) {
        const del = await db.from("deals").delete().eq("id", dealId);
        dealDeleted = !del.error;
        if (del.error) console.error(`[quarantine] deal delete failed for ${dealId}: ${del.error.message}`);
      }
    }
  }

  console.log(
    `[quarantine] call ${args.callId} purged (${reason}): transcript=${transcriptDeleted} deal=${dealDeleted}`,
  );
  return { purged: true, transcriptDeleted, dealDeleted, reason };
}

/** True when a call of this direction must be purged rather than processed. */
export function mustQuarantine(d: CommercialDirection): boolean {
  return d === "we_are_buying" || d === "internal";
}
