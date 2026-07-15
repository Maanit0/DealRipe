/**
 * Ground truth: dump exactly what listUpcomingMeetings (the sync's data source)
 * returns for Juan over the 7-day sync window. Run it a couple of times to see
 * whether Core Logistics is consistently present. Read-only.
 *
 *   npx tsx scripts/dump-calendar.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { listUpcomingMeetings } from "../lib/microsoft-graph";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const conns = await supabaseAdmin()
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  const juan = (conns.data ?? []).find((c) => c.user_principal_name === "jlopez@magaya.com");
  if (!juan) {
    console.error("no jlopez connection");
    process.exit(1);
  }

  console.log("now:", new Date().toISOString());
  const events = await listUpcomingMeetings(juan.id, 7);
  console.log(`jlopez: ${events.length} events in the 7-day window\n`);
  for (const e of events) {
    const dom = Array.from(
      new Set(e.attendees.map((a) => a.email?.split("@")[1]).filter(Boolean)),
    ).join(",");
    console.log(
      `  ${e.start?.dateTime ?? "?"}  link=${e.joinUrl ? "Y" : "N"}  cancel=${e.isCancelled ? "Y" : "N"}  [${dom}]  ${e.subject ?? ""}`,
    );
  }
  const core = events.find((e) => (e.subject ?? "").toLowerCase().includes("core logistics"));
  console.log(`\nCore Logistics present: ${core ? "YES" : "NO"}${core ? ` (link=${core.joinUrl ? "Y" : "N"})` : ""}`);
}

main().catch((e) => {
  console.error("Unexpected error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
