/**
 * CRM access enforcement for the Magaya pilot.
 *
 * Every Rolldog and Salesforce call passes through assertScopedRead or
 * assertScopedWrite before the network layer runs. The asserts throw
 * synchronously on any violation and append an audit entry to
 * crm_access_log (Supabase). Asserts that pass also append, so the table
 * is the canonical record of every CRM access the system attempted,
 * authorized or not.
 *
 * The constants below are the entire authority surface. Edit them and a
 * deploy is required. There is no runtime "add another opportunity" path.
 *
 * Audit reviewer: read top to bottom. The asserts at the bottom are the
 * only callable API; everything above them is data.
 */

// ---------------------------------------------------------------------
// Allowlist: which opportunities the system may touch at all.
// ---------------------------------------------------------------------

/**
 * The exhaustive set of Rolldog opportunity ids this system is allowed
 * to read or write. Until Mark Buman confirms the three pilot deals at
 * kickoff, this is the empty set, which means every assertScopedRead and
 * assertScopedWrite call fails closed. There is no "allow all" mode.
 *
 * Populated at kickoff when Mark Buman confirms the three pilot deals;
 * until then every CRM call fails closed.
 */
export const PILOT_OPPORTUNITY_IDS: readonly string[] = Object.freeze([
  // intentionally empty until kickoff
]);

/**
 * Parallel allowlist of Salesforce opportunity IDs (18-char Salesforce
 * record ids). Disjoint from PILOT_OPPORTUNITY_IDS because Salesforce
 * and Rolldog identify the same opportunity with different ids.
 *
 * Populated at kickoff when Fernando's admin provides the three pilot
 * deals' Salesforce ids; until then every Salesforce read fails closed.
 */
export const SALESFORCE_PILOT_OPPORTUNITY_IDS: readonly string[] = Object.freeze([
  // intentionally empty until kickoff
]);

// ---------------------------------------------------------------------
// Allowlist: which Rolldog fields may be read.
// Mirrors the integration spec verbatim. No additions without redeploy.
// ---------------------------------------------------------------------

export const ROLLDOG_READ_FIELDS: readonly string[] = Object.freeze([
  // Stage gates: the qualification checklist Mark inspects in QBRs
  "stage_gates",
  // Opportunity score (Rolldog computed roll-up)
  "opportunity_score",
  // Tab contents
  "timeline_tab",
  "people_tab",
  "budget_tab",
  "competitors_tab",
  // Free-text narrative fields
  "situation",
  "drivers",
  "solution",
  "next_step",
  // Activity history
  "interactions",
  // Opportunity metadata
  "close_date",
  "stage",
  "amount",
  "age",
  "owner",
  "last_updated",
]);

// ---------------------------------------------------------------------
// Allowlist: which Rolldog fields may be written.
// Strict subset of read fields plus a few write-only sub-resources.
// ---------------------------------------------------------------------

export const ROLLDOG_WRITE_FIELDS: readonly string[] = Object.freeze([
  "stage_gate_checklist_items",
  "next_step",
  "timeline",
  "timeline_notes",
  "people",
  "budget",
  "competitors",
  "situation",
]);

// ---------------------------------------------------------------------
// Allowlist: Salesforce reads. Closed-won and closed-lost outcomes only.
// We never write to Salesforce. Reads exist to label completed
// outcomes for the calibration loop.
// ---------------------------------------------------------------------

export const SALESFORCE_READ_FIELDS: readonly string[] = Object.freeze([
  "StageName",
  "IsClosed",
  "IsWon",
]);

// ---------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------

/**
 * Thrown by assertScopedRead and assertScopedWrite. The fields on this
 * error are intended to be safe to surface to a security log: they name
 * the violation but do not contain CRM record contents.
 */
export class ScopeViolationError extends Error {
  public readonly opportunityId: string;
  public readonly offendingField: string | null;
  public readonly operation: "read" | "write";

  constructor(args: {
    reason: string;
    opportunityId: string;
    offendingField: string | null;
    operation: "read" | "write";
  }) {
    super(args.reason);
    this.name = "ScopeViolationError";
    this.opportunityId = args.opportunityId;
    this.offendingField = args.offendingField;
    this.operation = args.operation;
  }
}

// ---------------------------------------------------------------------
// Audit hook
// ---------------------------------------------------------------------

/**
 * Shape of an entry appended to crm_access_log. Both passes and failures
 * are appended.
 */
export type CrmAccessAuditEntry = {
  tenantSlug: string;
  system: "rolldog" | "salesforce";
  operation: "read" | "write";
  opportunityId: string;
  fields: readonly string[];
  allowed: boolean;
  violationReason: string | null;
  at: Date;
};

/**
 * The current audit hook. The default writes to Supabase crm_access_log
 * best-effort and asynchronously. Tests inject an in-memory hook so the
 * test runner does not touch Supabase.
 */
