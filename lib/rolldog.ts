/**
 * Rolldog CRM client.
 *
 * Every public function follows the same three-step pattern, in this
 * exact order:
 *
 *   1. Call the assert from lib/crm-scope. assertScopedRead or
 *      assertScopedWrite, with snake_case LOGICAL field names (never
 *      kebab-case API attribute names). If the assert throws, no
 *      network code runs.
 *   2. readRolldogConfig() resolves env vars (base URL, OAuth URL,
 *      audience, client id/secret). ensureCredentials throws
 *      RolldogPendingError if any required credential is absent.
 *   3. Real HTTP. JSON:API against api.rolldog.com, Bearer token from
 *      the in-memory token manager.
 *
 * Do not move the assert. Do not catch ScopeViolationError here. Do not
 * add a code path that calls the network without going through an
 * assert. Free-text notes fields are tagged with "[DealRipe]" so the
 * audit marker is visible inside Rolldog itself.
 *
 * Sub-resource model (per the live sandbox, opp 80949):
 *   - Sub-objects (budget, timeline, competition, participant,
 *     situation) are SEPARATE resources with their own ids, reached via
 *     /opportunities/{id}/opportunity-<sub>. `include=` 500s server-
 *     side; never use it. Writes PATCH the sub-resource by ITS OWN id,
 *     discovered by GETting it first.
 *   - The opportunity `next-step` attribute is accepted-but-silently-
 *     ignored (derived). The logical "next_step" write maps to the
 *     opportunity `notes` scalar instead.
 */

import { assertScopedRead, assertScopedWrite } from "./crm-scope";

const PILOT_TENANT_SLUG = "magaya";

const PENDING_MESSAGE =
  "Rolldog credentials pending: ROLLDOG_BASE_URL, ROLLDOG_CLIENT_ID, and ROLLDOG_CLIENT_SECRET must all be set";

const DEALRIPE_TAG = "[DealRipe]";

/**
 * Read a Rolldog opportunity. `fields` is the set of snake_case LOGICAL
 * read fields the caller intends to consume; the assert enforces that
 * each one is in ROLLDOG_READ_FIELDS and the opportunity is in
 * PILOT_OPPORTUNITY_IDS.
 *
 * Returns the opportunity's JSON:API attributes object (kebab-case
 * keys, as the Rolldog API serializes them). Callers translate at
 * their boundary.
 *
 * Throws ScopeViolationError on assert failure.
 * Throws RolldogPendingError when any required credential env var is
 * absent. Throws RolldogApiError on non-2xx.
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
  ensureCredentials(config, opportunityId, "read");

  // STEP 3. Real HTTP. GET /opportunities/{id}, return its JSON:API
  // attributes. `include=` is intentionally NOT used (it 500s on the
  // sandbox); callers wanting sub-objects call getSubResource() or
  // getDealRoom().
  return getOpportunityCore(config, opportunityId);
}

/**
 * Populate the in-memory token cache once, before a burst of parallel reads.
 * Without this, N reads fired at the same instant on a cold process each fetch
 * a token concurrently; the OAuth endpoint throttles the herd and most reads
 * fail. Warming first means the burst shares one cached token. Best-effort:
 * callers should catch, since a missing credential legitimately throws.
 */
export async function prewarmRolldogToken(): Promise<void> {
  const config = readRolldogConfig();
  await getAccessToken(config, false);
}

