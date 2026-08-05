/**
 * Draft the post-call follow-up email for a real deal, and optionally write it
 * into the rep's Outlook drafts.
 *
 * Prints the exact email first. Nothing reaches a mailbox without --apply, and
 * nothing is ever sent: the app holds Mail.ReadWrite and not Mail.Send, so the
 * rep is always the one who presses send.
 *
 *   npx tsx scripts/draft-followup.ts --deal auto:corelogistics.net
 *   npx tsx scripts/draft-followup.ts --deal morneau --apply
 *   npx tsx scripts/draft-followup.ts --deal morneau --mailbox jlopez@magaya.com
 *
 * The mailbox defaults to the deal's rep and must be on
 * GRAPH_MAIL_ALLOWED_MAILBOXES. Run on your Mac.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getDealContext } from "../lib/deal-context";
import { customerDomainsFor, createFollowUpDraft, generateFollowUpDraft } from "../lib/followup-draft";
import { generatePostCallSummary } from "../lib/post-call-summary";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Attendee = { email?: string | null; name?: string | null };

async function main(): Promise<void> {
  const dealExternalId = arg("--deal");
  const apply = process.argv.includes("--apply");
  if (!dealExternalId) {
    console.error("Usage: --deal <external_id> [--mailbox rep@magaya.com] [--apply]");
    process.exit(1);
  }

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const deal = await db
    .from("deals")
    .select("id, account, rep_email")
    .eq("tenant_id", tenantId)
    .eq("external_id", dealExternalId)
    .maybeSingle();
  if (!deal.data) throw new Error(`deal '${dealExternalId}' not found`);

  const mailbox = arg("--mailbox") ?? deal.data.rep_email;
  if (!mailbox) throw new Error(`no rep_email on the deal and no --mailbox given`);

  // Most recent call that actually happened and has a transcript.
  const call = await db
    .from("calls")
    .select("id, scheduled_start, call_date, participants, title")
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.data.id)
    .lte("scheduled_start", new Date().toISOString())
    .order("scheduled_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!call.data) throw new Error("no past call on this deal");

  const tr = await db.from("transcripts").select("body").eq("call_id", call.data.id).maybeSingle();
  if (!tr.data?.body) throw new Error(`no transcript stored for the latest call (${call.data.id})`);

  const ctx = await getDealContext(tenantId, deal.data.id);
  if (!ctx) throw new Error("getDealContext returned null");

  const participants = Array.isArray(call.data.participants)
    ? (call.data.participants as Attendee[])
    : [];
  const customerEmails = participants
    .map((p) => (p?.email ?? "").toLowerCase())
    .filter((e) => e.includes("@") && !e.endsWith("@magaya.com"));
  const customerDomains = customerDomainsFor(customerEmails);

  console.log(`\ndeal:       ${dealExternalId}  "${deal.data.account}"`);
  console.log(`mailbox:    ${mailbox}`);
  console.log(`call:       ${call.data.scheduled_start ?? call.data.call_date}  ${call.data.title ?? "(untitled)"}`);
  console.log(`customer:   ${customerEmails.join(", ") || "(none on the invite)"}`);
  console.log(`domains:    ${customerDomains.join(", ") || "(none)"}\n`);

  console.log("Generating the post-call summary first (same input the recap uses)...");
  const summary = await generatePostCallSummary({
    account: ctx.account,
    stageKey: ctx.effectiveStageKey,
    closeDate: ctx.closeDate || undefined,
    attendees: ctx.attendees,
    framework: ctx.framework,
    extraction: ctx.extraction as never,
    transcript: tr.data.body,
  });
  if (!summary) throw new Error("post-call summary generation returned null");

  console.log(`  next-step commitment: ${summary.nextStepCommitment ?? "(none agreed on the call)"}`);
  console.log(`  follow-up expected:   ${summary.followUpMeetingExpected}`);
  console.log(`  should book a date:   ${summary.shouldBookNextMeeting}`);
  console.log(`  gaps still open:      ${summary.stillOpen.length}\n`);

  const input = {
    mailbox,
    customerDomains,
    customerEmails,
    account: ctx.account,
    summary,
    attendees: ctx.attendees,
    callDate: call.data.scheduled_start ?? call.data.call_date,
  };

  if (!apply) {
    const draft = await generateFollowUpDraft(input);
    if (!draft) throw new Error("draft generation returned nothing");
    console.log("-".repeat(70));
    console.log(draft.replyToMessageId ? "REPLY on the existing customer thread" : "NEW email (no thread found)");
    if (!draft.replyToMessageId) console.log(`To: ${draft.to.join(", ") || "(no recipients resolved)"}`);
    if (!draft.replyToMessageId) console.log(`Subject: ${draft.subject}`);
    console.log("-".repeat(70));
    console.log(draft.body);
    console.log("-".repeat(70));
    if (draft.attachmentsToAdd.length > 0) {
      console.log(`Rep should attach: ${draft.attachmentsToAdd.join(", ")}`);
    }
    console.log(`\nWord count: ${draft.body.trim().split(/\s+/).length}`);
    console.log("Dry run. Nothing written to the mailbox. Re-run with --apply.\n");
    return;
  }

  const res = await createFollowUpDraft(input);
  if (!res.created) throw new Error(`draft not created: ${res.reason}`);
  console.log("-".repeat(70));
  console.log(res.draft?.body ?? "");
  console.log("-".repeat(70));
  console.log(`\nDraft created in ${mailbox}'s Drafts folder. Nothing was sent.`);
  if (res.webLink) console.log(`Open: ${res.webLink}`);
  if (res.draft?.attachmentsToAdd.length) {
    console.log(`Rep should attach: ${res.draft.attachmentsToAdd.join(", ")}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
