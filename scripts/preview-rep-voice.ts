/**
 * What does DealRipe think this rep sounds like, and what would it write?
 *
 * Voice tuning has only ever been done for Juan, by reading his drafts and
 * adjusting until they read like him. Every other rep is running on a pipeline
 * nobody has inspected. This makes that inspectable without sending anything:
 *
 *   SAMPLES   the exact messages voiceSamples picked, and whether they are
 *             customer-facing or the weaker any-sent-mail fallback
 *   SIGN-OFF  the closing line of each sample, which is the single detail reps
 *             notice first and the one a preview-only sampler could never see
 *   DRAFT     a real generated follow-up for this rep's most recent captured
 *             call, printed rather than written to their mailbox
 *
 * The sample count matters more than it looks. A rep with two thin samples gets
 * a draft that is generically competent and not theirs, and that is
 * indistinguishable from a good draft unless you go looking. It is also not the
 * same as a rep whose mailbox we cannot read at all, which throws.
 *
 *   npx tsx scripts/preview-rep-voice.ts --rep asuntrup@magaya.com
 *   npx tsx scripts/preview-rep-voice.ts --rep asuntrup@magaya.com --full
 *
 * READ ONLY. Creates no draft. One model call when a draft is generated.
 *
 * Magaya is under NDA. This prints real customer correspondence to your
 * terminal. Do not redirect it into a file in the repo.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getDealContext } from "../lib/deal-context";
import { generateFollowUpDraft, learnSignature, voiceSamples, customerDomainsFor } from "../lib/followup-draft";
import { capturedFields, openFields, type PostCallSummary } from "../lib/post-call-summary";
import { getFrameworkForDeal } from "../lib/framework";
import { formatMeetingTime } from "../lib/graph-time";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The last non-empty line, which is where a sign-off lives. */
function closingLine(sample: string): string {
  const lines = sample.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "(empty)";
}

