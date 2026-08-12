/**
 * Re-send the notes that were cut off at 280 characters.
 *
 * lib/crm-writer.ts capped every note at 280 on the strength of a comment
 * guessing Rolldog's limit was "around 300". On 2026-08-11 the probe wrote 316
 * characters to Custom Goods and Rolldog stored all 316, so the cap was wrong
 * and every note long enough to hit it has been sitting in the customer's CRM
 * ending in an ellipsis mid-sentence.
 *
 * This recomposes each deal's notes at the new cap and re-sends them.
 *
 * WHY IT DOES NOT DUPLICATE ANYTHING
 *
 * The note fields are PATCHed, so re-sending replaces the truncated value
 * rather than appending. The one thing that would duplicate is the next-step
 * activity, which is a create rather than an update, so nextAction is
 * deliberately never passed here and writeNextStep stays skipped.
 *
 * WHAT IT WILL NOT FIX
 *
 * It sends what the deal composes NOW. If a deal has gained answers since the
 * original write, the repaired note is fuller than the original rather than a
 * faithful restoration. That is the right outcome for a CRM (the note should be
 * current) but it means this is not a replay of history, and the audit row it
 * produces is dated today.
 *
 *   ROLLDOG_MAX_NOTE=1000 npx tsx scripts/repair-truncated-notes.ts
 *   ROLLDOG_MAX_NOTE=1000 npx tsx scripts/repair-truncated-notes.ts --apply
 *   ROLLDOG_MAX_NOTE=1000 npx tsx scripts/repair-truncated-notes.ts --apply --deal Beeimagine
 *
 * Set ROLLDOG_MAX_NOTE explicitly. Without it the default 280 applies and this
 * script has nothing to do, which it will tell you rather than quietly no-op.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runWithAuthorizedOpportunities } from "../lib/crm-scope";
import { syncDealToRolldog } from "../lib/crm-writer";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Composed payloads that were truncated look exactly like this. Cheap and
 *  unambiguous: capNote is the only thing that appends this character. */
const ELLIPSIS = "…";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const only = arg("--deal")?.toLowerCase() ?? null;
  // Mirrors lib/crm-writer: the default is the correct value, and the env var
  // only lowers it. There is nothing to set for this script to work.
  const envCap = Number(process.env.ROLLDOG_MAX_NOTE);
  const cap = Number.isFinite(envCap) && envCap >= 80 ? Math.floor(envCap) : 1000;

  console.log("");
  console.log(
    `Recomposing at ${cap} characters${process.env.ROLLDOG_MAX_NOTE ? " (from ROLLDOG_MAX_NOTE)" : " (default)"}. ` +
      `${apply ? "APPLYING." : "Dry run, nothing will be sent."}`,
  );

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);
  let deals = (dealsRes.data ?? []) as Array<Record<string, unknown>>;
  if (only) deals = deals.filter((d) => String(d.account ?? "").toLowerCase().includes(only));

  let touched = 0;
  let skipped = 0;

  for (const d of deals) {
    const account = String(d.account ?? "?");
    const target = resolveWriteTarget(d as never);
    if (!target.authorized) {
      skipped += 1;
      continue;
    }

    // Compose at the new cap and see whether anything grew past what the old
    // cap allowed. A payload with no long field cannot have been truncated.
    const preview = await syncDealToRolldog({
      tenantSlug: "magaya",
      dealId: String(d.id),
      rolldogOpportunityId: target.opportunityId,
      dryRun: true,
    });
    const grew = preview.filter(
      (r) => r.status === "preview" && typeof r.payload === "string" && longestField(r.payload) > 280,
    );
    if (grew.length === 0) {
      skipped += 1;
      continue;
    }

    touched += 1;
    console.log(`\n${account}  ·  opportunity ${target.opportunityId}`);
    for (const r of grew) {
      console.log(`  ${r.method.padEnd(22)} longest field now ${longestField(r.payload ?? "")} chars` +
        `${(r.payload ?? "").includes(ELLIPSIS) ? "  (still truncated at the new cap)" : ""}`);
    }

    if (!apply) continue;

    // No nextAction: the activity is a create and would duplicate.
    const results = await runWithAuthorizedOpportunities(target.runtimeAuth, () =>
      syncDealToRolldog({
        tenantSlug: "magaya",
        dealId: String(d.id),
        rolldogOpportunityId: target.opportunityId,
      }),
    );
    for (const r of results) {
      if (r.status === "ok") console.log(`    sent    ${r.method}`);
      else if (r.status === "error") console.log(`    FAILED  ${r.method}: ${r.error}`);
    }
  }

  console.log("");
  console.log(`${touched} deal(s) had a note past the old cap. ${skipped} needed nothing or cannot write.`);
  if (touched > 0 && !apply) console.log(`Re-run with --apply to send them.`);
  if (touched > 0 && apply) {
    console.log(`Values are recorded on these writes, so Activity shows the full text under`);
    console.log(`"Exact content written". Spot-check one against Rolldog itself.`);
  }
  console.log("");
}

/** Longest string value in a composed payload, whether JSON or "notes:\n..." */
function longestField(payload: string): number {
  try {
    const o = JSON.parse(payload) as Record<string, unknown>;
    return Math.max(0, ...Object.values(o).filter((v): v is string => typeof v === "string").map((v) => v.length));
  } catch {
    return payload.replace(/^notes:\n/, "").length;
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
