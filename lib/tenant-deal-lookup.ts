import { supabaseAdmin } from "./supabase";

/**
 * Resolve seed string IDs ('topsort' tenant slug, 'lumora-2026-q2' deal
 * external_id) to Supabase UUIDs. Module-scoped cache means the first
 * request hits the DB and subsequent requests return cached UUIDs.
 *
 * Cache is per-process. Vercel cold starts bust it; that's fine, one
 * extra round-trip after a cold start.
 */

const tenantCache = new Map<string, string>();
const dealCache = new Map<string, string>(); // key: `${tenantSlug}:${externalId}`

export async function resolveTenantId(slug: string): Promise<string> {
  const cached = tenantCache.get(slug);
  if (cached) return cached;

  const { data, error } = await supabaseAdmin()
    .from("tenants")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    throw new Error(`tenant lookup failed for slug='${slug}': ${error.message}`);
  }
  if (!data) {
    throw new Error(
      `tenant not found for slug='${slug}'. Run npm run migrate:extractions.`,
    );
  }

  tenantCache.set(slug, data.id);
  return data.id;
}

export async function resolveDealId(
  externalId: string,
  tenantSlug: string,
): Promise<string> {
  const cacheKey = `${tenantSlug}:${externalId}`;
  const cached = dealCache.get(cacheKey);
  if (cached) return cached;

  const tenantId = await resolveTenantId(tenantSlug);

  const { data, error } = await supabaseAdmin()
    .from("deals")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("external_id", externalId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `deal lookup failed for external_id='${externalId}': ${error.message}`,
    );
  }
  if (!data) {
    throw new Error(
      `deal not found for external_id='${externalId}'. Run npm run migrate:extractions.`,
    );
  }

  dealCache.set(cacheKey, data.id);
  return data.id;
}
