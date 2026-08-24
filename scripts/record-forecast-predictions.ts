/**
 * Record DealRipe's forecast call on every live deal, dated.
 *
 * The point is the DATE. A disagreement written down after the deal resolved is
 * not a prediction, and by January the deals currently in Commit and Expect will
 * have resolved. This is the only artifact that can show DealRipe was right
 * before anyone knew, and it stops being creatable the moment those deals close.
 *
 * Imports getPipelineChanges rather than recomputing bands, so the row recorded
 * is exactly what the leader was shown. A recorder that can disagree with the
 * digest it is recording would be worse than no recorder.
 *
 *   npx tsx scripts/record-forecast-predictions.ts            dry run
 *   npx tsx scripts/record-forecast-predictions.ts --apply    writes
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { getPipelineChanges } from "../lib/pipeline-changes";

const APPLY = process.argv.includes("--apply");
const TENANT = "magaya";

const asDate = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

(async () => {
  const tenantId = await resolveTenantId(TENANT);
  const until = new Date();
  const since = new Date(until.getTime() - 7 * 864e5);
  const changes = await getPipelineChanges(tenantId, {
    sinceIso: since.toISOString(),
    untilIso: until.toISOString(),
  });

  const today = until.toISOString().slice(0, 10);
  const rows = changes.deals
    // A deal DealRipe has never captured a call on has no evidence to predict
    // from, and recording "no_data" as a call would pollute the eventual score.
    .filter((d) => d.dealRipeCategory && d.dealHealth !== "no_data")
    .map((d) => ({
      tenant_id: tenantId,
      deal_id: d.dealId,
      predicted_on: today,
      rep_category: d.forecastCategory,
      dealripe_category: d.dealRipeCategory,
      disagrees: (d.forecastCategory ?? null) !== (d.dealRipeCategory ?? null),
      verdict_kind: d.verdict?.kind ?? null,
      verdict_text: d.verdict?.text ?? null,
      blockers: d.blockers ?? [],
      annual_value: d.dealSizeAnnual,
      rep_close_date: asDate(d.closeDate),
      stage_key: d.stageKey,
      gates_confirmed: d.gatesConfirmed,
      rep_email: d.repEmail,
      account: d.account,
    }));

  const disagreements = rows.filter((r) => r.disagrees);
  const value = disagreements.reduce((s, r) => s + (Number(r.annual_value) || 0), 0);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`FORECAST PREDICTIONS  ${today}`);
  console.log("=".repeat(78));
  console.log(`\n  ${changes.deals.length} live deals, ${rows.length} with a DealRipe call on them.`);
  console.log(`  ${disagreements.length} disagreements, $${value.toLocaleString()} annual.\n`);

  for (const r of disagreements.sort((a, b) => (Number(b.annual_value) || 0) - (Number(a.annual_value) || 0))) {
    const v = Number(r.annual_value) || 0;
    console.log(`  ${r.account}${v ? `  $${v.toLocaleString()}` : ""}`);
    console.log(`     rep ${r.rep_category ?? "none"}  ->  DealRipe ${r.dealripe_category}   [${r.verdict_kind}]`);
    if (r.verdict_text) console.log(`     ${r.verdict_text.slice(0, 120)}`);
  }

  const agreed = rows.length - disagreements.length;
  console.log(`\n  ${agreed} agreements also recorded. They matter: scoring only the`);
  console.log(`  disagreements would count DealRipe's wins and ignore its ties.`);

  if (!APPLY) {
    console.log(`\n  DRY RUN. Nothing written. Re-run with --apply.\n`);
    return;
  }
  const db = supabaseAdmin();
  const { error } = await db.from("forecast_predictions").upsert(rows, { onConflict: "deal_id,predicted_on" });
  if (error) throw new Error(error.message);
  console.log(`\n  WROTE ${rows.length} prediction row(s) dated ${today}.\n`);
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
