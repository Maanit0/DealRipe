/**
 * Full dispatch history: every call row DealRipe has created, oldest first,
 * with whether a bot was armed, a transcript captured, extraction ran, and a
 * briefing sent. Answers "did we miss any eligible call, or were there none?"
 * Read-only.
 *
 *   npx tsx scripts/call-history.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const deals = await db
    .from("deals")
    .select("id, external_id, account")
    .eq("tenant_id", tenantId);
  const dealById = new Map((deals.data ?? []).map((d) => [d.id, d]));

  const calls = await db
    .from("calls")
    .select("deal_id, created_at, scheduled_start, call_date, source, recall_bot_id, transcript_id, has_been_extracted, briefing_sent_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (calls.error) {
    console.error(calls.error.message);
    process.exit(1);
  }

  const rows = calls.data ?? [];
  console.log(`\nTotal call rows: ${rows.length}\n`);
  let bots = 0;
  let transcripts = 0;
  for (const c of rows) {
    if (c.recall_bot_id) bots += 1;
    if (c.transcript_id) transcripts += 1;
    const d = dealById.get(c.deal_id);
    console.log(
      `created ${String(c.created_at ?? "?").padEnd(26)} meeting ${(c.scheduled_start ?? c.call_date ?? "?").toString().padEnd(26)} ${String(d?.account ?? c.deal_id).padEnd(20)} ` +
        `bot:${c.recall_bot_id ? "Y" : "-"} transcript:${c.transcript_id ? "Y" : "-"} extracted:${c.has_been_extracted ? "Y" : "-"} briefing:${c.briefing_sent_at ? "Y" : "-"}`,
    );
  }
  console.log(`\nSummary: ${rows.length} calls, ${bots} with a bot, ${transcripts} with a captured transcript.`);
  console.log("If the only bot rows are from the last couple of days, zero-joins was coverage scope, not a missed call.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
