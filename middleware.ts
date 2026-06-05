import { NextRequest, NextResponse } from "next/server";

/**
 * Access gate for the demo surfaces.
 *
 * /forecast and /demo are prospect demos, not public pages. They sit behind
 * HTTP Basic Auth so they are not crawlable or freely shareable. The public
 * site links to "Book a demo", never to a self-serve demo.
 *
 * Credentials come from env (set these in Vercel + .env.local):
 *   DEMO_ACCESS_USER
 *   DEMO_ACCESS_PASSWORD
 *
 * Behavior:
 *   - Production with creds set  -> require Basic Auth (fail closed).
 *   - Production with no creds    -> deny everything (fail closed) so a
 *                                    misconfig never exposes the demo.
 *   - Development (any)           -> allow through, so local work isn't blocked.
 */

const GATED = [/^\/forecast(\/|$)/, /^\/demo(\/|$)/];

function deny(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="DealRipe demo", charset="UTF-8"',
    },
  });
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (!GATED.some((re) => re.test(pathname))) return NextResponse.next();

  const user = process.env.DEMO_ACCESS_USER;
  const pass = process.env.DEMO_ACCESS_PASSWORD;
  const isProd = process.env.NODE_ENV === "production";

  if (!user || !pass) {
    // No creds configured: open in dev, fail closed in prod.
    return isProd ? deny() : NextResponse.next();
  }

  const header = req.headers.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    let decoded = "";
    try {
      decoded = atob(encoded);
    } catch {
      return deny();
    }
    const idx = decoded.indexOf(":");
    const u = idx >= 0 ? decoded.slice(0, idx) : "";
    const p = idx >= 0 ? decoded.slice(idx + 1) : "";
    if (u === user && p === pass) return NextResponse.next();
  }
  return deny();
}

export const config = {
  matcher: ["/forecast/:path*", "/demo/:path*"],
};
