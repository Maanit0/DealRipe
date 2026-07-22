/**
 * Preview a no-show follow-up draft for a deal WITHOUT emailing the rep.
 * Archives the draft to sent_messages so it shows on the deal page under Sent
 * communications. The draft content only depends on the account + its contacts,
 * so any deal with a captured call and a customer contact previews cleanly.
 *
 *   npx tsx scripts/preview-no-show.ts --deal auto:extrum.com            # dry-run (no email)
 *   npx tsx scripts/preview-no-show.ts --deal auto:extrum.com --send     # actually email the rep
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { sendNoShowFollowup } from "../lib/no-show-followup";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ext = arg("--deal");
  const send = process.argv.includes("--send");
  if (!ext) {
    console.error("Usage: --deal <external_id> [--send]");
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

  const call = await db
    .from("calls")
    .select("id, scheduled_start")
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.data.id)
    .order("scheduled_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (call.error || !call.data) {
    console.error(`No call found for '${ext}'.`);
    process.exit(1);
  }

  console.log(`${send ? "Sending" : "Previewing"} no-show follow-up for ${deal.data.account}...`);
  const res = await sendNoShowFollowup({ tenantId, callId: call.data.id, dryRun: !send });
  if (send) {
    console.log(res.sent ? `Draft emailed to ${res.to}.` : `Not sent: ${res.reason}`);
  } else {
    console.log(
      res.reason?.startsWith("dry-run")
        ? `Draft archived (no email) for ${res.to ?? "(no recipient)"}. Reload the deal page.`
        : `Skipped: ${res.reason}`,
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
