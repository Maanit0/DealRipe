/**
 * Reset/set the outcome of a deal's no-content call(s). Use to undo a misclick
 * (set back to 'no_conversation' so the rep classifies it) or to correct a
 * classification. Only touches calls already in the no-content set; never
 * overrides a captured call. Read-only unless --apply.
 *
 *   npx tsx scripts/set-call-outcome.ts --deal dutyfreeamericas --to no_conversation
 *   npx tsx scripts/set-call-outcome.ts --call <uuid> --to rescheduled --apply
 *
 * --call targets ONE call. Without it every changeable call on the deal moves,
 * which is wrong whenever two calls failed for different reasons: Dunavant has
 * a lobby timeout on 2026-08-19 that is a real miss and a refusal on 08-20 that
 * was a reschedule, and they must not be corrected together.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const NO_CONTENT = ["no_conversation", "no_show", "rescheduled", "placeholder"];

/**
 * Outcomes this tool may change FROM.
 *
 * The no-content set plus capture_failed. A capture failure has no transcript
 * and no extraction behind it, so correcting one destroys nothing, and it is
 * the case that actually needs correcting: the bot's own evidence cannot tell
 * a lost demo from a meeting that was rescheduled in the first minute.
 *
 * Dunavant, 2026-08-20, is the example. The bot was denied 44 seconds after
 * joining and the call recorded as capture_failed / lobby_refused, which counts
 * against capture rate as a lost recording. Eduardo: "The call was rescheduled
 * on the spot per their request so no recording is needed." A human knew; the
 * status changes could not.
 *
 * `captured` is still never overridden. A call with a transcript has downstream
 * state (extraction, recap, prescriptions) and changing its outcome would
 * orphan all of it.
 */
const CHANGEABLE_FROM = [...NO_CONTENT, "capture_failed"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ext = arg("--deal");
  const to = arg("--to") ?? "no_conversation";
  const apply = process.argv.includes("--apply");
  if (!ext) {
    console.error("Usage: --deal <external_id> --to <outcome> [--apply]");
    process.exit(1);
  }
  if (!NO_CONTENT.includes(to)) {
    console.error(`--to must be one of: ${NO_CONTENT.join(", ")}`);
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const deal = await db
    .from("deals")
    .select("id, account")
    .eq("tenant_id", tenantId)
    .eq("external_id", ext)
    .maybeSingle();
  if (deal.error || !deal.data) {
    console.error(`Deal '${ext}' not found.`);
    process.exit(1);
  }

  const calls = await db
    .from("calls")
    .select("id, scheduled_start, outcome")
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.data.id)
    .in("outcome", CHANGEABLE_FROM);
  const onlyCall = arg("--call");
  const targets = (calls.data ?? []).filter((c) => !onlyCall || (c as { id: string }).id === onlyCall);
  if (targets.length === 0) {
    console.log(`No changeable calls on ${deal.data.account}. Only ${CHANGEABLE_FROM.join(", ")} can be corrected; a captured call is never overridden.`);
    return;
  }

  console.log(`${deal.data.account}: ${targets.length} call(s) -> outcome '${to}'`);
  for (const c of targets) console.log(`  ${c.scheduled_start ?? c.id}: ${c.outcome} -> ${to}`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply.");
    return;
  }
  const upd = await db
    .from("calls")
    .update({ outcome: to })
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.data.id)
    .in("outcome", CHANGEABLE_FROM)
    // Without this the update ignores --call and rewrites every changeable
    // row on the deal, which is exactly the mistake the flag exists to avoid.
    .in("id", targets.map((c) => (c as { id: string }).id));
  if (upd.error) {
    console.error(`Update failed: ${upd.error.message}`);
    process.exit(1);
  }
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
