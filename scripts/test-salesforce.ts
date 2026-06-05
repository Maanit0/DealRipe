/**
 * Salesforce read-only smoke test.
 *
 * Mints an access token via client_credentials, then fetches one
 * Opportunity by id and prints the three outcome fields. Runnable the
 * day Fernando's admin delivers credentials.
 *
 * Usage:
 *   npm run test:salesforce -- <opportunityId>
 *
 * Prereqs in .env.local:
 *   SALESFORCE_INSTANCE_URL=https://magaya.my.salesforce.com
 *   SALESFORCE_CLIENT_ID=...
 *   SALESFORCE_CLIENT_SECRET=...
 *
 * Plus the opportunity id must be in SALESFORCE_PILOT_OPPORTUNITY_IDS
 * (lib/crm-scope.ts). If it isn't, the scope assert throws before any
 * HTTP request. Use __setSalesforcePilotIdsForTesting in this script's
 * call below if you want to dry-run an id that isn't yet allowlisted.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  __setSalesforcePilotIdsForTesting,
  ScopeViolationError,
} from "../lib/crm-scope";
import {
  SalesforceAuthError,
  SalesforceConfigError,
  SalesforceError,
  SalesforceNotFoundError,
  getOpportunityOutcome,
} from "../lib/salesforce";

const PILOT_TENANT_SLUG = "magaya";
const LINE = "=".repeat(72);

async function main(): Promise<void> {
  const opportunityId = process.argv[2];
  if (!opportunityId) {
    console.error(
      "Usage: npm run test:salesforce -- <opportunityId>",
    );
    process.exit(1);
  }

  // Dev convenience: allow the id under test without editing crm-scope.
  // Comment this line out to exercise the production scope behavior.
  __setSalesforcePilotIdsForTesting([opportunityId]);

  console.log("");
  console.log(LINE);
  console.log("Salesforce read-only smoke test");
  console.log(LINE);
  console.log(`Tenant:           ${PILOT_TENANT_SLUG}`);
  console.log(`Opportunity id:   ${opportunityId}`);
  console.log("");

  try {
    const outcome = await getOpportunityOutcome(
      PILOT_TENANT_SLUG,
      opportunityId,
    );
    console.log("Outcome (the three allowlisted fields):");
    console.log(`  StageName: ${outcome.stageName}`);
    console.log(`  IsClosed:  ${outcome.isClosed}`);
    console.log(`  IsWon:     ${outcome.isWon}`);
    console.log("");
    console.log("Done.");
  } catch (err) {
    if (err instanceof ScopeViolationError) {
      console.error(`Scope violation: ${err.message}`);
    } else if (err instanceof SalesforceNotFoundError) {
      console.error(`Not found: ${err.opportunityId}`);
    } else if (err instanceof SalesforceAuthError) {
      console.error(`Auth failed: ${err.message}`);
    } else if (err instanceof SalesforceConfigError) {
      console.error(`Config error: ${err.message}`);
    } else if (err instanceof SalesforceError) {
      console.error(`Salesforce API error: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`Unexpected error: ${err.message}`);
    } else {
      console.error(`Unexpected error: ${String(err)}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
