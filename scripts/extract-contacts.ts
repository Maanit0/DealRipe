/**
 * Extract customer contacts from a deal's stored transcript and add any new
 * people to the deal (deduped by name). Use to backfill contacts for a deal
 * whose call happened before contact extraction existed. Dry run by default.
 *
 *   npx tsx scripts/extract-contacts.ts --deal auto:corelogistics.net
 *   npx tsx scripts/extract-contacts.ts --deal auto:corelogistics.net --apply
 *   npx tsx scripts/extract-contacts.ts --deal auto:corelogistics.net --apply --replace
 *       (--replace first deletes call-sourced contacts so they're re-added with
 *        the correct "last contacted" date; hand-added contacts are untouched.)
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { extractContactsFromTranscript, upsertDealContacts } from "../lib/contacts-extract";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ext = arg("--deal");
  const apply = process.argv.includes("--apply");
  const replace = process.argv.includes("--replace");
  if (!ext) {
    console.error("Usage: --deal <external_id> [--apply] [--replace]");
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
    .select("id, scheduled_start")
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.data.id)
    .order("scheduled_start", { ascending: false });
  let body: string | null = null;
  let callDate: string | null = null;
  for (const c of calls.data ?? []) {
    const t = await db.from("transcripts").select("body").eq("call_id", c.id).maybeSingle();
    if (t.data?.body) {
      body = t.data.body;
      callDate = c.scheduled_start ?? null;
      break;
    }
  }
  if (!body) {
    console.error(`No stored transcript for '${ext}'.`);
    process.exit(1);
  }

  console.log(`Extracting contacts for ${deal.data.account} from transcript (${body.length} chars)...`);
  const people = await extractContactsFromTranscript({ transcript: body, account: deal.data.account });
  if (people.length === 0) {
    console.log("No named customer contacts found.");
    return;
  }
  console.log(`Found ${people.length} contact(s):`);
  for (const p of people) {
    console.log(
      `  ${p.name} — ${p.role || "(no role)"} [${p.relationship}] ${p.onCall ? "· on call" : "· mentioned only"}`,
    );
    if (p.evidence) console.log(`     "${p.evidence}"`);
  }

  if (!apply) {
    console.log(
      `\nDry run. Re-run with --apply to add the new ones${replace ? " (--replace will refresh existing call-sourced contacts)" : ""}.`,
    );
    return;
  }
  if (replace) {
    const del = await db
      .from("contacts")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("deal_id", deal.data.id)
      .like("external_id", "call:%");
    if (del.error) {
      console.error(`Replace delete failed: ${del.error.message}`);
      process.exit(1);
    }
    console.log("Cleared existing call-sourced contacts (--replace).");
  }
  const res = await upsertDealContacts({ tenantId, dealId: deal.data.id, contacts: people, callDate });
  console.log(`\nAdded ${res.inserted} new contact(s); skipped ${res.skipped} already on the deal.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
