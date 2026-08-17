/**
 * When a deal cannot be matched to a Salesforce account, ask the rep.
 *
 * Eduardo, 2026-08-14, closing out his own account-linking suggestion:
 *
 *   "the only thing you could do is like, if you don't find it, send an
 *    automated email to the owner: hey, we tried to save this but we couldn't."
 *
 * That is the last rung of the ladder in lib/salesforce-account-match.ts and it
 * was the only one that still needed a human to run a script. Five deals sit in
 * that state today and nothing tells anyone.
 *
 * WHAT THIS SENDS AND TO WHOM
 *
 * To the REP who owns the deal, over Resend, the same channel briefings and
 * recaps already use. Not to the Salesforce account owner: when we cannot find
 * the account we do not know who owns it, and guessing would mail a stranger
 * about a deal that is not theirs. The rep always knows their own deal.
 *
 * WHAT IT SAYS
 *
 * Which deal, which meeting, exactly which rungs were tried and what each one
 * found. A message that says only "we could not link this" makes the rep do the
 * diagnosis again. The ambiguous case is the valuable one: it lists the
 * candidate accounts with their ids, so the answer is a reply with one line
 * rather than a search.
 *
 * IT NEVER NAGS
 *
 * Two guards. Deduped through sent_messages on (deal_id, kind) with a cooldown,
 * so the same deal is not raised twice in a week. And batched per rep: Juan had
 * five unresolved deals in the first run and five separate emails landing at
 * once is exactly the thing that gets a sender filtered. One message, every
 * deal he owns, one reply.
 *
 * A filtered escalation is worse than none, because it looks like it is
 * working.
 */

import type { AccountMatchResult } from "./salesforce-account-match";
import { MailerConfigError, sendEmail } from "./mailer";
import { recordSentMessage } from "./sent-messages";
import { supabaseAdmin } from "./supabase";

/** How long before the same deal may be raised with the same rep again. */
export const ESCALATION_COOLDOWN_DAYS = 7;

export type EscalationDecision =
  | { kind: "sent"; account: string; to: string }
  | { kind: "skipped"; account: string; reason: string }
  | { kind: "failed"; account: string; reason: string };

export type EscalationCounts = {
  considered: number;
  sent: number;
  onCooldown: number;
  noRep: number;
  failed: number;
};

export type UnlinkedDeal = {
  dealId: string;
  account: string;
  repEmail: string | null;
  /** The meeting that prompted this, for the rep to recognise it. */
  meetingTitle: string | null;
  meetingDate: string | null;
  result: AccountMatchResult;
};

/**
 * The body. Plain, specific, and free of dashes: Mark reads them as
 * machine-written and the same convention governs anything a Magaya person
 * reads.
 */
export function escalationSection(d: UnlinkedDeal): string {
  const lines: string[] = [];
  lines.push(`Deal: ${d.account}`);
  if (d.meetingTitle) lines.push(`Meeting: ${d.meetingTitle}`);
  if (d.meetingDate) lines.push(`Date: ${d.meetingDate}`);
  lines.push("");

  switch (d.result.status) {
    case "ambiguous":
      lines.push(`We found more than one account that fits, so we did not choose.`);
      lines.push(`${d.result.why}.`);
      lines.push("");
      lines.push(`Candidates:`);
      for (const c of d.result.candidates) lines.push(`  ${c.name}  ${c.id}`);
      lines.push("");
      lines.push(`Reply with the right one and we will link it and backfill this deal's history into it.`);
      break;
    case "none":
      lines.push(`We checked, in order: ${d.result.triedRungs.join(", ") || "nothing usable"}.`);
      lines.push(`${d.result.why}.`);
      lines.push("");
      lines.push(
        `If the account exists, reply with its Salesforce link and we will take it from there. ` +
          `If it does not exist yet, no action needed, we will pick it up once it does.`,
      );
      break;
    case "unavailable":
      lines.push(`Salesforce did not answer, so this is unknown rather than missing: ${d.result.why}.`);
      lines.push(`We will retry automatically. Nothing for you to do unless it keeps appearing.`);
      break;
    case "matched":
      lines.push(
        `We matched ${d.result.match.accountName} (${d.result.match.accountId}) but only at review confidence, ` +
          `so nothing will be written to it until someone confirms: ${d.result.match.via}.`,
      );
      lines.push("");
      lines.push(`Reply "yes" and we will confirm it, or send the right account instead.`);
      break;
  }

  return lines.join("\n");
}

