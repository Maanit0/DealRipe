/**
 * Resolve where an upcoming meeting's qualification will be written, BEFORE the
 * call, and record what we tried.
 *
 * WHY THIS EXISTS SEPARATELY FROM rolldog-relink
 *
 * rolldog-relink is a post-call backfill. Its first filter is "does this deal
 * have a captured call", because its job is pushing history into an opportunity
 * created after the fact. That is correct for what it does, and it means a deal
 * with a meeting on Thursday and no call yet is never examined at all. On
 * 2026-08-11, three of a newly onboarded rep's deals showed "no Rolldog
 * opportunity" two days before their calls. Nothing had looked for one, and the
 * only way to find out was to email the rep.
 *
 * So this runs on the other side of the call:
 *
 *   deals with a meeting in the next N days
 *   and no authorized write target in either CRM
 *   -> search Rolldog by name variants and domain
 *   -> resolve Salesforce by domain, address, then name
 *   -> store the outcome in deal_link_attempts, including failures
 *
 * WHAT IT WILL AND WILL NOT DECIDE
 *
 * It stores a link only for an unambiguous match. Everything else becomes
 * `needs_decision` with the candidates attached, because linking a deal to the
 * wrong opportunity writes one customer's qualification onto another customer's
 * record inside Magaya's live CRM, and that is not recoverable. Seventeen
 * candidates matched "Medov" and seven matched "TQL"; no matcher should pick
 * from those. The goal is not zero human input, it is that a human is asked
 * only where a human is genuinely required, and asked with the candidates in
 * front of them.
 *
 * Linking is not writing. This decides which record a deal belongs to. Whether
 * anything is written into it is gated separately in lib/crm-scope.ts and
 * lib/salesforce-scope.ts, and neither is touched here.
 */

import { resolveAccountForDeal } from "./salesforce-link";
import { resolveSalesforceWriteTarget } from "./salesforce-scope";
import { matchDealToOpportunity } from "./rolldog-match";
import { resolveWriteTarget } from "./rolldog-writeback";
import { prewarmRolldogToken } from "./rolldog";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

export type AttemptStatus = "linked" | "needs_decision" | "no_candidates" | "unavailable";

export type DealLinkOutcome = {
  dealId: string;
  account: string;
  repEmail: string | null;
  meetingAt: string | null;
  /** Already had somewhere to write before we started; nothing was searched. */
  alreadyWritable: boolean;
  rolldog: { status: AttemptStatus; note: string; candidates: Array<{ id: string; label: string }>; queries: string[] };
  salesforce: { status: AttemptStatus; note: string };
};

export type ResolveOpts = {
  tenantSlug: string;
  /** How far ahead to look for meetings. */
  days?: number;
  /** Store confident matches. Default false: report only. */
  apply?: boolean;
};

/** Candidate shape kept small on purpose: enough for a human to choose from,
 *  not a copy of the customer's record. */
/**
 * Customer email addresses from a call's attendee list.
 *
 * calls.participants is the raw Graph attendee array, so it holds the invitees
 * and not the organiser. Magaya's own people are dropped: their domain would
 * resolve every deal to Magaya's own record in either CRM.
 */
