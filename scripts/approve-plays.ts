/**
 * Read the mined moves and decide which a rep may be shown.
 *
 *   npx tsx scripts/approve-plays.ts                      list what is pending
 *   npx tsx scripts/approve-plays.ts --kind named_ask     just one kind
 *   npx tsx scripts/approve-plays.ts --lang en            English only
 *   npx tsx scripts/approve-plays.ts --approve <id,id>    approve those rows
 *   npx tsx scripts/approve-plays.ts --reject <id,id>     mark them read and refused
 *
 * These are verbatim sentences from real calls and they end up in a briefing a
 * rep reads aloud to a customer, so approval is one person deciding one row.
 * There is deliberately no --approve-all.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const LOOKS_SPANISH = /[áéíóúñü¿¡]/i;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  for (const [flag, value] of [["--approve", true], ["--reject", false]] as const) {
    const list = arg(flag);
    if (!list) continue;
    const ids = list.split(",").map((s) => s.trim()).filter(Boolean);
    // Rejection is recorded as approved=false too. The row stays so the next
    // mining run does not resurface it as new, and so a person can see what was
    // already considered and turned down.
    const { data, error } = await db
      .from("mined_plays")
      .update({ approved: value })
      .in("id", ids)
      .eq("tenant_id", tenantId)
      .select("id");
    if (error) throw new Error(`could not update: ${error.message}`);
    // Report what was actually written, not what was asked for: an id that
    // matched nothing is a typo, and saying "approved 3" when one row moved
    // would hide it.
    console.log(`${value ? "approved" : "rejected"} ${(data ?? []).length} of ${ids.length} row(s)`);
    return;
  }

  const kind = arg("--kind");
  const lang = arg("--lang");
  let q = db.from("mined_plays").select("id, kind, quote, doing, speaker, account, stage, call_date, preceded_advance, approved")
    .eq("tenant_id", tenantId).eq("approved", false);
  if (kind) q = q.eq("kind", kind);
  const { data, error } = await q.order("kind").limit(200);
  if (error) throw new Error(`could not read: ${error.message}`);

  let rows = (data ?? []) as Array<Record<string, unknown>>;
  if (lang) rows = rows.filter((r) => LOOKS_SPANISH.test(String(r.quote)) === (lang === "es"));

  const { count: approved } = await db.from("mined_plays")
    .select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("approved", true);

  console.log(`\n${rows.length} pending${kind ? ` in ${kind}` : ""}${lang ? `, ${lang} only` : ""}. ${approved ?? 0} already approved.\n`);
  let last = "";
  for (const r of rows) {
    if (r.kind !== last) { console.log(`\n=== ${String(r.kind).toUpperCase()} ===`); last = String(r.kind); }
    console.log(`  ${r.id}`);
    console.log(`    ${String(r.speaker)}, ${String(r.account)}, ${String(r.call_date)}${r.preceded_advance ? ", preceded an advance" : ""}`);
    console.log(`    "${String(r.quote).slice(0, 200)}"`);
    console.log(`    ${String(r.doing)}`);
  }
  console.log(`\n  Approve with: npx tsx scripts/approve-plays.ts --approve <id>,<id>\n`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
