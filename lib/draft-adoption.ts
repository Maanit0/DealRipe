/**
 * Did the rep send the draft we wrote.
 *
 * WHY THIS COULD NOT BE ASKED UNTIL NOW.
 *
 * `readDraftSent` in lib/prescription-outcomes.ts answers a nearby but weaker
 * question: whether ANY outbound mail left the rep's mailbox to the customer
 * after the call. It says so in its own comment, and it was the closest honest
 * thing while the Graph draft id was returned by createDraft and discarded one
 * line later. A rep who ignored our draft and wrote their own three sentences
 * scored identically to a rep who sent ours verbatim.
 *
 * The id is now stored on the sent_messages row (provider_id), for both the
 * post-call follow-up and the no-show draft, so the two can finally be joined.
 * It is the RFC 5322 Message-ID rather than Graph's own key, which matters: see
 * readMessageStateByInternetId. Graph reassigns its id when a draft is sent, so
 * the key that looked obvious 404s on precisely the outcome being measured.
 *
 * FIVE OUTCOMES, AND THEY MUST STAY FIVE. The whole value of this measure is
 * the distinction between "they sent ours", "they rewrote it", "they wrote
 * something else", "they sent nothing" and "we could not tell". Collapsing the
 * last one into "sent nothing" would report every unreadable mailbox as a rep
 * ignoring us, which is the failure this codebase is built around.
 *
 * WHAT IT CANNOT SEE. A Message-ID that returns nothing is undecidable: the
 * draft was deleted unsent, or something rewrote the id on the way out. That
 * case falls through to a content match against the rep's actual sent mail,
 * which is why the draft TEXT is compared as well as the id.
 */

import {
  domainOf,
  listMailboxMessages,
  readMessageStateByInternetId,
  type MailMessage,
} from "./graph-mail";
import { supabaseAdmin } from "./supabase";

const GRAPH_TENANT = "magaya.com";

/** Kinds of draft this measures. Both put a message in a rep's Outlook. */
export const DRAFT_KINDS = ["followup_draft", "no_show_draft"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export type AdoptionVerdict =
  /** Sent, and the words are substantially ours. */
  | "sent_ours"
  /** Sent on the thread we drafted into, heavily rewritten first. */
  | "sent_edited"
  /** The rep wrote their own message to the customer instead. */
  | "sent_own"
  /** The draft is still sitting unsent, and no other mail went out. */
  | "not_sent"
  /** We could not tell. Never counted as either side. */
  | "unknown";

export type AdoptionRow = {
  dealId: string | null;
  account: string;
  callId: string | null;
  kind: DraftKind;
  mailbox: string;
  draftedAt: string;
  verdict: AdoptionVerdict;
  /** Why, in one line. Always populated, including for "unknown". */
  reason: string;
  /** 0 to 1 word overlap with what we wrote, where a sent message was found. */
  overlap?: number;
};

// =====================================================================
// Similarity
// =====================================================================

/**
 * How much of what we wrote survived into what they sent.
 *
 * Content words only, so "the", "and" and a shared signature block do not float
 * every comparison upward. Measured as the share of OUR words that appear in
 * their message rather than a symmetric score: a rep who sends our draft and
 * adds two paragraphs of their own has still sent our draft, and a symmetric
 * measure would punish them for the addition.
 */
const STOP = new Set(
  "a an the and or but if of to in on at for with from by as is are was were be been being it its this that these those i you we they he she them us our your their my me not no so then than there here have has had do does did can could will would should may might must about into over under out up down off just also very".split(
    " ",
  ),
);

export function wordOverlap(ours: string, theirs: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w)),
    );
  const a = words(ours);
  const b = words(theirs);
  if (a.size === 0) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size;
}

/**
 * Where "they sent ours" stops and "they rewrote it" begins.
 *
 * Calibrated against what actually varies. A rep editing a name, a time and a
 * sentence keeps most content words, so 0.6 is a rewrite that preserved the
 * substance. Below 0.3 the only shared words are the customer's name and the
 * signature, which is a different email that happens to be on the same thread.
 */
const SENT_OURS = 0.6;
const SENT_EDITED = 0.3;

function verdictFromOverlap(overlap: number): "sent_ours" | "sent_edited" | "sent_own" {
  if (overlap >= SENT_OURS) return "sent_ours";
  if (overlap >= SENT_EDITED) return "sent_edited";
  return "sent_own";
}

// =====================================================================
// One draft
// =====================================================================

export type DraftRecord = {
  dealId: string | null;
  account: string;
  callId: string | null;
  kind: DraftKind;
  mailbox: string;
  draftId: string;
  draftText: string;
  draftedAt: string;
  /** Customer domains for this deal, so a fallback search knows who to look for. */
  domains: string[];
};