/** One message covering every deal this rep has to settle. */
export function renderEscalation(deals: ReadonlyArray<UnlinkedDeal>): {
  subject: string;
  text: string;
  html: string;
} {
  const head =
    deals.length === 1
      ? `We could not match this meeting to a Salesforce account.`
      : `We could not match ${deals.length} of your meetings to a Salesforce account.`;
  const text = [
    head,
    "",
    deals.map(escalationSection).join("\n\n" + "-".repeat(52) + "\n\n"),
    "",
    `Until these are linked, DealRipe will not write their qualification data to Salesforce.`,
  ].join("\n");

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html =
    `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:#1E293B;">` +
    `<div style="white-space:pre-wrap;">${esc(text)}</div></div>`;

  const subject =
    deals.length === 1
      ? `Salesforce account needed for ${deals[0].account}`
      : `Salesforce accounts needed for ${deals.length} of your deals`;
  return { subject, text, html };
}

/**
 * Raise each unresolved deal with its rep, once.
 *
 * Best-effort per deal: one bad address never stops the rest, and every skip
 * says which case it was rather than passing silently.
 */
export async function escalateUnlinkedDeals(args: {
  tenantId: string;
  deals: ReadonlyArray<UnlinkedDeal>;
  dryRun?: boolean;
  onDecision?: (d: EscalationDecision) => void;
}): Promise<EscalationCounts> {
  const counts: EscalationCounts = {
    considered: 0,
    sent: 0,
    onCooldown: 0,
    noRep: 0,
    failed: 0,
  };
  const emit = args.onDecision ?? (() => {});
  const db = supabaseAdmin();

  // A SYSTEMIC failure is not a rep's problem and must never be mailed to them.
  //
  // On 2026-08-17 the Vercel SF_LOGIN_URL was set with its own name inside the
  // value, so every Salesforce auth call failed, so EVERY deal came back
  // unmatched, so every deal escalated. Four newly onboarded reps were told
  // their data was wrong when the fault was one line of our config. The
  // seven-day per-deal cooldown did nothing, because each deal was genuinely
  // being raised for the first time.
  //
  // "unavailable" already means "we could not check", which is the codebase's
  // own distinction. This just stops us mailing that distinction to a customer's
  // sales team. When most of a sweep is unavailable, the cause is ours: report
  // it loudly in the logs and send nobody anything.
  const unavailable = args.deals.filter((d) => d.result.status === "unavailable");
  if (unavailable.length > 0 && unavailable.length >= Math.max(3, args.deals.length / 2)) {
    const why = unavailable[0]?.result.status === "unavailable" ? unavailable[0].result.why : "unknown";
    console.error(
      `[link-escalation] SUPPRESSED: ${unavailable.length} of ${args.deals.length} deals could not be checked ` +
        `for the same reason, which is an outage on our side and not something a rep can act on. ` +
        `Nothing was emailed. Cause: ${why}`,
    );
    counts.considered = args.deals.length;
    counts.failed = unavailable.length;
    for (const d of unavailable) {
      emit({
        kind: "skipped",
        account: d.account,
        reason: "suppressed: a systemic lookup failure is ours to fix, not the rep's",
      });
    }
    return counts;
  }
  const since = new Date(Date.now() - ESCALATION_COOLDOWN_DAYS * 86_400_000).toISOString();

  // Which deals each rep still needs to hear about, after the cooldown.
  const byRep = new Map<string, UnlinkedDeal[]>();

  for (const d of args.deals) {
    counts.considered += 1;

    const to = (d.repEmail ?? "").trim().toLowerCase();
    if (!to) {
      counts.noRep += 1;
      emit({ kind: "skipped", account: d.account, reason: "the deal has no rep email" });
      continue;
    }

    // "We could not check" is never a rep-facing message, even one at a time.
    // Asking someone to resolve a lookup that did not happen is asking them to
    // fix our outage.
    if (d.result.status === "unavailable") {
      counts.failed += 1;
      emit({
        kind: "skipped",
        account: d.account,
        reason: `not raised: the lookup did not complete (${d.result.why}), which is ours to fix`,
      });
      continue;
    }

    // Already raised recently. Supabase reports failure in the result, so the
    // error is checked: a failed read must not be treated as "never sent" and
    // turn this into the nagging it exists to avoid.
    const prior = await db
      .from("sent_messages")
      .select("id")
      .eq("tenant_id", args.tenantId)
      .eq("deal_id", d.dealId)
      .eq("kind", "link_escalation")
      .gte("sent_at", since)
      .limit(1);
    if (prior.error) {
      counts.failed += 1;
      emit({
        kind: "failed",
        account: d.account,
        reason: `could not check whether this was already raised: ${prior.error.message}`,
      });
      continue;
    }
    if ((prior.data ?? []).length > 0) {
      counts.onCooldown += 1;
      emit({
        kind: "skipped",
        account: d.account,
        reason: `already raised with ${to} in the last ${ESCALATION_COOLDOWN_DAYS} days`,
      });
      continue;
    }

    byRep.set(to, [...(byRep.get(to) ?? []), d]);
  }

  for (const [to, deals] of byRep) {
    const mail = renderEscalation(deals);
    const names = deals.map((d) => d.account).join(", ");

    if (args.dryRun) {
      counts.sent += 1;
      emit({ kind: "sent", account: names, to });
      continue;
    }

    let providerId: string | null = null;
    try {
      const res = await sendEmail({ to, subject: mail.subject, html: mail.html, text: mail.text });
      providerId = res.id || null;
    } catch (err) {
      counts.failed += 1;
      emit({
        kind: "failed",
        account: names,
        reason:
          err instanceof MailerConfigError
            ? `mailer not configured: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err),
      });
      continue;
    }

    // One archive row PER DEAL, so the cooldown is per deal even though the
    // message was one. A deal resolved this week must not suppress a different
    // deal raised next week.
    for (const d of deals) {
      await recordSentMessage({
        tenantId: args.tenantId,
        dealId: d.dealId,
        kind: "link_escalation",
        toEmail: to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        providerId,
      });
    }

    counts.sent += 1;
    emit({ kind: "sent", account: names, to });
  }

  return counts;
}

// =====================================================================
// The unattended sweep
//
// The same work scripts/link-accounts.ts does by hand: find every deal with no
// confirmed Salesforce link, run the ladder over its calls, store what is
// confident, and raise the rest with the rep.
//
// KNOWN DUPLICATION. scripts/link-accounts.ts still carries its own copy of
// this loop, because it prints a line per deal as it goes and this returns
// counts. They agree today and nothing guarantees they will tomorrow. The rules
// they both depend on live in matchAccountForMeeting and escalateUnlinkedDeals,
// so a drift here changes reporting rather than behaviour, but the script should
// be repointed at this function the next time either is touched.
// =====================================================================

export type SweepCounts = {
  dealsChecked: number;
  linked: number;
  unresolved: number;
  noCalls: number;
};

export async function sweepAndEscalate(args: {
  tenantId: string;
  /** How far back to look for a call to match on. */
  days?: number;
  /** Write links and send mail. False is a dry run. */
  apply?: boolean;
  /** Restrict to these rep emails. Omit for every rep. */
  repEmails?: string[];
}): Promise<SweepCounts & EscalationCounts> {
  const { matchAccountForMeeting } = await import("./salesforce-account-match");
  const db = supabaseAdmin();
  const days = args.days ?? 45;

  const dealsRes = await db
    .from("deals")
    .select("id, account, rep_email, salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", args.tenantId);
  if (dealsRes.error) throw new Error(`[link-sweep] deals read failed: ${dealsRes.error.message}`);

  const wanted = new Set((args.repEmails ?? []).map((e) => e.trim().toLowerCase()));
  const deals = (dealsRes.data ?? []).filter(
    (d) =>
      d.salesforce_link_confidence !== "confirmed" &&
      (wanted.size === 0 || wanted.has((d.rep_email ?? "").trim().toLowerCase())),
  );

  const counts: SweepCounts = { dealsChecked: 0, linked: 0, unresolved: 0, noCalls: 0 };
  const unresolved: UnlinkedDeal[] = [];
  if (deals.length === 0) {
    return { ...counts, ...(await escalateUnlinkedDeals({ tenantId: args.tenantId, deals: [] })) };
  }

  const callsRes = await db
    .from("calls")
    .select("deal_id, participants, scheduled_start, call_date, title")
    .eq("tenant_id", args.tenantId)
    .in("deal_id", deals.map((d) => d.id))
    .gte("scheduled_start", new Date(Date.now() - days * 86_400_000).toISOString())
    .order("scheduled_start", { ascending: false });
  if (callsRes.error) throw new Error(`[link-sweep] calls read failed: ${callsRes.error.message}`);

  const byDeal = new Map<string, Array<(typeof callsRes.data)[number]>>();
  for (const c of callsRes.data ?? []) {
    if (!c.deal_id) continue;
    byDeal.set(c.deal_id, [...(byDeal.get(c.deal_id) ?? []), c]);
  }

  for (const d of deals) {
    counts.dealsChecked += 1;
    const calls = byDeal.get(d.id) ?? [];
    if (calls.length === 0) {
      // No meeting to match on. Not escalated: there is nothing to ask the rep
      // about yet, and a deal with no calls is not a failure to link.
      counts.noCalls += 1;
      continue;
    }

    let best = null as Awaited<ReturnType<typeof matchAccountForMeeting>> | null;
    for (const c of calls) {
      const emails = Array.isArray(c.participants)
        ? (c.participants as Array<{ email?: string | null }>)
            .map((p) => (p?.email ?? "").trim())
            .filter(Boolean)
        : [];
      const r = await matchAccountForMeeting({
        attendeeEmails: emails,
        meetingDate: (c.scheduled_start ?? c.call_date ?? "").slice(0, 10) || null,
        accountName: d.account,
      });
      if (r.status === "matched" && r.match.confidence === "confirmed") {
        best = r;
        break;
      }
      if (!best || best.status !== "matched") best = r;
    }
    if (!best) continue;

    if (best.status === "matched" && best.match.confidence === "confirmed") {
      if (args.apply) {
        const upd = await db
          .from("deals")
          .update({
            salesforce_account_id: best.match.accountId,
            salesforce_link_confidence: "confirmed",
          })
          .eq("id", d.id);
        if (upd.error) {
          console.error(`[link-sweep] link write failed for ${d.account}: ${upd.error.message}`);
          continue;
        }
      }
      counts.linked += 1;
      continue;
    }

    counts.unresolved += 1;
    const newest = calls[0];
    unresolved.push({
      dealId: d.id,
      account: d.account,
      repEmail: d.rep_email,
      meetingTitle: newest?.title ?? null,
      meetingDate: (newest?.scheduled_start ?? newest?.call_date ?? "").slice(0, 10) || null,
      result: best,
    });
  }

  const sent = await escalateUnlinkedDeals({
    tenantId: args.tenantId,
    deals: unresolved,
    dryRun: !args.apply,
  });
  return { ...counts, ...sent };
}
