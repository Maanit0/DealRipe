/**
 * Build the Monday digest. One function, called by the cron that sends it and
 * by the preview that inspects it.
 *
 * WHY THIS FILE EXISTS.
 *
 * scripts/preview-digest.ts opens by explaining that previewing one renderer
 * while shipping another is worse than useless, because the preview looks like
 * a regression that has not happened. It was right, and it then became the
 * thing it warned about: the ranking, the flag engine, the per-deal narratives
 * and the forecast-why section were added to app/api/cron/digest/route.ts on
 * 2026-08-20 and never reached the preview. Anyone opening digest-preview.html
 * to check what Mark receives has since been reading a digest with no ranking,
 * no flags, no narratives and no "who moved the number" section.
 *
 * Copying the sequence into the preview a second time would drift a second
 * time. This is the codebase's own rule applied to itself: a diagnostic imports
 * production logic or it does not exist.
 *
 * Sends nothing. The caller sends.
 */

import { attachFlags, attachNarratives, rankForDigest } from "./digest-priority";
import { attachDoThis } from "./digest-synthesis";
import { renderPipelineDigestEmail } from "./emails/weekly-digest";
import { getForecastWhy } from "./forecast-why";
import { getPipelineChanges } from "./pipeline-changes";
import { recordAllDealSnapshots } from "./snapshot";

export type BuiltDigest = {
  email: ReturnType<typeof renderPipelineDigestEmail>;
  pc: Awaited<ReturnType<typeof getPipelineChanges>>;
  why: Awaited<ReturnType<typeof getForecastWhy>> | null;
  priority: ReturnType<typeof rankForDigest>;
  /** What the snapshot refresh did, so a caller can report it rather than guess. */
  snapshot: { refreshed: number } | { failed: string } | { skipped: true };
};

export async function buildWeeklyDigest(args: {
  tenantId: string;
  /** Trailing window. Defaults to the seven days the cron uses. */
  days?: number;
  recipientName?: string;
  baseUrl?: string;
  /**
   * Refresh snapshots before reading, as the cron does, so the digest reflects
   * any category a rep changed since the overnight run. The preview turns this
   * off to stay inert.
   */
  refreshSnapshots?: boolean;
}): Promise<BuiltDigest> {
  const { tenantId } = args;
  const days = args.days ?? 7;

  let snapshot: BuiltDigest["snapshot"] = { skipped: true };
  if (args.refreshSnapshots !== false) {
    // Fail soft. A snapshot error must not block the digest, so it is logged
    // and reported, and the build continues on existing history.
    try {
      snapshot = { refreshed: await recordAllDealSnapshots(tenantId) };
    } catch (err) {
      snapshot = { failed: err instanceof Error ? err.message : String(err) };
      console.error("[digest] pre-digest snapshot failed, continuing:", err);
    }
  }

  const untilIso = new Date().toISOString();
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const pc = await getPipelineChanges(tenantId, { sinceIso, untilIso });

  // Who moved the forecast this week and whether the calls back it. Runs in
  // parallel with the ranking and fails soft: the digest sends without the
  // section rather than not sending.
  const whyPromise = getForecastWhy({ tenantId, sinceIso, untilIso }).catch((err) => {
    console.error("[digest] forecast why failed, building without it:", err);
    return null;
  });

  // Rank ONCE, then spend the model calls on exactly what the email prints.
  // Until 2026-08-20 attachDoThis took the first 8 of pc.deals, sorted by
  // attention score, while the email re-sorted by annual value and printed 6.
  // Four of the six deals Mark reads carried only fallback text, including the
  // two largest, and 6 of 8 model calls went to deals he never saw.
  const priority = rankForDigest(pc.deals);
  await attachFlags(priority, tenantId);

  const why = await whyPromise;
  const changesByDeal = new Map<string, string[]>();
  for (const c of why?.changes ?? []) {
    const list = changesByDeal.get(c.dealId) ?? [];
    list.push(c.headline);
    changesByDeal.set(c.dealId, list);
  }
  await attachNarratives(priority, tenantId, changesByDeal);
  await attachDoThis(priority.ranked.map((r) => r.deal), priority.ranked.length);

  const weekLabel = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "America/Chicago",
  });

  const email = renderPipelineDigestEmail({
    pc,
    why,
    // The same object the synthesis was given, so the two sets cannot drift.
    priority,
    weekLabel,
    recipientName: args.recipientName ?? "Mark Buman",
    baseUrl: args.baseUrl,
  });

  return { email, pc, why, priority, snapshot };
}