let auditHook: (entry: CrmAccessAuditEntry) => void = defaultAuditHook;

/**
 * Replace the audit hook. Used by scripts/test-crm-scope.ts to collect
 * entries in memory. Production code never calls this.
 */
export function setAuditHook(
  hook: (entry: CrmAccessAuditEntry) => void,
): void {
  auditHook = hook;
}

/**
 * Restore the default Supabase-backed audit hook. Symmetric to
 * setAuditHook so a test that overrides can cleanly restore.
 */
export function resetAuditHook(): void {
  auditHook = defaultAuditHook;
}

/**
 * Tracks in-flight default-hook audit writes so a caller (typically a
 * one-shot script) can await all pending writes before exiting or
 * querying crm_access_log. Custom hooks installed via setAuditHook are
 * not tracked here; they are the caller's responsibility.
 */
const pendingWrites: Set<Promise<void>> = new Set();

function defaultAuditHook(entry: CrmAccessAuditEntry): void {
  // Fire and forget at the call site. The assert is synchronous and
  // must not block on the audit write. If Supabase is unavailable, the
  // operation still succeeds or fails based on the in-memory
  // allowlists; only the log entry is dropped.
  //
  // The promise is registered in pendingWrites so flushAuditWrites()
  // can await completion. The catch handler resolves the promise to
  // void after logging, so Promise.allSettled in flushAuditWrites is
  // safe.
  const p = writeCrmAccessLogToSupabase(entry).catch((err) => {
    console.error(
      `[crm-scope] audit write failed for ${entry.system} ${entry.operation} ${entry.opportunityId}:`,
      err instanceof Error ? err.message : err,
    );
  });
  pendingWrites.add(p);
  void p.finally(() => pendingWrites.delete(p));
}

/**
 * Await every default-hook audit write currently in flight. Useful for
 * one-shot scripts that need to know "every entry has landed in
 * crm_access_log" before exiting or querying the table.
 *
 * Returns when all in-flight writes have either succeeded or failed.
 * Failures are already logged to stderr by the default hook; this
 * function does not re-surface them as exceptions.
 */
export async function flushAuditWrites(): Promise<void> {
  const snapshot = Array.from(pendingWrites);
  await Promise.allSettled(snapshot);
}

