/**
 * Before/after preview of the stakeholder-attribution change. For a deal's most
 * recent call, it prints the CURRENT Rolldog Situation values (the "before",
 * which say "the customer") next to a fresh extraction run with the new prompt
 * (the "after", which names the stakeholder and role). Read-only: it never
 * writes to Rolldog, it only calls the extraction model so you can eyeball the
 * phrasing on a real call before shipping.
 *
 * Runs on your Mac (reads Supabase + Rolldog, calls Anthropic). Writes nothing.
 *
 *   npx tsx scripts/attribution-preview.ts --account "Core Logistics"
 *   npx tsx scripts/attribution-preview.ts --account "Alba Wheels Up"
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getAnthropicClient, getAnthropicModel } from "../lib/anthropic";
import { repName } from "../lib/display-names";
import { buildExtractionSystemPrompt } from "../lib/extraction-prompt";
import { getFrameworkForDeal } from "../lib/framework";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { getSubResource } from "../lib/rolldog";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function firstJsonObject(s: string): string {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : s;
}

async function main(): Promise<void> {
  const account = arg("--account");
  const rep = (arg("--rep") ?? "").toLowerCase();
  if (!account && !rep) {
    console.log(`\nPass --account "<name>" or --rep <name>.\n`);
    return;
  }
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const { data } = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rep_email")
    .eq("tenant_id", tenantId);
  let deals = (data ?? []) as Array<{
    id: string; account: string; external_id: string | null; rolldog_opportunity_id: string | null; rep_email: string | null;
  }>;
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (account) {
    const target = norm(account);
    deals = deals.filter((d) => norm(d.account).includes(target));
  }
  if (rep) {
    deals = deals.filter((d) => (d.rep_email ?? "").toLowerCase().includes(rep) || repName(d.rep_email).toLowerCase().includes(rep));
  }
  if (deals.length === 0) {
    console.log(`\nNo matching deals.\n`);
    return;
  }

  const client = getAnthropicClient();
  const model = getAnthropicModel();

  for (const d of deals) {
    console.log(`\n========================================`);
    console.log(`${d.account}`);
    console.log(`========================================`);

    // Most recent call + its transcript.
    const call = await db
      .from("calls")
      .select("id, call_date, participants")
      .eq("deal_id", d.id)
      .order("call_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!call.data) {
      console.log("  No call on record.");
      continue;
    }
    const tr = await db.from("transcripts").select("body").eq("call_id", call.data.id).maybeSingle();
    if (!tr.data?.body) {
      console.log("  No transcript stored for the latest call.");
      continue;
    }

    // BEFORE: current Rolldog Situation values.
    const opp = (d.external_id ? rolldogOppIdForDeal(d.external_id) : null) ?? d.rolldog_opportunity_id;
    console.log(`\n--- BEFORE (current Rolldog Situation) ---`);
    if (opp) {
      const sit = await getSubResource(String(opp), "situation");
      const a = sit?.attributes ?? {};
      for (const key of ["why-looking", "existing-systems", "why-looking-now", "business-status"]) {
        const v = a[key];
        const text = Array.isArray(v) ? v.join("; ") : typeof v === "string" ? v : "";
        if (text.trim()) console.log(`  ${key}: ${text}`);
      }
    } else {
      console.log("  (deal not linked to a Rolldog opportunity)");
    }

    // AFTER: fresh extraction with the new attribution prompt.
    const framework = await getFrameworkForDeal(d.id);
    if (!framework) {
      console.log("\n  No framework resolved; cannot run extraction.");
      continue;
    }
    const res = await client.messages.create({
      model,
      max_tokens: 4000,
      temperature: 0.1,
      system: buildExtractionSystemPrompt(framework),
      messages: [{ role: "user", content: `<transcript>\n${tr.data.body}\n</transcript>` }],
    });
    const raw = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let parsed: Record<string, { status?: string; answer?: string }> = {};
    try {
      parsed = JSON.parse(firstJsonObject(raw));
    } catch {
      console.log("\n  Could not parse extraction JSON. Raw head:");
      console.log("  " + raw.slice(0, 300));
      continue;
    }

    console.log(`\n--- AFTER (new attribution prompt) ---`);
    for (const f of framework.fields) {
      const e = parsed[f.fieldKey];
      if (e?.status === "Yes" && e.answer) console.log(`  ${f.label}: ${e.answer}`);
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
