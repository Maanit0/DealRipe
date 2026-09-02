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
  /**
   * RFC 5322 Message-ID, stable ACROSS mailboxes.
   *
   * `id` above is Graph's own key and is per-mailbox, the same trap as
   * calendar events where iCalUId is stable and id is not. A co-sold thread
   * read from two reps' mailboxes yields two different `id` values for one
   * message, so anything deduping or counting has to key on this instead.
   * Null when Graph omits it, which happens on some drafts.
   */
  internetMessageId: string | null;
  /** Graph's thread key. Groups a reply chain without parsing References. */
  conversationId: string | null;
  subject: string;
  /** When it arrived (inbound) or was sent (outbound). */
  at: string | null;
  /**
   * True for a meeting invite, cancellation or response rather than an email.
   *
   * Outlook files these in the mailbox like any other message, so a calendar
   * invite the rep sent looks identical to a follow-up email: outbound, to the
   * customer's domain, subject line and all. Steven Johnson, 2026-08-27, is
   * exactly the shape that breaks: "I don't send emails right away, I could do
   * better at that, that's why I want DealRipe to do it. What I'm good about is
   * sending a calendar invite over email for the next meeting." Every one of
   * his suppressed drafts cited a MEETING subject, MAGAYA CUSTOMS COMPLIANCE
   * followed by the call type, not an email he had written.
   *
   * Graph annotates derived types on the message collection, so an invite comes
   * back as #microsoft.graph.eventMessageRequest without needing a second call.
   */
  isMeetingMessage: boolean;
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
  internetMessageId?: string | null;
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
  "internetMessageId",
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

/**
 * Outlook's own meeting-response and invite traffic, which is outbound mail
 * the rep did not write.
 *
 * "Accepted: Magaya Demo" leaves the rep's mailbox addressed to the customer
 * and looks identical to a follow-up in every field we filter on. Counting it
 * recorded a rep as having followed up when all they did was click Accept on
 * an invite, which is the difference between a rep who worked the deal and one
 * who did nothing.
 *
 * Subject-based on purpose: the localized forms below are what Outlook emits,
 * and a real follow-up does not open with them.
 */
