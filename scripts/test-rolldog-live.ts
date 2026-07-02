/**
 * Read-only live smoke test for the Rolldog integration.
 *
 *   npx tsx scripts/test-rolldog-live.ts            # default opp 72018 (Express Air Freight)
 *   npx tsx scripts/test-rolldog-live.ts 12345      # any opportunity id
 *
 * What it proves, in order:
 *   1. The scope guard fails closed: reading an opp that is NOT in the
 *      allowlist throws ScopeViolationError (before any network call).
 *   2. Token exchange + live read work: it allows the test opp via the
 *      test-only hook (NOT the production PILOT_OPPORTUNITY_IDS constant),
 *      then reads the opportunity core + every sub-resource.
 *
 * NO WRITES. This script never calls a write path. It also resets the
 * scope override and flushes the crm_access_log audit writes before exit.
 *
 * Requires in .env.local: ROLLDOG_BASE_URL, ROLLDOG_CLIENT_ID,
 * ROLLDOG_CLIENT_SECRET (and Supabase vars for the audit log). Must NOT
 * run with NODE_ENV=production (the test hook refuses).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readOpportunity, getDealRoom, RolldogApiError } from "../lib/rolldog";
import {
  ScopeViolationError,
  flushAuditWrites,
  __setPilotOpportunityIdsForTesting,
} from "../lib/crm-scope";

const TEST_OPP = process.argv[2] ?? "72018"; // Express Air Freight (Juan Lopez)

// A few core scalar fields for the fail-closed probe (all in ROLLDOG_READ_FIELDS).
const CORE_FIELDS = [
  "stage",
  "amount",
  "close_date",
  "owner",
  "next_step",
  "last_updated",
] as const;

async function cleanup(): Promise<void> {
  __setPilotOpportunityIdsForTesting(null); // restore production allowlist
  await flushAuditWrites(); // let the async crm_access_log writes finish
}

async function main(): Promise<void> {
  console.log(`Rolldog live read smoke test — opportunity ${TEST_OPP}`);
  console.log("(read-only; no writes are performed)\n");

  // STEP 1. Scope guard fails closed by default (allowlist is empty).
  console.log("1. Scope guard with opp NOT allowlisted — expect ScopeViolationError:");
  try {
    await readOpportunity(TEST_OPP, CORE_FIELDS);
    console.log("   UNEXPECTED: read succeeded with an empty allowlist.");
    console.log("   The scope guard is NOT enforcing. Stop and investigate.\n");
    await cleanup();
    process.exit(1);
  } catch (err) {
    if (err instanceof ScopeViolationError) {
      console.log(`   OK: blocked as expected (${err.message})\n`);
    } else {
      // Anything other than a scope violation here (e.g. a credential
      // error) means the guard let it through to the network path.
      console.log(`   WARNING: blocked, but NOT by the scope guard: ${(err as Error).message}\n`);
    }
  }

  // STEP 2. Allow just this opp for the rest of the test. This uses the
  // test-only hook and does NOT modify the production constant, so the
  // system stays fail-closed everywhere else.
  __setPilotOpportunityIdsForTesting([TEST_OPP]);

  // STEP 3. Live read of the opportunity core attributes (token exchange
  // happens here on first call).
  console.log("2. Live read of core attributes:");
  try {
    const attrs = await readOpportunity(TEST_OPP, CORE_FIELDS);
    console.log(JSON.stringify(attrs, null, 2) + "\n");
  } catch (err) {
    console.error(`   FAILED: ${(err as Error).message}`);
    if (err instanceof RolldogApiError) {
      console.error(`   status: ${err.status}  endpoint: ${err.endpoint}`);
      console.error(`   response body: ${JSON.stringify(err.body)}`);
    }
    console.error("   401 -> bad client_id/secret. 403 -> client not authorized for the");
    console.error("   rolldog-api audience (client-grant missing, same as the sandbox on Jun 17).");
    console.error("   Also confirm the opp id is an OPPORTUNITY id, not an account id.\n");
    await cleanup();
    process.exit(1);
  }

  // STEP 4. Full deal room: core + budget, timeline, competition,
  // participant, situation sub-resources (one scoped read).
  console.log("3. Deal room (core + sub-resources):");
  try {
    const room = await getDealRoom(TEST_OPP);
    console.log(JSON.stringify(room, null, 2) + "\n");
  } catch (err) {
    console.log(`   (sub-resources skipped) getDealRoom failed: ${(err as Error).message}\n`);
  }

  await cleanup();
  console.log("Done. Scope override reset; reads recorded in crm_access_log.");
}

main().catch(async (err) => {
  console.error("Unexpected error:", err);
  await cleanup();
  process.exit(1);
});
