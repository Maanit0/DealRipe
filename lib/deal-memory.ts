/**
 * What the deal knows, for the artifact that is about to be written.
 *
 * THE FOLLOW-UP DRAFT WAS FLYING ON THE TRANSCRIPT ALONE. Briefings and recaps
 * go through getDealContext; the draft and the re-engagement email each built
 * their own smaller context, which is why every improvement to deal memory had
 * to be made three times and never was.
 *
 * Ten draft-versus-sent pairs read on 2026-09-02 say the gap is not writing
 * quality. In every case where the rep wrote their own, they held something we
 * did not:
 *
 *   Eduardo   a EULA and a corrected proposal   we did not know they existed
 *   Daniel    Gustavo's three draft airway bills   we did not know they were sent
 *   Daniel    a discount pending manager approval  we did not know it was pending
 *   Ariel     six video links                      we held them and promised them instead
 *   Steven    Gina's reply that morning            we had not looked
 *
 * A draft can only be as good as what it knows.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. It reports what we told the customer
 * we would do on earlier calls, and separately what has actually been sent
 * since. It does NOT assert that a commitment is still outstanding, because
 * nothing here can establish that: an email whose subject looks unrelated may
 * carry the promised file, and a commitment may have been discharged on a call
 * we never captured. The two facts are given side by side and the reader
 * decides, which is the same rule the CRM reads follow: say what was observed,
 * never what was inferred from its absence.
 */

import { supabaseAdmin } from "./supabase";

export type PriorCommitment = { when: string; text: string };
export type SentItem = { when: string; subject: string; attachments: string[] };

export type DealMemory = {
  /**
   * Commitments our earlier drafts made on this deal.
   *
   * PROBABLY said, not certainly. A draft the rep rewrote or never sent
   * carries a promise the customer never received, and nothing here can tell
   * the two apart, so the prompt says so rather than asserting it.
   */
  toldThemWeWould: PriorCommitment[];
  /** What has actually left the rep's mailbox to them since those calls. */
  sentSince: SentItem[];
  /** The customer's most recent inbound message, if any. */
  customerLastWrote: { when: string; subject: string } | null;
};

/**
 * Commitment lines from a follow-up draft we wrote on an earlier call.
 *
 * NOT FROM THE RECAP. The recap's sections are WHAT HAPPENED, CAPTURED ON THIS
 * CALL, STILL OPEN and SUGGESTED NEXT STEP; the first version of this read the
 * head of that document and handed the model a list of captured qualification
 * gates labelled "what we told them we would do". Every line was true and the
 * label was false, which is worse than having nothing.
 *
 * The draft body is where a commitment actually lives: "Steven is checking
 * internally on the PCIT integration".
 */
function commitmentBullets(draftText: string): string[] {
  return draftText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*•]\s+/.test(l))
    .map((l) => l.replace(/^[-*•]\s+/, ""))
    // Ours, not theirs. "Debra will send the org chart" is not something we owe.
    .filter((l) => !/^(they|the customer|[A-Z][a-z]+ (will|is going to) (send|share|provide|get back))/i.test(l))
    .slice(0, 6);
}

export async function readDealMemory(args: {
  tenantId: string;
  dealId: string;
  /** The call being written about. Everything before it is history. */
  beforeCallId?: string | null;
}): Promise<DealMemory> {
  const db = supabaseAdmin();
  const empty: DealMemory = { toldThemWeWould: [], sentSince: [], customerLastWrote: null };

  try {
    const [recaps, msgs] = await Promise.all([
      db
        .from("sent_messages")
        .select("call_id, body_text, sent_at")
        .eq("deal_id", args.dealId)
        .eq("kind", "followup_draft")
        .order("sent_at", { ascending: false })
        .limit(6),
      db
        .from("deal_messages")
        .select("direction, subject, sent_at")
        .eq("tenant_id", args.tenantId)
        .eq("deal_id", args.dealId)
        .order("sent_at", { ascending: false })
        .limit(40),
    ]);

    const toldThemWeWould: PriorCommitment[] = [];
    for (const r of (recaps.data ?? []) as Array<{ call_id: string | null; body_text: string | null; sent_at: string }>) {
      // The call being written about is not history for itself.
      if (args.beforeCallId && r.call_id === args.beforeCallId) continue;
      for (const b of commitmentBullets(r.body_text ?? "")) {
        toldThemWeWould.push({ when: r.sent_at.slice(0, 10), text: b });
      }
    }

    const rows = (msgs.data ?? []) as Array<{ direction: string; subject: string | null; sent_at: string }>;
    const sentSince: SentItem[] = rows
      .filter((m) => m.direction === "outbound")
      .slice(0, 8)
      .map((m) => ({ when: m.sent_at.slice(0, 10), subject: m.subject ?? "(no subject)", attachments: [] }));
    const inbound = rows.find((m) => m.direction === "inbound");

    return {
      toldThemWeWould: toldThemWeWould.slice(0, 8),
      sentSince,
      customerLastWrote: inbound ? { when: inbound.sent_at.slice(0, 10), subject: inbound.subject ?? "(no subject)" } : null,
    };
  } catch {
    // A memory we could not read is not an empty deal history. The caller
    // renders nothing rather than telling the model the deal has no past.
    return empty;
  }
}

/** The memory as prompt text, or null when there is nothing worth saying. */
export function dealMemoryBlock(m: DealMemory): string | null {
  const parts: string[] = [];
  if (m.toldThemWeWould.length > 0) {
    parts.push(
      `WHAT OUR EARLIER FOLLOW-UP DRAFTS COMMITTED TO on this deal. The rep may have edited or not sent any of these, so treat them as probably said rather than certainly said. Check the send history below before offering any of it again:\n` +
        m.toldThemWeWould.map((c) => `- ${c.when}: ${c.text}`).join("\n"),
    );
  }
  if (m.sentSince.length > 0) {
    parts.push(
      `WHAT THE REP HAS ALREADY SENT THIS CUSTOMER, most recent first. Subjects only, so a file may have ridden on any of them:\n` +
        m.sentSince.map((s) => `- ${s.when}: ${s.subject}`).join("\n"),
    );
  }
  if (m.customerLastWrote) {
    parts.push(
      `THE CUSTOMER LAST WROTE on ${m.customerLastWrote.when}: "${m.customerLastWrote.subject}". If that is after the call, the conversation has moved and this email should meet it where it is.`,
    );
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
