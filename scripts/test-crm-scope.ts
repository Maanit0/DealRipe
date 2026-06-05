/**
 * CRM scope enforcement demonstration.
 *
 * Intended to be run live during the Magaya security code review.
 * Exercises lib/crm-scope.ts against the four cases that matter:
 *
 *   1. Read an allowed opportunity with allowed fields. Passes.
 *   2. Read an unknown opportunity. Throws.
 *   3. Read an off-allowlist field. Throws.
 *   4. Write to a field that is read-only (i.e. in ROLLDOG_READ_FIELDS
 *      but not in ROLLDOG_WRITE_FIELDS). Throws.
 *
 * The default audit hook is replaced with an in-memory collector so the
 * script does not touch Supabase. After the four cases run, the script
 * prints every audit entry that would have been written, so a reviewer
 * can confirm that passes and failures are both logged.
 *
 * Run with:
 *   npx tsx scripts/test-crm-scope.ts
 */

import {
  PILOT_OPPORTUNITY_IDS,
  ROLLDOG_READ_FIELDS,
  ROLLDOG_WRITE_FIELDS,
  SALESFORCE_READ_FIELDS,
  ScopeViolationError,
  __setPilotOpportunityIdsForTesting,
  assertScopedRead,
  assertScopedWrite,
  setAuditHook,
  type CrmAccessAuditEntry,
} from "../lib/crm-scope";

// ----- 1. In-memory audit hook so this script does not touch Supabase.

const auditLog: CrmAccessAuditEntry[] = [];
setAuditHook((entry) => auditLog.push(entry));

// ----- 2. Override the pilot id set for the duration of the script.

const ALLOWED_OPP = "MAGAYA_OPP_TEST_001";
__setPilotOpportunityIdsForTesting([ALLOWED_OPP]);

// ----- 3. Print header.

const line = "=".repeat(72);
console.log("");
console.log(line);
console.log("CRM scope enforcement demonstration");
console.log(line);
console.log("");
console.log(
  `Production PILOT_OPPORTUNITY_IDS: [${PILOT_OPPORTUNITY_IDS.join(", ") || "(empty)"}]`,
);
console.log(`Production read allowlist size:   ${ROLLDOG_READ_FIELDS.length}`);
console.log(`Production write allowlist size:  ${ROLLDOG_WRITE_FIELDS.length}`);
console.log(
  `Salesforce read allowlist:        [${SALESFORCE_READ_FIELDS.join(", ")}]`,
);
console.log("");
console.log(`Test override active: pilot ids = [${ALLOWED_OPP}]`);
console.log("");

// ----- 4. Run the four cases.

type Expectation = "pass" | "throw";
type CaseResult = "PASS" | "FAIL";

function runCase(
  label: string,
  expectation: Expectation,
  fn: () => void,
): CaseResult {
  process.stdout.write(`Case: ${label}\n`);
  process.stdout.write(`  Expectation: ${expectation}\n`);
  try {
    fn();
    if (expectation === "pass") {
      process.stdout.write("  Outcome:     passed (no throw)\n");
      process.stdout.write("  Result:      PASS\n\n");
      return "PASS";
    }
    process.stdout.write("  Outcome:     passed unexpectedly\n");
    process.stdout.write("  Result:      FAIL (should have thrown)\n\n");
    return "FAIL";
  } catch (err) {
    if (err instanceof ScopeViolationError) {
      process.stdout.write(`  Outcome:     ScopeViolationError\n`);
      process.stdout.write(`               reason: ${err.message}\n`);
      process.stdout.write(`               opp:    ${err.opportunityId}\n`);
      if (err.offendingField !== null) {
        process.stdout.write(
          `               field:  ${err.offendingField}\n`,
        );
      }
      if (expectation === "throw") {
        process.stdout.write("  Result:      PASS\n\n");
        return "PASS";
      }
      process.stdout.write("  Result:      FAIL (should have passed)\n\n");
      return "FAIL";
    }
    process.stdout.write(`  Outcome:     unexpected error: ${String(err)}\n`);
    process.stdout.write("  Result:      FAIL (wrong error type)\n\n");
    return "FAIL";
  }
}

const results: { label: string; result: CaseResult }[] = [];

results.push({
  label: "read allowed opportunity with allowed fields",
  result: runCase(
    "read allowed opportunity with allowed fields",
    "pass",
    () => {
      assertScopedRead(ALLOWED_OPP, ["stage", "amount", "owner", "next_step"]);
    },
  ),
});

results.push({
  label: "read unknown opportunity id",
  result: runCase("read unknown opportunity id", "throw", () => {
    assertScopedRead("UNKNOWN_OPP_999", ["stage"]);
  }),
});

results.push({
  label: "read off-allowlist field",
  result: runCase("read off-allowlist field", "throw", () => {
    // 'email_body' is not in ROLLDOG_READ_FIELDS. The first field is
    // allowed, the second is not. The assert must catch the second.
    assertScopedRead(ALLOWED_OPP, ["stage", "email_body"]);
  }),
});

results.push({
  label: "write to a read-only field (stage is readable, not writable)",
  result: runCase(
    "write to a read-only field (stage is readable, not writable)",
    "throw",
    () => {
      // 'stage' is in ROLLDOG_READ_FIELDS but NOT in ROLLDOG_WRITE_FIELDS.
      assertScopedWrite(ALLOWED_OPP, ["stage"]);
    },
  ),
});

// ----- 5. Print the in-memory audit log so the reviewer can see that
//          both passes and failures get an entry.

console.log(line);
console.log("Audit entries (would have been written to crm_access_log):");
console.log(line);
for (const e of auditLog) {
  const fieldStr = `[${e.fields.join(", ")}]`;
  const verdict = e.allowed ? "ALLOWED" : "DENIED ";
  const reason = e.violationReason ? ` :: ${e.violationReason}` : "";
  console.log(
    `  ${verdict}  ${e.operation.toUpperCase().padEnd(5)} ${e.opportunityId.padEnd(20)} ${fieldStr}${reason}`,
  );
}
console.log("");

// ----- 6. Verdict.

const passed = results.filter((r) => r.result === "PASS").length;
const total = results.length;
console.log(line);
console.log(`Cases: ${passed} of ${total} passed`);
console.log(`Audit entries written: ${auditLog.length}`);
console.log(line);
console.log("");

if (passed !== total) {
  process.exit(1);
}
