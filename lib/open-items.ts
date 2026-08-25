/**
 * What each side still owes the other, and whether it happened.
 *
 * THE SECTION THAT MAKES A BRIEFING DIFFERENT FROM A CRM PRINT-OUT.
 *
 * Magaya's dominant recorded loss reason is "No Decision / Non-Responsive", and
 * `next_step_confirmed` is the highest-scoring gate in the whole framework at
 * 68%. Reps almost always leave with a next step and deals still die of no
 * decision, so the next steps are being agreed and not held. Nothing in the
 * product tracked that until now.
 *
 * WHY THE MODEL DOES THE ATTRIBUTION AND THIS FILE DOES NOT.
 *
 * Splitting "Eduardo will update the proposal and they will reconnect" into who
 * owes what is a language problem, and getPipelineChanges already carries a
 * regex that guesses it. Copying that regex here would give two versions of the
 * rule that drift, which is the failure this codebase keeps paying for. So this
 * computes only what can be VERIFIED, and hands the model the raw commitment
 * text alongside it:
 *
 *   - what was agreed, verbatim, and the date it was agreed
 *   - whether a meeting is now on the calendar
 *   - whether we have written since, and about what
 *   - whether they have written since
 *
 * From those four the model can say "we owe them the follow-up, not sent"
 * without this file ever deciding who "we" is.
 */
import { supabaseAdmin } from "./supabase";
import { subjectTopic } from "./email-log";

export type OpenItems = {
  agreed: string | null;
  agreedOn: string | null;
  daysSinceAgreed: number | null;
  meetingOnCalendar: { when: string; title: string | null } | null;
  weWroteSince: { when: string; topic: string | null } | null;
  theyWroteSince: { when: string; topic: string | null } | null;
  lines: string[];
};

const daysBetween = (fromIso: string, now: number): number =>
  Math.floor((now - Date.parse(fromIso)) / 86_400_000);

export async function buildOpenItems(args: {
  tenantId: string;
  dealId: string;
  now?: Date;
}): Promise<OpenItems> {
  const db = supabaseAdmin();
  const now = (args.now ?? new Date()).getTime();
  const empty: OpenItems = {
    agreed: null, agreedOn: null, daysSinceAgreed: null,
    meetingOnCalendar: null, weWroteSince: null, theyWroteSince: null,
    lines: [`OPEN ITEMS: no next step has been captured on a call, so there is nothing recorded that either side owes.`],
  };

  // The agreed next step, and WHEN it was agreed. The date matters more than
  // the text: "not sent" means nothing without "agreed 19 days ago".
  const fx = await db
    .from("field_extractions")
    .select("answer, status, framework_field_key, last_updated_from_call_id")
    .eq("tenant_id", args.tenantId)
    .eq("deal_id", args.dealId)
    .ilike("framework_field_key", "%next_step%");
  const hit = ((fx.data ?? []) as Array<{ answer: string | null; status: string | null; last_updated_from_call_id: string | null }>)
    .find((r) => r.status === "Yes" && r.answer);
  if (!hit?.answer) return empty;

  let agreedOn: string | null = null;
  if (hit.last_updated_from_call_id) {
    const c = await db.from("calls").select("scheduled_start, call_date").eq("id", hit.last_updated_from_call_id).maybeSingle();
    agreedOn = ((c.data as { scheduled_start: string | null; call_date: string | null } | null)?.scheduled_start)
      ?? ((c.data as { call_date: string | null } | null)?.call_date)
      ?? null;
  }

  // Is a meeting actually booked now? "They agreed to reconvene" plus nothing on
  // the calendar is the single most common open item at Magaya.
  const up = await db
    .from("calls")
    .select("scheduled_start, title")
    .eq("tenant_id", args.tenantId)
    .eq("deal_id", args.dealId)
    .gte("scheduled_start", new Date(now).toISOString())
    .order("scheduled_start")
    .limit(1);
  const nextMeeting = (up.data ?? [])[0] as { scheduled_start: string; title: string | null } | undefined;

  // Movement since the commitment was made, each way.
  let weWroteSince: OpenItems["weWroteSince"] = null;
  let theyWroteSince: OpenItems["theyWroteSince"] = null;
  if (agreedOn) {
    const msgs = await db
      .from("deal_messages")
      .select("customer_side, subject, sent_at")
      .eq("tenant_id", args.tenantId)
      .eq("deal_id", args.dealId)
      .eq("is_calendar_response", false)
      .gt("sent_at", agreedOn)
      .order("sent_at", { ascending: false });
    const rows = (msgs.data ?? []) as Array<{ customer_side: boolean; subject: string | null; sent_at: string }>;
    const ours = rows.find((r) => !r.customer_side);
    const theirs = rows.find((r) => r.customer_side);
    if (ours) weWroteSince = { when: ours.sent_at, topic: subjectTopic(ours.subject) };
    if (theirs) theyWroteSince = { when: theirs.sent_at, topic: subjectTopic(theirs.subject) };
  }

  const dAgreed = agreedOn ? daysBetween(agreedOn, now) : null;
  const lines: string[] = [
    `OPEN ITEMS. What was agreed last time, and what has actually happened since. Split this into what WE owe and what THEY owe, and say plainly whether each is done.`,
    `- Agreed${dAgreed !== null ? ` ${dAgreed} day(s) ago` : ""}: "${hit.answer}"`,
  ];
  lines.push(
    nextMeeting
      ? `- A meeting IS on the calendar: ${nextMeeting.scheduled_start?.slice(0, 10)}${nextMeeting.title ? ` (${nextMeeting.title})` : ""}.`
      : `- NOTHING is on the calendar with this customer. If the agreed step was a meeting, it has not been booked.`,
  );
  if (agreedOn) {
    lines.push(
      weWroteSince
        ? `- We have emailed them since${weWroteSince.topic ? ` about "${weWroteSince.topic}"` : ""}, ${daysBetween(weWroteSince.when, now)} day(s) ago.`
        : `- We have NOT emailed them since that call.`,
      theyWroteSince
        ? `- They have emailed us since${theyWroteSince.topic ? ` about "${theyWroteSince.topic}"` : ""}, ${daysBetween(theyWroteSince.when, now)} day(s) ago.`
        : `- They have NOT emailed us since that call.`,
    );
  }
  lines.push(
    `Anything agreed and not done is the most important thing on this call. Raise it as the thing it is, never as a complaint.`,
  );

  return {
    agreed: hit.answer,
    agreedOn,
    daysSinceAgreed: dAgreed,
    meetingOnCalendar: nextMeeting ? { when: nextMeeting.scheduled_start, title: nextMeeting.title } : null,
    weWroteSince,
    theyWroteSince,
    lines,
  };
}
