/**
 * Force the follow-up draft retry now, instead of waiting for transcript-sync's
 * five minute tick. For the case where a code defect cost a rep their draft and
 * the fix is already live.
 *
 *   npx tsx scripts/run-draft-retry.ts
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { retryFailedDrafts } from "../lib/transcript-sync";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const state = async () => {
  const { data } = await sb.from("calls")
    .select("followup_draft_state, followup_draft_reason, deals!inner(account, rep_email)")
    .in("followup_draft_state", ["failed", "unavailable", "drafted"])
    .gte("scheduled_start", new Date(Date.now() - 2 * 864e5).toISOString());
  return (data ?? []) as any[];
};
(async () => {
  console.log("  before:");
  for (const c of await state()) console.log(`    ${String(c.deals.account).padEnd(20)} ${String(c.deals.rep_email).split("@")[0].padEnd(11)} ${c.followup_draft_state}`);
  console.log("\n  running retry...\n");
  await retryFailedDrafts();
  console.log("  after:");
  for (const c of await state()) console.log(`    ${String(c.deals.account).padEnd(20)} ${String(c.deals.rep_email).split("@")[0].padEnd(11)} ${String(c.followup_draft_state).padEnd(13)} ${String(c.followup_draft_reason ?? "").slice(0,60)}`);
})().catch(e => console.error("ERR:", e instanceof Error ? e.message : e));
