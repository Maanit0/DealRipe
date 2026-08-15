/**
 * Inverted deal -> Rolldog opportunity reconciliation.
 *
 * Deals that begin as Salesforce-only discovery have no Rolldog opp when DealRipe
 * captures them. When the rep later promotes the deal to a Rolldog opp, this finds
 * that new opp and links it, so the captured qualification data gets written back
 * instead of the deal landing in Rolldog blank.
 *
 * Detection is inverted (pull each pilot rep's own opps, newest-first, and match
 * to their unlinked captured deals) rather than fuzzy-searching 26k opps by a
 * messy slug. A match is auto-confirmed only when it is unambiguous AND recent:
 *   - same rep (owner), and the deal's normalized account slug equals or prefixes
 *     the opportunity's normalized account-name,
 *   - exactly one such candidate,
 *   - created within RECENT_DAYS (a genuine promotion, not an old account).
 * Anything else is "review" (surfaced, never auto-written). Writing captured data
 * to the wrong customer's opp is unrecoverable, so ambiguity always fails safe.
 *
 * Writes go through writeBackDealToRolldog, which authorizes the newly-linked opp
 * for exactly that one write via runWithAuthorizedOpportunities; the static
 * PILOT_OPPORTUNITY_IDS allowlist is never mutated.
 */

import { repName } from "./display-names";
import { rolldogOppIdForDeal } from "./pilot-config";
import { listOpportunities, type OppSummary } from "./rolldog";
import { normalizeName } from "./rolldog-match";
import { logHistoryBackfillToRolldog, writeBackDealToRolldog, type WriteBackResult } from "./rolldog-writeback";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";
import { extractAndStore } from "./transcript-ingest";

/**
 * Rolldog owner user-ids, keyed by the rep's work email.
 *
 * Reconciliation walks each rep's OWN opportunities, so a rep missing from this
 * map is skipped entirely: their promoted deals never link and never backfill.
 * That failure is silent by nature, so unmappedReps() exists to surface it and
 * findLinkMatches logs a warning rather than dropping the deal quietly.
 *
 * Discover a new id with `npx tsx scripts/rolldog-owner-ids.ts`, which groups
 * recent opportunities by owner so you can recognise a rep by their accounts.
 */
export const REP_UID: Record<string, string> = {
  "jlopez@magaya.com": "82", // Juan, measured from Core Logistics
  "ebencomo@magaya.com": "79", // Eduardo, measured from Alba Wheels Up
  // Net-new AE team, live August 10 2026.
  "asuntrup@magaya.com": "349", // Alexandra, measured from Cargo Cleared + Karla Regina Baeza
  // Confirmed Aug 10 from an opportunity each rep named as their own in the
  // onboarding call chat, resolved with scripts/rolldog-owner-from-opp.ts.
  // Alexandra's 349 was previously inferred from Cargo Cleared; TOC Logistics
  // resolving to the same id confirms it independently.
  "arodriguez@magaya.com": "85", // Ariel, from SSL Intl Corp (opp 83618)
  "dblitstein@magaya.com": "758", // Daniel, from Custom Goods (opp 82005)
  // Steven joined five weeks after the others; Mark chased him on 2026-08-15 and
  // he sent one opportunity link the same morning. 93 is the user-id on Gold
  // Point INBOND SUBSCRIPTION (opp 82443), read through the unscoped listing
  // because a direct read is correctly refused by PILOT_OPPORTUNITY_IDS.
  "sjohnson@magaya.com": "93", // Steven, from Gold Point (opp 82443)
};

/**
 * Did this call actually produce a conversation we hold?
 *
 * has_been_extracted alone does not answer that. transcript-sync sets it to
 * true alongside outcome capture_failed on a bot that never recorded, where it
 * means "stop retrying", not "we have this call". Both call sites below used to
 * test the flag on its own, so a deal whose only meeting was a bot nobody
 * admitted counted as having a captured call: it became eligible for
 * auto-linking, and the backfill note pushed into the customer's opportunity
 * announced a call we have no record of.
 *
 * That is the same class of error as the incident described above the first
 * call site. The filter added then covered meetings that had not happened yet
 * and did not cover meetings that happened without us.
 */
function producedContent(c: { outcome: string | null; has_been_extracted: boolean | null }): boolean {
  if (c.outcome !== null && NO_CONTENT.has(c.outcome)) return false;
  return c.has_been_extracted === true || c.outcome === "captured";
}

const NO_CONTENT = new Set([
  "capture_failed",
  "no_conversation",
  "no_show",
  "rescheduled",
  "placeholder",
  "duplicate",
  "discarded",
]);

const RECENT_DAYS = 90;
const MIN_SLUG = 5;
const MAX_PAGES = 3;

/** A rep's work email, lowercased. Keys of REP_UID. */
export type RepKey = string;

