import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

import { decodeAccessTokenClaims } from "@/lib/jwt-claims";

/**
 * Two stacked gates:
 *
 *   1. Existing demo Basic Auth for /forecast and /demo. Unchanged from
 *      the pre-auth state. The public site links to "Book a demo", never
 *      to a self-serve demo.
 *
 *   2. Supabase magic-link auth for everything in SUPABASE_AUTH_GATE.
 *      Unauthenticated -> redirect to /login. Authenticated user with no
 *      app_users row (no tenant_id claim in JWT) -> redirect to /no-access.
 *
 * Everything else (landing page /, /rep-experience, /rep-onboarding,
 * /onboarding, /pipeline, /deals/*, the existing demo surfaces) remains
 * publicly reachable. The Supabase-auth list grows as real customer
 * data starts loading into those routes.
 */

const BASIC_AUTH_PATHS = [
  /^\/forecast(\/|$)/,
  /^\/demo(\/|$)/,
  // Pilot board: the live Magaya pipeline + deal pages carry NDA'd customer
  // data, so gate them behind the shared pilot password until per-user
  // magic-link login is turned on for these routes. Mark reaches the board at
  // /pipeline?tenant=magaya with the DEMO_ACCESS_USER / DEMO_ACCESS_PASSWORD.
  /^\/pipeline(\/|$)/,
  /^\/deals(\/|$)/,
];

const SUPABASE_AUTH_GATE = [
  /^\/operator(\/|$)/,
  /^\/no-access(\/|$)?$/,
];

const OPERATOR_ONLY = [/^\/operator(\/|$)/];

function denyBasic(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="DealRipe demo", charset="UTF-8"',
    },
  });
}

function checkBasicAuth(req: NextRequest): NextResponse | null {
  const { pathname } = req.nextUrl;
  if (!BASIC_AUTH_PATHS.some((re) => re.test(pathname))) return null;

  const user = process.env.DEMO_ACCESS_USER;
  const pass = process.env.DEMO_ACCESS_PASSWORD;
  const isProd = process.env.NODE_ENV === "production";

  if (!user || !pass) {
    return isProd ? denyBasic() : null;
  }

  const header = req.headers.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    let decoded = "";
    try {
      decoded = atob(encoded);
    } catch {
      return denyBasic();
    }
    const idx = decoded.indexOf(":");
    const u = idx >= 0 ? decoded.slice(0, idx) : "";
    const p = idx >= 0 ? decoded.slice(idx + 1) : "";
    if (u === user && p === pass) return null;
  }
  return denyBasic();
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // Gate 1: existing demo Basic Auth.
  const basicResult = checkBasicAuth(req);
  if (basicResult) return basicResult;

  // The Supabase client mutates response cookies on session refresh,
  // so we hold a mutable reference here.
  let response = NextResponse.next({ request: req });

  // Only spin up the Supabase client if env vars are configured. In a
  // fresh local dev without Supabase set up, fall through.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Update both request and response cookies so the downstream
        // server component sees the refreshed session in this same
        // request cycle.
        for (const { name, value } of cookiesToSet) {
          req.cookies.set(name, value);
        }
        response = NextResponse.next({ request: req });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Triggers session refresh if the access token is near expiry.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const needsAuth = SUPABASE_AUTH_GATE.some((re) => re.test(pathname));
  if (!needsAuth) {
    return response;
  }

  if (!user) {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  // /no-access is reachable while authenticated but without tenant_id.
  if (pathname === "/no-access" || pathname.startsWith("/no-access/")) {
    return response;
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = decodeAccessTokenClaims(session?.access_token);
  const tenantId = typeof claims?.tenant_id === "string" ? claims.tenant_id : null;
  const appRole =
    claims?.app_role === "cro" || claims?.app_role === "operator"
      ? claims.app_role
      : null;

  if (!tenantId) {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = "/no-access";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  if (OPERATOR_ONLY.some((re) => re.test(pathname)) && appRole !== "operator") {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = "/no-access";
    redirectUrl.searchParams.set("reason", "operator-only");
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  /*
   * Run middleware on every path EXCEPT:
   *   - /api/*       (cron + system routes; bearer / service-role auth)
   *   - /auth/*      (Supabase callback + Microsoft OAuth)
   *   - /_next/*     (Next.js build assets)
   *   - /favicon.ico (browser fetch)
   *   - any path with a file extension (.svg, .png, .css, .js, etc.)
   *
   * /login, /no-access, /operator are all included.
   */
  matcher: [
    "/((?!api|auth|_next/static|_next/image|favicon.ico|.*\\.).*)",
  ],
};
