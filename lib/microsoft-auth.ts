/**
 * Microsoft OAuth authority resolution.
 *
 * The authority is the path segment between login.microsoftonline.com
 * and /oauth2/v2.0/* and decides which Microsoft accounts can complete
 * the flow:
 *
 *   "organizations"  Azure AD work/school accounts only. The Magaya
 *                    pilot value and the production default.
 *   "common"         Work/school AND personal Microsoft accounts.
 *                    Useful for dev testing without an Azure AD tenant.
 *   "<tenant-uuid>"  A specific Azure AD tenant. Restricts the flow to
 *                    a single customer org.
 *
 * Read at every call site rather than cached at module load so a
 * .env.local change is picked up on the next request.
 */

const DEFAULT_AUTHORITY = "organizations";

export function getAuthority(): string {
  const v = process.env.MICROSOFT_AUTHORITY;
  return v && v.length > 0 ? v : DEFAULT_AUTHORITY;
}

export function getAuthorizeEndpoint(): string {
  return `https://login.microsoftonline.com/${getAuthority()}/oauth2/v2.0/authorize`;
}

export function getTokenEndpoint(): string {
  return `https://login.microsoftonline.com/${getAuthority()}/oauth2/v2.0/token`;
}
