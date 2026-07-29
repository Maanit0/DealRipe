/**
 * Re-run the corrected classification on an ALREADY-processed call and clean up
 * the data it left behind. New code only affects future calls; a call that was
 * already ingested keeps its old (wrong) state until you fix it here.
 *
 * For the given call it:
 *   - recomputes meeting type and customer participation,
 *   - if a customer was invited but nobody from their side spoke, marks the call
 *     outcome = no_show,
 *   - re-runs the hardened contact extractor and removes call-sourced contacts on
 *     the deal that the corrected extractor no longer considers customer-side
 *     (e.g. internal colleagues wrongly added), and
 *   - deletes any qualification field_extractions this call wrote to the deal, so
 *     an internal / no-show call never leaves deal truth behind.
 *
 * Dry-run by default. Pass --apply to write the changes.
 *
 *   npx tsx scripts/reclassify-call.ts --call <callId>
 *   npx tsx scripts/reclassify-call.ts --account "Flyfreight"   # find the deal's latest call
 *   npx tsx scripts/reclassify-call.ts --call <callId> --apply
 *
 * Runs on your Mac with .env.local (needs Supabase + ANTHROPIC_API_KEY).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { customerParticipation } from "../lib/attendance";
import { extractContactsFromTranscript } from "../lib/contacts-extract";
import { classifyMeetingType, callSubtypeLabel } from "../lib/meeting-classify";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  // Resolve the call: by --call, or the latest call on a deal matched by --account.
  let callId = arg("--call") ?? null;
  if (!callId) {
    const acct = arg("--account");
    if (!acct) {
      console.error('Provide --call <callId> or --account "<name>".');
      process.exit(1);
    }
    const deal = await db
      .from("deals")
      .select("id, account")
      .eq("tenant_id", tenantId)
      .ilike("account", `%${acct}%`)
      .limit(1)
      .maybeSingle();
    if (!deal.data) {
      console.error(`No deal matched account "${acct}".`);
      process.exit(1);
    }
    const c = await db
      .from("calls")
      .select("id, scheduled_start, call_date")
      .eq("tenant_id", tenantId)
      .eq("deal_id", deal.data.id)
      .order("scheduled_start", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!c.data) {
      console.error(`Deal "${deal.data.account}" has no calls.`);
      process.exit(1);
    }
    callId = c.data.id;
  }

  const call = await db
    .from("calls")
    .select("id, deal_id, participants, meeting_type, call_subtype, outcome")
    .eq("tenant_id", tenantId)
    .eq("id", callId)
    .maybeSingle();
  if (call.error || !call.data) {
    console.error(`Call ${callId} not found.`);
    process.exit(1);
  }
  const deal = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id")
    .eq("tenant_id", tenantId)
    .eq("id", call.data.deal_id)
    .maybeSingle();
  if (!deal.data) {
    console.error(`Deal for call ${callId} not found.`);
    process.exit(1);
  }
  const t = await db.from("transcripts").select("body").eq("tenant_id", tenantId).eq("call_id", callId).maybeSingle();
  const body = t.data?.body ?? "";
  if (body.trim().length < 50) {
    console.error("No transcript stored for this call; nothing to reclassify.");
    process.exit(1);
  }

  console.log(`\nCall ${callId}  ·  deal: ${deal.data.account}`);
  console.log(`  current: meeting_type=${call.data.meeting_type ?? "-"}  outcome=${call.data.outcome ?? "-"}\n`);

  // 1. Meeting type + customer participation.
  const trackedOpportunity =
    !!deal.data.rolldog_opportunity_id || !!rolldogOppIdForDeal(deal.data.external_id ?? "");
  const meetingType = await classifyMeetingType(body, { trackedOpportunity });
  const { hadCustomerInvitee, anyCustomerSpoke } = customerParticipation(call.data.participants, body);
  const customerNoShow = hadCustomerInvitee && !anyCustomerSpoke;
  const newOutcome = customerNoShow ? "no_show" : call.data.outcome ?? "captured";

  console.log(`  recomputed: meeting_type=${meetingType}  customerInvited=${hadCustomerInvitee}  customerSpoke=${anyCustomerSpoke}`);
  console.log(`  -> outcome: ${call.data.outcome ?? "-"} => ${newOutcome}${customerNoShow ? "  (customer no-show)" : ""}`);

  // 2. Contacts: which call-sourced ones the corrected extractor no longer keeps.
  const kept = await extractContactsFromTranscript({ transcript: body, account: deal.data.account });
  const keepNames = new Set(kept.map((c) => c.name.trim().toLowerCase()));
  const existing = await db
    .from("contacts")
    .select("id, name, external_id, relationship")
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.data.id);
  const removable = ((existing.data ?? []) as Array<{ id: string; name: string; external_id: string | null; relationship: string | null }>)
    .filter((c) => (c.external_id ?? "").startsWith("call:") && !keepNames.has((c.name ?? "").trim().toLowerCase()));
  console.log(`  contacts to remove (${removable.length}): ${removable.map((c) => `${c.name} [${c.relationship}]`).join(", ") || "none"}`);

  // 3. Field extractions this call wrote to the deal.
  const fx = await db
    .from("field_extractions")
    .select("id, framework_field_key")
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.data.id)
    .eq("last_updated_from_call_id", callId);
  const fxRows = (fx.data ?? []) as Array<{ id: string; framework_field_key: string }>;
  console.log(`  field_extractions from this call to delete (${fxRows.length}): ${fxRows.map((r) => r.framework_field_key).join(", ") || "none"}`);

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to write these changes.\n`);
    return;
  }

  // ---- Apply ----
  const subtype = customerNoShow ? call.data.call_subtype : callSubtypeLabel(call.data.call_subtype) ? call.data.call_subtype : call.data.call_subtype;
  const upd = await db.from("calls").update({ meeting_type: meetingType, outcome: newOutcome }).eq("id", callId);
  if (upd.error) console.error(`  calls update failed: ${upd.error.message}`);
  void subtype;

  if (removable.length) {
    const del = await db.from("contacts").delete().in("id", removable.map((c) => c.id));
    if (del.error) console.error(`  contacts delete failed: ${del.error.message}`);
  }
  if (fxRows.length) {
    const del = await db.from("field_extractions").delete().in("id", fxRows.map((r) => r.id));
    if (del.error) console.error(`  field_extractions delete failed: ${del.error.message}`);
  }
  console.log(`\nApplied. Call is now meeting_type=${meetingType}, outcome=${newOutcome}; ${removable.length} contact(s) and ${fxRows.length} field(s) removed.\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
