/**
 * Salesforce read-only client (Magaya pilot, outcome labeling only).
 *
 * Scope is exactly three fields on the pilot opportunities:
 *   StageName, IsClosed, IsWon
 *
 * Read-only is a hard architectural line agreed in the Magaya security
 * review. There is no exported write function in this module, and
 * assertScopedWrite in lib/crm-scope.ts has no Salesforce branch — a
 * caller that tried to write Salesforce fields would fail closed at
 * the scope layer before any HTTP could happen.
 *
 * Auth: OAuth 2.0 client_credentials. If Magaya's admin issues a
 * different grant (JWT bearer or username-password), the swap is one
 * function: mintAccessToken(). Everything else (the cached token,
 * getOpportunityOutcome, the error types) stays unchanged.
 *
 * Endpoint reference:
 *   POST {SALESFORCE_INSTANCE_URL}/services/oauth2/token   (client_credentials)
 *   GET  {SALESFORCE_INSTANCE_URL}/services/data/v60.0/sobjects/Opportunity/{id}?fields=StageName,IsClosed,IsWon
 */

import { assertScopedRead } from "./crm-scope";

const API_VERSION = "v60.0";
const TOKEN_TTL_SAFETY_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour, conservative

// ====================================================================
// Errors
// ====================================================================

export class SalesforceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesforceConfigError";
  }
}

export class SalesforceAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyExcerpt: string,
  ) {
    super(
      `Salesforce auth failed (HTTP ${status}): ${truncate(bodyExcerpt, 300)}`,
    );
    this.name = "SalesforceAuthError";
  }
}

export class SalesforceNotFoundError extends Error {
  constructor(public readonly opportunityId: string) {
    super(`Salesforce Opportunity '${opportunityId}' not found`);
    this.name = "SalesforceNotFoundError";
  }
}

export class SalesforceError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly bodyExcerpt: string,
  ) {
    super(
      `Salesforce API ${status} on ${endpoint}: ${truncate(bodyExcerpt, 300)}`,
    );
    this.name = "SalesforceError";
  }
}

// ====================================================================
// Lazy client (token cache)
// ====================================================================

type CachedToken = {
  token: string;
  instanceUrl: string;
  expiresAt: number;
};

let _cached: CachedToken | null = null;

/**
 * Lazy singleton accessor: returns a cached access token if it has more
 * than 60s of life left, otherwise mints a fresh one. The token is held
 * only in memory; it is never persisted.
 */
export async function getSalesforceClient(): Promise<{
  token: string;
  instanceUrl: string;
}> {
  if (_cached && _cached.expiresAt > Date.now() + TOKEN_TTL_SAFETY_MARGIN_MS) {
    return { token: _cached.token, instanceUrl: _cached.instanceUrl };
  }
  _cached = await mintAccessToken();
  return { token: _cached.token, instanceUrl: _cached.instanceUrl };
}

/**
 * Exported for test-salesforce.ts. Production callers should use
 * getSalesforceClient(), which caches.
 */
export async function mintAccessToken(): Promise<CachedToken> {
  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
  const clientId = process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
  if (!instanceUrl || !clientId || !clientSecret) {
    throw new SalesforceConfigError(
      "SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID, and SALESFORCE_CLIENT_SECRET must be set",
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(`${instanceUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await safeReadText(res);
    throw new SalesforceAuthError(res.status, text);
  }
  const json = (await res.json()) as {
    access_token?: string;
    instance_url?: string;
    expires_in?: number;
    token_type?: string;
  };
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new SalesforceAuthError(
      res.status,
      `response missing access_token: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  const resolvedInstance =
    typeof json.instance_url === "string" && json.instance_url
      ? json.instance_url
      : instanceUrl;
  const ttlMs =
    typeof json.expires_in === "number" && json.expires_in > 0
      ? json.expires_in * 1000
      : DEFAULT_TOKEN_TTL_MS;
  return {
    token: json.access_token,
    instanceUrl: resolvedInstance,
    expiresAt: Date.now() + ttlMs,
  };
}

// ====================================================================
// Public API
// ====================================================================

export type OpportunityOutcome = {
  stageName: string;
  isClosed: boolean;
  isWon: boolean;
};

/**
 * Read the three outcome fields for a single Salesforce Opportunity.
 *
 * Order of operations:
 *   1. assertScopedRead(tenantSlug, opportunityId, ['StageName','IsClosed','IsWon'])
 *      runs BEFORE any network code. Auto-detects the Salesforce path,
 *      validates against SALESFORCE_PILOT_OPPORTUNITY_IDS, appends an
 *      audit row to crm_access_log.
 *   2. GET /services/data/v60.0/sobjects/Opportunity/{id}?fields=...
 *      with the cached bearer token.
 *   3. On 401, the cached token is invalidated and the call retries once.
 *   4. On 404, throw SalesforceNotFoundError.
 *
 * Returns the three fields as a plain typed object. Never returns extra
 * Salesforce metadata.
 */
export async function getOpportunityOutcome(
  tenantSlug: string,
  opportunityExternalId: string,
): Promise<OpportunityOutcome> {
  // STEP 1: enforce scope BEFORE any network code.
  assertScopedRead(tenantSlug, opportunityExternalId, [
    "StageName",
    "IsClosed",
    "IsWon",
  ]);

  // STEP 2: network call.
  return fetchOutcomeWithRetry(opportunityExternalId);
}

async function fetchOutcomeWithRetry(
  opportunityExternalId: string,
): Promise<OpportunityOutcome> {
  const url = (instanceUrl: string) =>
    `${instanceUrl}/services/data/${API_VERSION}/sobjects/Opportunity/${encodeURIComponent(
      opportunityExternalId,
    )}?fields=StageName,IsClosed,IsWon`;

  const first = await getSalesforceClient();
  let res = await fetch(url(first.instanceUrl), {
    headers: {
      Authorization: `Bearer ${first.token}`,
      Accept: "application/json",
    },
  });

  if (res.status === 401) {
    // Stale cached token. Invalidate and retry once.
    _cached = null;
    const refreshed = await getSalesforceClient();
    res = await fetch(url(refreshed.instanceUrl), {
      headers: {
        Authorization: `Bearer ${refreshed.token}`,
        Accept: "application/json",
      },
    });
  }

  if (res.status === 404) {
    throw new SalesforceNotFoundError(opportunityExternalId);
  }
  if (!res.ok) {
    const text = await safeReadText(res);
    if (res.status === 401 || res.status === 403) {
      throw new SalesforceAuthError(res.status, text);
    }
    throw new SalesforceError(
      res.status,
      "/sobjects/Opportunity/{id}",
      text,
    );
  }

  const json = (await res.json()) as Record<string, unknown>;
  return parseOpportunity(json);
}

function parseOpportunity(raw: Record<string, unknown>): OpportunityOutcome {
  const stageName = typeof raw.StageName === "string" ? raw.StageName : "";
  const isClosed = raw.IsClosed === true;
  const isWon = raw.IsWon === true;
  return { stageName, isClosed, isWon };
}

// ====================================================================
// Internals
// ====================================================================

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(response body unreadable)";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}
