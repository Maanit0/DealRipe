/**
 * Tests the per-deal write authorization added for auto-linked deals
 * (runWithAuthorizedOpportunities in lib/crm-scope.ts). Proves it is:
 *   - fail-closed by default (an opp not in the static list is denied),
 *   - scoped to exactly the authorized opp (a different opp is still denied),
 *   - request-scoped (authorization is gone after the wrapper returns),
 *   - not a field bypass (write-field checks still apply),
 *   - preserved across awaits (works in real async write-back).
 *
 *   npx tsx scripts/test-writeback-scope.ts
 */

import {
  ScopeViolationError,
  __setPilotOpportunityIdsForTesting,
  assertScopedWrite,
  runWithAuthorizedOpportunities,
  setAuditHook,
  type CrmAccessAuditEntry,
} from "../lib/crm-scope";

const auditLog: CrmAccessAuditEntry[] = [];
setAuditHook((e) => auditLog.push(e));

const BASE_OPP = "STATIC_ALLOWED_OPP";
const AUTO_OPP = "AUTO_LINKED_OPP";
const OTHER_OPP = "SOME_OTHER_OPP";
__setPilotOpportunityIdsForTesting([BASE_OPP]);

let pass = 0;
let fail = 0;

function expectThrow(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  FAIL  ${label} (expected a throw, none happened)`);
    fail += 1;
  } catch (err) {
    if (err instanceof ScopeViolationError) {
      console.log(`  PASS  ${label}`);
      pass += 1;
    } else {
      console.log(`  FAIL  ${label} (wrong error: ${String(err)})`);
      fail += 1;
    }
  }
}
function expectOk(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.log(`  FAIL  ${label} (unexpected throw: ${String(err)})`);
    fail += 1;
  }
}

console.log("\nPer-deal write authorization (runWithAuthorizedOpportunities):\n");

// 1. Default fail-closed: AUTO_OPP is not in the static list, no wrapper.
expectThrow("auto opp denied by default (fail-closed)", () =>
  assertScopedWrite("magaya", AUTO_OPP, ["budget"]),
);

// 2. Authorized inside the wrapper.
expectOk("auto opp allowed inside runWithAuthorizedOpportunities", () =>
  runWithAuthorizedOpportunities([AUTO_OPP], () =>
    assertScopedWrite("magaya", AUTO_OPP, ["budget"]),
  ),
);

// 3. Authorization is gone after the wrapper returns.
expectThrow("auto opp denied again after the wrapper (request-scoped)", () =>
  assertScopedWrite("magaya", AUTO_OPP, ["budget"]),
);

// 4. Only the authorized opp is allowed, not a different one.
expectThrow("a different opp is still denied inside the wrapper", () =>
  runWithAuthorizedOpportunities([AUTO_OPP], () =>
    assertScopedWrite("magaya", OTHER_OPP, ["budget"]),
  ),
);

// 5. Field checks still apply (authorization is opp-level, not a field bypass).
expectThrow("non-writable field still denied inside the wrapper", () =>
  runWithAuthorizedOpportunities([AUTO_OPP], () =>
    assertScopedWrite("magaya", AUTO_OPP, ["stage"]),
  ),
);

// 6. The static allowlisted opp still works with no wrapper (unchanged).
expectOk("static allowlisted opp still writes without a wrapper", () =>
  assertScopedWrite("magaya", BASE_OPP, ["budget"]),
);

// 7. Authorization survives awaits (how real write-back uses it).
async function asyncCase(): Promise<void> {
  await runWithAuthorizedOpportunities([AUTO_OPP], async () => {
    await Promise.resolve();
    assertScopedWrite("magaya", AUTO_OPP, ["budget"]);
  });
}

asyncCase()
  .then(() => {
    console.log("  PASS  authorization preserved across awaits");
    pass += 1;
    finish();
  })
  .catch((err) => {
    console.log(`  FAIL  authorization lost across awaits (${String(err)})`);
    fail += 1;
    finish();
  });

function finish(): void {
  console.log(`\n${pass} passed, ${fail} failed. (${auditLog.length} audit entries)\n`);
  if (fail > 0) process.exit(1);
}
