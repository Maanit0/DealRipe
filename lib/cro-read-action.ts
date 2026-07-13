"use server";

/**
 * Server action for saving Mark's day-0 read from the deal page. Gated by the
 * same Basic Auth middleware that protects /deals. Never throws to the client;
 * returns a small result object the form can render.
 */

import { upsertCroRead, type CroRead } from "./cro-read";
import { resolveTenantId } from "./tenant-deal-lookup";

export async function saveCroRead(
  dealId: string,
  read: CroRead,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const tenantId = await resolveTenantId("magaya");
    await upsertCroRead({ tenantId, dealId, read });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
