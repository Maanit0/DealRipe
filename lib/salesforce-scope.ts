/**
 * Salesforce Account write enforcement.
 *
 * The Rolldog twin of this file is lib/crm-scope.ts and this deliberately
 * mirrors it: same two authorization routes, same AsyncLocalStorage runtime
 * grant, same append to crm_access_log, same fail-closed default. Anyone who
 * has read that file can audit this one.
 *
 * READ THIS BEFORE ENABLING ANYTHING HERE.
 *
 * lib/crm-scope.ts carries this line, above assertScopedWrite:
 *
 *   "Writes are Rolldog-only by hard architectural constraint (Magaya security
 *    review): no Salesforce write path is permitted anywhere in the codebase."
 *
 * This file is a Salesforce write path. That constraint is a commitment made to
 * a customer during a security review, and code cannot lift it. So everything
 * here is built and inert:
 *
 *   - SALESFORCE_PILOT_ACCOUNT_IDS is empty, exactly as PILOT_OPPORTUNITY_IDS
 *     was before Mark confirmed the pilot deals.
 *   - The runtime route requires a 'confirmed' link AND the kill switch below.
 *   - SALESFORCE_WRITEBACK_ENABLED defaults to off, so a deploy of this code
 *     changes nothing about what reaches Magaya's Salesforce.
 *
 * Turning it on is a decision for whoever owns that commitment, not a
 * configuration detail. Until then the plan/preview path is fully usable and
 * writes nothing.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { emitAudit } from "./crm-scope";

/**
 * Static allowlist of Salesforce Account ids DealRipe may write to.
 *
 * Empty by design and by commitment. An entry here is a human asserting that
 * this specific customer's Account may be edited by an automated extraction.
 * Nothing automated may add to this list.
 */
export const SALESFORCE_PILOT_ACCOUNT_IDS: readonly string[] = Object.freeze([
  // intentionally empty: see the security-review note in the file header
]);

/**
 * Master kill switch, independent of the allowlists.
 *
 * Off unless SALESFORCE_WRITEBACK_ENABLED is exactly "1". Two independent
 * gates rather than one, because the failure we are guarding against is
 * somebody widening an allowlist without realizing it turns on writes into a
 * paying customer's CRM.
 */
export function salesforceWritebackEnabled(): boolean {
  return process.env.SALESFORCE_WRITEBACK_ENABLED === "1";
}

/** The fields we are willing to touch: the Sales Development section only. */
export const SALESFORCE_WRITE_FIELDS: readonly string[] = Object.freeze([
  "sales_development",
]);

export class SalesforceScopeViolationError extends Error {
  readonly accountId: string;
  readonly reason: string;
  constructor(args: { reason: string; accountId: string }) {
    super(`Salesforce write refused for account ${args.accountId}: ${args.reason}`);
    this.name = "SalesforceScopeViolationError";
    this.accountId = args.accountId;
    this.reason = args.reason;
  }
}

// ---------------------------------------------------------------------
// Runtime authorization (auto-linked deals), mirroring crm-scope
// ---------------------------------------------------------------------

const authorizedAccountsStore = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Run `fn` with `accountIds` temporarily authorized for a Salesforce write.
 * Scoped to one call, per-account, concurrency-safe. Outside this wrapper the
 * set is empty and only the (empty) static allowlist applies.
 */
export function runWithAuthorizedAccounts<T>(accountIds: readonly string[], fn: () => T): T {
  return authorizedAccountsStore.run(new Set(accountIds), fn);
}

function isAuthorized(accountId: string): boolean {
  if (SALESFORCE_PILOT_ACCOUNT_IDS.includes(accountId)) return true;
  return authorizedAccountsStore.getStore()?.has(accountId) === true;
}

/**
 * Throws unless the account is authorized by one of the two routes AND the
 * kill switch is on. Appends to crm_access_log either way, so a refusal is as
 * visible as a write.
 */
export function assertScopedAccountWrite(
  tenantSlug: string,
  accountId: string,
  fields: readonly string[],
): void {
  let reason: string | null = null;
  if (!salesforceWritebackEnabled()) {
    reason = "SALESFORCE_WRITEBACK_ENABLED is not set to '1'";
  } else if (!accountId) {
    reason = "no account id";
  } else if (!isAuthorized(accountId)) {
    reason = `account '${accountId}' is not in SALESFORCE_PILOT_ACCOUNT_IDS and is not runtime-authorized`;
  } else {
    const bad = fields.find((f) => !SALESFORCE_WRITE_FIELDS.includes(f));
    if (bad) reason = `field '${bad}' is not in SALESFORCE_WRITE_FIELDS`;
  }

  emitAudit({
    tenantSlug,
    system: "salesforce",
    operation: "write",
    opportunityId: accountId,
    fields,
    allowed: reason === null,
    violationReason: reason,
    at: new Date(),
  });

  if (reason !== null) throw new SalesforceScopeViolationError({ reason, accountId });
}

// ---------------------------------------------------------------------
// The single place the write decision is made
// ---------------------------------------------------------------------

/**
 * Can this deal write to Salesforce, and to which Account?
 *
 * The Salesforce twin of resolveWriteTarget in lib/rolldog-writeback.ts, and it
 * exists for the same reason: that decision was written out three times on the
 * Rolldog side and a diagnostic reimplemented a fourth, wrong version that
 * reported four healthy deals as blocked. Anything asking "will this deal write
 * to Salesforce" calls THIS.
 *
 * Note the asymmetry with Rolldog, and it is deliberate. A 'review' link (an
 * account reached only by company name) can be read from for a briefing and can
 * never be written to. Informing a rep and editing a customer's record are not
 * the same act and should not share an evidence bar.
 */
export type SalesforceWriteTarget =
  | { authorized: true; accountId: string; route: "static" | "runtime"; runtimeAuth: readonly string[] }
  | { authorized: false; accountId: string | null; reason: string };

export function resolveSalesforceWriteTarget(deal: {
  salesforce_account_id?: string | null;
  salesforce_link_confidence?: string | null;
}): SalesforceWriteTarget {
  const accountId = deal.salesforce_account_id ?? null;

  if (!salesforceWritebackEnabled()) {
    return {
      authorized: false,
      accountId,
      reason:
        "Salesforce write-back is switched off (SALESFORCE_WRITEBACK_ENABLED is not '1'). See the security-review note in lib/salesforce-scope.ts.",
    };
  }
  if (!accountId) {
    return { authorized: false, accountId: null, reason: "no Salesforce account linked to this deal" };
  }
  if (SALESFORCE_PILOT_ACCOUNT_IDS.includes(accountId)) {
    return { authorized: true, accountId, route: "static", runtimeAuth: [] };
  }
  const conf = deal.salesforce_link_confidence ?? null;
  if (conf === "confirmed") {
    return { authorized: true, accountId, route: "runtime", runtimeAuth: [accountId] };
  }
  return {
    authorized: false,
    accountId,
    reason: `link confidence is '${conf ?? "none"}', which fails closed. Only a domain-verified ('confirmed') link authorizes a write.`,
  };
}
