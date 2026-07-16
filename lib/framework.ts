/**
 * Qualification framework configuration loader.
 *
 * The extraction layer is parameterized by framework: topsort uses the
 * seeded SCOTSMAN builtin; magaya will use a Rolldog Stage Gates
 * framework ingested at kickoff. The prompt assembly, validation, and
 * field_extractions upsert all key off this module.
 *
 * Backed by qualification_frameworks + framework_fields tables. A
 * module-scope cache eliminates per-request round-trips; cold starts
 * bust it, which is the right tradeoff for a config that rarely changes.
 *
 * Cache invariant: a Framework object in the cache is immutable.
 */

import { cache } from "react";
import { supabaseAdmin } from "./supabase";
import type { Json } from "./database.types";

export type FrameworkSource = "builtin" | "rolldog" | "manual";

/**
 * CRM write target metadata for a single framework field. Optional;
 * fields without a write_target are extraction-only. The shape varies
 * by system (rolldog stage-gate items cap at 300 chars; salesforce
 * pointers carry SObject + field names).
 */
export type WriteTarget = {
  system: "rolldog" | "salesforce";
  [key: string]: unknown;
};

export type FrameworkField = {
  fieldKey: string;
  label: string;
  question: string;
  stageKey: string | null;
  writeTarget: WriteTarget | null;
  sortOrder: number;
};

export type Framework = {
  id: string;
  tenantId: string;
  name: string;
  source: FrameworkSource;
  fields: FrameworkField[];
};

// ====================================================================
// Cache invalidation contract (no-op)
// ====================================================================

/**
 * Framework loading is request-scoped via React cache() (see loadFramework):
 * memoized within a single request and discarded at request end, so it can
 * never serve a stale entry across requests. There is NO process-wide cache to
 * invalidate. (A module-level Map used to live here and caused a stale
 * framework to survive a runtime repoint until redeploy, which is exactly the
 * bug this design avoids.) Kept as a no-op for the seed script's contract.
 */
export function __invalidateFrameworkCache(_tenantId: string): void {
  /* no-op: nothing persists across requests */
}

// ====================================================================
// Public API
// ====================================================================

/**
 * Load a framework by tenant and (optionally) framework id. When frameworkId is
 * omitted the tenant's first framework by created_at is returned (the "default
 * framework" convention).
 *
 * Wrapped in React cache() so it's loaded at most once per request but never
 * cached across requests. Returns null when no framework matches. Throws on
 * Supabase errors.
 */
export const loadFramework = cache(async (
  tenantId: string,
  frameworkId?: string,
): Promise<Framework | null> => {
  const db = supabaseAdmin();
  const fwQuery = db
    .from("qualification_frameworks")
    .select("id, tenant_id, name, source, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  const fwRes = frameworkId
    ? await fwQuery.eq("id", frameworkId).maybeSingle()
    : await fwQuery.limit(1).maybeSingle();
  if (fwRes.error) {
    throw new Error(
      `framework lookup failed for tenant=${tenantId}${
        frameworkId ? ` framework=${frameworkId}` : ""
      }: ${fwRes.error.message}`,
    );
  }
  if (!fwRes.data) return null;

  const fieldsRes = await db
    .from("framework_fields")
    .select("field_key, label, question, stage_key, write_target, sort_order")
    .eq("framework_id", fwRes.data.id)
    .order("sort_order", { ascending: true });
  if (fieldsRes.error) {
    throw new Error(
      `framework_fields lookup failed for framework=${fwRes.data.id}: ${fieldsRes.error.message}`,
    );
  }

  const framework: Framework = {
    id: fwRes.data.id,
    tenantId: fwRes.data.tenant_id,
    name: fwRes.data.name,
    source: fwRes.data.source as FrameworkSource,
    fields: (fieldsRes.data ?? []).map((r) => ({
      fieldKey: r.field_key,
      label: r.label,
      question: r.question,
      stageKey: r.stage_key,
      writeTarget: normalizeWriteTarget(r.write_target),
      sortOrder: r.sort_order,
    })),
  };

  return framework;
});

/**
 * Resolve the framework for a deal. Order of precedence:
 *   1. deals.framework_id if set
 *   2. tenant's default framework (first by created_at)
 *
 * Returns null only when neither resolves (the tenant has no framework
 * registered). Throws on Supabase errors.
 */
export async function getFrameworkForDeal(
  dealId: string,
): Promise<Framework | null> {
  const db = supabaseAdmin();
  const dealRow = await db
    .from("deals")
    .select("framework_id, tenant_id")
    .eq("id", dealId)
    .maybeSingle();
  if (dealRow.error) {
    throw new Error(
      `deal lookup failed for id=${dealId}: ${dealRow.error.message}`,
    );
  }
  if (!dealRow.data) return null;

  if (dealRow.data.framework_id) {
    return loadFramework(dealRow.data.tenant_id, dealRow.data.framework_id);
  }
  return loadFramework(dealRow.data.tenant_id);
}

// ====================================================================
// Internals
// ====================================================================

function normalizeWriteTarget(raw: Json | null): WriteTarget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.system !== "string") return null;
  if (obj.system !== "rolldog" && obj.system !== "salesforce") return null;
  return obj as WriteTarget;
}
