/**
 * Microsoft Graph mail: create DRAFTS in a rep's mailbox.
 *
 * Draft only, never send. DealRipe writes the email into the rep's Drafts
 * folder; the rep reads it, edits it, and hits send. This is enforced in three
 * places, deliberately:
 *
 *   1. Permission. The app holds Mail.ReadWrite (Application) and NOT
 *      Mail.Send. Even a bug cannot put mail on the wire.
 *   2. Code. There is no send function in this module.
 *   3. Allowlist. assertMailboxAllowed() restricts writes to the pilot reps'
 *      mailboxes, so an app-only token that technically reaches the whole
 *      tenant cannot touch anyone else. Mirrors the Rolldog/Salesforce
 *      opportunity allowlists in lib/crm-scope.ts.
 *
 * Customers should ALSO scope us server-side with an Application Access Policy
 * (New-ApplicationAccessPolicy in Exchange Online) so the tenant enforces the
 * same boundary independently of our code. The allowlist here is our half of
 * that contract, not a substitute for it.
 *
 * Auth is the app-only client-credentials flow proven by
 * scripts/verify-graph-mail.ts: the customer's admin consents our Application
 * permissions in THEIR tenant, and we mint a token against that tenant.
 *
 * Endpoints:
 *   POST https://graph.microsoft.com/v1.0/users/{upn}/messages                (new draft)
 *   POST https://graph.microsoft.com/v1.0/users/{upn}/messages/{id}/createReply (reply draft)
 *   PATCH https://graph.microsoft.com/v1.0/users/{upn}/messages/{draftId}      (set body)
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_SAFETY_MARGIN_MS = 60_000;

// ====================================================================
// Errors
// ====================================================================

export class GraphMailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphMailConfigError";
  }
}

export class GraphMailAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`Graph auth failed (HTTP ${status}): ${detail.slice(0, 200)}`);
    this.name = "GraphMailAuthError";
  }
}

export class GraphMailScopeError extends Error {
  constructor(public readonly mailbox: string) {
    super(
      `Mailbox '${mailbox}' is not on the DealRipe draft allowlist. ` +
        `Add it to GRAPH_MAIL_ALLOWED_MAILBOXES before drafting into it.`,
    );
    this.name = "GraphMailScopeError";
  }
}

export class GraphMailError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`Graph request failed (HTTP ${status}): ${detail.slice(0, 300)}`);
    this.name = "GraphMailError";
  }
}

// ====================================================================
// Mailbox allowlist (fail closed)
// ====================================================================

/**
 * Mailboxes DealRipe may draft into. Comma-separated env override so a new rep
 * is a config change, not a deploy. Empty allowlist = nothing is permitted.
 */
export function allowedMailboxes(): string[] {
  const raw = process.env.GRAPH_MAIL_ALLOWED_MAILBOXES ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function assertMailboxAllowed(mailbox: string): void {
  const allowed = allowedMailboxes();
  if (!allowed.includes(mailbox.trim().toLowerCase())) throw new GraphMailScopeError(mailbox);
}

// ====================================================================
// Auth: app-only token per customer tenant
// ====================================================================

type CachedToken = { token: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();

/** Resolve a domain (magaya.com) to its tenant GUID; passes GUIDs through. */
export async function resolveGraphTenantId(tenantOrDomain: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(tenantOrDomain)) return tenantOrDomain;
  const res = await fetch(`https://login.microsoftonline.com/${tenantOrDomain}/v2.0/.well-known/openid-configuration`);
  if (!res.ok) throw new GraphMailConfigError(`Could not resolve tenant for "${tenantOrDomain}" (HTTP ${res.status})`);
  const doc = (await res.json()) as { issuer?: string };
  const m = /([0-9a-f-]{36})/i.exec(String(doc.issuer ?? ""));
  if (!m) throw new GraphMailConfigError(`No tenant id in discovery document for "${tenantOrDomain}"`);
  return m[1];
}

async function getAppOnlyToken(tenantId: string): Promise<string> {
  const cached = tokenCache.get(tenantId);
  if (cached && cached.expiresAt - TOKEN_SAFETY_MARGIN_MS > Date.now()) return cached.token;

  const clientId = process.env.MS_CLIENT_ID ?? process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET ?? process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GraphMailConfigError("MS_CLIENT_ID and MS_CLIENT_SECRET must be set");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) {
    // Trim: the description can echo configuration back at us.
    throw new GraphMailAuthError(res.status, String(json.error_description ?? "").split("\n")[0]);
  }
  const ttlMs = (json.expires_in ?? 3600) * 1000;
  tokenCache.set(tenantId, { token: json.access_token, expiresAt: Date.now() + ttlMs });
  return json.access_token;
}

