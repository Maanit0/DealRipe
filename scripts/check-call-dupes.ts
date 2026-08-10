/**
 * Are two bots about to join the same customer meeting?
 *
 * Calls used to be keyed on the Microsoft event id, which is per-mailbox: when
 * two reps are invited to the same meeting, each mailbox has its own copy with
 * its own id. That produced two rows on one deal, two Recall bots visible to
 * the customer, two transcripts, two recaps and a doubled CRM write-back.
 * They are keyed on iCalUId now, which is identical across mailboxes.
 *
 * This verifies that, against real data rather than intent. Two future rows on
 * the same deal starting at the same time is the signature of the old bug.
 *
 *   npx tsx scripts/check-call-dupes.ts
 *   npx tsx scripts/check-call-dupes.ts --days 21
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function when(iso: string | null): string {
  if (!iso) return "(no time)";
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** An Outlook event id is long and base64-ish; an iCalUId is hex-ish and shorter. */
function keyKind(externalId: string | null): string {
  if (!externalId) return "none";
  return externalId.length > 120 ? "legacy event id" : "iCalUId";
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 14);
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const until = new Date(Date.now() + days * 86_400_000).toISOString();
  const rows = await db
    .from("calls")
    .select("id, deal_id, external_id, title, scheduled_start, recall_bot_id, deals(account, rep_email)")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", new Date().toISOString())
    .lte("scheduled_start", until)
    .order("scheduled_start", { ascending: true });
  if (rows.error) throw new Error(rows.error.message);

  const all = rows.data ?? [];
  console.log("");
  console.log(`Upcoming calls in the next ${days} days: ${all.length}`);
  console.log("");

  // Group by deal + start minute. Same deal, same moment, two rows = duplicate.
  const groups = new Map<string, typeof all>();
  for (const r of all) {
    const k = `${r.deal_id}|${(r.scheduled_start ?? "").slice(0, 16)}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }

  const dupes = [...groups.values()].filter((g) => g.length > 1);
  const legacy = all.filter((r) => keyKind(r.external_id) === "legacy event id");

  for (const r of all) {
    const deal = (r.deals as unknown as { account?: string } | null)?.account ?? "(no deal)";
    console.log(
      `  ${when(r.scheduled_start).padEnd(24)}${deal.slice(0, 24).padEnd(26)}${(r.title ?? "").slice(0, 40).padEnd(42)}${
        r.recall_bot_id ? "bot" : "no bot"
      }  ${keyKind(r.external_id)}`,
    );
  }

  console.log("");
  if (dupes.length === 0) {
    console.log("No duplicates. Every upcoming meeting has exactly one row.");
  } else {
    console.log(`${dupes.length} DUPLICATE GROUP(S). Two bots would join these:`);
    for (const g of dupes) {
      const deal = (g[0].deals as unknown as { account?: string } | null)?.account ?? "(no deal)";
      console.log(`   ${when(g[0].scheduled_start)}  ${deal}  ${g[0].title ?? ""}`);
      for (const r of g) {
        console.log(`      call ${r.id}  bot ${r.recall_bot_id ?? "none"}  key ${keyKind(r.external_id)}`);
      }
    }
    console.log("");
    console.log("Delete the row WITHOUT a bot, or the newer one if both have bots and");
    console.log("cancel that bot, before the meeting starts.");
  }

  if (legacy.length > 0) {
    console.log("");
    console.log(`${legacy.length} row(s) still on the legacy per-mailbox key.`);
    console.log("They migrate automatically the next time calendar sync sees that meeting.");
    console.log("Until then a second rep on the same meeting can still create a duplicate.");
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
