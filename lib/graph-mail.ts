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
// Reading (deal signal)
// ====================================================================

/**
 * A mail message reduced to the fields DealRipe reasons about. Bodies are
 * deliberately NOT fetched: every signal we derive (latency, direction,
 * participant change, thread continuity) comes from headers, and headers are a
 * far smaller privacy surface to defend in a security review.
 */
export type MailMessage = {
  id: string;
  /** Graph's thread key. Groups a reply chain without parsing References. */
  conversationId: string | null;
  subject: string;
  /** When it arrived (inbound) or was sent (outbound). */
  at: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  /** True when the mailbox owner sent it. Drives the direction signal. */
  outbound: boolean;
  /** First ~255 chars. Enough to classify intent without storing the body. */
  preview: string;
};

type GraphRecipient = { emailAddress?: { address?: string | null } };
type GraphMessage = {
  id: string;
  conversationId?: string | null;
  subject?: string | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  bodyPreview?: string | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
};

const MESSAGE_SELECT = [
  "id",
  "conversationId",
  "subject",
  "receivedDateTime",
  "sentDateTime",
  "bodyPreview",
  "from",
  "toRecipients",
  "ccRecipients",
].join(",");

function addr(r: GraphRecipient | null | undefined): string | null {
  const a = r?.emailAddress?.address;
  return a ? a.trim().toLowerCase() : null;
}

function addrs(list: GraphRecipient[] | undefined): string[] {
  return (list ?? []).map(addr).filter((a): a is string => Boolean(a));
}

/** Domain part of an address, for deal-scoping. */
export function domainOf(email: string | null | undefined): string | null {
  const at = (email ?? "").lastIndexOf("@");
  return at > 0 ? email!.slice(at + 1).toLowerCase() : null;
}

/**
 * Read recent messages from a rep's mailbox, newest first.
 *
 * Scoping note: Graph's $search supports `participants:` but requires the
 * eventual-consistency header and behaves inconsistently across tenants, so we
 * page a bounded date window and filter by domain in code. That keeps the query
 * predictable, and the domain filter is applied before anything is stored, so
 * non-deal mail is read transiently and never persisted.
 *
 * Read-only. Allowlist-gated exactly like the draft path.
 */
export async function listMailboxMessages(args: {
  tenantIdOrDomain: string;
  mailbox: string;
  /** Only messages at or after this instant. */
  since: Date;
  /** Restrict to threads involving these customer domains. Empty = no filter. */
  domains?: string[];
  /** Safety bound on pages of 100. */
  maxPages?: number;
}): Promise<MailMessage[]> {
  assertMailboxAllowed(args.mailbox);
  const tenantId = await resolveGraphTenantId(args.tenantIdOrDomain);
  const token = await getAppOnlyToken(tenantId);
  const user = encodeURIComponent(args.mailbox);
  const me = args.mailbox.trim().toLowerCase();
  const wanted = new Set((args.domains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean));

  const out: MailMessage[] = [];
  let url =
    `${GRAPH_BASE}/users/${user}/messages` +
    `?$select=${MESSAGE_SELECT}` +
    `&$top=100&$orderby=receivedDateTime desc` +
    `&$filter=receivedDateTime ge ${args.since.toISOString()}`;

  for (let page = 0; page < (args.maxPages ?? 10) && url; page++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new GraphMailError(res.status, await res.text());
    const json = (await res.json()) as { value?: GraphMessage[]; "@odata.nextLink"?: string };
    for (const m of json.value ?? []) {
      const from = addr(m.from ?? m.sender);
      const to = addrs(m.toRecipients);
      const cc = addrs(m.ccRecipients);
      if (wanted.size > 0) {
        const involved = [from, ...to, ...cc].filter(Boolean) as string[];
        if (!involved.some((a) => wanted.has(domainOf(a) ?? ""))) continue;
      }
      out.push({
        id: m.id,
        conversationId: m.conversationId ?? null,
        subject: m.subject ?? "",
        at: m.receivedDateTime ?? m.sentDateTime ?? null,
        from,
        to,
        cc,
        outbound: from === me,
        preview: (m.bodyPreview ?? "").trim(),
      });
    }
    url = json["@odata.nextLink"] ?? "";
  }
  return out;
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

/**
 * Plain text to minimal HTML, for prepending above Outlook's quoted thread.
 * Deliberately spartan: no styling, so it inherits the rep's default font
 * rather than looking like it came from somewhere else.
 */
function textToHtml(text: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paras = text
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div>${paras}</div>`;
}

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
/**
 * Full plain-text body of one message.
 *
 * listMailboxMessages returns bodyPreview, which is roughly the first 255
 * characters. That is fine for spotting a thread, and useless for learning how
 * someone writes: a sign-off lives at the END of an email, so "Cheers, Steven"
 * never appears in a preview. Voice samples need the tail, so they fetch the
 * body for the handful of messages they actually use rather than pulling
 * bodies for every message in the mailbox.
 *
 * Requested as text so no HTML stripping is needed. The body is used in a
 * prompt and never stored.
 */
export async function getMessageBody(args: {
  tenantIdOrDomain: string;
  mailbox: string;
  messageId: string;
}): Promise<string | null> {
  assertMailboxAllowed(args.mailbox);
  const tenantId = await resolveGraphTenantId(args.tenantIdOrDomain);
  const token = await getAppOnlyToken(tenantId);
  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(args.mailbox)}` +
    `/messages/${encodeURIComponent(args.messageId)}?$select=body`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { body?: { content?: string } };
  const content = (json.body?.content ?? "").trim();
  return content.length > 0 ? content : null;
}

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

  // 1. Graph creates the reply skeleton: recipients, plus the quoted thread
  //    already formatted the way Outlook formats it.
  const createRes = await fetch(`${GRAPH_BASE}/users/${user}/messages/${encodeURIComponent(args.messageId)}/createReply`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!createRes.ok) throw new GraphMailError(createRes.status, await createRes.text());
  const draft = (await createRes.json()) as {
    id?: string;
    webLink?: string;
    body?: { content?: string; contentType?: string };
  };
  if (!draft.id) throw new GraphMailError(createRes.status, "Graph returned no draft id");

  // 2. PREPEND our text above the quoted thread rather than replacing the body.
  //    A plain PATCH overwrites what Graph seeded, so the reply would go out
  //    with no quoted history, which is not how a reply is supposed to read and
  //    strips the context the customer needs. Verified against a live mailbox:
  //    createReply seeds the quoted thread and no signature.
  const seeded = draft.body?.content ?? "";
  const seededIsHtml = (draft.body?.contentType ?? "").toLowerCase() === "html" || /<[a-z]/i.test(seeded);
  const wantsHtml = (args.contentType ?? "Text") === "HTML";

  let content: string;
  let contentType: "Text" | "HTML";
  if (seeded && (seededIsHtml || wantsHtml)) {
    // Match Outlook's own format so the two halves render as one message.
    const asHtml = wantsHtml ? args.body : textToHtml(args.body);
    content = `${asHtml}${seeded}`;
    contentType = "HTML";
  } else {
    content = seeded ? `${args.body}\n\n${seeded}` : args.body;
    contentType = args.contentType ?? "Text";
  }

  const patchRes = await fetch(`${GRAPH_BASE}/users/${user}/messages/${encodeURIComponent(draft.id)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ body: { contentType, content } }),
  });
  if (!patchRes.ok) throw new GraphMailError(patchRes.status, await patchRes.text());

  return { id: draft.id, webLink: draft.webLink ?? null };
}
