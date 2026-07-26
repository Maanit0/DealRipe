/**
 * Tenant-aware navigation helpers.
 *
 * The pilot tenant is "magaya" and its URLs must stay byte-identical to what
 * they were before multi-tenant links existed (so no diff for the pilot). For
 * every other tenant (e.g. the "keelson" demo), append `?tenant=<slug>` so
 * navigation preserves the active tenant.
 *
 * Rule: when tenant === "magaya", return the path untouched. Otherwise add the
 * tenant query param, respecting any query string already on the path.
 */

export const DEFAULT_TENANT_SLUG = "magaya";

/**
 * Append `?tenant=<slug>` to a path for non-default tenants; return the path
 * unchanged for the default (magaya) tenant so pilot links never change.
 */
export function withTenant(path: string, tenant: string): string {
  if (tenant === DEFAULT_TENANT_SLUG) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}tenant=${encodeURIComponent(tenant)}`;
}

/**
 * The pipeline URL always carries the tenant param (the live pipeline path is
 * gated on it). For magaya this yields the exact `/pipeline?tenant=magaya` the
 * app used before.
 */
export function pipelineHref(tenant: string): string {
  return `/pipeline?tenant=${encodeURIComponent(tenant)}`;
}

/** A human-facing tenant title. magaya keeps its exact label. */
export function tenantTitle(tenant: string): string {
  if (tenant === DEFAULT_TENANT_SLUG) return "Magaya";
  return tenant.charAt(0).toUpperCase() + tenant.slice(1);
}