export function isCalendarResponseSubject(subject: string | null | undefined): boolean {
  const s = (subject ?? "").trim();
  if (!s) return false;
  return /^\s*(re:\s*|fw:\s*|fwd:\s*)*(accepted|declined|tentative|canceled|cancelled|updated|aceptado|rechazado|provisional|cancelado|invitation|convocatoria)\s*:/i.test(
    s,
  );
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
    // 25, not 100. Measured against Alexandra Suntrup's mailbox on 2026-08-20:
    // $top=25 with the same filter and orderby returns in ~700ms, $top=50 hits
    // Graph's 30 second ceiling and returns a bare 504 with an empty message.
    // Her mailbox failed on every run while the other five succeeded, so the
    // ingest was silently losing one rep's entire email rather than one page.
    // More pages at a size Graph can actually serve beats fewer that time out.
    `&$top=25&$orderby=receivedDateTime desc` +
    `&$filter=receivedDateTime ge ${args.since.toISOString()}`;

  for (let page = 0; page < (args.maxPages ?? 20) && url; page++) {
    // Graph times out on a busy mailbox and says so with a bare 504 carrying
    // an empty message. Alexandra Suntrup's mailbox failed that way on every
    // run while the other five succeeded, so the whole ingest silently lost one
    // rep's email rather than one page of it.
    //
    // The domain filter is applied CLIENT-side below, so this pages through
    // every message in the window before narrowing, which is why a high-volume
    // mailbox is the one that dies. Retrying the same page usually succeeds:
    // the timeout is Graph's, not ours.
    let res: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) break;
      // 429 and 5xx are worth retrying. A 401 or 403 is a permission fact and
      // retrying it just delays an honest error.
      if (res.status !== 429 && res.status < 500) break;
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** attempt;
      console.warn(
        `[graph-mail] ${args.mailbox} page ${page} returned ${res.status}, retrying in ${waitMs}ms (attempt ${attempt + 1} of 4)`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (!res || !res.ok) throw new GraphMailError(res?.status ?? 0, res ? await res.text() : "no response");
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
        internetMessageId: m.internetMessageId ?? null,
        conversationId: m.conversationId ?? null,
        subject: m.subject ?? "",
        at: m.receivedDateTime ?? m.sentDateTime ?? null,
        from,
        to,
        cc,
        outbound: from === me,
        isMeetingMessage: String((m as { "@odata.type"?: string })["@odata.type"] ?? "")
          .toLowerCase()
          .includes("eventmessage"),
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
  /**
   * Graph message id of the created draft.
   *
   * Per-mailbox AND per-folder: Outlook assigns a new one when the draft moves
   * to Sent Items, so this cannot be used to recognise the sent copy. Kept for
   * addressing the draft while it is still a draft.
   */
  id: string;
  /**
   * RFC 5322 Message-ID, assigned at draft creation and PRESERVED on send.
   *
   * This is the join key that answers "did the rep send the draft we wrote".
   * Same stability property as the calendar's iCalUId against its per-mailbox
   * id, and the same trap: using `id` here would silently never match, because
   * the sent copy has a different one.
   *
   * Null when Graph omits it, which it does on some drafts, and a caller must
   * treat that as "cannot be joined" rather than as "not sent".
   */
  internetMessageId: string | null;
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

/**
 * What became of one message we created, by its Graph id.
 *
 * The one read that answers "did the rep send our draft". Three outcomes, and
 * they must stay three: a draft still sitting in Drafts, a message that has
 * been sent, and an id Graph no longer knows about. The third is genuinely
 * ambiguous, because Outlook may reassign the id when a draft is sent, so it is
 * reported as gone rather than folded into either of the other two.
 */
export type MessageState =
  | { status: "draft"; conversationId: string | null; subject: string; body: string | null }
  | { status: "sent"; conversationId: string | null; subject: string; sentAt: string | null; body: string | null }
  /** Graph 404s on the id: sent under a new id, or deleted. Undecidable here. */
  | { status: "gone" }
  /** The read itself failed. NOT the same as the message being gone. */
  | { status: "unavailable"; error: string };

/**
 * Looked up by INTERNET MESSAGE ID, not by Graph's own key.
 *
 * Graph's `id` is per-mailbox and Outlook reassigns it when a draft is sent, so
 * a draft id stored at creation 404s the moment the rep actually sends, which
 * is the one outcome this read exists to detect. Exchange assigns the RFC 5322
 * Message-ID when the draft is CREATED and keeps it through the send, so it is
 * the only key that survives the event we are measuring. It is also what
 * createDraft and createReplyDraft already store on the sent_messages row.
 *
 * The filter searches the whole mailbox, so a message that moved from Drafts to
 * Sent Items is still found in one call.
 */
export async function readMessageStateByInternetId(args: {
  tenantIdOrDomain: string;
  mailbox: string;
  internetMessageId: string;
}): Promise<MessageState> {
  assertMailboxAllowed(args.mailbox);
  const tenantId = await resolveGraphTenantId(args.tenantIdOrDomain);
  const token = await getAppOnlyToken(tenantId);
  // Single quotes are the OData string delimiter and are escaped by doubling.
  const filter = `internetMessageId eq '${args.internetMessageId.replace(/'/g, "''")}'`;
  const url =
    `${GRAPH_BASE}/users/${encodeURIComponent(args.mailbox)}/messages` +
    `?$filter=${encodeURIComponent(filter)}` +
    `&$select=id,isDraft,conversationId,subject,sentDateTime,body`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' },
    });
  } catch (err) {
    return { status: "unavailable", error: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { status: "unavailable", error: `${res.status} ${await res.text()}` };
  const json = (await res.json()) as {
    value?: Array<{
      isDraft?: boolean;
      conversationId?: string | null;
      subject?: string | null;
      sentDateTime?: string | null;
      body?: { content?: string };
    }>;
  };
  const hits = json.value ?? [];
  if (hits.length === 0) return { status: "gone" };
  // A sent copy wins over a draft copy. Outlook can leave both behind, and the
  // question is whether it was sent, not whether a draft still exists.
  const m = hits.find((h) => h.isDraft === false) ?? hits[0];
  const body = (m.body?.content ?? "").trim() || null;
  const conversationId = m.conversationId ?? null;
  const subject = m.subject ?? "";
  return m.isDraft
    ? { status: "draft", conversationId, subject, body }
    : { status: "sent", conversationId, subject, sentAt: m.sentDateTime ?? null, body };
}

/**
 * What is actually sitting in a mailbox's Drafts folder.
 *
 * createDraft records "drafted" on the strength of a 201 from Graph and nothing
 * else, which is a claim about a POST rather than a claim about the rep's
 * mailbox. Ariel Rodriguez, 2026-08-28, on a call where the row said drafted:
 * "I don't get anything on draft." A success we never read back is the same
 * shape as every other bug in this codebase, and the only way to tell "we wrote
 * it" from "it is there" is to go and look.
 *
 * Reads the well-known drafts folder rather than filtering on isDraft, because a
 * message can be a draft and live somewhere else entirely, and the question the
 * rep is asking is specifically about the folder they have open.
 */
export async function listDrafts(args: {
  tenantIdOrDomain: string;
  mailbox: string;
  top?: number;
}): Promise<Array<{ id: string; subject: string; createdDateTime: string; to: string[] }>> {
  assertMailboxAllowed(args.mailbox);
  const tenantId = await resolveGraphTenantId(args.tenantIdOrDomain);
  const token = await getAppOnlyToken(tenantId);
  const url =
    `${GRAPH_BASE}/users/${encodeURIComponent(args.mailbox)}/mailFolders/drafts/messages` +
    `?$select=id,subject,createdDateTime,toRecipients&$top=${args.top ?? 25}&$orderby=createdDateTime desc`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new GraphMailError(res.status, `list drafts for ${args.mailbox}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    value?: Array<{ id: string; subject?: string; createdDateTime?: string; toRecipients?: Array<{ emailAddress?: { address?: string } }> }>;
  };
  return (json.value ?? []).map((m) => ({
    id: String(m.id),
    subject: String(m.subject ?? ""),
    createdDateTime: String(m.createdDateTime ?? ""),
    to: (m.toRecipients ?? []).map((r) => String(r.emailAddress?.address ?? "")).filter(Boolean),
  }));
}

/**
 * Files attached to messages a rep has already SENT.
 *
 * Juan Lopez sends the same two datasheets after almost every call and does not
 * have the source PDFs to hand; they live in his own sent mail, attached to the
 * two emails he pointed at as worked examples. Reading them back out is better
 * than asking anyone to dig them up, and it gets the exact file the customer
 * actually receives rather than a copy that may have drifted.
 *
 * Searched by subject rather than by message id, because ids are per-mailbox and
 * the examples were identified by what they say, not by an id anybody recorded.
 */
export async function findSentAttachments(args: {
  tenantIdOrDomain: string;
  mailbox: string;
  /** Only messages sent on or after this instant. */
  since: Date;
  top?: number;
}): Promise<Array<{ id: string; subject: string; sentAt: string; to: string[]; attachments: Array<{ id: string; name: string; contentType: string; size: number }> }>> {
  assertMailboxAllowed(args.mailbox);
  const tenantId = await resolveGraphTenantId(args.tenantIdOrDomain);
  const token = await getAppOnlyToken(tenantId);
  const user = encodeURIComponent(args.mailbox);
  // ONE FILTER TERM, sorted separately. Combining hasAttachments with a
  // sentDateTime range and an orderby is rejected as InefficientFilter: Exchange
  // will not serve that shape however correct the OData is. Filtering on the
  // date and checking hasAttachments client side is the query it will actually
  // run, and the sent-items folder is small enough that it costs nothing.
  const filter = encodeURIComponent(`sentDateTime ge ${args.since.toISOString()}`);
  const url =
    `${GRAPH_BASE}/users/${user}/mailFolders/sentitems/messages?$filter=${filter}` +
    `&$select=id,subject,sentDateTime,toRecipients,hasAttachments&$top=${args.top ?? 60}&$orderby=sentDateTime desc`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new GraphMailError(res.status, `list attachments for ${args.mailbox}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    value?: Array<{ id: string; subject?: string; sentDateTime?: string; hasAttachments?: boolean; toRecipients?: Array<{ emailAddress?: { address?: string } }> }>;
  };

  // The MESSAGE id is returned too. readAttachment needs it, and leaving it off
  // made every read fail with nothing to look up.
  const out: Array<{ id: string; subject: string; sentAt: string; to: string[]; attachments: Array<{ id: string; name: string; contentType: string; size: number }> }> = [];
  for (const m of (json.value ?? []).filter((m) => m.hasAttachments)) {
    const ar = await fetch(
      `${GRAPH_BASE}/users/${user}/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!ar.ok) continue;
    const aj = (await ar.json()) as { value?: Array<{ id: string; name?: string; contentType?: string; size?: number }> };
    out.push({
      id: String(m.id),
      subject: String(m.subject ?? ""),
      sentAt: String(m.sentDateTime ?? ""),
      to: (m.toRecipients ?? []).map((r) => String(r.emailAddress?.address ?? "")).filter(Boolean),
      attachments: (aj.value ?? []).map((a) => ({
        id: String(a.id),
        name: String(a.name ?? ""),
        contentType: String(a.contentType ?? ""),
        size: Number(a.size ?? 0),
      })),
    });
  }
  return out;
}

/** One attachment's bytes, base64, as Graph stores them. */
export async function readAttachment(args: {
  tenantIdOrDomain: string;
  mailbox: string;
  messageId: string;
  attachmentId: string;
}): Promise<{ name: string; contentType: string; contentBytes: string } | null> {
  assertMailboxAllowed(args.mailbox);
  const tenantId = await resolveGraphTenantId(args.tenantIdOrDomain);
  const token = await getAppOnlyToken(tenantId);
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(args.mailbox)}/messages/${encodeURIComponent(args.messageId)}/attachments/${encodeURIComponent(args.attachmentId)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const j = (await res.json()) as { name?: string; contentType?: string; contentBytes?: string };
  if (!j.contentBytes) return null;
  return { name: String(j.name ?? ""), contentType: String(j.contentType ?? ""), contentBytes: String(j.contentBytes) };
}

/**
 * Put a real file on a draft, so the rep opens it already attached.
 *
 * Juan promises a datasheet on almost every discovery call and then attaches it
 * by hand. Naming it in the card was the honest half-measure while we had no
 * file; the PDFs now sit in assets/collateral, pulled from his own sent mail, so
 * the draft can carry them.
 *
 * fileAttachment, not a reference: a link to a file the customer cannot open is
 * worse than no attachment. Graph caps a simple upload at about 3MB and both
 * datasheets are well under, so no upload session is needed and none is built,
 * because an untested code path for a case that does not occur is a liability
 * rather than coverage. A file over the cap is refused loudly instead.
 *
 * Throws on failure. The caller decides what a failed attachment costs, and for
 * a follow-up draft the answer is nothing: the draft is already written and a
 * missing file is a line in the card, not a lost email.
 */
/**
 * Delete a DRAFT from a mailbox.
 *
 * Narrow on purpose. Nothing here should ever delete a rep's real mail, so this
 * refuses anything that is not currently a draft: the id is read back first and
 * a message that has been sent, or that Graph no longer has, is left alone.
 *
 * Written because a self-test of the attachment path left a draft in Juan's
 * mailbox, and debris in a customer's rep's inbox is not something to leave for
 * them to find.
 */
export async function deleteDraft(args: {
  tenantIdOrDomain: string;
  mailbox: string;
  draftId: string;
}): Promise<"deleted" | "not_a_draft" | "gone"> {
  assertMailboxAllowed(args.mailbox);
  const tenantId = await resolveGraphTenantId(args.tenantIdOrDomain);
  const token = await getAppOnlyToken(tenantId);
  const base = `${GRAPH_BASE}/users/${encodeURIComponent(args.mailbox)}/messages/${encodeURIComponent(args.draftId)}`;

  const check = await fetch(`${base}?$select=id,isDraft`, { headers: { authorization: `Bearer ${token}` } });
  if (check.status === 404) return "gone";
  if (!check.ok) throw new GraphMailError(check.status, `read before delete: ${(await check.text()).slice(0, 200)}`);
  const j = (await check.json()) as { isDraft?: boolean };
  if (j.isDraft !== true) return "not_a_draft";

  const res = await fetch(base, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) {
    throw new GraphMailError(res.status, `delete draft: ${(await res.text()).slice(0, 200)}`);
  }
  return "deleted";
}

export async function attachFileToDraft(args: {
  tenantIdOrDomain: string;
  mailbox: string;
  /** The Graph message id from createDraft, valid while it is still a draft. */
  draftId: string;
  filename: string;
  contentType: string;
  /** Raw bytes. Base64 encoding happens here so callers do not each do it. */
  bytes: Buffer;
  /**
   * Set for a signature image, so the body's cid: reference resolves.
   *
   * An inline attachment does not show as a paper clip; it is the picture in
   * the mail. Without both isInline and contentId Outlook renders a broken
   * image, which on outgoing customer mail is worse than no image at all.
   */
  contentId?: string;
  isInline?: boolean;
}): Promise<void> {
  assertMailboxAllowed(args.mailbox);
  const MAX = 3_000_000;
  if (args.bytes.length > MAX) {
    throw new GraphMailError(
      413,
      `${args.filename} is ${Math.round(args.bytes.length / 1024)}KB, over the ${MAX / 1_000_000}MB simple-upload limit`,
    );
  }
  const tenantId = await resolveGraphTenantId(args.tenantIdOrDomain);
  const token = await getAppOnlyToken(tenantId);
  const res = await fetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(args.mailbox)}/messages/${encodeURIComponent(args.draftId)}/attachments`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: args.filename,
        contentType: args.contentType,
        contentBytes: args.bytes.toString("base64"),
        ...(args.contentId ? { contentId: args.contentId, isInline: args.isInline ?? true } : {}),
      }),
    },
  );
  if (!res.ok) {
    throw new GraphMailError(res.status, `attach ${args.filename} to ${args.mailbox}: ${(await res.text()).slice(0, 300)}`);
  }
}

