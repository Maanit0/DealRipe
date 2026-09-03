/**
 * Sent communications archive.
 *
 * Records the exact briefing/recap emailed to a rep so it can be shown on the
 * deal page and read back later. recordSentMessage is best-effort: it never
 * throws into the send path, because a failure to archive must not fail (or
 * duplicate) an email that already went out.
 */

import { supabaseAdmin } from "./supabase";

export type SentMessageKind =
  | "briefing"
  | "recap"
  /**
   * The reservation taken before a recap is generated or sent, so two runs
   * cannot both email one. Never an artifact: it carries no body and
   * lib/activity-log.ts excludes it from anything a person reads.
   */
  | "recap_claim"
  | "no_show_draft"
  | "followup_draft"
  /** Asking a rep which Salesforce account a deal belongs to. */
  | "link_escalation"
  /**
   * A re-engagement draft, written because a FLAG fired rather than because a
   * call happened or a message arrived. See lib/reengage-draft.ts.
   */
  | "reengage_draft"
  /**
   * "Your follow-up draft is ready", with a link into it.
   *
   * A notification to the rep, not the draft itself and not a second copy of it.
   * See lib/emails/draft-ready.ts for why a link beats a folder.
   */
  | "draft_ready";

export type SentMessage = {
  id: string;
  kind: SentMessageKind;
  /** The call this message belongs to, when recorded with one. */
  callId: string | null;
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
  /**
   * The token embedded in this artifact's feedback links.
   *
   * Generated BEFORE the artifact is rendered, because the link has to be in
   * the HTML and the row does not exist yet. Stored here so the click can find
   * its way back to the thing it was rating.
   */
  feedbackToken?: string | null;
  /**
   * Fill a row already claimed by claimSentMessageSlot instead of inserting.
   *
   * The claim is taken BEFORE the artifact is created so the lock covers the
   * mailbox write and not just the archive row. Without this the row would be
   * inserted afterwards, which is a unique index that guarantees one RECORD per
   * call while a rep still ends up with two drafts.
   */
  rowId?: string | null;
}): Promise<void> {
  try {
    if (args.rowId) {
      const upd = await supabaseAdmin()
        .from("sent_messages")
        .update({
          to_email: args.toEmail,
          subject: args.subject,
          body_html: args.html,
          body_text: args.text,
          ...(args.feedbackToken ? { feedback_token: args.feedbackToken } : {}),
          provider_id: args.providerId ?? null,
        })
        .eq("id", args.rowId);
      if (upd.error) console.error(`[sent-messages] could not fill claimed row ${args.rowId}: ${upd.error.message}`);
      return;
    }
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
        ...(args.feedbackToken ? { feedback_token: args.feedbackToken } : {}),
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

/**
 * Archive one Monday activity report. Same shape as the digest: no deal_id,
 * because it is about the whole book rather than one deal, so it must never
 * appear in a deal's own sent-communications list.
 */
export async function recordActivityReportSend(args: {
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
      kind: "activity_report",
      to_email: args.toEmail,
      subject: args.subject,
      body_html: args.html,
      body_text: args.text,
      provider_id: args.providerId ?? null,
    });
    if (res.error) {
      console.error(`[sent-messages] activity report insert failed: ${res.error.message}`);
    }
  } catch (err) {
    console.error(
      `[sent-messages] activity report insert threw: ${err instanceof Error ? err.message : String(err)}`,
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

const KNOWN_KINDS: ReadonlySet<string> = new Set<SentMessageKind>([
  "briefing",
  "recap",
  "no_show_draft",
  "followup_draft",
  "link_escalation",
  "reengage_draft",
]);

/** All archived messages for a deal, newest first. */
export async function getSentMessages(dealId: string): Promise<SentMessage[]> {
  const res = await supabaseAdmin()
    .from("sent_messages")
    .select("id, kind, call_id, to_email, subject, body_html, body_text, provider_id, sent_at")
    .eq("deal_id", dealId)
    .order("sent_at", { ascending: false });
  if (res.error || !res.data) return [];
  return res.data.map((r) => ({
    id: r.id,
    // Every kind we know, not two of them.
    //
    // This listed the known pair and collapsed EVERYTHING else to "briefing",
    // so a follow-up draft sitting in a rep's Outlook was displayed as a
    // briefing that had been emailed to them, and the new link_escalation would
    // have been too. Two different things reported as one is the same defect
    // this codebase keeps paying for, just in a diagnostic rather than a query.
    kind: (KNOWN_KINDS.has(r.kind) ? r.kind : "briefing") as SentMessageKind,
    callId: (r as { call_id?: string | null }).call_id ?? null,
    toEmail: r.to_email,
    subject: r.subject,
    bodyHtml: r.body_html,
    bodyText: r.body_text,
    providerId: r.provider_id,
    sentAt: r.sent_at,
  }));
}

/**
 * Reserve the one archive row for this artifact, before creating it.
 *
 * The partial unique index in supabase/add-draft-claim.sql turns this INSERT
 * into the lock. A second concurrent run is rejected with 23505 and gets
 * "raced", so it returns before writing anything into a rep's mailbox, which
 * the previous ordering could not prevent: the Outlook draft was created first
 * and the row inserted after, so the index guaranteed one RECORD per call while
 * the rep still got two drafts.
 *
 * A crash between claiming and filling leaves an empty row that blocks the
 * call. That is the same trade recap-sync's own claim makes and the direction
 * is deliberate: a missing draft is visible in followup_draft_state, a
 * duplicate is already in a rep's inbox. Release it with releaseSentMessageSlot
 * on every path that gives up.
 */
export async function claimSentMessageSlot(args: {
  tenantId: string;
  dealId: string;
  callId: string;
  kind: SentMessageKind;
  toEmail: string;
}): Promise<{ status: "claimed"; rowId: string } | { status: "raced" } | { status: "error"; message: string }> {
  const res = await supabaseAdmin()
    .from("sent_messages")
    .insert({
      tenant_id: args.tenantId,
      deal_id: args.dealId,
      call_id: args.callId,
      kind: args.kind,
      to_email: args.toEmail,
      subject: "",
      body_html: "",
      body_text: "",
    })
    .select("id")
    .single();
  if (res.error) {
    const code = (res.error as { code?: string }).code;
    if (code === "23505") return { status: "raced" };
    return { status: "error", message: res.error.message };
  }
  return { status: "claimed", rowId: (res.data as { id: string }).id };
}

/** Give the slot back, so a retry is not blocked by an attempt that never produced anything. */
export async function releaseSentMessageSlot(rowId: string): Promise<void> {
  const res = await supabaseAdmin().from("sent_messages").delete().eq("id", rowId);
  if (res.error) console.error(`[sent-messages] could not release claim ${rowId}: ${res.error.message}`);
}