export type LinkMatch = {
  dealId: string;
  account: string;
  externalId: string | null;
  rep: RepKey;
  status: "confirmed" | "review" | "none";
  opp?: OppSummary;
  candidates?: OppSummary[];
  note?: string;
};

export function repKey(email: string | null): RepKey | null {
  const e = (email ?? "").trim().toLowerCase();
  return e && REP_UID[e] ? e : null;
}

/** Human label for a rep key, for log lines and cron output. */
export function repLabel(key: RepKey): string {
  return repName(key);
}

function isRecent(iso: string | null): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t <= RECENT_DAYS * 86_400_000;
}

async function fetchRepOpps(uid: string): Promise<OppSummary[]> {
  try {
    const out: OppSummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await listOpportunities(`filter[user-id]=${uid}&sort=-created-at&page[size]=200&page[number]=${page}`);
      out.push(...rows);
      if (rows.length < 200) break;
    }
    return out;
  } catch {
    // Owner filter unsupported: scan newest and filter client-side.
    const out: OppSummary[] = [];
    for (let page = 1; page <= 6; page++) {
      const rows = await listOpportunities(`sort=-created-at&page[size]=200&page[number]=${page}`);
      if (rows.length === 0) break;
      out.push(...rows.filter((o) => o.owner === uid));
      if (rows.length < 200) break;
    }
    return out;
  }
}

export async function findLinkMatches(tenantSlug: string): Promise<LinkMatch[]> {
  const tenantId = await resolveTenantId(tenantSlug);
  const db = supabaseAdmin();

  const repOpps: Record<RepKey, OppSummary[]> = {};
  for (const rep of Object.keys(REP_UID)) {
    repOpps[rep] = (await fetchRepOpps(REP_UID[rep])).filter((o) => !o.archived);
  }

  const { data: dealData } = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rep_email")
    .eq("tenant_id", tenantId);
  const deals = (dealData ?? []) as Array<{
    id: string; account: string; external_id: string | null; rolldog_opportunity_id: string | null; rep_email: string | null;
  }>;
  // CAPTURED calls, not merely scheduled ones. This used to select every calls
  // row, so a deal whose only meeting was still in the future satisfied a check
  // whose own comment said "no captured call". On 2026-08-10 that linked three
  // deals with zero conversations and wrote each an interaction claiming
  // DealRipe "had already captured a call on it (Aug 14)", a date three days in
  // the future, and that "the qualification fields on this record were filled
  // from that call" when no field had been filled at all. Two false statements
  // in a customer's CRM, from one missing filter.
  const { data: callData } = await db
    .from("calls")
    .select("deal_id, outcome, has_been_extracted")
    .eq("tenant_id", tenantId);
  const withCall = new Set(
    (callData ?? [])
      .filter((c: { outcome: string | null; has_been_extracted: boolean | null }) =>
        producedContent(c),
      )
      .map((c: { deal_id: string | null }) => c.deal_id)
      .filter(Boolean) as string[],
  );

  const out: LinkMatch[] = [];
  const unmapped = new Set<string>();
  for (const x of deals) {
    const staticOpp = x.external_id ? rolldogOppIdForDeal(x.external_id) : null;
    if (staticOpp || x.rolldog_opportunity_id) continue; // already linked
    if (!withCall.has(x.id)) continue; // no captured call, nothing to write
    const rep = repKey(x.rep_email);
    if (!rep) {
      // A rep with no Rolldog user-id in REP_UID cannot be reconciled: we have
      // no way to fetch their opportunities. Record it instead of dropping it,
      // otherwise a newly onboarded rep's deals never link and nothing says so.
      if (x.rep_email) unmapped.add(x.rep_email.trim().toLowerCase());
      continue;
    }

    const base = { dealId: x.id, account: x.account, externalId: x.external_id, rep };
    const dn = normalizeName(x.account);
    if (dn.length < MIN_SLUG) {
      out.push({ ...base, status: "none", note: "slug too short to match safely" });
      continue;
    }
    const cands = repOpps[rep].filter((o) => {
      const on = normalizeName(o.accountName);
      return on === dn || on.startsWith(dn);
    });
    if (cands.length === 1 && isRecent(cands[0].createdAt)) {
      out.push({ ...base, status: "confirmed", opp: cands[0] });
    } else if (cands.length === 1) {
      out.push({ ...base, status: "review", candidates: cands, note: "name matches but opp is old" });
    } else if (cands.length > 1) {
      out.push({ ...base, status: "review", candidates: cands });
    } else {
      out.push({ ...base, status: "none" });
    }
  }

  if (unmapped.size > 0) {
    lastUnmappedReps = [...unmapped].sort();
    console.warn(
      `[rolldog-reconcile] ${unmapped.size} rep(s) have captured deals but no Rolldog user-id in REP_UID, ` +
        `so their promoted deals will not link: ${lastUnmappedReps.join(", ")}. ` +
        `Run scripts/rolldog-owner-ids.ts and add them.`,
    );
  } else {
    lastUnmappedReps = [];
  }

  return out;
}

