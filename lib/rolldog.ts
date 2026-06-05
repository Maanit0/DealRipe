/**
 * Rolldog CRM client scaffold.
 *
 * Every public function in this file follows the same three-step pattern,
 * in this exact order:
 *
 *   1. Call the assert from lib/crm-scope before doing anything else.
 *      If the assert throws, the function throws and no network code runs.
 *   2. Confirm credentials are present. The env var names are visible here
 *      so a security reviewer can see the credential path; the actual
 *      secret values live only in Vercel project env or a kickoff secrets
 *      vault.
 *   3. Stub. Until Jeff sends Swagger docs (June 9 call), every function
 *      throws "Rolldog credentials pending". When credentials and Swagger
 *      land, the real HTTP code replaces the stub below the assert.
 *
 * Do not move the assert. Do not catch ScopeViolationError here. Do not
 * add a code path that calls the network without going through an assert.
 */

import { assertScopedRead, assertScopedWrite } from "./crm-scope";

const PILOT_TENANT_SLUG = "magaya";

const PENDING_MESSAGE =
  "Rolldog credentials pending (Swagger docs expected from Jeff, June 9 call)";

/**
 * Read a Rolldog opportunity. Returns the requested fields only.
 *
 * Throws ScopeViolationError if opportunityId is not in
 * PILOT_OPPORTUNITY_IDS, or if any field is not in ROLLDOG_READ_FIELDS.
 *
 * Throws RolldogPendingError (current state) until credentials and
 * Swagger arrive.
 */
export async function readOpportunity(
  opportunityId: string,
  fields: readonly string[],
): Promise<Record<string, unknown>> {
  // STEP 1. Enforce scope. Throws ScopeViolationError on violation. Also
  // appends an entry to crm_access_log via the audit hook.
  assertScopedRead(PILOT_TENANT_SLUG, opportunityId, fields);

  // STEP 2. Credential path. Reading these here documents which env vars
  // the production call will use. They are intentionally not logged.
  const config = readRolldogConfig();

  // STEP 3. Stub. The real implementation, when Swagger arrives, will:
  //
  //   const token = await oauthClientCredentialsExchange(config);
  //   const res = await fetch(
  //     `${config.baseUrl}/v1/opportunities/${encodeURIComponent(opportunityId)}` +
  //       `?fields=${fields.join(',')}`,
  //     { headers: { Authorization: `Bearer ${token}` } }
  //   );
  //   return await res.json();
  //
  // Today, throw. Including the config object in the error suppression
  // ensures the type system keeps us honest that config is read, not
  // dropped, even though we do not transmit it.
  void config;
  throw new RolldogPendingError(opportunityId, "read");
}

/**
 * Write to a Rolldog opportunity. Only the fields named as keys of
 * `updates` are written; every key is validated against
 * ROLLDOG_WRITE_FIELDS before any network code runs.
 *
 * Throws ScopeViolationError on violation.
 * Throws RolldogPendingError (current state) until credentials and
 * Swagger arrive.
 */
export async function writeOpportunity(
  opportunityId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  // STEP 1. Enforce scope.
  assertScopedWrite(PILOT_TENANT_SLUG, opportunityId, Object.keys(updates));

  // STEP 2. Credential path.
  const config = readRolldogConfig();

  // STEP 3. Stub. The real PATCH call will look like:
  //
  //   const token = await oauthClientCredentialsExchange(config);
  //   await fetch(
  //     `${config.baseUrl}/v1/opportunities/${encodeURIComponent(opportunityId)}`,
  //     {
  //       method: 'PATCH',
  //       headers: {
  //         Authorization: `Bearer ${token}`,
  //         'Content-Type': 'application/json',
  //       },
  //       body: JSON.stringify(updates),
  //     }
  //   );
  void config;
  throw new RolldogPendingError(opportunityId, "write");
}

// ---------------------------------------------------------------------
// Config and errors
// ---------------------------------------------------------------------

type RolldogConfig = {
  baseUrl: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
};

function readRolldogConfig(): RolldogConfig {
  return {
    baseUrl: process.env.ROLLDOG_BASE_URL,
    clientId: process.env.ROLLDOG_CLIENT_ID,
    clientSecret: process.env.ROLLDOG_CLIENT_SECRET,
  };
}

/**
 * Thrown by every Rolldog call until the integration is wired. Includes
 * the operation and opportunity id so the caller knows what was blocked.
 * Does not include credential values.
 */
export class RolldogPendingError extends Error {
  public readonly opportunityId: string;
  public readonly operation: "read" | "write";

  constructor(opportunityId: string, operation: "read" | "write") {
    super(PENDING_MESSAGE);
    this.name = "RolldogPendingError";
    this.opportunityId = opportunityId;
    this.operation = operation;
  }
}
