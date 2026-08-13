/**
 * Deal -> Salesforce Account write-back, gated.
 *
 * The Salesforce twin of lib/rolldog-writeback.ts. Same shape: resolve a
 * target, refuse loudly if it is not authorized, plan, then apply. Never
 * throws, so it can never break transcript-sync.
 *
 * Read the security-review note at the top of lib/salesforce-scope.ts before
 * enabling this. It is inert by default and a deploy of this file changes
 * nothing about what reaches Magaya's Salesforce.
 */

import { getDealForTenant } from "./supabase-queries";
import {
  planAccountWriteBack,
  applyAccountWriteBack,
  type WriteBackPlan,
} from "./salesforce-writeback";
import {
  assertScopedAccountWrite,
  resolveSalesforceWriteTarget,
  runWithAuthorizedAccounts,
  SalesforceScopeViolationError,
} from "./salesforce-scope";
import { recordWrite } from "./crm-scope";
import { resolveWriteTarget } from "./rolldog-writeback";
import { readSalesforceLink } from "./salesforce-link";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

/**
 * Which extracted field feeds which Salesforce label.
 *
 * Deliberately partial. Magaya's Sales Development section has seventeen
 * fields we can see and this maps eight, because those are the eight where a
 * call genuinely evidences the answer. "Does lead have a warehouse?",
 * "ACE/AES Filer Code" and "Annual Company Revenue" are not mapped: no
 * qualification field in our framework answers them, and inferring one from a
 * transcript would put a guess in a field a CRO reads as fact.
 *
 * Labels are matched against accountFieldMeta at plan time, so a label absent
 * from the org or invisible to the integration user is skipped with a reason
 * rather than producing an error. Nothing here hardcodes an API name.
 */
const FIELD_SOURCES: ReadonlyArray<{ label: string; fieldKey: string; asBoolean?: boolean }> = Object.freeze([
  { label: "Business Issues", fieldKey: "why_looking_now" },
  { label: "Software Purposes", fieldKey: "why_looking" },
  { label: "Any Other Software", fieldKey: "existing_systems" },
  { label: "Other Providers Reached Out", fieldKey: "competition_notes" },
  { label: "Desired Go-Live Date", fieldKey: "close_date_validated" },
  { label: "Compelling Events", fieldKey: "why_looking_now", asBoolean: true },
  { label: "Budget Confirmed", fieldKey: "budget_fit", asBoolean: true },
  { label: "Executive Sponsorship", fieldKey: "sql4_exec_involvement", asBoolean: true },
]);

/**
 * A confirmed extraction is worth 0.9 to the checkbox rule in
 * salesforce-writeback, which needs 0.8.
 *
 * That is not an arbitrary number. lib/grounding.ts already downgrades any
 * "Yes" whose evidence quote is not actually in the transcript to "Unknown"
 * before it is stored, so a "Yes" that survives to here has a quote behind it.
 * Anything short of "Yes" contributes nothing: an unchecked Salesforce
 * checkbox already means "not established", which is exactly what we know.
 */
const CONFIRMED_CONFIDENCE = 0.9;

/**
 * Salesforce took the request and rejected the change: a validation rule, a
 * required field, a permission on the object. Carried as a throw purely so the
 * settlement promise the audit is waiting on resolves as a failure.
 */
class SalesforceApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesforceApplyError";
  }
}

export type SalesforceWriteResult = {
  written: boolean;
  accountId?: string | null;
  reason?: string;
  plan?: WriteBackPlan;
  /** True when this was a plan-only run. A dry run is never `written`. */
  dryRun?: boolean;
};

/**
 * Plan, and optionally apply, the Salesforce write for one deal.
 *
 * Dry run is the default. `apply: true` still has to get past
 * resolveSalesforceWriteTarget and assertScopedAccountWrite, both of which are
 * fail-closed, so passing it is necessary and nowhere near sufficient.
 */
