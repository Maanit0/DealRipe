/**
 * No-show follow-up draft.
 *
 * When a scheduled customer call is a no-show (the bot joined but there was no
 * conversation), draft a short, warm follow-up the rep can send to the prospect,
 * and email that draft to the rep to copy, tweak, and send. This is Eduardo's
 * "no-show follow-up" idea. It never emails the customer and never sends
 * anything automatically; it only hands the rep a ready starting point.
 *
 * Best-effort by design: every failure returns a reason instead of throwing, so
 * the transcript-sync pipeline is never affected. Only drafts for real external
 * customer meetings (a non-Magaya invitee or a known contact), so internal
 * placeholders never generate a draft.
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { renderNoShowDraftEmail } from "./emails/no-show-draft";
import { MailerConfigError, sendEmail } from "./mailer";
import { repEmailForDeal } from "./pilot-config";
import { recordSentMessage } from "./sent-messages";
import { supabaseAdmin } from "./supabase";

export type NoShowDraft = { subject: string; body: string };
export type NoShowResult = { sent: boolean; to?: string; reason?: string };

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Draft a graceful follow-up from the rep to a prospect who missed the call. */
export async function generateNoShowDraft(args: {
  account: string;
  contactName: string | null;
  context?: string;
}): Promise<NoShowDraft | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const system = `You draft a short, warm follow-up email FROM a B2B sales rep TO a prospect who did not show up to a scheduled call.

Goal: acknowledge the missed meeting graciously, assume good faith (things come up), and gently check whether there is still interest and offer to find another time.

Rules:
- No em-dashes or en-dashes anywhere. Use commas or periods. Hard rule.
- 3 to 5 short sentences. Friendly, professional, human. Never guilt-tripping, never pushy, never salesy filler.
- Do not sound automated. Do not invent facts, numbers, or specifics that were not given.
- Use the contact's first name if provided.
- End with a light question or an invitation to reschedule.
- Do NOT add a signature or sign-off line; the rep adds their own.

Return a single JSON object, no prose, no markdown fences:
{ "subject": string, "body": string }`;

  const contactLine = args.contactName
    ? `CONTACT: ${args.contactName} (use the first name "${firstName(args.contactName)}")`
    : `CONTACT: unknown (open with a warm, name-free greeting)`;

  const user = [
    `ACCOUNT: ${args.account}`,
    contactLine,
    args.context ? `CONTEXT: ${args.context}` : "",
    ``,
    `Write the follow-up JSON. Return JSON only.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const resp = await getAnthropicClient().messages.create({
      model: getAnthropicModel(),
      max_tokens: 500,
      temperature: 0.4,
      system,
      messages: [{ role: "user", content: user }],
    });
    const block = resp.content.find((b) => b.type === "text");
    const text = block && "text" in block ? block.text : "";
    const s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const o = JSON.parse(s) as { subject?: string; body?: string };
    if (typeof o.subject === "string" && typeof o.body === "string") {
      return { subject: o.subject, body: o.body };
    }
    return null;
  } catch (err) {
    console.warn(
      `[no-show] draft generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Draft and email a no-show follow-up for a call, to the deal's rep. Returns a
 * reason instead of throwing. Skips internal/placeholder meetings (no customer
 * invitee and no known contact).
 */
export async function sendNoShowFollowup(args: {
  tenantId: string;
  callId: string;
  /** When true, archive the draft to sent_messages but do NOT email the rep.
   *  Lets you preview a no-show draft on the deal page without sending. */
  dryRun?: boolean;
}): Promise<NoShowResult> {
  const db = supabaseAdmin();

  const call = await db
    .from("calls")
    .select("id, deal_id, participants, scheduled_start, call_date")
    .eq("tenant_id", args.tenantId)
    .eq("id", args.callId)
    .maybeSingle();
  if (call.error || !call.data?.deal_id) {
    return { sent: false, reason: `call ${args.callId} not found or has no deal` };
  }

  const deal = await db
    .from("deals")
    .select("id, account, external_id, rep_email, industry")
    .eq("tenant_id", args.tenantId)
    .eq("id", call.data.deal_id)
    .maybeSingle();
  if (deal.error || !deal.data) {
    return { sent: false, reason: `deal for call ${args.callId} not found` };
  }

  const to = repEmailForDeal(deal.data.external_id ?? "") ?? deal.data.rep_email ?? undefined;
  if (!to) return { sent: false, reason: `no rep email for deal ${deal.data.external_id}` };

  // A customer stakeholder must exist for this to be a real external no-show,
  // not an internal placeholder. Prefer a known contact name for personalizing.
  const contactsRes = await db
    .from("contacts")
    .select("name, relationship")
    .eq("tenant_id", args.tenantId)
    .eq("deal_id", deal.data.id);
  const contacts = (contactsRes.data ?? []) as Array<{ name: string | null; relationship: string | null }>;
  const champion = contacts.find((c) => c.relationship === "champion")?.name ?? null;
  const anyContact = champion ?? contacts.find((c) => c.name)?.name ?? null;

  const participants = Array.isArray(call.data.participants)
    ? (call.data.participants as Array<Record<string, unknown>>)
    : [];
  const hasCustomerInvitee = participants.some((p) => {
    const email = typeof p.email === "string" ? p.email : "";
    const domain = email.split("@")[1]?.toLowerCase();
    return domain && domain !== "magaya.com";
  });

  let contactName = anyContact;
  if (!contactName && hasCustomerInvitee) {
    // Fall back to an invitee's name if we have no stored contact.
    const inv = participants.find((p) => {
      const email = typeof p.email === "string" ? p.email : "";
      const domain = email.split("@")[1]?.toLowerCase();
      return domain && domain !== "magaya.com";
    });
    contactName = (inv && typeof inv.name === "string" ? inv.name : null) ?? null;
  }

  if (!anyContact && !hasCustomerInvitee) {
    return { sent: false, reason: "no customer stakeholder; skipping (likely internal placeholder)" };
  }

  const draft = await generateNoShowDraft({
    account: deal.data.account,
    contactName,
    context: deal.data.industry ? `The account is in: ${deal.data.industry}.` : undefined,
  });
  if (!draft) return { sent: false, to, reason: "draft generation returned null" };

  const email = renderNoShowDraftEmail({
    account: deal.data.account,
    contactName,
    callDate: call.data.scheduled_start ?? call.data.call_date ?? null,
    draft,
  });

  if (args.dryRun) {
    await recordSentMessage({
      tenantId: args.tenantId,
      dealId: deal.data.id,
      callId: args.callId,
      kind: "no_show_draft",
      toEmail: to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      providerId: null,
    });
    return { sent: false, to, reason: "dry-run: draft archived, email skipped" };
  }

  try {
    const res = await sendEmail({ to, subject: email.subject, html: email.html, text: email.text });
    await recordSentMessage({
      tenantId: args.tenantId,
      dealId: deal.data.id,
      callId: args.callId,
      kind: "no_show_draft",
      toEmail: to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      providerId: res.id || null,
    });
    return { sent: true, to, reason: `resend id ${res.id}` };
  } catch (err) {
    if (err instanceof MailerConfigError) {
      return { sent: false, to, reason: `mailer not configured: ${err.message}` };
    }
    return { sent: false, to, reason: err instanceof Error ? err.message : String(err) };
  }
}
