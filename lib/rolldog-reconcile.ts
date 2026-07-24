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
import { writeBackDealToRolldog, type WriteBackResult } from "./rolldog-writeback";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";
import { extractAndStore } from "./transcript-ingest";

// Rolldog owner user-ids, measured from known pilot deals (Core Logistics = Juan,
// Alba Wheels Up = Eduardo). If a rep's owner id changes, update here.
export const REP_UID: Record<"juan" | "eduardo", string> = { juan: "82", eduardo: "79" };
const RECENT_DAYS = 90;
const MIN_SLUG = 5;
const MAX_PAGES = 3;

export type RepKey = "juan" | "eduardo";

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
  const e = (email ?? "").toLowerCase();
  const n = repName(email).toLowerCase();
  if (e.includes("jlopez") || n.includes("juan")) return "juan";
  if (e.includes("ebencomo") || n.includes("eduardo")) return "eduardo";
  return null;
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

  const repOpps: Record<RepKey, OppSummary[]> = { juan: [], eduardo: [] };
  for (const rep of ["juan", "eduardo"] as const) {
    repOpps[rep] = (await fetchRepOpps(REP_UID[rep])).filter((o) => !o.archived);
  }

  const { data: dealData } = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rep_email")
    .eq("tenant_id", tenantId);
  const deals = (dealData ?? []) as Array<{
    id: string; account: string; external_id: string | null; rolldog_opportunity_id: string | null; rep_email: string | null;
  }>;
  const { data: callData } = await db.from("calls").select("deal_id").eq("tenant_id", tenantId);
  const withCall = new Set((callData ?? []).map((c: { deal_id: string | null }) => c.deal_id).filter(Boolean) as string[]);

  const out: LinkMatch[] = [];
  for (const x of deals) {
    const staticOpp = x.external_id ? rolldogOppIdForDeal(x.external_id) : null;
    if (staticOpp || x.rolldog_opportunity_id) continue; // already linked
    if (!withCall.has(x.id)) continue; // no captured call, nothing to write
    const rep = repKey(x.rep_email);
    if (!rep) continue;

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
  return out;
}

export type ApplyResult = { account: string; oppId: string; linked: boolean; writeback?: WriteBackResult; error?: string };

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

      if (reextract && m.externalId) {
        const call = await db
          .from("calls")
          .select("id, external_id")
          .eq("tenant_id", tenantId)
          .eq("deal_id", m.dealId)
          .order("call_date", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (call.data?.external_id) {
          const tr = await db.from("transcripts").select("body").eq("call_id", call.data.id).maybeSingle();
          if (tr.data?.body) {
            try {
              await extractAndStore({ transcript: tr.data.body, dealExternalId: m.externalId, callExternalId: call.data.external_id });
            } catch {
              // Non-fatal: write back the existing extraction rather than skip the link.
            }
          }
        }
      }

      const writeback = m.externalId
        ? await writeBackDealToRolldog(tenantSlug, m.externalId, { force: true })
        : undefined;
      out.push({ account: m.account, oppId, linked: true, writeback });
    } catch (e) {
      out.push({ account: m.account, oppId, linked: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
