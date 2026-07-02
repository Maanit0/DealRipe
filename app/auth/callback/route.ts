import { NextRequest, NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Supabase magic-link callback.
 *
 * The email link arrives at this route with a one-time `code`. We
 * exchange the code for a session; @supabase/ssr drops the access +
 * refresh tokens into cookies (managed by lib/supabase-server.ts).
 *
 * On success: redirect to ?next or "/".
 * On any failure: redirect to /no-access?reason=exchange-failed (the
 * user is unauthenticated at that point; the middleware will then bounce
 * them to /login). Never leak the underlying error to the URL.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") || "/";

  if (code) {
    const supabase = createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Only allow same-origin relative paths in `next` to prevent
      // open-redirect.
      const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
      return NextResponse.redirect(new URL(safeNext, request.url));
    }
    console.error("[auth/callback] exchange failed:", error.message);
  } else {
    console.error("[auth/callback] no code in callback URL");
  }

  return NextResponse.redirect(
    new URL("/no-access?reason=exchange-failed", request.url),
  );
}