/**
 * Write to a Rolldog opportunity at the opportunity-scalar level
 * (i.e. attributes that live directly on /opportunities/{id}, not on
 * a sub-resource). `updates` keys are snake_case LOGICAL field names
 * from ROLLDOG_WRITE_FIELDS; the assert enforces the coarse field
 * allowlist before any HTTP runs.
 *
 * Only one logical field is genuinely writable at the opportunity
 * scalar today (see Rolldog API note in the file header):
 *
 *   next_step  ->  PATCH attributes.notes
 *                  (the kebab `next-step` attribute is accepted but
 *                  silently ignored, so we route to `notes` instead).
 *
 * Every other coarse logical field (budget, timeline, people,
 * competitors) lives on a sub-resource; callers must use the
 * sub-resource methods (writeBudget, writeTimeline,
 * writeCompetitionNotes, addCompetitor, writeParticipantNotes,
 * addParticipantContact). Passing one of those keys here throws so we
 * never audit-claim a write that didn't happen.
 *
 * stage_gate_checklist_items is in the allowlist but its sandbox
 * write path has not been confirmed with Jeff; calling it throws a
 * clear TODO error so it fails loudly, not silently.
 *
 * Throws ScopeViolationError on assert failure.
 * Throws RolldogPendingError when any required credential env var is
 * absent. Throws RolldogApiError on non-2xx.
 */
export async function writeOpportunity(
  opportunityId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  // STEP 1. Enforce scope.
  assertScopedWrite(PILOT_TENANT_SLUG, opportunityId, Object.keys(updates));

  // STEP 2. Credential path.
  const config = readRolldogConfig();
  ensureCredentials(config, opportunityId, "write");

  // STEP 3. Real HTTP. Translate logical -> physical at the boundary.
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (key === "next_step") {
      // The `next-step` attribute is accepted-but-silently-ignored by
      // the sandbox (derived). Route to the `notes` scalar which DOES
      // persist. Free-text gets the [DealRipe] audit marker.
      attrs.notes = tagWithDealRipe(String(value ?? ""));
    } else if (key === "stage_gate_checklist_items") {
      // TODO(stage-gates): sandbox path for per-checklist-item writes
      // not yet verified. Fail loudly rather than silently no-op.
      throw new Error(
        `writeOpportunity does not support '${key}' yet; sandbox path TBD with Jeff.`,
      );
    } else {
      // Coarse logical field that belongs to a sub-resource. Caller
      // must use the appropriate sub-resource method.
      throw new Error(
        `writeOpportunity does not write '${key}' (it is a sub-resource field); use writeBudget / writeTimeline / writeCompetitionNotes / addCompetitor / writeParticipantNotes / addParticipantContact.`,
      );
    }
  }

  if (Object.keys(attrs).length === 0) return;

  const path = `/opportunities/${encodeURIComponent(opportunityId)}`;
  const body = JSON.stringify({
    data: {
      type: "opportunities",
      id: opportunityId,
      attributes: attrs,
    },
  });
  const res = await rolldogFetch(config, path, { method: "PATCH", body });
  if (!res.ok) {
    throw new RolldogApiError(res.status, path, await safeBody(res));
  }
}

// ---------------------------------------------------------------------
// Config and errors
// ---------------------------------------------------------------------

type RolldogConfig = {
  baseUrl: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  oauthUrl: string;
  audience: string;
};

function readRolldogConfig(): RolldogConfig {
  return {
    baseUrl: process.env.ROLLDOG_BASE_URL ?? "https://api.rolldog.com",
    clientId: process.env.ROLLDOG_CLIENT_ID,
    clientSecret: process.env.ROLLDOG_CLIENT_SECRET,
    oauthUrl:
      process.env.ROLLDOG_OAUTH_URL ?? "https://login.rolldog.com/oauth/token",
    audience: process.env.ROLLDOG_AUDIENCE ?? "https://rolldog-api",
  };
}

/**
 * Thrown when a required Rolldog credential env var is absent. Includes
 * the operation and opportunity id so the caller knows what was
 * blocked. Does not include credential values.
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

/**
 * Thrown on any non-2xx response from the Rolldog API. Carries the HTTP
 * status, the path that was hit, and the parsed body (JSON:API errors
 * array, or raw text excerpt if parsing failed). NEVER includes
 * credential values — the body is the API response, which Rolldog does
 * not echo credentials in.
 */
export class RolldogApiError extends Error {
  public readonly status: number;
  public readonly endpoint: string;
  public readonly body: unknown;

