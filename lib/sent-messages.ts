/**
 * Sent communications archive.
 *
 * Records the exact briefing/recap emailed to a rep so it can be shown on the
 * deal page and read back later. recordSentMessage is best-effort: it never
 * throws into the send path, because a failure to archive must not fail (or
 * duplicate) an email that already went out.
 */

import { supabaseAdmin } from "./supabase";

export type SentMessageKind = "briefing" | "recap";

export type SentMessage = {
  id: string;
  kind: SentMessageKind;
  toEmail: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  providerId: string | null;
  sentAt: string;
};

/** Archive one sent message. Best-effort: logs and swallows any error. */
export async function recordSentMessage(args: {
  tenantId: string;
  dealId: string;
  callId?: string | null;
  kind: SentMessageKind;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
  providerId?: string | null;
}): Promise<void> {
  try {
    const res = await supabaseAdmin()
      .from("sent_messages")
      .insert({
        tenant_id: args.tenantId,
        deal_id: args.dealId,
        call_id: args.callId ?? null,
        kind: args.kind,
        to_email: args.toEmail,
        subject: args.subject,
        body_html: args.html,
        body_text: args.text,
        provider_id: args.providerId ?? null,
      });
    if (res.error) {
      console.error(`[sent-messages] insert failed for deal ${args.dealId}: ${res.error.message}`);
    }
  } catch (err) {
    console.error(
      `[sent-messages] insert threw for deal ${args.dealId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export type DigestSend = {
  id: string;
  toEmail: string;
  subject: string;
  bodyHtml: string;
  providerId: string | null;
  sentAt: string;
};

/**
 * Archive one weekly digest send (manual or the 6am cron). Stored in
 * sent_messages as kind="digest" with a null deal_id, so it never shows up in a
 * deal's per-deal "Sent communications" but is listed on the digest log page.
 * Best-effort: never throws into the send path.
 */
export async function recordDigestSend(args: {
  tenantId: string;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
  providerId?: string | null;
}): Promise<void> {
  try {
    const res = await supabaseAdmin().from("sent_messages").insert({
      tenant_id: args.tenantId,
      deal_id: null,
      call_id: null,
      kind: "digest",
      to_email: args.toEmail,
      subject: args.subject,
      body_html: args.html,
      body_text: args.text,
      provider_id: args.providerId ?? null,
    });
    if (res.error) {
      console.error(`[sent-messages] digest insert failed: ${res.error.message}`);
    }
  } catch (err) {
    console.error(
      `[sent-messages] digest insert threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Every archived weekly digest for a tenant, newest first. */
export async function getDigestSends(tenantId: string): Promise<DigestSend[]> {
  const res = await supabaseAdmin()
    .from("sent_messages")
    .select("id, to_email, subject, body_html, provider_id, sent_at")
    .eq("tenant_id", tenantId)
    .eq("kind", "digest")
    .order("sent_at", { ascending: false })
    .limit(50);
  if (res.error || !res.data) return [];
  return res.data.map((r) => ({
    id: r.id,
    toEmail: r.to_email,
    subject: r.subject,
    bodyHtml: r.body_html,
    providerId: r.provider_id,
    sentAt: r.sent_at,
  }));
}

/** All archived messages for a deal, newest first. */
export async function getSentMessages(dealId: string): Promise<SentMessage[]> {
  const res = await supabaseAdmin()
    .from("sent_messages")
    .select("id, kind, to_email, subject, body_html, body_text, provider_id, sent_at")
    .eq("deal_id", dealId)
    .order("sent_at", { ascending: false });
  if (res.error || !res.data) return [];
  return res.data.map((r) => ({
    id: r.id,
    kind: (r.kind === "recap" ? "recap" : "briefing") as SentMessageKind,
    toEmail: r.to_email,
    subject: r.subject,
    bodyHtml: r.body_html,
    bodyText: r.body_text,
    providerId: r.provider_id,
    sentAt: r.sent_at,
  }));
}