function customerAddresses(participants: unknown): string[] {
  if (!Array.isArray(participants)) return [];
  const out: string[] = [];
  for (const p of participants) {
    const email =
      typeof p === "string"
        ? p
        : typeof (p as { email?: unknown })?.email === "string"
          ? ((p as { email: string }).email)
          : null;
    if (!email || !email.includes("@")) continue;
    const lower = email.trim().toLowerCase();
    if (lower.endsWith("@magaya.com")) continue;
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

function label(c: { id: string; accountName: string; name: string; owner: string | null; stageName: string | null; createdAt: string | null }): string {
  const bits = [c.accountName || c.name];
  if (c.stageName) bits.push(c.stageName);
  if (c.owner) bits.push(`owner ${c.owner}`);
  if (c.createdAt) bits.push(c.createdAt.slice(0, 10));
  return bits.join(" · ");
}

export async function resolveUpcomingLinks(opts: ResolveOpts): Promise<DealLinkOutcome[]> {
  const days = opts.days ?? 7;
  const tenantId = await resolveTenantId(opts.tenantSlug);
  const db = supabaseAdmin();

  const now = new Date();
  const until = new Date(now.getTime() + days * 86_400_000);

  const callsRes = await db
    .from("calls")
    .select("deal_id, scheduled_start, outcome, title, participants")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", now.toISOString())
    .lte("scheduled_start", until.toISOString())
    .order("scheduled_start", { ascending: true });
  if (callsRes.error) throw new Error(`calls lookup failed: ${callsRes.error.message}`);

  // Earliest upcoming meeting per deal, skipping rows we already know are not
  // real meetings. The title travels with it: for a customer on free mail the
  // invite subject is often the only identifier that names a company at all.
  const DEAD = new Set(["duplicate", "placeholder", "capture_failed", "discarded", "rescheduled"]);
  const soonest = new Map<string, { at: string; subject: string | null; addresses: string[] }>();
  for (const c of callsRes.data ?? []) {
    if (!c.deal_id || !c.scheduled_start) continue;
    if (c.outcome && DEAD.has(String(c.outcome))) continue;
    if (!soonest.has(c.deal_id)) {
      soonest.set(c.deal_id, {
        at: c.scheduled_start,
        subject: (c.title as string | null) ?? null,
        addresses: customerAddresses(c.participants),
      });
    }
  }
  if (soonest.size === 0) return [];

  const dealsRes = await db
    .from("deals")
    .select(
      "id, account, external_id, rep_email, rolldog_opportunity_id, rolldog_link_confidence, salesforce_account_id, salesforce_link_confidence",
    )
    .in("id", [...soonest.keys()]);
  if (dealsRes.error) throw new Error(`deals lookup failed: ${dealsRes.error.message}`);

  // One token for the whole sweep rather than one per deal.
  await prewarmRolldogToken().catch(() => {});

  const out: DealLinkOutcome[] = [];

  for (const d of (dealsRes.data ?? []) as Array<Record<string, unknown>>) {
    const dealId = String(d.id);
    const account = String(d.account ?? "");
    const meeting = soonest.get(dealId) ?? null;
    const meetingAt = meeting?.at ?? null;
    const meetingSubject = meeting?.subject ?? null;
    const repEmail = (d.rep_email as string | null) ?? null;

    const deal = d as {
      external_id?: string | null;
      rolldog_opportunity_id?: string | null;
      rolldog_link_confidence?: string | null;
      salesforce_account_id?: string | null;
      salesforce_link_confidence?: string | null;
    };

    // Ask the enforcers, not a restatement of their rules.
    const rdTarget = resolveWriteTarget(deal);
    const sfTarget = resolveSalesforceWriteTarget(deal);
    if (rdTarget.authorized || sfTarget.authorized) {
      out.push({
        dealId,
        account,
        repEmail,
        meetingAt,
        alreadyWritable: true,
        rolldog: { status: "linked", note: rdTarget.authorized ? `opp ${rdTarget.opportunityId}` : "not needed", candidates: [], queries: [] },
        salesforce: { status: "linked", note: sfTarget.authorized ? `account ${sfTarget.accountId}` : "not needed" },
      });
      continue;
    }

    const addresses = meeting?.addresses ?? [];
    const domain = addresses.map((a) => a.split("@")[1]).find(Boolean) ?? null;

    // ---- Rolldog ----
    const m = await matchDealToOpportunity({
      account,
      externalId: deal.external_id,
      domain,
      meetingSubject,
    });
    let rd: DealLinkOutcome["rolldog"];
    if (m.status === "confirmed") {
      rd = { status: "linked", note: `opp ${m.opp.id} (${m.opp.accountName})`, candidates: [{ id: m.opp.id, label: label(m.opp) }], queries: m.queries };
      if (opts.apply) {
        const up = await db
          .from("deals")
          .update({ rolldog_opportunity_id: m.opp.id, rolldog_link_confidence: "confirmed" } as never)
          .eq("id", dealId);
        if (up.error) rd = { ...rd, status: "needs_decision", note: `match found but store failed: ${up.error.message}` };
      } else {
        rd = { ...rd, note: `${rd.note} (dry run, not stored)` };
      }
    } else if (m.status === "review") {
      rd = { status: "needs_decision", note: m.reason, candidates: m.candidates.map((c) => ({ id: c.id, label: label(c) })), queries: m.queries };
    } else if (m.status === "unavailable") {
      rd = { status: "unavailable", note: m.reason, candidates: [], queries: m.queries };
    } else {
      rd = { status: "no_candidates", note: "Rolldog answered and had no match", candidates: [], queries: m.queries };
    }

    // ---- Salesforce ----
    // resolveAccountForDeal already distinguishes domain, address, name and
    // outright failure, and stores only what it is entitled to store.
    let sf: DealLinkOutcome["salesforce"];
    try {
      const r = await resolveAccountForDeal({
        tenantId,
        dealId,
        dealAccountName: account,
        domain,
        addresses,
        // The identifier that survives free mail. resolveAccount tries domain,
        // then exact address, then the deal name, then this.
        meetingSubject,
        force: true,
      });
      const res = r.resolution;
      if (res.status === "resolved_by_domain") sf = { status: "linked", note: `${res.accountName} (${res.accountId})` };
      else if (res.status === "resolved_by_name") sf = { status: "needs_decision", note: `name match only: ${res.accountName} (${res.accountId})` };
      else if (res.status === "no_account") sf = { status: "no_candidates", note: `searched ${res.searchedNames.join(", ") || "domain only"}` };
      else sf = { status: "unavailable", note: `Salesforce returned ${res.status}` };
    } catch (err) {
      sf = { status: "unavailable", note: err instanceof Error ? err.message : String(err) };
    }

    await recordAttempt(dealId, "rolldog", rd.status, rd.candidates, rd.queries, rd.note);
    await recordAttempt(dealId, "salesforce", sf.status, [], [], sf.note);

    out.push({ dealId, account, repEmail, meetingAt, alreadyWritable: false, rolldog: rd, salesforce: sf });
  }

  return out;
}

/** Persist what we tried. Best effort: failing to record an attempt must not
 *  fail the sweep, but it is logged loudly because an unrecorded attempt is
 *  exactly the ambiguity this table exists to remove. */
async function recordAttempt(
  dealId: string,
  system: "rolldog" | "salesforce",
  status: AttemptStatus,
  candidates: Array<{ id: string; label: string }>,
  queries: string[],
  note: string,
): Promise<void> {
  try {
    const res = await (supabaseAdmin() as unknown as {
      from: (t: string) => {
        upsert: (v: Record<string, unknown>, o: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
      };
    })
      .from("deal_link_attempts")
      .upsert(
        {
          deal_id: dealId,
          system,
          status,
          candidates: candidates.length > 0 ? candidates : null,
          queries: queries.length > 0 ? queries : null,
          note,
          searched_at: new Date().toISOString(),
        },
        { onConflict: "deal_id,system" },
      );
    if (res.error) {
      console.warn(`[upcoming-links] could not record ${system} attempt for ${dealId}: ${res.error.message}`);
    }
  } catch (err) {
    console.warn(
      `[upcoming-links] could not record ${system} attempt for ${dealId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