  constructor(status: number, endpoint: string, body: unknown) {
    super(`Rolldog API ${status} on ${endpoint}`);
    this.name = "RolldogApiError";
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
  }
}

// ---------------------------------------------------------------------
// Token manager
// ---------------------------------------------------------------------
//
// Single in-memory token cache. Refreshed when within 60s of expiry; a
// 401 from the API force-refreshes and retries the call once.

type CachedToken = { token: string; expiresAt: number };

let _tokenCache: CachedToken | null = null;

async function getAccessToken(
  config: RolldogConfig,
  forceRefresh: boolean,
): Promise<string> {
  const now = Date.now();
  if (
    !forceRefresh &&
    _tokenCache &&
    _tokenCache.expiresAt > now + 60_000
  ) {
    return _tokenCache.token;
  }
  if (!config.clientId || !config.clientSecret) {
    // Should never reach here — ensureCredentials runs before any call
    // that needs a token. Throw a generic error rather than
    // RolldogPendingError to surface the bug if it does.
    throw new Error("getAccessToken called without credentials configured");
  }

  const res = await fetch(config.oauthUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      audience: config.audience,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new RolldogApiError(res.status, "/oauth/token", await safeBody(res));
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new RolldogApiError(
      res.status,
      "/oauth/token",
      "missing access_token in oauth response",
    );
  }
  const ttlSec = typeof json.expires_in === "number" ? json.expires_in : 86_400;
  _tokenCache = {
    token: json.access_token,
    expiresAt: now + ttlSec * 1000,
  };
  return _tokenCache.token;
}

// ---------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------

type JsonApiResource = {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
};

type JsonApiSingleResponse = {
  data?: JsonApiResource | null;
  errors?: unknown[];
};

function ensureCredentials(
  config: RolldogConfig,
  opportunityId: string,
  operation: "read" | "write",
): void {
  if (!config.baseUrl || !config.clientId || !config.clientSecret) {
    throw new RolldogPendingError(opportunityId, operation);
  }
}

async function rolldogFetch(
  config: RolldogConfig,
  path: string,
  init: { method: "GET" | "POST" | "PATCH"; body?: string },
): Promise<Response> {
  const url = `${config.baseUrl}${path}`;
  let token = await getAccessToken(config, false);
  const buildHeaders = (t: string): HeadersInit => ({
    Authorization: `Bearer ${t}`,
    Accept: "application/vnd.api+json",
    "Content-Type": "application/vnd.api+json",
  });

  let res = await fetch(url, {
    method: init.method,
    headers: buildHeaders(token),
    body: init.body,
  });

  // Retry once on 401 with a freshly-minted token.
  if (res.status === 401) {
    token = await getAccessToken(config, true);
    res = await fetch(url, {
      method: init.method,
      headers: buildHeaders(token),
      body: init.body,
    });
  }

  return res;
}

async function safeBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.length > 600 ? text.slice(0, 600) + "..." : text;
  }
}

function tagWithDealRipe(text: string): string {
  if (typeof text !== "string") return text;
  // Already carries a [DealRipe] or [DealRipe · ...] stamp: leave it alone.
  if (text.trimStart().startsWith("[DealRipe")) return text;
  return text.trim().length === 0
    ? `${DEALRIPE_TAG}`
    : `${DEALRIPE_TAG} ${text}`;
}