async function main(): Promise<void> {
  const rep = arg("--rep")?.toLowerCase();
  const full = process.argv.includes("--full");
  if (!rep) {
    console.log("\nUsage: --rep <email> [--full]\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  console.log("");
  console.log(`VOICE SAMPLES for ${rep}`);
  console.log("");

  let samples: string[] = [];
  try {
    samples = await voiceSamples(rep);
  } catch (e) {
    // A throw here is almost always the mailbox allowlist, and it is a
    // completely different problem from a rep who writes very little. Say which.
    console.log(`  MAILBOX READ FAILED: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  This is not "this rep has no voice". We could not read the mailbox at all.`);
    console.log(`  If it mentions scope or allowlist, check GRAPH_MAIL_ALLOWED_MAILBOXES.`);
    console.log("");
    return;
  }

  if (samples.length === 0) {
    console.log(`  No usable sent mail in the last 90 days.`);
    console.log(`  The draft will be written in a competent generic voice, which reads fine and`);
    console.log(`  will not sound like her. Worth knowing before she opens it.`);
  } else {
    console.log(`  ${samples.length} sample(s).`);
    console.log("");
    samples.forEach((s, i) => {
      const subject = s.split("\n")[0];
      console.log(`  [${i + 1}] ${subject.slice(0, 78)}`);
      console.log(`      closes with: "${closingLine(s).slice(0, 78)}"`);
      if (full) {
        console.log("");
        console.log(s.split("\n").map((l) => `      ${l}`).join("\n"));
      }
      console.log("");
    });
    const sig = learnSignature(samples);
    console.log(`  LEARNED SIGNATURE, which is what the draft will actually end with:`);
    console.log("");
    console.log(sig ? sig.split("\n").map((l) => `      ${l}`).join("\n") : "      (none learned, falls back to \"Best regards\" plus first name)");
  }

  // Now a real draft, from her most recent captured call.
  const deals = await db.from("deals").select("id, account, rep_email").eq("tenant_id", tenantId);
  if (deals.error) throw new Error(deals.error.message);
  const mine = (deals.data ?? []).filter((d) => (d.rep_email ?? "").toLowerCase() === rep);
  if (mine.length === 0) {
    console.log(`\nNo deals owned by ${rep}, so no draft to preview.\n`);
    return;
  }

  const calls = await db
    .from("calls")
    .select("id, deal_id, title, scheduled_start, participants, has_been_extracted")
    .eq("tenant_id", tenantId)
    .in("deal_id", mine.map((d) => d.id))
    .eq("has_been_extracted", true)
    .order("scheduled_start", { ascending: false })
    .limit(1);
  if (calls.error) throw new Error(calls.error.message);
  const call = (calls.data ?? [])[0];
  if (!call) {
    console.log(`\nNo captured call for ${rep} yet, so there is nothing to draft from.`);
    console.log(`Re-run once one of her calls has been processed.\n`);
    return;
  }

  const deal = mine.find((d) => d.id === call.deal_id);
  const conn = await db
    .from("microsoft_connections")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_principal_name", rep)
    .maybeSingle();

  const emails = (Array.isArray(call.participants) ? call.participants : [])
    .map((p) => String((p as { email?: string }).email ?? ""))
    .filter(Boolean);

  console.log("");
  console.log(`DRAFT PREVIEW`);
  console.log(`  from call   ${formatMeetingTime(call.scheduled_start)}  ${(call.title ?? "").slice(0, 50)}`);
  console.log(`  account     ${deal?.account ?? "?"}`);
  console.log("");

  const recap = await db
    .from("sent_messages")
    .select("body_text")
    .eq("tenant_id", tenantId)
    .eq("call_id", call.id)
    .limit(1)
    .maybeSingle();

  // Build the summary the way production does, from the framework and the
  // stored extraction, rather than faking one. The first version of this passed
  // a two-field stub and the prompt builder read fields that were not there, so
  // the preview died on a missing property while telling you nothing about the
  // voice. A preview that does not use the real shape is not a preview.
  const framework = await getFrameworkForDeal(call.deal_id).catch(() => null);
  const ctx = await getDealContext(tenantId, call.deal_id);
  if (!framework || !ctx) {
    console.log(`  Could not load the framework or deal context, so no draft preview.`);
    console.log("");
    return;
  }

  const summary: PostCallSummary = {
    account: deal?.account ?? "the account",
    // Same precedence the briefing uses: the CRM stage wins over the seeded one.
    stageKey: ctx.crmStageKey ?? ctx.nominalStageKey,
    recap: (recap.data?.body_text ?? "").slice(0, 1200),
    captured: capturedFields(framework, ctx.extraction),
    stillOpen: openFields(framework, ctx.extraction, ctx.crmStageKey ?? ctx.nominalStageKey),
    suggestedNextStep: "",
    nextStepCommitment: null,
    followUpMeetingExpected: false,
    shouldBookNextMeeting: true,
    customerTimezone: null,
    nda: null,
    coaching: null,
  };

  try {
    const draft = await generateFollowUpDraft({
      mailbox: rep,
      customerDomains: customerDomainsFor(emails),
      customerEmails: emails,
      account: deal?.account ?? "the account",
      summary,
      callDate: String(call.scheduled_start ?? "").slice(0, 10),
      calendarConnectionId: conn.data?.id ?? null,
    });
    if (!draft) {
      console.log(`  Generation returned nothing.`);
    } else {
      console.log(`  Subject: ${draft.subject}`);
      console.log(`  Replying to a thread: ${draft.replyToMessageId ? "yes" : "no, new email"}`);
      if (draft.attachmentsToAdd.length > 0) {
        console.log(`  Asks her to attach: ${draft.attachmentsToAdd.join(", ")}`);
      }
      console.log("");
      console.log(draft.body.split("\n").map((l) => `  ${l}`).join("\n"));
    }
  } catch (e) {
    console.log(`  Draft generation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
