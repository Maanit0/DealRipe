/**
 * One deal's history, call by call, as structured data.
 *
 * The unit is the CALL, and each call is a before / during / after triple:
 *
 *   BEFORE   what we told the rep to get, and whether the briefing reached them
 *   DURING   who was in the room
 *   AFTER    what the calls newly proved, what the rep did, what the CRM did
 *
 * That triple is the "did DealRipe help" unit. Stacked in time it is the deal's
 * history; summed across deals it is the leader view.
 *
 * This returns DATA rather than text so the terminal script and the page render
 * the same reading. Two renderers over one builder; never two builders.
 *
 * ATTRIBUTION IS DELIBERATELY NOT CLAIMED. All six pilot reps are enrolled, so
 * there is no holdout and no control arm. This puts what was prescribed and
 * what followed in order and lets a reader draw their own line.
 */

import { supabaseAdmin } from "./supabase";
import {
  HISTORY_BEGINS,
  loadCloseDateHistoryForAccounts,
  loadStageHistoryForAccounts,
} from "./salesforce-stage-history";

export type TimelinePrescription = {
  text: string;
  /** "yes" | "no" | "unknown". Unknown is usually "inside the settle window". */
  followed: string;
};

export type TimelineEntry = {
  callId: string;
  at: string;
  upcoming: boolean;
  /** meeting_type / call_subtype, or "untyped" when the router had no signal. */
  kind: string;
  title: string | null;
  outcome: string | null;
  /** Minutes before the call the briefing landed. Null when none was sent. */
  briefingLeadMinutes: number | null;
  prescriptions: TimelinePrescription[];
  /** briefing, recap, followup_draft, no_show_draft, as actually delivered. */
  artifacts: string[];
  /** What the ledger recorded after this call, already worded for a reader. */
  outcomes: string[];
  emailOut: number;
  emailIn: number;
  /** What the CUSTOMER'S CRM recorded between this call and the next. */
  crmMoves: string[];
};

export type DealTimeline = {
  entries: TimelineEntry[];
  /**
   * False when deal_messages holds nothing for this deal.
   *
   * A caller must render that as "no email record", never as "the customer has
   * been silent". Keeping those apart is the point of the log.
   */
  emailLogged: boolean;
};

