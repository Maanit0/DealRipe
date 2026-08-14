/**
 * Why did this call get no follow-up draft, and can we still produce one?
 *
 * transcript-sync calls autoDraftFollowUpForCall best-effort and only LOGS the
 * reason it declined, so the Activity card says "never sent" and nothing says
 * why. On 2026-08-11 Custom Goods and Z Transportation both showed that, while
 * every one of Alexandra's calls the same day drafted fine.
 *
 * Rather than restate the guards in a checker (which is how a diagnostic starts
 * disagreeing with production), this calls the real function. It returns a
 * reason when it declines, and creates the draft when it can, so either way you
 * end up better off:
 *
 *   meeting type is not new_opportunity   correct, an internal or post-sale call
 *   mailbox not on the allowlist          GRAPH_MAIL_ALLOWED_MAILBOXES in Vercel
 *   no customer-side attendee             calls.participants holds invitees only,
 *                                         so a customer-organised meeting has none
 *   already drafted                       idempotency, nothing wrong
 *
 * Regenerating the summary costs one model call per deal, because the draft is
 * composed from it and it is not stored in a reusable shape.
 *
 *   npx tsx scripts/retry-followup-draft.ts --deal Custom-goods
 *   npx tsx scripts/retry-followup-draft.ts --deal Custom-goods --apply
 *
 * Without --apply it stops before the model call and reports only the cheap
 * guards, which is usually enough.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { allowedMailboxes, listMailboxMessages } from "../lib/graph-mail";
import { formatMeetingTime } from "../lib/graph-time";
import { getFrameworkForDeal } from "../lib/framework";
import { generatePostCallSummary } from "../lib/post-call-summary";
import { autoDraftFollowUpForCall } from "../lib/followup-draft";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function domainOf(e: string): string {
  return (e.split("@")[1] ?? "").toLowerCase();
}

async function main(): Promise<void> {
  const only = arg("--deal")?.toLowerCase();
  const apply = process.argv.includes("--apply");
  if (!only) {
    console.log("\nPass --deal <name>.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const deals = await db.from("deals").select("id, account, rep_email").eq("tenant_id", tenantId);
  const deal = ((deals.data ?? []) as Array<{ id: string; account: string; rep_email: string | null }>).find(
    (d) => (d.account ?? "").toLowerCase().includes(only),
  );
  if (!deal) {
    console.log(`\nNo deal matching "${only}".\n`);
    process.exit(1);
  }

  const callsRes = await db
    .from("calls")
    .select("id, external_id, title, scheduled_start, outcome, meeting_type, participants, has_been_extracted")
    .eq("deal_id", deal.id)
    .order("scheduled_start", { ascending: false });
  const calls = (callsRes.data ?? []).filter(
    (c) => c.outcome !== "duplicate" && (c.has_been_extracted === true || c.outcome === "captured"),
  );
  if (calls.length === 0) {
    console.log(`\n${deal.account}: no captured call.\n`);
    return;
  }

  const c = calls[0];
  const rep = (deal.rep_email ?? "").trim().toLowerCase();
  console.log(`\n${deal.account}   ${formatMeetingTime(c.scheduled_start)}`);
  console.log(`  rep           ${rep || "(none on the deal)"}`);
  console.log(`  meeting_type  ${c.meeting_type ?? "(unclassified)"}`);

  // The cheap guards, reported before spending a model call.
  const mailboxes = allowedMailboxes();
  console.log(`  mailbox       ${mailboxes.includes(rep) ? "on the allowlist" : `NOT on GRAPH_MAIL_ALLOWED_MAILBOXES (${mailboxes.length} entries locally)`}`);

  const people = Array.isArray(c.participants) ? (c.participants as Array<{ email?: string | null }>) : [];
  const customers = people
    .map((p) => (p?.email ?? "").toLowerCase().trim())
    .filter((e) => e.includes("@") && domainOf(e) !== "magaya.com");
  console.log(`  customers     ${customers.length > 0 ? customers.join(", ") : "NONE on calls.participants"}`);

  const prior = await db
    .from("sent_messages")
    .select("id, sent_at")
    .eq("tenant_id", tenantId)
    .eq("call_id", String(c.id))
    .eq("kind", "followup_draft");
  console.log(`  prior draft   ${(prior.data ?? []).length > 0 ? "one already exists" : "none"}`);

  if (c.meeting_type !== "new_opportunity") {
    console.log(`\n  Declined: extraction and drafting are gated on new_opportunity. An internal`);
    console.log(`  or post-sale call getting no draft is the gate working.\n`);
    return;
  }
  if (!mailboxes.includes(rep)) {
    console.log(`\n  Declined: this rep's mailbox is not on the allowlist. Note this reads your`);
    console.log(`  LOCAL env; production is what mattered when the call ran. Check Vercel.\n`);
    return;
  }
  if (customers.length === 0) {
    console.log(`\n  Declined: no customer-side attendee. calls.participants holds invitees only`);
    console.log(`  and Graph reports the organiser separately, so a meeting the CUSTOMER`);
    console.log(`  organised has an empty attendee list from our side.\n`);
    return;
  }
  if ((prior.data ?? []).length > 0) {
    console.log(`\n  Declined: already drafted, so this is idempotency rather than a failure.\n`);
    return;
  }

  // Did the rep already follow up themselves?
  //
  // A draft exists to save the rep a job, not to duplicate one they have done.
  // If they emailed the customer after the call, dropping another draft in their
  // Outlook is noise at best and a confusing near-duplicate at worst. We have
  // app-only Mail.Read, so this is answerable rather than assumed.
  const callEnd = new Date(String(c.scheduled_start ?? ""));
  const domains = Array.from(new Set(customers.map((e) => domainOf(e)).filter(Boolean)));
  let repEmailed: { at: string | null; subject: string } | null = null;
  try {
    const msgs = await listMailboxMessages({
      tenantIdOrDomain: "magaya.com",
      mailbox: rep,
      since: callEnd,
      domains,
      maxPages: 3,
    });
    const sentToCustomer = msgs
      .filter((m) => m.outbound)
      .filter((m) => [...m.to, ...m.cc].some((a) => domains.includes(domainOf(a) ?? "")))
      .sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""));
    repEmailed = sentToCustomer[0] ? { at: sentToCustomer[0].at, subject: sentToCustomer[0].subject } : null;
  } catch (err) {
    console.log(`\n  Could not read ${rep}'s mailbox: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  That is not evidence they did not follow up. Resolve before drafting.\n`);
    return;
  }

  // --diagnose continues past this so the original failure can be seen. The rep
  // having covered for us answers "is the customer waiting", not "why did the
  // draft not appear", and those are different questions.
  const diagnose = process.argv.includes("--diagnose");
  if (repEmailed) {
    console.log(`\n  ${rep} already emailed the customer after this call:`);
    console.log(`    ${repEmailed.at ? formatMeetingTime(repEmailed.at) : "(no timestamp)"}  ${repEmailed.subject}`);
    if (!diagnose) {
      console.log(`\n  No draft needed. The follow-up happened, DealRipe just did not write it.`);
      console.log(`  Re-run with --diagnose to find out why the draft failed anyway.\n`);
      return;
    }
    console.log(`\n  --diagnose: continuing to find the original failure. A draft WILL be`);
    console.log(`  created if it succeeds, so only do this when a near-duplicate is acceptable.`);
  }

  // Only true when the check above found nothing. This line used to print
  // unconditionally, so a --diagnose run said "already emailed the customer"
  // and "no outbound mail since the call" four lines apart, about the same
  // mailbox. Two statements from one check cannot be allowed to disagree.
  if (!repEmailed) {
    console.log(`\n  No outbound mail from ${rep} to ${domains.join(", ")} since the call.`);
  }
  console.log(`  Every cheap guard passes, so the decline happened inside createFollowUpDraft.`);
  if (!apply) {
    console.log(`  Re-run with --apply to regenerate the summary and try the draft for real.\n`);
    return;
  }

  const tr = await db.from("transcripts").select("body").eq("call_id", String(c.id)).maybeSingle();
  const body = tr.data?.body ?? "";
  if (body.trim().length < 50) {
    console.log(`  No transcript to summarise.\n`);
    return;
  }
  const framework = await getFrameworkForDeal(deal.id);
  if (!framework) {
    console.log(`  No framework on this deal.\n`);
    return;
  }
  const fx = await db
    .from("field_extractions")
    .select("framework_field_key, status, answer, evidence, confidence")
    .eq("deal_id", deal.id);
  const extraction = Object.fromEntries(
    (fx.data ?? []).map((r) => [
      String((r as { framework_field_key: string }).framework_field_key),
      r as unknown as Record<string, unknown>,
    ]),
  );

  const summary = await generatePostCallSummary({
    account: deal.account,
    stageKey: "SQL1",
    framework,
    extraction: extraction as never,
    transcript: body,
  });

  const res = await autoDraftFollowUpForCall({
    tenantId,
    callId: String(c.id),
    dealId: deal.id,
    account: deal.account,
    repEmail: rep,
    meetingType: String(c.meeting_type ?? ""),
    summary,
    callDate: c.scheduled_start,
    participants: c.participants,
  });

  console.log(res.created ? `\n  Draft created in ${rep}'s Outlook.\n` : `\n  Declined: ${res.reason}\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
