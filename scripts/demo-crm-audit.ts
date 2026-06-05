/**
 * End-to-end CRM access audit demo.
 *
 * Runs the same four scope-check cases as scripts/test-crm-scope.ts,
 * but with the DEFAULT Supabase-backed audit hook left in place. After
 * the cases run and the in-flight audit writes flush, the script
 * queries crm_access_log for the magaya tenant and prints the latest
 * rows so a reviewer can see live audit data instead of an in-memory
 * collector.
 *
 * Prereqs (the script verifies both and exits with a clear message if
 * either is missing):
 *
 *   1. The crm_access_log table exists (apply the delta from
 *      supabase/schema.sql and supabase/rls.sql to the live project).
 *   2. The magaya tenant row exists. Create it with:
 *        npm run seed:magaya
 *
 * Run: npm run demo:crm-audit
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  ScopeViolationError,
  __setPilotOpportunityIdsForTesting,
  assertScopedRead,
  assertScopedWrite,
  flushAuditWrites,
} from "../lib/crm-scope";
import { supabaseAdmin } from "../lib/supabase";

const MAGAYA_SLUG = "magaya";
const ALLOWED_OPP = "MAGAYA_OPP_TEST_001";
const LINE = "=".repeat(80);

async function main(): Promise<void> {
  // ----- 0. Preflight: confirm magaya tenant exists. -----
  // If it does not, the default audit hook will resolve "magaya" -> null
  // and the inserts will fail loudly. Better to catch it up front with a
  // clear remediation instruction.

  const db = supabaseAdmin();
  const tenant = await db
    .from("tenants")
    .select("id, slug, name")
    .eq("slug", MAGAYA_SLUG)
    .maybeSingle();

  if (tenant.error) {
    console.error(`Failed to query tenants: ${tenant.error.message}`);
    process.exit(1);
  }
  if (!tenant.data) {
    console.error(
      `Tenant '${MAGAYA_SLUG}' is missing. Run \`npm run seed:magaya\` first, then re-run this script.`,
    );
    process.exit(1);
  }

  console.log("");
  console.log(LINE);
  console.log("CRM access enforcement, live audit demo");
  console.log(LINE);
  console.log("");
  console.log(`Tenant resolved: ${tenant.data.name}`);
  console.log(`  slug: ${tenant.data.slug}`);
  console.log(`  id:   ${tenant.data.id}`);
  console.log("");
  console.log(`Test override: pilot ids = [${ALLOWED_OPP}]`);
  console.log("");

  __setPilotOpportunityIdsForTesting([ALLOWED_OPP]);

  // ----- 1. Run the four cases. The default audit hook fires for each. -----

  const cases: Array<{
    label: string;
    expectation: "pass" | "throw";
    run: () => void;
  }> = [
    {
      label: "read allowed opportunity with allowed fields",
      expectation: "pass",
      run: () =>
        assertScopedRead(
          "magaya",
          ALLOWED_OPP,
          ["stage", "amount", "owner", "next_step"],
        ),
    },
    {
      label: "read unknown opportunity id",
      expectation: "throw",
      run: () => assertScopedRead("magaya", "UNKNOWN_OPP_999", ["stage"]),
    },
    {
      label: "read off-allowlist field (email_body)",
      expectation: "throw",
      run: () =>
        assertScopedRead("magaya", ALLOWED_OPP, ["stage", "email_body"]),
    },
    {
      label: "write to a read-only field (stage)",
      expectation: "throw",
      run: () => assertScopedWrite("magaya", ALLOWED_OPP, ["stage"]),
    },
  ];

  let passed = 0;
  for (const c of cases) {
    process.stdout.write(`Case: ${c.label}\n`);
    process.stdout.write(`  Expectation: ${c.expectation}\n`);
    try {
      c.run();
      if (c.expectation === "pass") {
        process.stdout.write("  Outcome:     passed (no throw)\n");
        process.stdout.write("  Result:      PASS\n\n");
        passed++;
      } else {
        process.stdout.write("  Outcome:     passed unexpectedly\n");
        process.stdout.write("  Result:      FAIL (should have thrown)\n\n");
      }
    } catch (err) {
      if (err instanceof ScopeViolationError) {
        process.stdout.write(`  Outcome:     ScopeViolationError\n`);
        process.stdout.write(`               reason: ${err.message}\n`);
        process.stdout.write(`               opp:    ${err.opportunityId}\n`);
        if (err.offendingField !== null) {
          process.stdout.write(`               field:  ${err.offendingField}\n`);
        }
        if (c.expectation === "throw") {
          process.stdout.write("  Result:      PASS\n\n");
          passed++;
        } else {
          process.stdout.write("  Result:      FAIL (should have passed)\n\n");
        }
      } else {
        process.stdout.write(
          `  Outcome:     unexpected error: ${String(err)}\n`,
        );
        process.stdout.write("  Result:      FAIL (wrong error type)\n\n");
      }
    }
  }

  // ----- 2. Wait for the default hook's in-flight writes to settle. -----
  //
  // Without this, the query below could fire before the inserts land
  // and the table would be empty even though the writes succeed a
  // moment later. flushAuditWrites resolves once Promise.allSettled
  // returns over the in-flight set.

  console.log("Flushing in-flight audit writes...");
  await flushAuditWrites();
  console.log("Flush complete.\n");

  // ----- 3. Query the live crm_access_log for the magaya tenant. -----

  const recent = await db
    .from("crm_access_log")
    .select(
      "created_at, operation, opportunity_external_id, allowed, violation_reason",
    )
    .eq("tenant_id", tenant.data.id)
    .order("created_at", { ascending: false })
    .limit(10);

  if (recent.error) {
    console.error(
      `Failed to query crm_access_log: ${recent.error.message}. ` +
        `If the table does not exist, apply the crm_access_log delta from ` +
        `supabase/schema.sql and supabase/rls.sql to the project.`,
    );
    process.exit(1);
  }

  // ----- 4. Print the rows as a fixed-width table. -----

  console.log(LINE);
  console.log(
    `Last ${recent.data.length} crm_access_log entries for tenant '${MAGAYA_SLUG}' (newest first)`,
  );
  console.log(LINE);

  if (recent.data.length === 0) {
    console.log("(no rows)");
    console.log("");
    console.log(
      "Expected four rows from this run. If the table is empty, scroll up for ",
    );
    console.log(
      "any [crm-scope] audit write failed messages from the default hook.",
    );
    process.exit(1);
  }

  const headers = [
    "created_at",
    "op",
    "opportunity_external_id",
    "allowed",
    "violation_reason",
  ];
  const rows = recent.data.map((r) => [
    String(r.created_at).replace("T", " ").replace(/\.\d+\+00:00$/, "Z"),
    String(r.operation).toUpperCase(),
    String(r.opportunity_external_id),
    r.allowed ? "ALLOWED" : "DENIED",
    r.violation_reason ?? "",
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  );

  const pad = (s: string, w: number) => s.padEnd(w);
  const sep = widths.map((w) => "-".repeat(w)).join("  ");

  console.log(headers.map((h, i) => pad(h, widths[i])).join("  "));
  console.log(sep);
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i])).join("  "));
  }
  console.log("");

  console.log(LINE);
  console.log(
    `Scope-check cases: ${passed} of ${cases.length} passed | log rows returned: ${recent.data.length}`,
  );
  console.log(LINE);
  console.log("");

  if (passed !== cases.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