// ====================================================================
// Drafting
// ====================================================================

export type DraftRecipient = { email: string; name?: string };

export type DraftResult = {
  /** Graph message id of the created draft. */
  id: string;
  /** Deep link that opens the draft in Outlook on the web. */
  webLink: string | null;
};

function toRecipientList(list: DraftRecipient[] | undefined) {
  return (list ?? []).map((r) => ({
    emailAddress: { address: r.email, ...(r.name ? { name: r.name } : {}) },
  }));
}

/**
 * Create a NEW draft in the rep's mailbox. Nothing is sent.
 *
 * contentType defaults to "Text" because DealRipe drafts are written in the
 * rep's own voice; HTML markup makes them read like templates.
 */
export async function createDraft(args: {
  tenantIdOrDomain: string;
  /** The rep's mailbox (userPrincipalName), e.g. jlopez@magaya.com. */
  mailbox: string;
  subject: string;
  body: string;
  to?: DraftRecipient[];
  cc?: DraftRecipient[];
  contentType?: "Text" | "HTML";
}): Promise<DraftResult> {
  assertMailboxAllowed(args.mailbox);
  const tenantId = await resolveGraphTenantId(args.tenantIdOrDomain);
  const token = await getAppOnlyToken(tenantId);

  const res = await fetch(`${GRAPH_BASE}/users/${encodeURIComponent(args.mailbox)}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      subject: args.subject,
      body: { contentType: args.contentType ?? "Text", content: args.body },
      toRecipients: toRecipientList(args.to),
      ccRecipients: toRecipientList(args.cc),
    }),
  });
  if (!res.ok) throw new GraphMailError(res.status, await res.text());
  const json = (await res.json()) as { id?: string; webLink?: string };
  if (!json.id) throw new GraphMailError(res.status, "Graph returned no message id");
  return { id: json.id, webLink: json.webLink ?? null };
}

/**
 * Create a draft REPLY on an existing thread, so it lands in the conversation
 * the customer is already reading rather than as a detached new email. Used for
 * the unanswered-question and slipped-commitment recoveries.
 */
export async function createReplyDraft(args: {
  tenantIdOrDomain: string;
  mailbox: string;
  /** Graph id of the message being replied to. */
  messageId: string;
  body: string;
  contentType?: "Text" | "HTML";
}): Promise<DraftResult> {
  assertMailboxAllowed(args.mailbox);
  const tenantId = await resolveGraphTenantId(args.tenantIdOrDomain);
  const token = await getAppOnlyToken(tenantId);
  const user = encodeURIComponent(args.mailbox);

  // 1. Graph creates the reply skeleton (recipients + quoted thread).
  const createRes = await fetch(`${GRAPH_BASE}/users/${user}/messages/${encodeURIComponent(args.messageId)}/createReply`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!createRes.ok) throw new GraphMailError(createRes.status, await createRes.text());
  const draft = (await createRes.json()) as { id?: string; webLink?: string };
  if (!draft.id) throw new GraphMailError(createRes.status, "Graph returned no draft id");

  // 2. Set our body on it.
  const patchRes = await fetch(`${GRAPH_BASE}/users/${user}/messages/${encodeURIComponent(draft.id)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ body: { contentType: args.contentType ?? "Text", content: args.body } }),
  });
  if (!patchRes.ok) throw new GraphMailError(patchRes.status, await patchRes.text());

  return { id: draft.id, webLink: draft.webLink ?? null };
}