export async function readDraftAdoption(rec: DraftRecord): Promise<AdoptionRow> {
  const base = {
    dealId: rec.dealId,
    account: rec.account,
    callId: rec.callId,
    kind: rec.kind,
    mailbox: rec.mailbox,
    draftedAt: rec.draftedAt,
  };

  const state = await readMessageStateByInternetId({
    tenantIdOrDomain: GRAPH_TENANT,
    mailbox: rec.mailbox,
    internetMessageId: rec.draftId,
  });

  if (state.status === "unavailable") {
    return { ...base, verdict: "unknown", reason: `could not read ${rec.mailbox}: ${state.error}` };
  }

  if (state.status === "sent") {
    const overlap = state.body ? wordOverlap(rec.draftText, state.body) : 1;
    return {
      ...base,
      verdict: state.body ? verdictFromOverlap(overlap) : "sent_ours",
      overlap: state.body ? overlap : undefined,
      reason: state.body
        ? `the draft itself was sent${state.sentAt ? ` on ${state.sentAt.slice(0, 10)}` : ""}, ${Math.round(overlap * 100)}% of our words kept`
        : `the draft itself was sent${state.sentAt ? ` on ${state.sentAt.slice(0, 10)}` : ""}`,
    };
  }

  // STILL A DRAFT, or the id is gone. Either way the question becomes whether
  // the rep wrote to this customer at all after we drafted, because a rep who
  // ignored the draft and sent their own is a different fact from a rep who
  // sent nothing, and only one of them is a problem with the draft.
  let sentMail: MailMessage[] = [];
  if (rec.domains.length > 0) {
    try {
      const msgs = await listMailboxMessages({
        tenantIdOrDomain: GRAPH_TENANT,
        mailbox: rec.mailbox,
        since: new Date(Date.parse(rec.draftedAt) - 60_000),
        domains: rec.domains,
        maxPages: 3,
      });
      sentMail = msgs.filter((m) => m.outbound);
    } catch (err) {
      return {
        ...base,
        verdict: "unknown",
        reason: `the draft is ${state.status === "draft" ? "still unsent" : "gone from the mailbox"} and ${
          rec.mailbox
        } could not be searched: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else if (state.status === "gone") {
    return {
      ...base,
      verdict: "unknown",
      reason: "the draft id is gone from the mailbox and the deal has no customer domain to search on",
    };
  }

  if (sentMail.length === 0) {
    if (state.status === "draft") {
      return { ...base, verdict: "not_sent", reason: "still sitting in the rep's drafts, and no mail went to the customer" };
    }
    return {
      ...base,
      verdict: "unknown",
      reason: "the draft id is gone and no outbound mail to this customer was found, so it was probably deleted unsent",
    };
  }

  // Compare against the closest match rather than the first. A rep may write
  // several times; the question is whether ANY of them is our draft.
  let best = { overlap: 0, msg: sentMail[0] };
  for (const m of sentMail) {
    const o = wordOverlap(rec.draftText, m.preview);
    if (o > best.overlap) best = { overlap: o, msg: m };
  }

  // OUR DRAFT STILL SITTING IN DRAFTS SETTLES IT.
  //
  // Whatever they sent, they did not send ours: the copy we wrote is still
  // there unsent. Overlap is worth reporting and must not drive the verdict
  // here, because two follow-ups about the same call share the customer's name,
  // the product and the next step, and the first run of this scored a 32%
  // coincidence as "sent ours, rewritten" while its own reason line said the
  // rep wrote their own. A measure that argues with itself gets discounted.
  //
  // Overlap only decides the case where the Message-ID is GONE, which is
  // genuinely ambiguous: a high match there is real evidence the draft went out
  // and something rewrote the id on the way.
  if (state.status === "draft") {
    return {
      ...base,
      verdict: "sent_own",
      overlap: best.overlap,
      reason: `our draft is still unsent and the rep wrote their own ("${best.msg.subject}"), sharing ${Math.round(
        best.overlap * 100,
      )}% of our words`,
    };
  }
  return {
    ...base,
    verdict: verdictFromOverlap(best.overlap),
    overlap: best.overlap,
    reason: `the draft is gone from the mailbox and an outbound message matches at ${Math.round(
      best.overlap * 100,
    )}% ("${best.msg.subject}")`,
  };
}

// =====================================================================
// The whole book
// =====================================================================

/**
 * Every draft we wrote in a window, and what happened to it.
 *
 * Rows with no provider_id are the drafts written before the id was stored.
 * They are reported as their own count rather than as "unknown", because
 * unknown means we looked and could not tell, and these were never joinable at
 * all. Same distinction, one level up.
 */
export async function readAdoptionForWindow(args: {
  tenantId: string;
  days: number;
  kinds?: ReadonlyArray<DraftKind>;
}): Promise<{ rows: AdoptionRow[]; notJoinable: number; scanned: number }> {
  const db = supabaseAdmin();
  const since = new Date(Date.now() - args.days * 86_400_000).toISOString();
  const kinds = args.kinds ?? DRAFT_KINDS;

  const res = await db
    .from("sent_messages")
    .select("deal_id, call_id, kind, to_email, subject, body_text, provider_id, sent_at")
    .eq("tenant_id", args.tenantId)
    .in("kind", kinds as unknown as string[])
    .gte("sent_at", since)
    .order("sent_at", { ascending: false });
  if (res.error) throw new Error(`sent_messages read failed: ${res.error.message}`);
  const all = (res.data ?? []) as Array<{
    deal_id: string | null;
    call_id: string | null;
    kind: string;
    to_email: string;
    subject: string;
    body_text: string;
    provider_id: string | null;
    sent_at: string;
  }>;

  // A RESEND ID IS NOT A MESSAGE-ID, and the column holds both.
  //
  // The no-show fallback path emails the rep through Resend and stores that id
  // here; the draft paths store the RFC 5322 Message-ID. Running a mailbox
  // lookup on a Resend uuid returns nothing and would report the entire
  // fallback population as drafts that vanished. The RFC form is unmistakable.
  const isMessageId = (id: string) => /^<[^>]+@[^>]+>$/.test(id.trim());

  const joinable = all.filter((r) => r.provider_id && isMessageId(r.provider_id));
  const notJoinable = all.length - joinable.length;

  const dealIds = Array.from(new Set(joinable.map((r) => r.deal_id).filter(Boolean))) as string[];
  const deals = dealIds.length
    ? await db.from("deals").select("id, account, external_id").in("id", dealIds)
    : { data: [] as Array<{ id: string; account: string; external_id: string | null }>, error: null };
  if (deals.error) throw new Error(`deals read failed: ${deals.error.message}`);
  const byDeal = new Map(
    ((deals.data ?? []) as Array<{ id: string; account: string; external_id: string | null }>).map((d) => [d.id, d]),
  );
  // DealRipe's own auto key carries the customer domain ("auto:pxgl.com"), and
  // it is the only domain the deal row holds. Used only when the call has no
  // participants to read a domain from.
  const domainFromExternalId = (ext: string | null | undefined): string | null => {
    const v = (ext ?? "").trim().toLowerCase();
    const m = /^auto:(?:.*@)?([a-z0-9.-]+\.[a-z]{2,})$/.exec(v);
    return m ? m[1] : null;
  };

  // Customer domains come from the call's own attendees where we have a call,
  // since that is who the message is actually addressed to.
  const callIds = Array.from(new Set(joinable.map((r) => r.call_id).filter(Boolean))) as string[];
  const calls = callIds.length
    ? await db.from("calls").select("id, participants").in("id", callIds)
    : { data: [] as Array<{ id: string; participants: unknown }>, error: null };
  const domainsByCall = new Map<string, string[]>();
  for (const c of (calls.data ?? []) as Array<{ id: string; participants: unknown }>) {
    const ps = Array.isArray(c.participants) ? (c.participants as Array<{ email?: string | null }>) : [];
    const ds = new Set<string>();
    for (const p of ps) {
      const d = domainOf((p?.email ?? "").toLowerCase());
      if (d && d !== "magaya.com") ds.add(d);
    }
    domainsByCall.set(c.id, [...ds]);
  }

  const rows: AdoptionRow[] = [];
  for (const r of joinable) {
    const deal = r.deal_id ? byDeal.get(r.deal_id) : undefined;
    const fromCall = r.call_id ? domainsByCall.get(r.call_id) ?? [] : [];
    const fallbackDomain = domainFromExternalId(deal?.external_id);
    const domains = fromCall.length > 0 ? fromCall : fallbackDomain ? [fallbackDomain] : [];
    rows.push(
      await readDraftAdoption({
        dealId: r.deal_id,
        account: deal?.account ?? "(unknown deal)",
        callId: r.call_id,
        kind: r.kind as DraftKind,
        mailbox: r.to_email,
        draftId: r.provider_id!,
        draftText: r.body_text ?? "",
        draftedAt: r.sent_at,
        domains,
      }),
    );
  }

  return { rows, notJoinable, scanned: all.length };
}

/** Counts by verdict, for a report line. */
export function summarise(rows: ReadonlyArray<AdoptionRow>): Record<AdoptionVerdict, number> {
  const out: Record<AdoptionVerdict, number> = {
    sent_ours: 0,
    sent_edited: 0,
    sent_own: 0,
    not_sent: 0,
    unknown: 0,
  };
  for (const r of rows) out[r.verdict]++;
  return out;
}

/**
 * The one number worth quoting, and the denominator that makes it honest.
 *
 * Adoption is drafts the rep actually sent, ours or ours-rewritten, over the
 * drafts we could DECIDE. Unknown never appears on either side: a mailbox we
 * could not read is not a rep who ignored us.
 */
export function adoptionRate(rows: ReadonlyArray<AdoptionRow>): {
  adopted: number;
  decided: number;
  rate: number | null;
} {
  const s = summarise(rows);
  const decided = s.sent_ours + s.sent_edited + s.sent_own + s.not_sent;
  const adopted = s.sent_ours + s.sent_edited;
  return { adopted, decided, rate: decided > 0 ? adopted / decided : null };
}