async function writeCrmAccessLogToSupabase(
  entry: CrmAccessAuditEntry,
): Promise<void> {
  // Imports are deferred so the test script and the rolldog scaffold
  // do not pay for the Supabase client at module load time.
  const { supabaseAdmin } = await import("./supabase");
  const { resolveTenantId } = await import("./tenant-deal-lookup");

  // Resolve the caller-supplied tenant slug to the Supabase tenant uuid.
  // This used to hardcode "magaya"; now every assert names its tenant
  // explicitly so the audit row lands under the right tenant_id.
  const tenantId = await resolveTenantId(entry.tenantSlug);

  const { error } = await supabaseAdmin().from("crm_access_log").insert({
    tenant_id: tenantId,
    operation: entry.operation,
    opportunity_external_id: entry.opportunityId,
    fields: entry.fields as unknown as string[],
    allowed: entry.allowed,
    violation_reason: entry.violationReason,
  });
  if (error) {
    throw new Error(`crm_access_log insert failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------
// Test-only override
// ---------------------------------------------------------------------

let _testOverridePilotIds: readonly string[] | null = null;
let _testOverrideSalesforcePilotIds: readonly string[] | null = null;

/**
 * Test-only. Lets scripts/test-crm-scope.ts exercise the happy path
 * without populating PILOT_OPPORTUNITY_IDS, which stays empty until
 * kickoff. The double-underscore prefix and the explicit production
 * guard mean a reviewer can confirm by inspection that no production
 * code calls this.
 *
 * Throws if invoked while NODE_ENV=production.
 */
export function __setPilotOpportunityIdsForTesting(
  ids: readonly string[] | null,
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "__setPilotOpportunityIdsForTesting cannot be called in production",
    );
  }
  _testOverridePilotIds = ids;
}

/**
 * Test-only. Parallel of __setPilotOpportunityIdsForTesting for the
 * Salesforce path. Same production guard, same audit contract.
 */
export function __setSalesforcePilotIdsForTesting(
  ids: readonly string[] | null,
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "__setSalesforcePilotIdsForTesting cannot be called in production",
    );
  }
  _testOverrideSalesforcePilotIds = ids;
}

function effectivePilotIds(system: "rolldog" | "salesforce"): readonly string[] {
  if (system === "salesforce") {
    return _testOverrideSalesforcePilotIds ?? SALESFORCE_PILOT_OPPORTUNITY_IDS;
  }
  return _testOverridePilotIds ?? PILOT_OPPORTUNITY_IDS;
}

// ---------------------------------------------------------------------
// Assert API. The only public enforcement surface.
// ---------------------------------------------------------------------

/**
 * Throws ScopeViolationError unless:
 *   1. opportunityId is in the system-appropriate pilot id allowlist, AND
 *   2. every field in fields is in the system-appropriate read allowlist.
 *
 * The "system" (rolldog vs salesforce) is auto-detected from the fields:
 *   - If ANY field is in SALESFORCE_READ_FIELDS, the call is treated as
 *     a Salesforce read and validated against SALESFORCE_READ_FIELDS +
 *     SALESFORCE_PILOT_OPPORTUNITY_IDS.
 *   - Otherwise, the call is treated as a Rolldog read and validated
 *     against ROLLDOG_READ_FIELDS + PILOT_OPPORTUNITY_IDS.
 *
 * The two field allowlists are intentionally disjoint (Salesforce uses
 * PascalCase, Rolldog uses snake_case), so the detection is unambiguous.
 *
 * Always appends an audit entry to crm_access_log (pass or fail) tagged
 * with the resolved tenant + system.
 */
export function assertScopedRead(
  tenantSlug: string,
  opportunityId: string,
  fields: readonly string[],
): void {
  const system: "rolldog" | "salesforce" = fields.some((f) =>
    SALESFORCE_READ_FIELDS.includes(f),
  )
    ? "salesforce"
    : "rolldog";
  const allowlist =
    system === "salesforce" ? SALESFORCE_READ_FIELDS : ROLLDOG_READ_FIELDS;

  const violation = computeViolation(opportunityId, fields, allowlist, system, "read");
  emitAudit({
    tenantSlug,
    system,
    operation: "read",
    opportunityId,
    fields,
    allowed: violation === null,
    violationReason: violation?.reason ?? null,
    at: new Date(),
  });
  if (violation !== null) {
    throw new ScopeViolationError({
      reason: violation.reason,
      opportunityId,
      offendingField: violation.offendingField,
      operation: "read",
    });
  }
}

/**
 * Throws ScopeViolationError unless:
 *   1. opportunityId is in PILOT_OPPORTUNITY_IDS, AND
 *   2. every field in fields is in ROLLDOG_WRITE_FIELDS.
 *
 * Writes are Rolldog-only by hard architectural constraint (Magaya
 * security review): no Salesforce write path is permitted anywhere in
 * the codebase, including this assert. Calling assertScopedWrite with
 * a Salesforce field will fail closed because that field is not in
 * ROLLDOG_WRITE_FIELDS.
 *
 * Always appends an audit entry to crm_access_log (pass or fail).
 */
export function assertScopedWrite(
  tenantSlug: string,
  opportunityId: string,
  fields: readonly string[],
): void {
  const violation = computeViolation(
    opportunityId,
    fields,
    ROLLDOG_WRITE_FIELDS,
    "rolldog",
    "write",
  );
  emitAudit({
    tenantSlug,
    system: "rolldog",
    operation: "write",
    opportunityId,
    fields,
    allowed: violation === null,
    violationReason: violation?.reason ?? null,
    at: new Date(),
  });
  if (violation !== null) {
    throw new ScopeViolationError({
      reason: violation.reason,
      opportunityId,
      offendingField: violation.offendingField,
      operation: "write",
    });
  }
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

type Violation = { reason: string; offendingField: string | null };

function computeViolation(
  opportunityId: string,
  fields: readonly string[],
  allowlist: readonly string[],
  system: "rolldog" | "salesforce",
  operation: "read" | "write",
): Violation | null {
  const allowedIds = effectivePilotIds(system);
  const idListName =
    system === "salesforce"
      ? "SALESFORCE_PILOT_OPPORTUNITY_IDS"
      : "PILOT_OPPORTUNITY_IDS";
  if (!allowedIds.includes(opportunityId)) {
    return {
      reason:
        `opportunity_id '${opportunityId}' is not in ${idListName} ` +
        `(pilot set has ${allowedIds.length} entries)`,
      offendingField: null,
    };
  }
  const listName =
    system === "salesforce"
      ? "SALESFORCE_READ_FIELDS"
      : operation === "read"
        ? "ROLLDOG_READ_FIELDS"
        : "ROLLDOG_WRITE_FIELDS";
  for (const f of fields) {
    if (!allowlist.includes(f)) {
      return {
        reason: `field '${f}' is not in ${listName}`,
        offendingField: f,
      };
    }
  }
  return null;
}

function emitAudit(entry: CrmAccessAuditEntry): void {
  try {
    auditHook(entry);
  } catch (err) {
    // The audit hook itself must not crash a request. If a test hook
    // throws, log and move on. The assert outcome is unaffected.
    console.error(
      "[crm-scope] audit hook threw:",
      err instanceof Error ? err.message : err,
    );
  }
}
