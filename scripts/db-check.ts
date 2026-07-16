/**
 * Ground truth for one deal from whatever Supabase .env.local points at, plus
 * the Supabase host so you can compare it to Vercel's NEXT_PUBLIC_SUPABASE_URL.
 * If the host here differs from Vercel's, the scripts and production are talking
 * to different databases. Read-only.
 *
 *   npx tsx scripts/db-check.ts a64e1dd9-6e37-42f3-898c-54ce755c1c6a
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";

async function main(): Promise<void> {
  const dealId = process.argv[2];
  if (!dealId) {
    console.error("Usage: npx tsx scripts/db-check.ts <deal-uuid>");
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(unset)";
  console.log(`\nSupabase host (.env.local): ${url}`);
  console.log("Compare this to NEXT_PUBLIC_SUPABASE_URL in Vercel's env. If different, that's the whole problem.\n");

  const db = supabaseAdmin();

  const deal = await db
    .from("deals")
    .select("id, external_id, account, framework_id")
    .eq("id", dealId)
    .maybeSingle();
  if (deal.error) {
    console.error("deal read error:", deal.error.message);
    process.exit(1);
  }
  if (!deal.data) {
    console.log(`No deal with id ${dealId} in THIS database. (Likely a different DB than production.)`);
    return;
  }

  let fwName = "(none)";
  let fieldCount = 0;
  if (deal.data.framework_id) {
    const fw = await db
      .from("qualification_frameworks")
      .select("name")
      .eq("id", deal.data.framework_id)
      .maybeSingle();
    fwName = fw.data?.name ?? "(missing)";
    const ff = await db
      .from("framework_fields")
      .select("id", { count: "exact", head: true })
      .eq("framework_id", deal.data.framework_id);
    fieldCount = ff.count ?? 0;
  }

  const fx = await db
    .from("field_extractions")
    .select("id", { count: "exact", head: true })
    .eq("deal_id", dealId);

  const msgs = await db
    .from("sent_messages")
    .select("kind, subject, sent_at")
    .eq("deal_id", dealId)
    .order("sent_at", { ascending: false });

  const calls = await db
    .from("calls")
    .select("scheduled_start, duration_minutes, outcome")
    .eq("deal_id", dealId);

  console.log(`Deal:        ${deal.data.external_id}  "${deal.data.account}"`);
  console.log(`Framework:   ${fwName}  (${fieldCount} fields)  id=${deal.data.framework_id ?? "none"}`);
  console.log(`Extractions: ${fx.count ?? 0} rows`);
  console.log(`Calls:       ${(calls.data ?? []).map((c) => `${c.scheduled_start ?? "?"} ${c.duration_minutes ?? "?"}min outcome=${c.outcome ?? "-"}`).join(" | ") || "(none)"}`);
  console.log(`Sent msgs:   ${(msgs.data ?? []).length}`);
  for (const m of msgs.data ?? []) console.log(`   - [${m.kind}] ${m.subject}`);
  console.log("");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
