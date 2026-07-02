/**
 * Decode the claims (middle segment) of a Supabase access token JWT.
 *
 * Edge-runtime safe: uses atob (available in Edge + Node 18+) and no
 * Node-only Buffer. Does NOT verify the signature — callers must trust
 * that the token came from a previously-verified Supabase session
 * (e.g. `supabase.auth.getUser()` succeeded first).
 *
 * Returns null on any parse failure. Never throws.
 */
export type AppAccessTokenClaims = {
  sub?: string;
  email?: string;
  tenant_id?: string;
  tenant_slug?: string;
  app_role?: "cro" | "operator";
  [key: string]: unknown;
};

export function decodeAccessTokenClaims(
  token: string | null | undefined,
): AppAccessTokenClaims | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64url = parts[1];
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as AppAccessTokenClaims;
  } catch {
    return null;
  }
}
