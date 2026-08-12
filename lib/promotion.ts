/**
 * A deal that has just become a Rolldog opportunity.
 *
 * The lifecycle DealRipe actually sees is: a meeting appears on a rep's
 * calendar, the deal exists in Salesforce as a discovery prospect or nowhere at
 * all, calls accumulate, and at some point the rep decides it is real and
 * creates a Rolldog opportunity. That moment is a promotion, and until now
 * nothing marked it.
 *
 * Why it needs marking rather than just linking:
 *
 *   Everything learned before the promotion lives only in DealRipe. Several
 *   calls' worth of confirmed qualification, written to Salesforce Account
 *   fields at best, sits outside the opportunity that is now the system of
 *   record. A rep opening that opportunity sees an empty deal room for a
 *   customer they have met three times.
 *
 *   And where DealRipe writes changes at the moment of promotion. Before it,
 *   Salesforce takes the qualification. After it, Rolldog does, because Rolldog
 *   is the system of record wherever an opportunity exists (see the precedence
 *   in lib/salesforce-writeback-run.ts). Nothing was detecting the switch.
 *
 * What this does NOT do, deliberately: it does not create Rolldog
 * opportunities, and it does not decide that a deal should be promoted. Only a
 * rep promotes a deal. This detects that it happened and carries the history
 * across.
 */

import { runWithAuthorizedOpportunities } from "./crm-scope";
import { syncDealToRolldog } from "./crm-writer";
import { resolveWriteTarget } from "./rolldog-writeback";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

export type Promotion = {
  dealId: string;
  account: string;
  opportunityId: string;
  /** Confirmed answers that existed before the opportunity did. */
  answersCarried: number;
  /** Calls captured before the opportunity existed. */
  callsBefore: number;
  salesforceAccountId: string | null;
  /** Written into the opportunity, or only detected. */
  migrated: boolean;
  note: string;
};

/**
 * Deals that are writable to Rolldog and have never received a write.
 *
 * That combination is exactly a promotion: the link exists, so the rep created
 * the opportunity, and nothing has gone into it, so everything DealRipe knows
 * is still outside. It is also self-clearing, since a successful migration
 * leaves an audit row and the deal stops matching.
 */
export async function detectPromotions(tenantSlug: string): Promise<Promotion[]> {
  const tenantId = await resolveTenantId(tenantSlug);
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select(
      "id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence, salesforce_account_id",
    )
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);

  const logRes = await db
    .from("crm_access_log")
    .select("opportunity_external_id")
    .eq("tenant_id", tenantId)
    .eq("operation", "write")
    .eq("allowed", true);
  if (logRes.error) throw new Error(logRes.error.message);
  const written = new Set(
    (logRes.data ?? []).map((r) => String((r as { opportunity_external_id: string }).opportunity_external_id)),
  );

  const fxRes = await db
    .from("field_extractions")
    .select("deal_id, status")
    .eq("tenant_id", tenantId)
    .eq("status", "Yes");
  const answers = new Map<string, number>();
  for (const f of (fxRes.data ?? []) as Array<{ deal_id: string }>) {
    answers.set(f.deal_id, (answers.get(f.deal_id) ?? 0) + 1);
  }

  const callsRes = await db
    .from("calls")
    .select("deal_id, outcome, has_been_extracted")
    .eq("tenant_id", tenantId);
  const captured = new Map<string, number>();
  for (const c of (callsRes.data ?? []) as Array<Record<string, unknown>>) {
    if (!c.deal_id) continue;
    if (!c.has_been_extracted && c.outcome !== "captured") continue;
    captured.set(String(c.deal_id), (captured.get(String(c.deal_id)) ?? 0) + 1);
  }

  const out: Promotion[] = [];
  for (const d of (dealsRes.data ?? []) as Array<Record<string, unknown>>) {
    const target = resolveWriteTarget(d as never);
    if (!target.authorized) continue;
    if (written.has(String(target.opportunityId))) continue;

    const dealId = String(d.id);
    const carried = answers.get(dealId) ?? 0;
    if (carried === 0) continue; // promoted, but nothing learned yet to carry

    out.push({
      dealId,
      account: String(d.account ?? "?"),
      opportunityId: target.opportunityId,
      answersCarried: carried,
      callsBefore: captured.get(dealId) ?? 0,
      salesforceAccountId: (d.salesforce_account_id as string | null) ?? null,
      migrated: false,
      note: "",
    });
  }
  return out;
}

/**
 * Write the pre-promotion history into the opportunity.
 *
 * No re-extraction: the answers already exist and re-running the model over old
 * transcripts would cost tokens to reproduce what is already stored, and risk
 * an unrelated answer changing.
 *
 * The next-step activity is not sent. It is a create rather than an update, so
 * a migration would leave a duplicate to-do in the interactions tab for a
 * next step that has probably already happened.
 */
export async function migratePromotions(
  tenantSlug: string,
  promotions: Promotion[],
): Promise<Promotion[]> {
  const out: Promotion[] = [];
  for (const p of promotions) {
    try {
      const target = { runtimeAuth: [p.opportunityId] };
      const results = await runWithAuthorizedOpportunities(target.runtimeAuth, () =>
        syncDealToRolldog({
          tenantSlug,
          dealId: p.dealId,
          rolldogOpportunityId: p.opportunityId,
        }),
      );
      const sent = results.filter((r) => r.status === "ok");
      const failed = results.filter((r) => r.status === "error");
      out.push({
        ...p,
        migrated: sent.length > 0,
        note:
          failed.length > 0
            ? `${sent.length} written, ${failed.length} failed: ${failed.map((f) => `${f.method} ${f.error}`).join("; ")}`
            : `${sent.length} sub-resource(s) written`,
      });
    } catch (err) {
      out.push({ ...p, migrated: false, note: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