export async function writeBackDealToSalesforce(
  tenantSlug: string,
  dealExternalId: string,
  opts: {
    callId?: string | null;
    callDate?: string | null;
    apply?: boolean;
    /**
     * Plan against this account even though no link is stored for the deal.
     *
     * DRY RUN ONLY, and enforced below: passing it alongside apply is refused
     * rather than honoured. It exists so the preflight can answer "what would
     * we write" before the link columns are migrated, which is the difference
     * between a reviewable plan and a blank page. It authorizes nothing: the
     * scope assert never runs on this path.
     */
    previewAccountId?: string | null;
    /**
     * Write to Salesforce even when the deal already writes to Rolldog.
     *
     * Off by default. See the precedence note below.
     */
    evenIfRolldogWrites?: boolean;
  } = {},
): Promise<SalesforceWriteResult> {
  if (opts.previewAccountId && opts.apply) {
    return {
      written: false,
      reason: "previewAccountId is a dry-run-only affordance and cannot be combined with apply",
    };
  }
  const tenantId = await resolveTenantId(tenantSlug);
  const db = supabaseAdmin();

  const dealRow = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId)
    .eq("external_id", dealExternalId)
    .maybeSingle();
  if (dealRow.error) return { written: false, reason: `deal lookup failed: ${dealRow.error.message}` };
  if (!dealRow.data) return { written: false, reason: `deal '${dealExternalId}' not found` };

  // ONE system of record per deal. Rolldog wins where it exists.
  //
  // Without this the two writers are independent and a deal with both a Rolldog
  // opportunity and a Salesforce account writes to both, which is not a
  // redundancy so much as a second version of the truth. Reps run their
  // opportunities in Rolldog; Salesforce is where a deal lives when Rolldog has
  // no opportunity for it, which today is Beyond Pegasus, Febest, Sunny Wing,
  // Dunavant, Medov and TQL.
  //
  // resolveWriteTarget is the same function the Rolldog writer uses, so the two
  // cannot disagree about whether Rolldog is going to write. A restatement of
  // its rules here would eventually drift and produce a deal that writes to
  // neither, which is worse than one that writes to both.
  if (!opts.evenIfRolldogWrites) {
    const rolldog = resolveWriteTarget(dealRow.data);
    if (rolldog.authorized) {
      return {
        written: false,
        accountId: null,
        reason: `Rolldog is the system of record for this deal (opportunity ${rolldog.opportunityId}, ${rolldog.route} route). Salesforce is written only where Rolldog has no opportunity.`,
      };
    }
  }

  // The link is read through readSalesforceLink so "no link" and "the link
  // columns do not exist yet" stay distinguishable all the way to the caller.
  const link = await readSalesforceLink(tenantId, dealRow.data.id);

  // Preview path: no link needed, no authorization granted, never applies.
  let accountId: string;
  let target: ReturnType<typeof resolveSalesforceWriteTarget> | null = null;
  if (opts.previewAccountId) {
    accountId = opts.previewAccountId;
  } else {
    if (link.status === "schema_missing") {
      return {
        written: false,
        reason: "salesforce link columns are not migrated yet (run supabase/add-deal-salesforce-link.sql)",
      };
    }
    if (link.status === "unavailable") {
      return { written: false, reason: `could not read the deal's Salesforce link: ${link.error}` };
    }
    target = resolveSalesforceWriteTarget({
      salesforce_account_id: link.status === "linked" ? link.accountId : null,
      salesforce_link_confidence: link.status === "linked" ? link.confidence : null,
    });
    if (!target.authorized) {
      return { written: false, accountId: target.accountId, reason: `${dealExternalId}: ${target.reason}` };
    }
    accountId = target.accountId;
  }

  const deal = await getDealForTenant(tenantId, dealRow.data.id);
  if (!deal) return { written: false, accountId, reason: "deal context could not be loaded" };

  const extraction = (deal.extraction ?? {}) as Record<
    string,
    { status?: string; answer?: string; evidence?: string } | undefined
  >;

  const proposed = FIELD_SOURCES.flatMap((src) => {
    const e = extraction[src.fieldKey];
    if (!e || e.status !== "Yes") return [];
    const answer = (e.answer ?? "").trim();
    if (!answer) return [];
    return [
      {
        label: src.label,
        value: src.asBoolean ? true : answer,
        evidence: e.evidence ?? null,
        confidence: CONFIRMED_CONFIDENCE,
      },
    ];
  });

  if (proposed.length === 0) {
    return {
      written: false,
      accountId,
      reason: "no confirmed extraction maps to a Sales Development field yet",
    };
  }

  let plan: WriteBackPlan;
  try {
    plan = await planAccountWriteBack({
      accountId,
      accountName: dealRow.data.account,
      proposed,
      callDate: opts.callDate ?? new Date(),
    });
  } catch (err) {
    // A failed plan is not an empty plan. Saying so keeps a Salesforce outage
    // from reading later as "there was nothing to write".
    return {
      written: false,
      accountId,
      reason: `could not build the write plan: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!opts.apply) {
    return { written: false, dryRun: true, accountId, plan, reason: "dry run" };
  }
  if (plan.writes.length === 0) {
    return { written: false, accountId, plan, reason: "plan is empty; nothing to write" };
  }
  // Unreachable on the preview path (it returns above), but stated so the
  // compiler and a reader agree that applying always has a resolved target.
  if (!target) return { written: false, accountId, plan, reason: "no write target" };

  try {
    const res = await runWithAuthorizedAccounts(target.runtimeAuth, async () =>
      // recordWrite publishes the values AND a settlement promise the audit
      // hook awaits. applyAccountWriteBack reports a rejected PATCH by
      // returning an error, which settles as success and had the audit
      // claiming a write Salesforce refused, so it is rethrown here and turned
      // back into a reason below.
      recordWrite(
        plan.writes.map((w) => ({ label: w.label, value: w.display, mode: w.mode })),
        async () => {
          // Inside the grant, so the assert sees the runtime authorization.
          // Throws SalesforceScopeViolationError if anything is out of scope,
          // and appends to crm_access_log either way.
          assertScopedAccountWrite(tenantSlug, accountId, ["sales_development"]);
          const applied = await applyAccountWriteBack(plan);
          if (applied.error) throw new SalesforceApplyError(applied.error);
          return applied;
        },
      ),
    );
    void res;
    return { written: true, accountId, plan };
  } catch (err) {
    if (err instanceof SalesforceScopeViolationError) {
      return { written: false, accountId, plan, reason: `scope blocked: ${err.reason}` };
    }
    // Salesforce accepted the request and refused the change. Distinct from a
    // scope refusal (we were never allowed) and from a transport failure (we
    // never found out), and the audit has already recorded it as not landed.
    if (err instanceof SalesforceApplyError) {
      return { written: false, accountId, plan, reason: err.message };
    }
    return {
      written: false,
      accountId,
      plan,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
