/**
 * Diagnoses the framework for Magaya: is loadFramework actually null, or does it
 * load but with field keys that don't match the gates? Prints the framework, its
 * field keys, the distinct gate keys in field_extractions, and whether the
 * dashboard's KEY_FIELDS regexes match each side.
 *
 * Runs on your Mac (reads Supabase). Sends nothing.
 *
 *   npx tsx scripts/framework-check.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { loadFramework } from "../lib/framework";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

// Mirror of the dashboard's KEY_FIELDS regexes.
const KEY_FIELDS: Array<{ re: RegExp; label: string }> = [
  { re: /why_looking|driver|situation/i, label: "Why now" },
  { re: /budget/i, label: "Budget" },
  { re: /compet/i, label: "Competition" },
  { re: /economic|budget_approver|key_decision_maker/i, label: "Economic buyer" },
  { re: /decision_process|authority/i, label: "Decision process" },
  { re: /exec/i, label: "Exec involvement" },
  { re: /timeline|close_date/i, label: "Timeline / close date" },
  { re: /signature|agreement|contract/i, label: "Agreement / signature" },
];

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  console.log(`\nmagaya tenantId = ${tenantId}\n`);

  let fw = null;
  let threw = "";
  try {
    fw = await loadFramework(tenantId);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }

  if (threw) {
    console.log(`loadFramework THREW: ${threw}`);
  } else if (!fw) {
    console.log(`loadFramework returned NULL (no qualification_frameworks row for this tenant).`);
  } else {
    console.log(`loadFramework OK: "${fw.name}" (${fw.source}), ${fw.fields.length} fields`);
    console.log(`  first field keys: ${fw.fields.slice(0, 12).map((f) => f.fieldKey).join(", ")}`);
    const matched = KEY_FIELDS.filter((kf) => fw!.fields.some((f) => kf.re.test(f.fieldKey))).map((k) => k.label);
    console.log(`  KEY_FIELDS matched by framework field keys: ${matched.join(", ") || "(none)"}`);
  }

  // Distinct gate keys actually present in field_extractions.
  const db = supabaseAdmin();
  const { data } = await db.from("field_extractions").select("framework_field_key, status").eq("tenant_id", tenantId);
  const rows = (data ?? []) as Array<{ framework_field_key: string; status: string }>;
  const gateKeys = Array.from(new Set(rows.map((r) => r.framework_field_key)));
  console.log(`\nfield_extractions: ${rows.length} rows, ${gateKeys.length} distinct gate keys`);
  console.log(`  sample gate keys: ${gateKeys.slice(0, 15).join(", ")}`);
  const matchedGates = KEY_FIELDS.filter((kf) => gateKeys.some((k) => kf.re.test(k))).map((k) => k.label);
  console.log(`  KEY_FIELDS matched by gate keys: ${matchedGates.join(", ") || "(none)"}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