async function getOpportunityCore(
  config: RolldogConfig,
  opportunityId: string,
): Promise<Record<string, unknown>> {
  const path = `/opportunities/${encodeURIComponent(opportunityId)}`;
  const res = await rolldogFetch(config, path, { method: "GET" });
  if (!res.ok) {
    throw new RolldogApiError(res.status, path, await safeBody(res));
  }
  const json = (await res.json()) as JsonApiSingleResponse;
  return (json.data?.attributes ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------
// Sub-resource map. snake_case logical name -> { read field on
// ROLLDOG_READ_FIELDS, related GET endpoint, JSON:API resource type
// for PATCH }.
//
// "situation" was originally read-only; once added to
// ROLLDOG_WRITE_FIELDS in lib/crm-scope.ts it became writable via
// writeSituation below. The read path stays as before so getDealRoom
// can surface it.
// ---------------------------------------------------------------------

type SubResourceInfo = {
  /** GET path under /opportunities/{id}/ */
  relatedPath: string;
  /** JSON:API resource type used in PATCH body */
  resourceType: string;
  /** snake_case field name registered in ROLLDOG_READ_FIELDS */
  readField: string;
};

const SUB_RESOURCE_MAP: Record<RolldogSubResource, SubResourceInfo> = {
  budget: {
    relatedPath: "opportunity-budget",
    resourceType: "opportunity-budgets",
    readField: "budget_tab",
  },
  timeline: {
    relatedPath: "opportunity-timeline",
    resourceType: "opportunity-timelines",
    readField: "timeline_tab",
  },
  competition: {
    relatedPath: "opportunity-competition",
    resourceType: "opportunity-competitions",
    readField: "competitors_tab",
  },
  participant: {
    relatedPath: "opportunity-participant",
    resourceType: "opportunity-participants",
    readField: "people_tab",
  },
  situation: {
    relatedPath: "opportunity-situation",
    resourceType: "opportunity-situations",
    readField: "situation",
  },
};

export type RolldogSubResource =
  | "budget"
  | "timeline"
  | "competition"
  | "participant"
  | "situation";

/**
 * Internal: GET a sub-resource without asserting (the caller's coarse
 * write assert is the only audit entry for write paths, per the
 * abstraction's design rule). For PUBLIC reads, use getSubResource(),
 * which wraps this with its own assertScopedRead on the corresponding
 * `_tab` field.
 */
async function fetchSubResource(
  config: RolldogConfig,
  opportunityId: string,
  sub: RolldogSubResource,
): Promise<{ id: string; attributes: Record<string, unknown> } | null> {
  const info = SUB_RESOURCE_MAP[sub];
  const path = `/opportunities/${encodeURIComponent(opportunityId)}/${info.relatedPath}`;
  const res = await rolldogFetch(config, path, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new RolldogApiError(res.status, path, await safeBody(res));
  }
  const json = (await res.json()) as JsonApiSingleResponse;
  const data = json.data ?? null;
  if (!data || typeof data.id !== "string") return null;
  return {
    id: data.id,
    attributes: (data.attributes ?? {}) as Record<string, unknown>,
  };
}

async function patchSubResource(
  config: RolldogConfig,
  sub: RolldogSubResource,
  subId: string,
  attributes: Record<string, unknown>,
): Promise<void> {
  const info = SUB_RESOURCE_MAP[sub];
  const path = `/${info.resourceType}/${encodeURIComponent(subId)}`;
  const body = JSON.stringify({
    data: {
      type: info.resourceType,
      id: subId,
      attributes,
    },
  });
  const res = await rolldogFetch(config, path, { method: "PATCH", body });
  if (!res.ok) {
    throw new RolldogApiError(res.status, path, await safeBody(res));
  }
}

async function discoverSubId(
  config: RolldogConfig,
  opportunityId: string,
  sub: RolldogSubResource,
): Promise<string> {
  const existing = await fetchSubResource(config, opportunityId, sub);
  if (!existing) {
    throw new RolldogApiError(
      404,
      `/opportunities/${opportunityId}/${SUB_RESOURCE_MAP[sub].relatedPath}`,
      `no ${sub} sub-resource found for opportunity ${opportunityId}; sub-objects must be pre-created in Rolldog`,
    );
  }
  return existing.id;
}

// ---------------------------------------------------------------------
// Sub-resource write methods. Each asserts the COARSE snake_case
// logical field name from ROLLDOG_WRITE_FIELDS, then discovers the
// sub-resource id and PATCHes its fine-grained kebab-case attributes.
// Free-text notes are tagged with [DealRipe].
// ---------------------------------------------------------------------

export type BudgetWrite = Partial<{
  lowRange: number;
  highRange: number;
  budgetFit: string;
  approver: string;
  department: string;
  isTiedToFye: boolean;
  notes: string;
  fundingNotes: string;
}>;

export async function writeBudget(
  opportunityId: string,
  write: BudgetWrite,
): Promise<void> {
  assertScopedWrite(PILOT_TENANT_SLUG, opportunityId, ["budget"]);
  const config = readRolldogConfig();
  ensureCredentials(config, opportunityId, "write");

  const subId = await discoverSubId(config, opportunityId, "budget");
  const attrs: Record<string, unknown> = {};
  if (write.lowRange !== undefined) attrs["low-range"] = write.lowRange;
  if (write.highRange !== undefined) attrs["high-range"] = write.highRange;
  if (write.budgetFit !== undefined) attrs["budget-fit"] = write.budgetFit;
  if (write.approver !== undefined) attrs.approver = write.approver;
  if (write.department !== undefined) attrs.department = write.department;
  if (write.isTiedToFye !== undefined) attrs["is-tied-to-fye"] = write.isTiedToFye;
  if (write.notes !== undefined) attrs.notes = tagWithDealRipe(write.notes);
  if (write.fundingNotes !== undefined) {
    attrs["funding-notes"] = tagWithDealRipe(write.fundingNotes);
  }
  if (Object.keys(attrs).length === 0) return;
  await patchSubResource(config, "budget", subId, attrs);
}

export type TimelineWrite = Partial<{
  notes: string;
  closeDateValidator: string;
  isCloseDateValidated: boolean;
}>;

export async function writeTimeline(
  opportunityId: string,
  write: TimelineWrite,
): Promise<void> {
  assertScopedWrite(PILOT_TENANT_SLUG, opportunityId, ["timeline"]);
  const config = readRolldogConfig();
  ensureCredentials(config, opportunityId, "write");

  const subId = await discoverSubId(config, opportunityId, "timeline");
  const attrs: Record<string, unknown> = {};
  if (write.notes !== undefined) attrs.notes = tagWithDealRipe(write.notes);
  if (write.closeDateValidator !== undefined) {
    attrs["close-date-validator"] = write.closeDateValidator;
  }
  if (write.isCloseDateValidated !== undefined) {
    attrs["is-close-date-validated"] = write.isCloseDateValidated;
  }
  if (Object.keys(attrs).length === 0) return;
  await patchSubResource(config, "timeline", subId, attrs);
}

export async function writeCompetitionNotes(
  opportunityId: string,
  notes: string,
): Promise<void> {
  assertScopedWrite(PILOT_TENANT_SLUG, opportunityId, ["competitors"]);
  const config = readRolldogConfig();
  ensureCredentials(config, opportunityId, "write");

  const subId = await discoverSubId(config, opportunityId, "competition");
  await patchSubResource(config, "competition", subId, {
    notes: tagWithDealRipe(notes),
  });
}

export type CompetitorWrite = {
  name: string;
  productName?: string;
  isIncumbent?: boolean;
  score?: number;
  strengths?: string;
  weaknesses?: string;
  isShortlisted?: boolean;
  notes?: string;
};

export async function addCompetitor(
  opportunityId: string,
  competitor: CompetitorWrite,
): Promise<void> {
  assertScopedWrite(PILOT_TENANT_SLUG, opportunityId, ["competitors"]);
  const config = readRolldogConfig();
  ensureCredentials(config, opportunityId, "write");

  const competitionSubId = await discoverSubId(
    config,
    opportunityId,
    "competition",
  );
  const attrs: Record<string, unknown> = { name: competitor.name };
  if (competitor.productName !== undefined) attrs["product-name"] = competitor.productName;
  if (competitor.isIncumbent !== undefined) attrs["is-incumbent"] = competitor.isIncumbent;
  if (competitor.score !== undefined) attrs.score = competitor.score;
  if (competitor.strengths !== undefined) attrs.strengths = competitor.strengths;
  if (competitor.weaknesses !== undefined) attrs.weaknesses = competitor.weaknesses;
  if (competitor.isShortlisted !== undefined) attrs["is-shortlisted"] = competitor.isShortlisted;
  if (competitor.notes !== undefined) attrs.notes = tagWithDealRipe(competitor.notes);

  const body = JSON.stringify({
    data: {
      type: "opportunity-competitors",
      attributes: attrs,
      relationships: {
        "opportunity-competition": {
          data: { type: "opportunity-competitions", id: competitionSubId },
        },
      },
    },
  });
  const path = "/opportunity-competitors";
  const res = await rolldogFetch(config, path, { method: "POST", body });
  if (!res.ok) {
    throw new RolldogApiError(res.status, path, await safeBody(res));
  }
}

export type ParticipantNotesWrite = Partial<{
  notes: string;
  consultantNotes: string;
  hasPartner: boolean;
  partnerName: string;
  hasConsultant: boolean;
  consultantName: string;
}>;

export async function writeParticipantNotes(
  opportunityId: string,
  write: ParticipantNotesWrite,
): Promise<void> {
  assertScopedWrite(PILOT_TENANT_SLUG, opportunityId, ["people"]);
  const config = readRolldogConfig();
  ensureCredentials(config, opportunityId, "write");

  const subId = await discoverSubId(config, opportunityId, "participant");
  const attrs: Record<string, unknown> = {};
  if (write.notes !== undefined) attrs.notes = tagWithDealRipe(write.notes);
  if (write.consultantNotes !== undefined) {
    attrs["consultant-notes"] = tagWithDealRipe(write.consultantNotes);
  }
  if (write.hasPartner !== undefined) attrs["has-partner"] = write.hasPartner;
  if (write.partnerName !== undefined) attrs["partner-name"] = write.partnerName;
  if (write.hasConsultant !== undefined) attrs["has-consultant"] = write.hasConsultant;
  if (write.consultantName !== undefined) attrs["consultant-name"] = write.consultantName;
  if (Object.keys(attrs).length === 0) return;
  await patchSubResource(config, "participant", subId, attrs);
}

export type ParticipantContactWrite = {
  contactId: string;
  title?: string;
  powerClass?: string;
  access?: string;
  involvement?: string;
  keyDecisionMaker?: boolean;
  notes?: string;
};

export async function addParticipantContact(
  opportunityId: string,
  contact: ParticipantContactWrite,
): Promise<void> {
  assertScopedWrite(PILOT_TENANT_SLUG, opportunityId, ["people"]);
  const config = readRolldogConfig();
  ensureCredentials(config, opportunityId, "write");

  const participantSubId = await discoverSubId(
    config,
    opportunityId,
    "participant",
  );
  const attrs: Record<string, unknown> = { "contact-id": contact.contactId };
  if (contact.title !== undefined) attrs.title = contact.title;
  if (contact.powerClass !== undefined) attrs["power-class"] = contact.powerClass;
  if (contact.access !== undefined) attrs.access = contact.access;
  if (contact.involvement !== undefined) attrs.involvement = contact.involvement;
  if (contact.keyDecisionMaker !== undefined) {
    attrs["key-decision-maker"] = contact.keyDecisionMaker;
  }
  if (contact.notes !== undefined) attrs.notes = tagWithDealRipe(contact.notes);

  const body = JSON.stringify({
    data: {
      type: "opportunity-participant-contacts",
      attributes: attrs,
      relationships: {
        "opportunity-participant": {
          data: {
            type: "opportunity-participants",
            id: participantSubId,
          },
        },
      },
    },
  });
  const path = "/opportunity-participant-contacts";
  const res = await rolldogFetch(config, path, { method: "POST", body });
  if (!res.ok) {
    throw new RolldogApiError(res.status, path, await safeBody(res));
  }
}

export type SituationWrite = Partial<{
  whyLooking: string;
  whyLookingNow: string;
  // TODO(existing-systems): the sandbox GET returned this as an array
  // (e.g. []); the write shape may need to be an array of system names
  // rather than free text. Treating as string today so the parser can
  // pass free text from extraction; revisit when we have a sample
  // PATCH that successfully sets it.
  existingSystems: string;
  businessStatus: string;
  notes: string;
}>;

export async function writeSituation(
  opportunityId: string,
  write: SituationWrite,
): Promise<void> {
  assertScopedWrite(PILOT_TENANT_SLUG, opportunityId, ["situation"]);
  const config = readRolldogConfig();
  ensureCredentials(config, opportunityId, "write");

  const subId = await discoverSubId(config, opportunityId, "situation");
  const attrs: Record<string, unknown> = {};
  if (write.whyLooking !== undefined) attrs["why-looking"] = write.whyLooking;
  if (write.whyLookingNow !== undefined) {
    attrs["why-looking-now"] = write.whyLookingNow;
  }
  if (write.existingSystems !== undefined) {
    attrs["existing-systems"] = write.existingSystems;
  }
  if (write.businessStatus !== undefined) {
    attrs["business-status"] = write.businessStatus;
  }
  // Only `notes` carries the [DealRipe] audit tag; the business
  // narrative fields above are customer content, not audit markers.
  if (write.notes !== undefined) attrs.notes = tagWithDealRipe(write.notes);

  if (Object.keys(attrs).length === 0) return;
  await patchSubResource(config, "situation", subId, attrs);
}

// ---------------------------------------------------------------------
// Sub-resource read + convenience aggregate
// ---------------------------------------------------------------------

/**
 * Public sub-resource read. Asserts the corresponding snake_case
 * read field (budget_tab, timeline_tab, competitors_tab, people_tab,
 * situation), then fetches the sub-resource. Returns null when the
 * sub-resource has not been created on this opportunity.
 */
export async function getSubResource(
  opportunityId: string,
  sub: RolldogSubResource,
): Promise<{ id: string; attributes: Record<string, unknown> } | null> {
  const info = SUB_RESOURCE_MAP[sub];
  assertScopedRead(PILOT_TENANT_SLUG, opportunityId, [info.readField]);
  const config = readRolldogConfig();
  ensureCredentials(config, opportunityId, "read");
  return fetchSubResource(config, opportunityId, sub);
}

export type DealRoom = {
  core: Record<string, unknown>;
  budget: { id: string; attributes: Record<string, unknown> } | null;
  timeline: { id: string; attributes: Record<string, unknown> } | null;
  competition: { id: string; attributes: Record<string, unknown> } | null;
  participant: { id: string; attributes: Record<string, unknown> } | null;
  situation: { id: string; attributes: Record<string, unknown> } | null;
};

/**
 * Convenience: read the opportunity core + every sub-resource in
 * parallel, returning a single object the briefing/forecast code can
 * consume. Asserts the full set of snake_case read fields it pulls
 * (single assert, single audit row).
 */
export async function getDealRoom(opportunityId: string): Promise<DealRoom> {
  assertScopedRead(PILOT_TENANT_SLUG, opportunityId, [
    "stage",
    "close_date",
    "amount",
    "owner",
    "next_step",
    "budget_tab",
    "timeline_tab",
    "competitors_tab",
    "people_tab",
    "situation",
  ]);
  const config = readRolldogConfig();
  ensureCredentials(config, opportunityId, "read");

  const [core, budget, timeline, competition, participant, situation] =
    await Promise.all([
      getOpportunityCore(config, opportunityId),
      fetchSubResource(config, opportunityId, "budget"),
      fetchSubResource(config, opportunityId, "timeline"),
      fetchSubResource(config, opportunityId, "competition"),
      fetchSubResource(config, opportunityId, "participant"),
      fetchSubResource(config, opportunityId, "situation"),
    ]);
  return { core, budget, timeline, competition, participant, situation };
}
