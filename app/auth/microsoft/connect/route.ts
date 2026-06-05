import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

import { getAuthorizeEndpoint } from "@/lib/microsoft-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPE = [
  "openid",
  "profile",
  "offline_access",
  "https://graph.microsoft.com/Calendars.Read",
].join(" ");

const STATE_COOKIE = "ms_oauth_state";
const STATE_COOKIE_MAX_AGE_SECONDS = 600;

/**
 * Begin the Microsoft OAuth flow. Generates a random state, stores it
 * in a short-lived httpOnly cookie scoped to /auth/microsoft, and
 * redirects to login.microsoftonline.com.
 *
 * The state cookie + state query param are verified together in
 * /auth/microsoft/callback to prevent CSRF on the OAuth response.
 */
export async function GET(): Promise<Response> {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return new Response(
      renderError(
        "Microsoft OAuth is not configured",
        "MICROSOFT_CLIENT_ID and MICROSOFT_REDIRECT_URI must be set in the environment.",
      ),
      { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  const state = randomBytes(32).toString("base64url");

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: SCOPE,
    state,
  });

  const redirect = NextResponse.redirect(`${getAuthorizeEndpoint()}?${params.toString()}`);
  redirect.cookies.set({
    name: STATE_COOKIE,
    value: state,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/auth/microsoft",
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  });
  return redirect;
}

function renderError(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>DealRipe | Error</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#fff;color:#0F172A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{max-width:480px;padding:32px;border:1px solid #FEE2E2;border-radius:12px}h1{font-size:20px;margin:0 0 12px;color:#EF4444}p{margin:0;line-height:1.5;color:#475569}</style>
</head><body><div class="card"><h1>${escape(title)}</h1><p>${escape(detail)}</p></div></body></html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
