import { NextRequest } from "next/server";

import { getTokenEndpoint } from "@/lib/microsoft-auth";
import { encryptToken } from "@/lib/token-crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPE = [
  "openid",
  "profile",
  "offline_access",
  "https://graph.microsoft.com/Calendars.Read",
].join(" ");

const STATE_COOKIE = "ms_oauth_state";
const PILOT_TENANT_SLUG = "magaya";

/**
 * Microsoft OAuth callback.
 *
 *   1. Verify the state cookie matches the state query param (CSRF).
 *   2. Exchange the authorization code for tokens at the
 *      /organizations/oauth2/v2.0/token endpoint.
 *   3. Decode the id_token payload (no signature verification: see
 *      "Pre-production hardening" note below).
 *   4. Encrypt the refresh_token and upsert into microsoft_connections
 *      keyed by (tenant_id, microsoft_user_id).
 *   5. Render a minimal "Calendar connected" page.
 *
 * Pre-production hardening (NOT done for the pilot):
 *   - id_token signature verification against Microsoft's JWKS. For
 *     production we will add a JWT library (jose or similar) that
 *     fetches https://login.microsoftonline.com/common/discovery/v2.0/keys
 *     and verifies signature + iss + aud + exp. For the pilot we trust
 *     the id_token because it arrived from the same TLS exchange that
 *     produced the access_token; the tokens themselves are validated
 *     by Microsoft when used.
 *   - Move CLIENT_SECRET to a managed secrets vault. Today it lives
 *     in MICROSOFT_CLIENT_SECRET env.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (errorParam) {
    return htmlResponse(
      400,
      renderError(
        "Microsoft rejected the connection",
        errorDescription ?? errorParam,
      ),
    );
  }

  if (!code || !stateParam) {
    return htmlResponse(
      400,
      renderError(
        "Missing code or state",
        "The Microsoft callback URL did not include both a code and a state parameter.",
      ),
    );
  }

  const stateCookie = request.cookies.get(STATE_COOKIE)?.value;
  if (!stateCookie || stateCookie !== stateParam) {
    return htmlResponse(
      400,
      renderError(
        "State mismatch",
        "The OAuth state cookie did not match the state returned by Microsoft. This usually means the connect link was opened in one browser and completed in another, or the cookie expired. Try again from /auth/microsoft/connect.",
      ),
    );
  }

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return htmlResponse(
      500,
      renderError(
        "Microsoft OAuth is not configured",
        "MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_REDIRECT_URI must be set in the environment.",
      ),
    );
  }

  // ----- 2. Exchange the code for tokens. -----

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope: SCOPE,
  });

  let tokenJson: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    scope?: string;
  };
  try {
    const res = await fetch(getTokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      // Microsoft returns JSON errors; surface the description but never
      // log the request body (it contains the client secret).
      let description = text;
      try {
        const parsed = JSON.parse(text) as { error_description?: string };
        if (parsed.error_description) description = parsed.error_description;
      } catch {
        // not JSON; fall through with the raw text
      }
      return htmlResponse(
        502,
        renderError("Microsoft token exchange failed", description),
      );
    }
    tokenJson = JSON.parse(text);
  } catch (err) {
    return htmlResponse(
      502,
      renderError(
        "Microsoft token exchange failed",
        err instanceof Error ? err.message : String(err),
      ),
    );
  }

  if (!tokenJson.refresh_token) {
    return htmlResponse(
      502,
      renderError(
        "Microsoft did not return a refresh_token",
        "The OAuth response was missing offline_access. Confirm the Azure app registration includes offline_access on the consented scopes.",
      ),
    );
  }
  if (!tokenJson.id_token) {
    return htmlResponse(
      502,
      renderError(
        "Microsoft did not return an id_token",
        "The OAuth response was missing the id_token. Confirm the request scope includes openid.",
      ),
    );
  }

  // ----- 3. Decode the id_token payload (no signature verification; see
  //          file header comment for the production hardening item). -----

  let claims: { upn?: string; preferred_username?: string; oid?: string };
  try {
    claims = decodeIdTokenPayload(tokenJson.id_token);
  } catch (err) {
    return htmlResponse(
      502,
      renderError(
        "Could not decode id_token",
        err instanceof Error ? err.message : String(err),
      ),
    );
  }

  const upn = claims.upn ?? claims.preferred_username ?? null;
  const oid = claims.oid ?? null;
  if (!oid) {
    return htmlResponse(
      502,
      renderError(
        "id_token missing oid claim",
        "Microsoft did not include the object id (oid) claim. This is required to key the connection.",
      ),
    );
  }

  // ----- 4. Encrypt refresh token and upsert. -----

  let encrypted: string;
  try {
    encrypted = encryptToken(tokenJson.refresh_token);
  } catch (err) {
    return htmlResponse(
      500,
      renderError(
        "Could not encrypt the refresh token",
        err instanceof Error ? err.message : String(err),
      ),
    );
  }

  let tenantId: string;
  try {
    tenantId = await resolveTenantId(PILOT_TENANT_SLUG);
  } catch (err) {
    return htmlResponse(
      500,
      renderError(
        `Could not resolve tenant '${PILOT_TENANT_SLUG}'`,
        "Run `npm run seed:magaya` first.",
      ),
    );
  }

  const db = supabaseAdmin();
  const upsert = await db
    .from("microsoft_connections")
    .upsert(
      {
        tenant_id: tenantId,
        user_principal_name: upn,
        microsoft_user_id: oid,
        refresh_token_encrypted: encrypted,
        scopes: tokenJson.scope ?? SCOPE,
        connected_at: new Date().toISOString(),
        last_synced_at: null,
      },
      { onConflict: "tenant_id,microsoft_user_id" },
    )
    .select("id")
    .single();

  if (upsert.error) {
    return htmlResponse(
      500,
      renderError(
        "Could not save the connection",
        upsert.error.message,
      ),
    );
  }

  // ----- 5. Clear the state cookie and render success. -----

  const successHtml = renderSuccess(upn ?? "this account");
  return new Response(successHtml, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Expire the state cookie immediately.
      "Set-Cookie": `${STATE_COOKIE}=; Path=/auth/microsoft; Max-Age=0; HttpOnly; SameSite=Lax${
        process.env.NODE_ENV === "production" ? "; Secure" : ""
      }`,
    },
  });
}

// ====================================================================
// Helpers
// ====================================================================

function decodeIdTokenPayload(idToken: string): Record<string, unknown> {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("id_token must have 3 segments");
  }
  const padded =
    parts[1].replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (parts[1].length % 4)) % 4);
  const json = Buffer.from(padded, "base64").toString("utf8");
  const parsed = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("id_token payload is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function htmlResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderSuccess(upn: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>DealRipe | Calendar connected</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#fff;color:#0F172A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{max-width:480px;padding:32px;border:1px solid #D1FAE5;border-radius:12px}h1{font-size:20px;margin:0 0 12px;color:#10B981}p{margin:0 0 8px;line-height:1.5;color:#475569}.muted{color:#94A3B8;font-size:13px;margin-top:16px}</style>
</head><body><div class="card"><h1>Calendar connected</h1><p>DealRipe can now read upcoming meetings from <strong>${escape(upn)}</strong>.</p><p class="muted">You can close this tab.</p></div></body></html>`;
}

function renderError(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>DealRipe | Connection failed</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#fff;color:#0F172A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{max-width:560px;padding:32px;border:1px solid #FEE2E2;border-radius:12px}h1{font-size:20px;margin:0 0 12px;color:#EF4444}p{margin:0 0 8px;line-height:1.5;color:#475569}code{font-family:"SFMono-Regular",ui-monospace,monospace;background:#F1F5F9;padding:2px 6px;border-radius:4px;font-size:12px}</style>
</head><body><div class="card"><h1>${escape(title)}</h1><p>${escape(detail)}</p><p><a href="/auth/microsoft/connect">Try again</a></p></div></body></html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
