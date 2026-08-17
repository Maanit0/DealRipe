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

import { envValue } from "./env-value";
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
  // Magaya's connected app is JWT bearer, not client_credentials: Ernesto
  // registered our certificate and set the OAuth policy to "admin-approved
  // users are pre-authorized", which is why no client secret was ever issued.
  // Prefer that flow whenever it is configured and fall back to the original
  // secret flow for any tenant still on it.
  if (jwtConfigured()) return mintViaJwt();

  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
  const clientId = process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
  if (!instanceUrl || !clientId || !clientSecret) {
    throw new SalesforceConfigError(
      "Set the JWT bearer vars (SF_CLIENT_ID, SF_USERNAME and SF_PRIVATE_KEY or SF_PRIVATE_KEY_PATH), " +
        "or the legacy SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET",
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
// JWT bearer flow (Magaya)
// ====================================================================

/**
 * The signing key. Vercel cannot read a file from the repo, so production sets
 * SF_PRIVATE_KEY with the PEM inline (newlines may be escaped as \n) while local
 * development keeps using SF_PRIVATE_KEY_PATH. Never log the return value.
 */
function privateKey(): string | null {
  const inline = process.env.SF_PRIVATE_KEY;
  if (inline && inline.trim()) return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
  const path = process.env.SF_PRIVATE_KEY_PATH;
  if (!path) return null;
  // A filesystem path in production is the same copy-paste mistake as a
  // localhost redirect URI: the file lives on a laptop and does not exist on
  // Vercel, so Salesforce auth fails with a config error that reads like an
  // outage. Say so once, loudly, rather than letting every briefing lose its
  // BDR context in silence.
  if (process.env.NODE_ENV === "production") {
    console.error(
      `[salesforce] SF_PRIVATE_KEY_PATH is set in production ("${path}"). That file does not exist here. ` +
        "Set SF_PRIVATE_KEY to the PEM contents instead and remove SF_PRIVATE_KEY_PATH from Vercel.",
    );
  }
  try {
    // Required lazily so bundling for the edge does not pull in node:fs when
    // the inline key is being used.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function jwtConfigured(): boolean {
  return Boolean(process.env.SF_CLIENT_ID && process.env.SF_USERNAME && privateKey());
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mintViaJwt(): Promise<CachedToken> {
  const loginUrl = (envValue("SF_LOGIN_URL") ?? "https://login.salesforce.com").replace(/\/$/, "");
  const clientId = process.env.SF_CLIENT_ID!;
  const username = process.env.SF_USERNAME!;
  const key = privateKey()!;
  // `aud` is the Salesforce LOGIN host even when the token endpoint is My
  // Domain. Getting this wrong returns a bare "invalid_grant" with no detail,
  // which is the usual first failure on this flow.
  const audience = process.env.SF_AUDIENCE ?? "https://login.salesforce.com";

  const { createSign } = await import("node:crypto");
  const header = b64url(JSON.stringify({ alg: "RS256" }));
  const claims = b64url(
    JSON.stringify({ iss: clientId, sub: username, aud: audience, exp: Math.floor(Date.now() / 1000) + 180 }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${b64url(signer.sign(key))}`;

  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!res.ok) throw new SalesforceAuthError(res.status, await safeReadText(res));

  const json = (await res.json()) as { access_token?: string; instance_url?: string; expires_in?: number };
  if (!json.access_token) {
    throw new SalesforceAuthError(res.status, `response missing access_token: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return {
    token: json.access_token,
    instanceUrl: (json.instance_url ?? loginUrl).replace(/\/$/, ""),
    // JWT bearer responses often omit expires_in. Fall back to the module
    // default rather than treating the token as immortal.
    expiresAt: Date.now() + (typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in * 1000 : DEFAULT_TOKEN_TTL_MS),
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
