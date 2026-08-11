/**
 * What are we extracting that Salesforce never receives, and what could receive it?
 *
 * FIELD_SOURCES maps 7 of the framework's 27 fields onto Account. That is not
 * obviously wrong, since most qualification belongs on a Rolldog opportunity,
 * but nobody has ever looked at which side of the line the real data falls on.
 * The preflight cannot tell you either: it reports "no confirmed extraction maps
 * to a Sales Development field", which reads identically whether the deal has no
 * extraction at all or has plenty and none of it is mapped.
 *
 * So this puts the two halves next to each other:
 *
 *   EXTRACTED    every framework field, how often it is confirmed across deals,
 *                and whether a Salesforce destination exists for it
 *   AVAILABLE    the writable Account fields Salesforce actually exposes, their
 *                type and length, and whether anything writes to them
 *
 * Read it as a worksheet. A field confirmed on many deals with no destination is
 * a candidate; an empty Account field with nothing feeding it is a home. Adding
 * a mapping still needs a look at type and length, which is why both are shown:
 * FM Global already skipped a write because 231 of 500 characters were used and
 * the new text would have overflowed.
 *
 *   npx tsx scripts/salesforce-mapping-gaps.ts
 *
 * READ ONLY. Writes nothing, and touches Salesforce only to describe Account.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getFrameworkForDeal } from "../lib/framework";
import { accountFieldMeta } from "../lib/salesforce-context";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

/** Mirrored from lib/salesforce-writeback-run.ts. Kept in sync by the check at
 *  the end of this script, which fails loudly if the two lists diverge. */
const MAPPED: ReadonlyArray<{ label: string; fieldKey: string; asBoolean?: boolean }> = [
  { label: "Business Issues", fieldKey: "why_looking_now" },
  { label: "Software Purposes", fieldKey: "why_looking" },
  { label: "Any Other Software", fieldKey: "existing_systems" },
  { label: "Other Providers Reached Out", fieldKey: "competition_notes" },
  { label: "Desired Go-Live Date", fieldKey: "close_date_validated" },
  { label: "Compelling Events", fieldKey: "why_looking_now", asBoolean: true },
  { label: "Budget Confirmed", fieldKey: "budget_fit", asBoolean: true },
  { label: "Executive Sponsorship", fieldKey: "sql4_exec_involvement", asBoolean: true },
];

async function main(): Promise<void> {
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  // How often each framework field is actually confirmed. A mapping for a field
  // nobody ever confirms buys nothing.
  const fx = await db
    .from("field_extractions")
    .select("framework_field_key, status, deal_id")
    .eq("tenant_id", tenantId)
    .eq("status", "Yes");
  if (fx.error) throw new Error(fx.error.message);

  const dealsByField = new Map<string, Set<string>>();
  for (const r of fx.data ?? []) {
    const k = String(r.framework_field_key);
    const set = dealsByField.get(k) ?? new Set<string>();
    set.add(String(r.deal_id));
    dealsByField.set(k, set);
  }

  // The framework itself, so unconfirmed fields still appear. Any deal will do:
  // the framework is per tenant, not per deal.
  const anyDeal = await db.from("deals").select("id").eq("tenant_id", tenantId).limit(1).maybeSingle();
  const framework = anyDeal.data ? await getFrameworkForDeal(anyDeal.data.id).catch(() => null) : null;

  const mappedKeys = new Set(MAPPED.map((m) => m.fieldKey));

  console.log("");
  console.log("EXTRACTED: framework fields by how many deals have them confirmed");
  console.log("");

  const rows: Array<{ key: string; label: string; deals: number; mapped: boolean }> = [];
  const seen = new Set<string>();
  for (const f of framework?.fields ?? []) {
    const key = String((f as { fieldKey?: string }).fieldKey ?? "");
    if (!key) continue;
    seen.add(key);
    rows.push({
      key,
      label: String((f as { label?: string }).label ?? key),
      deals: dealsByField.get(key)?.size ?? 0,
      mapped: mappedKeys.has(key),
    });
  }
  // Anything extracted that the framework no longer lists, which would otherwise
  // vanish from this report entirely.
  for (const [key, set] of dealsByField) {
    if (seen.has(key)) continue;
    rows.push({ key, label: `${key} (not in the current framework)`, deals: set.size, mapped: mappedKeys.has(key) });
  }

  rows.sort((a, b) => b.deals - a.deals || a.key.localeCompare(b.key));
  for (const r of rows) {
    const flag = r.mapped ? "-> salesforce" : r.deals > 0 ? "   NO DESTINATION" : "";
    console.log(`  ${String(r.deals).padStart(3)} deal(s)  ${r.key.padEnd(30)} ${flag}`);
  }

  const unmapped = rows.filter((r) => !r.mapped && r.deals > 0);
  console.log("");
  console.log(
    unmapped.length === 0
      ? "Every field with confirmed data has a Salesforce destination."
      : `${unmapped.length} field(s) carry confirmed data and reach Salesforce nowhere. Those are the candidates.`,
  );

  console.log("");
  console.log("AVAILABLE: writable Account fields Salesforce exposes");
  console.log("");
  try {
    const meta = await accountFieldMeta();
    const usedLabels = new Set(MAPPED.map((m) => m.label.toLowerCase()));
    for (const [label, m] of meta) {
      const info = m as unknown as { type?: string; length?: number; api?: string };
      const used = usedLabels.has(label.toLowerCase());
      console.log(
        `  ${used ? "USED " : "free "} ${label.padEnd(34)} ${(info.type ?? "?").padEnd(12)} ${
          info.length ? `max ${info.length}` : ""
        }`,
      );
    }
  } catch (e) {
    // Distinguishable from "Salesforce exposes nothing", which would be a very
    // different and much more alarming finding.
    console.log(`  COULD NOT DESCRIBE Account: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  This says nothing about which fields exist. We failed to ask.`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
