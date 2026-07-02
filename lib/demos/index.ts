import type { ForecastTenant } from "./types";
import { TOPSORT } from "./topsort";
import { AWARE } from "./aware";
import { COBALT } from "./cobalt";
import { WESTCHESTER } from "./westchester";

export * from "./types";

/**
 * Registry of all prospect demos.
 *
 * These are STATIC pitch artifacts: no database, no live integrations,
 * shown only on the gated demo routes. Real production pilots (Magaya,
 * etc.) are Supabase-backed and do NOT live here -- see
 * lib/tenant-deal-lookup.ts + lib/pilot-config.ts.
 *
 * To add a prospect demo: copy _template/ to lib/demos/<prospect>/,
 * fill it in, then add an import + one line to DEMOS below.
 */
export const DEMOS: Record<string, ForecastTenant> = {
  topsort: TOPSORT,
  aware: AWARE,
  cobalt: COBALT,
  westchester: WESTCHESTER,
};

export const DEMO_LIST: ForecastTenant[] = Object.values(DEMOS);

export function getDemo(slug: string | null | undefined): ForecastTenant {
  if (slug && DEMOS[slug]) return DEMOS[slug];
  return DEMOS.topsort;
}