/**
 * Reps seen with captured deals but no REP_UID entry on the last findLinkMatches
 * run. Read by the relink cron so the gap shows up in the response rather than
 * only in logs.
 */
let lastUnmappedReps: string[] = [];
export function unmappedReps(): string[] {
  return lastUnmappedReps;
}

export type ApplyResult = {
  account: string;
  oppId: string;
  linked: boolean;
  /** How many captured calls were replayed into the merged extraction. */
  callsReplayed?: number;
  writeback?: WriteBackResult;
  /** Result of the single "history backfilled" interaction, when one was due. */
  backfillNote?: { written: boolean; reason?: string };
  error?: string;
};

/**
 * For each confirmed match: stamp the link on the deal, refresh the stored
 * extraction from the latest call (so the write carries the current attribution
 * phrasing), and write back to the newly-authorized opp.
 */
export async function applyConfirmedLinks(
  tenantSlug: string,
  matches: LinkMatch[],
  opts: { reextract?: boolean } = {},
): Promise<ApplyResult[]> {
  const tenantId = await resolveTenantId(tenantSlug);
  const db = supabaseAdmin();
  const reextract = opts.reextract ?? true;
  const out: ApplyResult[] = [];

  for (const m of matches) {
    if (m.status !== "confirmed" || !m.opp) continue;
    const oppId = m.opp.id;
    try {
      const upd = await db
        .from("deals")
        .update({ rolldog_opportunity_id: oppId, rolldog_link_confidence: "confirmed" })
        .eq("id", m.dealId);
      if (upd.error) {
        out.push({ account: m.account, oppId, linked: false, error: `link update failed: ${upd.error.message}` });
        continue;
      }

      // Every captured call on the deal, OLDEST FIRST. A discovery deal can
      // accumulate several calls while it is still a Salesforce lead; the link
      // is the first moment any of them can reach Rolldog.
      //
      // "Captured" is enforced here rather than assumed. Unfiltered, this list
      // included meetings that have not happened, so `newest` below resolved to
      // a future one and the backfill note announced a call date days ahead of
      // today. A meeting on the calendar is not history.
      const callRows = await db
        .from("calls")
        .select("id, external_id, call_date, scheduled_start, outcome, has_been_extracted")
        .eq("tenant_id", tenantId)
        .eq("deal_id", m.dealId)
        .order("call_date", { ascending: true });
      const calls = (callRows.data ?? []).filter((c) => producedContent(c));

      // Re-extract the FULL history, oldest first, so the merged extraction
      // reflects every call rather than only the newest one. Order matters:
      // extraction-merge lets a later call supersede an earlier answer, so
      // replaying out of order would let stale answers win.
      if (reextract && m.externalId) {
        for (const call of calls) {
          if (!call.external_id) continue;
          const tr = await db.from("transcripts").select("body").eq("call_id", call.id).maybeSingle();
          if (!tr.data?.body) continue;
          try {
            await extractAndStore({ transcript: tr.data.body, dealExternalId: m.externalId, callExternalId: call.external_id });
          } catch {
            // Non-fatal: keep replaying the rest, and write back whatever merged.
          }
        }
      }

      // One field write carries the whole history: field_extractions is a merged
      // store keyed (deal_id, scotsman_field_id), not per call, so replaying the
      // transcripts above already folded every call into it.
      //
      // callId attributes the write to the newest call in crm_access_log, which
      // is what makes the activity guard below idempotent on a re-run.
      const newest = calls.length > 0 ? calls[calls.length - 1] : null;
      const writeback = m.externalId
        ? await writeBackDealToRolldog(tenantSlug, m.externalId, { force: true, callId: newest?.id ?? null })
        : undefined;

      // Name the captured history in the interactions tab, which is otherwise
      // empty on a freshly linked deal. Guarded and best-effort: a failure here
      // must never undo a successful link.
      let backfillNote: { written: boolean; reason?: string } | undefined;
      if (writeback?.written && newest) {
        backfillNote = await logHistoryBackfillToRolldog(tenantSlug, {
          opportunityId: oppId,
          callId: newest.id,
          callDates: calls.map((c) => c.scheduled_start ?? c.call_date ?? null),
          staticallyAuthorized: Boolean(rolldogOppIdForDeal(m.externalId ?? "")),
        });
      }

      out.push({ account: m.account, oppId, linked: true, callsReplayed: calls.length, writeback, backfillNote });
    } catch (e) {
      out.push({ account: m.account, oppId, linked: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
