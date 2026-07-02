/**
 * Email sending primitive (Resend).
 *
 * The one place DealRipe sends mail. Used by the post-call summary and the
 * pre-call briefing delivery. Kept deliberately small: a single sendEmail()
 * that takes rendered html + text and a recipient.
 *
 * Config (both required to actually send):
 *   RESEND_API_KEY  - Resend workspace API key.
 *   MAIL_FROM       - verified sender, e.g. "DealRipe <notify@dealripe.com>".
 *
 * The Resend package is imported lazily so code paths that only RENDER email
 * (the dry-run preview, tests) don't require the dependency or the API key.
 */

export class MailerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailerConfigError";
  }
}

export type SendEmailArgs = {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

export type SendEmailResult = { id: string };

// Cached client. Typed loosely to avoid a hard top-level dependency on the
// resend types; the shape we use is stable.
let _client: { emails: { send: (opts: unknown) => Promise<{ data: { id: string } | null; error: { message: string } | null }> } } | null =
  null;

async function getClient() {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new MailerConfigError(
      "RESEND_API_KEY is not set. Add it to .env.local (and Vercel) to send email.",
    );
  }
  if (_client) return _client;
  // Lazy import: only pulled in when a send actually happens.
  const mod = (await import("resend")) as unknown as {
    Resend: new (key: string) => typeof _client;
  };
  _client = new mod.Resend(key);
  return _client!;
}

export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  const from = process.env.MAIL_FROM;
  if (!from) {
    throw new MailerConfigError(
      'MAIL_FROM is not set. Set it to a verified sender, e.g. "DealRipe <notify@dealripe.com>".',
    );
  }
  const client = await getClient();
  const res = await client.emails.send({
    from,
    to: Array.isArray(args.to) ? args.to : [args.to],
    subject: args.subject,
    html: args.html,
    text: args.text,
    ...(args.replyTo ? { reply_to: args.replyTo } : {}),
  });
  if (res.error) {
    throw new Error(`Resend send failed: ${res.error.message}`);
  }
  return { id: res.data?.id ?? "" };
}