export async function buildDealTimeline(args: {
  tenantId: string;
  dealId: string;
  /** Confirmed-linked Salesforce account, when there is one. */
  accountId?: string | null;
  now?: Date;
}): Promise<DealTimeline> {
  const db = supabaseAdmin();
  const nowMs = (args.now ?? new Date()).getTime();

  const [callsRes, presRes, msgsRes, sentRes] = await Promise.all([
    db
      .from("calls")
      .select("id, scheduled_start, call_date, meeting_type, call_subtype, outcome, briefing_sent_at, title")
      .eq("tenant_id", args.tenantId)
      .eq("deal_id", args.dealId)
      .order("scheduled_start", { ascending: true }),
    db
      .from("prescribed_actions")
      .select("call_id, text, followed, outcome_next_meeting, outcome_stage_moved, outcome_qualification_advanced, outcome_reasons")
      .eq("tenant_id", args.tenantId)
      .eq("deal_id", args.dealId),
    db
      .from("deal_messages")
      .select("customer_side, sent_at, is_calendar_response")
      .eq("tenant_id", args.tenantId)
      .eq("deal_id", args.dealId)
      .eq("is_calendar_response", false),
    db.from("sent_messages").select("call_id, kind").eq("tenant_id", args.tenantId).eq("deal_id", args.dealId),
  ]);

  type CallRow = {
    id: string;
    scheduled_start: string | null;
    call_date: string | null;
    meeting_type: string | null;
    call_subtype: string | null;
    outcome: string | null;
    briefing_sent_at: string | null;
    title: string | null;
  };
  const calls = ((callsRes.data ?? []) as CallRow[])
    .map((c) => ({ ...c, ms: Date.parse(c.scheduled_start ?? c.call_date ?? "") }))
    .filter((c) => Number.isFinite(c.ms));

  const pres = (presRes.data ?? []) as Array<{
    call_id: string;
    text: string;
    followed: string;
    outcome_next_meeting: string;
    outcome_stage_moved: string;
    outcome_qualification_advanced: string;
    outcome_reasons: Record<string, string> | null;
  }>;
  // A failed read is "no log", not "no email". The table may not exist yet.
  const emailLogged = !msgsRes.error;
  const msgs = emailLogged
    ? ((msgsRes.data ?? []) as Array<{ customer_side: boolean; sent_at: string | null }>)
    : [];
  const sent = (sentRes.data ?? []) as Array<{ call_id: string | null; kind: string }>;

  // Salesforce's own record of what moved, with real timestamps rather than a
  // window inferred from differencing snapshots.
  let stageMoves: Array<{ ms: number; text: string }> = [];
  let dateMoves: Array<{ ms: number; text: string }> = [];
  if (args.accountId) {
    const since = `${HISTORY_BEGINS}T00:00:00Z`;
    const [sh, cd] = await Promise.all([
      loadStageHistoryForAccounts([args.accountId], since),
      loadCloseDateHistoryForAccounts([args.accountId], since),
    ]);
    if (sh.status === "read") {
      stageMoves = (sh.byAccount.get(args.accountId) ?? []).map((t) => ({
        ms: Date.parse(t.at),
        text: `stage ${t.from ?? "(unset)"} to ${t.to ?? "(unset)"}`,
      }));
    }
    if (cd.status === "read") {
      dateMoves = (cd.byAccount.get(args.accountId) ?? []).map((m) => ({
        ms: Date.parse(m.at),
        // A date moving EARLIER is a rep tightening a forecast. It reads as
        // what it is rather than being folded in with the pushes.
        text: `close date ${(m.daysMoved ?? 0) > 0 ? "pushed" : "pulled in"} ${Math.abs(m.daysMoved ?? 0)} days, ${m.from} to ${m.to}`,
      }));
    }
  }

  const entries: TimelineEntry[] = calls.map((c, i) => {
    const upper = i + 1 < calls.length ? calls[i + 1].ms : nowMs;
    const mine = pres.filter((p) => p.call_id === c.id);
    const head = mine[0];

    const outcomes: string[] = [];
    if (head) {
      if (head.outcome_next_meeting === "yes") outcomes.push("next meeting booked");
      if (head.outcome_qualification_advanced === "yes") {
        const why = head.outcome_reasons?.qualification_advanced;
        outcomes.push(why ? why.replace(/^the calls /, "") : "qualification advanced");
      }
      if (head.outcome_stage_moved === "yes") outcomes.push("the CRM stage moved");
    }

    const between = msgs.filter((m) => {
      const t = Date.parse(String(m.sent_at ?? ""));
      return Number.isFinite(t) && t > c.ms && t <= upper;
    });

    return {
      callId: c.id,
      at: c.scheduled_start ?? c.call_date ?? "",
      upcoming: c.ms > nowMs,
      kind: [c.meeting_type, c.call_subtype].filter(Boolean).join(" / ") || "untyped",
      title: c.title,
      outcome: c.outcome,
      briefingLeadMinutes: c.briefing_sent_at
        ? Math.round((c.ms - Date.parse(c.briefing_sent_at)) / 60000)
        : null,
      prescriptions: mine.map((p) => ({ text: p.text, followed: p.followed })),
      artifacts: [...new Set(sent.filter((m) => m.call_id === c.id).map((m) => m.kind))],
      outcomes,
      emailOut: between.filter((m) => !m.customer_side).length,
      emailIn: between.filter((m) => m.customer_side).length,
      crmMoves: [...stageMoves, ...dateMoves]
        .filter((m) => m.ms > c.ms && m.ms <= upper)
        .sort((a, b) => a.ms - b.ms)
        .map((m) => m.text),
    };
  });

  return { entries, emailLogged };
}