/**
 * Replace a draft's body. Nothing is sent.
 *
 * Used to swap a plain-text body for the HTML one a rep's real signature needs,
 * after the draft exists and its inline images can be attached to it.
 */
export async function updateDraftBody(args: {
  tenantIdOrDomain: string;
  mailbox: string;
  draftId: string;
  html: string;
}): Promise<void> {
  assertMailboxAllowed(args.mailbox);
  const tenantId = await resolveGraphTenantId(args.tenantIdOrDomain);
  const token = await getAppOnlyToken(tenantId);
  const res = await fetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(args.mailbox)}/messages/${encodeURIComponent(args.draftId)}`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ body: { contentType: "HTML", content: args.html } }),
    },
  );
  if (!res.ok) {
    throw new GraphMailError(res.status, `update draft body for ${args.mailbox}: ${(await res.text()).slice(0, 300)}`);
  }
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
  const json = (await res.json()) as { id?: string; webLink?: string; internetMessageId?: string };
  if (!json.id) throw new GraphMailError(res.status, "Graph returned no message id");
  return { id: json.id, internetMessageId: json.internetMessageId ?? null, webLink: json.webLink ?? null };
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
  /**
   * Override the recipients Graph seeded from the thread.
   *
   * createReply addresses whoever sent the LAST message on the thread. When a
   * BDR booked the meeting, that is the BDR, so the rep's follow-up to the
   * customer was being addressed to a colleague. Eduardo caught this on
   * 2026-08-14: "your recap email is going out to that BDR instead of the
   * prospect in the meeting."
   *
   * Empty or omitted leaves Graph's own recipients alone, which is correct when
   * the thread genuinely is with the customer.
   */
  toRecipients?: ReadonlyArray<string>;
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
    internetMessageId?: string;
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
    body: JSON.stringify({
      body: { contentType, content },
      // Only when the caller supplied them. Sending an empty array would clear
      // the recipients entirely and leave the rep a draft addressed to nobody.
      ...(args.toRecipients && args.toRecipients.length > 0
        ? { toRecipients: args.toRecipients.map((a) => ({ emailAddress: { address: a } })) }
        : {}),
    }),
  });
  if (!patchRes.ok) throw new GraphMailError(patchRes.status, await patchRes.text());

  return { id: draft.id, internetMessageId: draft.internetMessageId ?? null, webLink: draft.webLink ?? null };
}
