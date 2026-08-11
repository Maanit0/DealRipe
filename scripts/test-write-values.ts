/**
 * Does a Rolldog write record what it actually wrote?
 *
 * The Activity view used to show Rolldog content by re-running the writer in dry
 * run at page load. That is a re-derivation, not a record: it drifts as the deal
 * changes and comes back empty when the deal no longer composes anything, which
 * is why an activity-only write showed a blank panel labelled "Exact content
 * written". recordWrite fixes it by carrying the label/value pairs to the audit
 * row the assert already emits.
 *
 * Two things can break in a way the type checker cannot see, and both are here:
 *
 *   1. The values are carried on an AsyncLocalStorage, and the assert that reads
 *      them runs inside an async function. If the context did not propagate, the
 *      values would silently be absent and the panel would be empty again with
 *      nothing in the logs.
 *   2. The audit row is held until the request settles, so a rejected write is
 *      not recorded as content that landed. If the settle promise never resolved
 *      the audit row would never be inserted at all.
 *
 * Uses an in-memory audit hook, so this touches neither Supabase nor Rolldog.
 *
 *   npx tsx scripts/test-write-values.ts
 *
 * READ ONLY. Writes nothing anywhere.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  assertScopedWrite,
  recordWrite,
  resetAuditHook,
  runWithAuthorizedOpportunities,
  setAuditHook,
  type CrmAccessAuditEntry,
} from "../lib/crm-scope";

const OPP = "999999-test-not-a-real-opportunity";

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** Stands in for lib/rolldog.ts: asserts first, then does async work, exactly
 *  like every real write function. `throws` simulates a 422. */
async function fakeRolldogWrite(throws: boolean): Promise<void> {
  assertScopedWrite("magaya", OPP, ["situation"]);
  await new Promise((r) => setTimeout(r, 5));
  if (throws) throw new Error("422 Unprocessable Entity: close-date-validator is required");
}

async function main(): Promise<void> {
  const seen: CrmAccessAuditEntry[] = [];
  setAuditHook((e) => {
    seen.push(e);
  });

  const values = [{ label: "Situation › Why looking now", value: "Peak season starts in October.", mode: "overwrite" }];

  console.log("");
  console.log("A permitted write that succeeds");
  await runWithAuthorizedOpportunities([OPP], () => recordWrite(values, () => fakeRolldogWrite(false)));
  const ok = seen.at(-1);
  check("one audit entry emitted", seen.length === 1, `got ${seen.length}`);
  check("entry is allowed", ok?.allowed === true);
  check("values reached the audit entry", (ok?.fieldValues?.length ?? 0) === 1, `got ${ok?.fieldValues?.length ?? 0}`);
  check("value text is intact", ok?.fieldValues?.[0]?.value === values[0].value);
  check("a settle promise is attached", !!ok?.settled);
  const outcome = ok?.settled ? await ok.settled : null;
  check("settled resolves ok", outcome?.ok === true);

  console.log("");
  console.log("A permitted write that the CRM rejects");
  seen.length = 0;
  let threw: string | null = null;
  try {
    await runWithAuthorizedOpportunities([OPP], () => recordWrite(values, () => fakeRolldogWrite(true)));
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  const bad = seen.at(-1);
  check("the caller still sees the error", threw !== null, threw ?? "");
  check("an audit entry was still emitted", seen.length === 1);
  const outcome2 = bad?.settled ? await bad.settled : null;
  check("settled resolves as a failure", outcome2 !== null && outcome2.ok === false);
  check(
    "the failure carries the CRM's message",
    outcome2 !== null && !outcome2.ok && /422/.test(outcome2.error),
    outcome2 && !outcome2.ok ? outcome2.error : "",
  );
  console.log(
    "        (the default hook drops field_values on this row, so a rejected write",
  );
  console.log("         is never displayed as content that landed)");

  console.log("");
  console.log("A refused write carries no values");
  seen.length = 0;
  // No runWithAuthorizedOpportunities, so the opp is not in scope.
  try {
    await recordWrite(values, () => fakeRolldogWrite(false));
  } catch {
    // expected: ScopeViolationError
  }
  const refused = seen.at(-1);
  check("entry is a refusal", refused?.allowed === false);
  check("no values on a refusal", (refused?.fieldValues?.length ?? 0) === 0);

  console.log("");
  console.log("A write with no recordWrite wrapper behaves as before");
  seen.length = 0;
  await runWithAuthorizedOpportunities([OPP], () => fakeRolldogWrite(false));
  const plain = seen.at(-1);
  check("still audited", plain?.allowed === true);
  check("no values", plain?.fieldValues === undefined);
  check("no settle promise, so the hook does not wait", plain?.settled === undefined);

  resetAuditHook();
  console.log("");
  console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
  console.log("");
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
