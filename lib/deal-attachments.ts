/**
 * Which document actually went out.
 *
 * 260 messages across 41 deals mention a proposal, quote or pricing, and no
 * document exists anywhere in the ledger. lib/deal-memory.ts renders the rep's
 * sent items with the hedge "Subjects only, so a file may have ridden on any of
 * them", and SentItem.attachments has been hardcoded to [] since it was written.
 *
 * listMessageAttachments has existed with zero callers. This is its caller.
 *
 * WHAT IT STORES AND DOES NOT. Metadata: filename, type, size, and which of the
 * two categories the file falls into. No bytes. Retaining files needs a private
 * Supabase Storage bucket that does not exist, and createBucket defaults to
 * public: true, which would put customer proposals on a guessable URL. That is
 * not a decision to make in passing.
 *
 * INLINE IS FILTERED AT THE SOURCE. Every rep here has an HTML signature and
 * every HTML signature carries a logo, so hasAttachments is true on almost
 * everything they send. listMessageAttachments drops those and returns the
 * count it dropped, so "the rep sent a document" does not become a flag that
 * fires on most of the book.
 */

import { listMessageAttachments } from "./graph-mail";
import { classifyAttachmentForStorage } from "./magaya-collateral";
import { supabaseAdmin } from "./supabase";

export type AttachmentIngestResult = {
  messagesConsidered: number;
  listed: number;
  unavailable: number;
  gone: number;
  attachmentsFound: number;
  inlineSkipped: number;
  byClass: Record<string, number>;
  /** Distinct deals that turn out to have sent or received a real file. */
  dealsTouched: number;
};

const DEFAULT_LIMIT = 400;

export async function ingestAttachments(args: {
  tenantId: string;
  graphTenant: string;
  limit?: number;
  dryRun?: boolean;
}): Promise<AttachmentIngestResult> {
  const db = supabaseAdmin();
  const out: AttachmentIngestResult = {
    messagesConsidered: 0,
    listed: 0,
    unavailable: 0,
    gone: 0,
    attachmentsFound: 0,
    inlineSkipped: 0,
    byClass: {},
    dealsTouched: 0,
  };

  const res = await db
    .from("deal_messages")
    .select("id, deal_id, graph_message_id, mailbox, direction, agreement_state, sent_at")
    .eq("tenant_id", args.tenantId)
    .eq("attachment_status", "not_listed")
    .order("sent_at", { ascending: false })
    .limit(args.limit ?? DEFAULT_LIMIT);
  // A failed read is not an empty backlog. Reporting zero here would look like
  // a finished job, which is how a broken backfill survives for weeks.
  if (res.error) throw new Error(`attachment backlog read failed: ${res.error.message}`);

  const rows = res.data ?? [];
  out.messagesConsidered = rows.length;
  if (args.dryRun || rows.length === 0) return out;

  const deals = new Set<string>();

  for (const m of rows) {
    const listed = await listMessageAttachments({
      tenantIdOrDomain: args.graphTenant,
      mailbox: m.mailbox,
      messageId: m.graph_message_id,
    });

    if (listed.status !== "ok") {
      // 'gone' is permanent and 'unavailable' is transient, and they are
      // different instructions to the next run. Neither is "no attachments".
      const status = listed.status === "gone" ? "gone" : "unavailable";
      if (listed.status === "gone") out.gone += 1;
      else out.unavailable += 1;
      await db.from("deal_messages").update({ attachment_status: status === "gone" ? "none" : "unavailable" }).eq("id", m.id);
      continue;
    }

    out.listed += 1;
    out.inlineSkipped += listed.skippedInline;

    if (listed.attachments.length === 0) {
      // Listed successfully and there was nothing but signature furniture.
      // That is a real 'none', distinct from a read we could not perform.
      await db.from("deal_messages").update({ attachment_status: "none" }).eq("id", m.id);
      continue;
    }

    const attachmentRows = listed.attachments.map((a) => {
      const c = classifyAttachmentForStorage({
        filename: a.name,
        direction: m.direction === "outbound" ? "outbound" : "inbound",
        agreementState: m.agreement_state,
      });
      out.byClass[c.class] = (out.byClass[c.class] ?? 0) + 1;
      return {
        tenant_id: args.tenantId,
        deal_id: m.deal_id,
        message_id: m.id,
        direction: m.direction,
        filename: a.name,
        content_type: a.contentType,
        size_bytes: a.size,
        is_inline: a.isInline,
        classification: c.class,
        classification_basis: c.basis,
        // No bytes are pulled, so there is no hash and nothing is stored. Said
        // explicitly rather than left null, which would read as "not yet".
        storage_status: c.class === "static" ? "skipped_static" : "not_fetched",
        graph_attachment_id: a.id,
        mailbox: m.mailbox,
      };
    });

    out.attachmentsFound += attachmentRows.length;
    if (m.deal_id) deals.add(m.deal_id);

    const ins = await db
      .from("deal_attachments")
      .upsert(attachmentRows, { onConflict: "message_id,graph_attachment_id", ignoreDuplicates: true })
      .select("id");
    if (ins.error) {
      console.error(`[attachments] write failed for message ${m.id}: ${ins.error.message}`);
      continue;
    }
    await db.from("deal_messages").update({ attachment_status: "listed" }).eq("id", m.id);
  }

  out.dealsTouched = deals.size;
  return out;
}
