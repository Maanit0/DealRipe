import { NextRequest, NextResponse } from "next/server";

import { allowedMailboxes } from "@/lib/graph-mail";
import { autoJoinRepEmails } from "@/lib/pilot-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What does the RUNNING deployment actually believe its configuration is?
 *
 * This exists because of a morning that could have cost a pilot day. The
 * question was simple, "is GRAPH_MAIL_ALLOWED_MAILBOXES set for all six reps in
 * production", and there was no way to ask it. `vercel env pull` answers a
 * different question: it reports what the dashboard holds, which differs from
 * what the running functions have whenever a variable was changed without a
 * redeploy, and which comes back empty for variables marked Sensitive. So an
 * empty pull is consistent with three states at once: genuinely unset, set but
 * unreadable, and set but not yet deployed. Exactly the ambiguity this codebase
 * keeps losing time to.
 *
 * The rules here:
 *
 *   1. It imports the same functions production uses. `allowedMailboxes` and
 *      `autoJoinRepEmails` are the real ones, not a re-parse of the env var. A
 *      checker that can disagree with the code it checks eventually will.
 *   2. It never returns a secret value, only whether one is present and how
 *      long it is. Length alone catches the common failure, a key pasted with
 *      its newlines mangled, without disclosing anything.
 *   3. Mailbox addresses ARE returned, in full. They are rep email addresses,
 *      not credentials, and redacting them would defeat the entire purpose.
 *
 * Auth is the same bearer as the crons, so it is not publicly readable.
 *
 *   curl -s -H "Authorization: Bearer $CRON_SECRET" \
 *     https://<deployment>/api/debug/config | jq
 *
 * READ ONLY. It makes no network calls and touches no customer data.
 */

/** Presence and shape of a secret, never its value. */
function secretShape(name: string): { set: boolean; length: number } {
  const v = process.env[name];
  return { set: Boolean(v && v.length > 0), length: v?.length ?? 0 };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 500 });
  }
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const reps = autoJoinRepEmails();
  const mailboxes = allowedMailboxes();

  // The check that actually matters. A rep on a calendar we join but not in the
  // mail allowlist gets a briefing and a recap and then no draft at all, because
  // assertMailboxAllowed throws and there is no allow-all fallback. That is the
  // silent half-working state, and it is invisible from the outside: the rep
  // sees email arriving and assumes the whole loop ran.
  const missing = reps.filter((r) => !mailboxes.includes(r));

  return NextResponse.json(
    {
      // Which build answered. Without this you cannot tell a fixed deployment
      // from a cached response off the old one.
      deployment: {
        env: process.env.VERCEL_ENV ?? "(not on vercel)",
        sha: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
        ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
        answeredAt: new Date().toISOString(),
      },

      mail: {
        // Stated as a verdict, not as two lists the reader has to diff by eye.
        allRepsCanDraft: missing.length === 0 && reps.length > 0,
        autoJoinReps: reps,
        allowedMailboxes: mailboxes,
        repsWithoutMailAccess: missing,
        note:
          mailboxes.length === 0
            ? "GRAPH_MAIL_ALLOWED_MAILBOXES is empty in the running deployment, so assertMailboxAllowed rejects every mailbox and NO rep gets a post-call draft."
            : missing.length > 0
              ? "These reps are joined on calendar but blocked for mail. They will get a briefing and a recap and no draft."
              : "Every auto-join rep can have a draft written to their mailbox.",
      },

      // Presence only. Each of these has failed at least once by being absent or
      // subtly malformed rather than by erroring.
      secrets: {
        MICROSOFT_CLIENT_SECRET: secretShape("MICROSOFT_CLIENT_SECRET"),
        SF_PRIVATE_KEY: secretShape("SF_PRIVATE_KEY"),
        // Must be ABSENT in production: a filesystem path for the key cannot
        // resolve on Vercel, and its presence has previously shadowed the
        // inline key.
        SF_PRIVATE_KEY_PATH_present: Boolean(process.env.SF_PRIVATE_KEY_PATH),
        SF_LOGIN_URL: process.env.SF_LOGIN_URL ?? null,
        SF_USERNAME: process.env.SF_USERNAME ?? null,
        ROLLDOG_CLIENT_SECRET: secretShape("ROLLDOG_CLIENT_SECRET"),
        RESEND_API_KEY: secretShape("RESEND_API_KEY"),
        ANTHROPIC_API_KEY: secretShape("ANTHROPIC_API_KEY"),
        RECALL_API_KEY: secretShape("RECALL_API_KEY"),
        SUPABASE_SERVICE_ROLE_KEY: secretShape("SUPABASE_SERVICE_ROLE_KEY"),
      },

      /**
       * Can the RUNNING FUNCTION read the files it attaches?
       *
       * The PDFs and the signature images are read at runtime with a path built
       * from process.cwd(), which Next's tracer cannot see, so a file committed
       * to git is not thereby beside a deployed function. That failed silently
       * for a week: every one of Juan's drafts came back from Graph with
       * hasAttachments false while the same code attached correctly on a
       * laptop. outputFileTracingIncludes fixes it, and nothing except asking
       * the deployment can confirm the fix.
       *
       * Sizes, not contents. A present-but-truncated file is the other way this
       * goes wrong and a byte count catches it.
       */
      assets: await readAssets(),

      routing: {
        DIGEST_TO: process.env.DIGEST_TO ?? null,
        DIGEST_BCC: process.env.DIGEST_BCC ?? null,
        MAIL_FROM: process.env.MAIL_FROM ?? null,
        DEALRIPE_APP_URL: process.env.DEALRIPE_APP_URL ?? null,
        ROLLDOG_WRITE_NEXT_STEP: process.env.ROLLDOG_WRITE_NEXT_STEP ?? null,
      },
    },
    { status: 200 },
  );
}

/** Bytes on disk for each runtime-read asset, or why not. */
async function readAssets(): Promise<Record<string, string>> {
  const { stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const wanted = [
    "assets/collateral/Magaya-Supply-Chain-Data-Sheet.pdf",
    "assets/collateral/Magaya-Rates-Solution-Sheet-02192024-1-.pdf",
    "assets/signatures/jlopez/signature.html",
    "assets/signatures/jlopez/image001.png",
    "assets/signatures/jlopez/image002.jpg",
    "assets/signatures/jlopez/image003.jpg",
    "assets/signatures/jlopez/image004.jpg",
    "assets/signatures/jlopez/image005.jpg",
  ];
  const out: Record<string, string> = {};
  for (const rel of wanted) {
    try {
      const st = await stat(join(process.cwd(), rel));
      out[rel] = `${st.size} bytes`;
    } catch (err) {
      out[rel] = `MISSING (${err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.message : String(err)})`;
    }
  }
  return out;
}
