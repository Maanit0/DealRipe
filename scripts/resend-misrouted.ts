/**
 * Re-send an artifact that went to the wrong rep, to the right one.
 *
 * Sends the EXACT body already stored in sent_messages rather than regenerating.
 * A regenerated recap would be a different document from the one the first rep
 * read, and the two reps would then be discussing different artifacts about the
 * same call.
 *
 * Deliberately refuses to re-send a briefing. A briefing says "your call in 35
 * min" and is worthless once the call has happened; sending one late is noise
 * that teaches a rep to ignore the channel.
 *
 * Dry run by default. --apply SENDS MAIL.
 *
 *   npx tsx scripts/resend-misrouted.ts --since 2026-08-28
 *   npx tsx scripts/resend-misrouted.ts --since 2026-08-28 --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { sendEmail } from "../lib/mailer";
import { recordSentMessage, type SentMessageKind } from "../lib/sent-messages";
import { supabaseAdmin } from "../lib/supabase";

const APPLY = process.argv.includes("--apply");
function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Only these kinds are worth re-sending after the fact. */
// RECAPS ONLY on this path, and that is not an oversight.
//
// A "followup_draft" row does not record an email that was sent. It records a
// draft written into a rep's Outlook through Graph, and the whole point of that
// artifact is that it is sitting in Drafts ready to edit and send to the
// CUSTOMER. Mailing its body to the correct rep would put a strange-looking
// inbox message in front of them instead of a usable draft, so a mis-routed
// draft has to be re-created in the right mailbox rather than forwarded. Same
// for no_show_draft.
const RESENDABLE = new Set<SentMessageKind>(["recap"]);

async function main(): Promise<void> {
  const since = `${arg("--since") ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const db = supabaseAdmin();

  const { data: sent, error } = await db
    .from("sent_messages")
    .select("id, deal_id, call_id, kind, to_email, subject, body_html, body_text, sent_at, tenant_id")
    .gte("sent_at", since)
    .order("sent_at", { ascending: true });
  if (error) throw new Error(error.message);

  const work: Array<{ id: string; kind: string; subject: string; from: string; to: string; html: string; text: string; dealId: string; callId: string | null; tenantId: string }> = [];

  for (const m of sent ?? []) {
    const dealId = m.deal_id as string | null;
    if (!dealId) continue;
    const { data: deal } = await db.from("deals").select("rep_email, account").eq("id", dealId).maybeSingle();
    const owner = String(deal?.rep_email ?? "").trim().toLowerCase();
    const went = String(m.to_email ?? "").trim().toLowerCase();
    if (!owner || !went || owner === went) continue;

    if (!RESENDABLE.has(m.kind as SentMessageKind)) {
      console.log(`  SKIP  ${String(m.kind).padEnd(14)} ${String(m.subject).slice(0, 44)}  (went to ${went}, now owned by ${owner}) - not worth re-sending late`);
      continue;
    }
    work.push({
      id: m.id as string, kind: String(m.kind), subject: String(m.subject ?? ""),
      from: went, to: owner, html: String(m.body_html ?? ""), text: String(m.body_text ?? ""),
      dealId, callId: (m.call_id as string | null) ?? null, tenantId: m.tenant_id as string,
    });
  }

  if (work.length === 0) {
    console.log(`\nNothing to re-send since ${since.slice(0, 10)}.\n`);
    return;
  }

  console.log(`\n${work.length} artifacts to re-send:`);
  for (const w of work) console.log(`  ${w.kind.padEnd(14)} ${w.subject.slice(0, 46).padEnd(48)} ${w.from} -> ${w.to}`);

  if (!APPLY) {
    console.log(`\nDry run. Re-run with --apply to SEND.\n`);
    return;
  }

  for (const w of work) {
    if (!w.html) {
      console.log(`  no stored body for ${w.subject}, skipping rather than sending a regenerated one`);
      continue;
    }
    const res = await sendEmail({ to: [w.to], subject: w.subject, html: w.html, text: w.text || w.subject });
    await recordSentMessage({
      tenantId: w.tenantId, dealId: w.dealId, callId: w.callId, kind: w.kind as SentMessageKind,
      toEmail: w.to, subject: w.subject, html: w.html, text: w.text || w.subject,
      providerId: res.id || null,
    });
    console.log(`  sent ${w.kind} "${w.subject.slice(0, 40)}" -> ${w.to}`);
  }
  console.log(`\nDone.\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
