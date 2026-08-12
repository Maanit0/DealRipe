/**
 * How long a note will Rolldog actually keep?
 *
 * lib/crm-writer.ts has truncated every note at 280 characters since the pilot
 * began, on the strength of a code comment guessing "Rolldog note fields cap
 * around 300". Reading the opportunities back on 2026-08-11 showed the only
 * 280-character values in Rolldog are the ones we put there, so nothing in the
 * customer's data proves the ceiling either way.
 *
 * HOW THIS TESTS IT WITHOUT PUTTING JUNK IN A CUSTOMER'S CRM
 *
 * It writes the deal's OWN note, composed by lib/crm-writer with the cap
 * temporarily raised. That is real qualification content, the same text
 * production would have sent if the cap were higher, so the worst case is that
 * the field ends up with a fuller and more accurate version of what is already
 * there. No lorem ipsum, no test strings, nothing a rep opening Rolldog would
 * find strange.
 *
 * AND IT READS THE VALUE BACK, WHICH IS THE ACTUAL TEST
 *
 * An API accepting 1,200 characters and returning 200 does not mean it stored
 * 1,200. Silent truncation is common and would look like success. The verdict
 * below compares what we sent against what Rolldog hands back:
 *
 *   accepted in full      -> the limit is at least this long, raise ROLLDOG_MAX_NOTE
 *   stored short          -> Rolldog truncates silently, and the stored length IS the limit
 *   rejected              -> the limit is below what we sent; run again with --max lower
 *
 *   npx tsx scripts/probe-note-limit.ts --deal Custom-goods              # dry run
 *   npx tsx scripts/probe-note-limit.ts --deal Custom-goods --apply      # one real write
 *   npx tsx scripts/probe-note-limit.ts --deal Custom-goods --apply --max 1200
 *
 * Pick a deal whose situation note DealRipe already owns, so the write replaces
 * our own truncated text rather than something a rep wrote by hand.
 *
 * Writes exactly one sub-resource, once, scope-gated and audited like any other
 * write. Without --apply it changes nothing.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

// Type-only, so it is erased at compile time and does not load lib/rolldog
// before ROLLDOG_MAX_NOTE is set below.
import type { SituationWrite } from "../lib/rolldog";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * SituationWrite params are camelCase; Rolldog stores kebab-case attributes.
 * Reading the value back by the param name silently returns nothing, which made
 * this script report "currently 0 chars" for a field holding 280, and would
 * have made a successful write look like it changed nothing.
 */
const ATTR_FOR_PARAM: Record<string, string> = {
  whyLooking: "why-looking",
  whyLookingNow: "why-looking-now",
  existingSystems: "existing-systems",
  businessStatus: "business-status",
  notes: "notes",
};

// Raise the cap BEFORE crm-writer is imported, so its composition produces the
// untruncated note. Deliberately set here rather than in .env.local: this is a
// one-off probe and the production default must stay 280 until we know better.
const MAX = Number(arg("--max") ?? "4000");
process.env.ROLLDOG_MAX_NOTE = String(MAX);

async function main(): Promise<void> {
  const { runWithAuthorizedOpportunities } = await import("../lib/crm-scope");
  const { syncDealToRolldog } = await import("../lib/crm-writer");
  const { getSubResource, writeSituation } = await import("../lib/rolldog");
  const { resolveWriteTarget } = await import("../lib/rolldog-writeback");
  const { supabaseAdmin } = await import("../lib/supabase");
  const { resolveTenantId } = await import("../lib/tenant-deal-lookup");

  const only = arg("--deal")?.toLowerCase();
  const apply = process.argv.includes("--apply");
  if (!only) {
    console.log("\nPass --deal <name>.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);

  const deal = ((dealsRes.data ?? []) as Array<Record<string, unknown>>).find((d) =>
    String(d.account ?? "").toLowerCase().includes(only),
  );
  if (!deal) {
    console.log(`\nNo deal matching "${only}".\n`);
    process.exit(1);
  }
  const target = resolveWriteTarget(deal as never);
  if (!target.authorized) {
    console.log(`\n${deal.account} cannot be written to: ${target.reason}\n`);
    process.exit(1);
  }
  const opp = target.opportunityId;

  // Compose exactly what production would send, with the cap raised.
  const results = await syncDealToRolldog({
    tenantSlug: "magaya",
    dealId: String(deal.id),
    rolldogOpportunityId: opp,
    dryRun: true,
  });
  const sit = results.find((r) => r.method === "writeSituation");
  if (!sit?.payload) {
    console.log(`\n${deal.account} composes no situation payload, so there is nothing to test.`);
    console.log(`Pick a deal with a captured call and a confirmed why_looking extraction.\n`);
    return;
  }
  const payload = JSON.parse(sit.payload) as SituationWrite;
  const field = (Object.keys(payload) as Array<keyof SituationWrite>).find(
    (k) => typeof payload[k] === "string" && (payload[k] as string).length > 280,
  );

  console.log("");
  console.log(`${deal.account}  ·  opportunity ${opp}`);
  console.log(`Cap raised to ${MAX} for this run.`);
  console.log("");
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === "string") console.log(`  ${k}: ${v.length} chars`);
  }
  console.log("");

  if (!field) {
    console.log(`Nothing composes longer than 280 for this deal, so writing it would test`);
    console.log(`nothing. Try a deal whose note is currently cut off with an ellipsis.\n`);
    return;
  }

  const sending = payload[field] as string;
  const attr = ATTR_FOR_PARAM[field as string] ?? String(field);
  const before = await runWithAuthorizedOpportunities(target.runtimeAuth, () =>
    getSubResource(opp, "situation"),
  );
  const beforeLen = String((before?.attributes ?? {})[attr] ?? "").length;
  console.log(`Testing '${field}' (Rolldog attribute '${attr}')`);
  console.log(`  currently ${beforeLen} chars in Rolldog, sending ${sending.length}.`);

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to send it.\n`);
    return;
  }

  try {
    await runWithAuthorizedOpportunities(target.runtimeAuth, () =>
      writeSituation(opp, { [field]: sending } as SituationWrite),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\nREJECTED at ${sending.length} chars.`);
    console.log(`  ${msg}`);
    console.log(`\nThe limit is below ${sending.length}. Re-run with a lower --max to narrow it.`);
    console.log(`Nothing changed in Rolldog: a rejected PATCH is not a partial write.\n`);
    return;
  }

  // The write returning 2xx proves nothing on its own.
  const after = await runWithAuthorizedOpportunities(target.runtimeAuth, () =>
    getSubResource(opp, "situation"),
  );
  const stored = String((after?.attributes ?? {})[attr] ?? "");

  console.log("");
  if (stored.length >= sending.length) {
    console.log(`ACCEPTED IN FULL. Sent ${sending.length}, Rolldog stored ${stored.length}.`);
    console.log("");
    console.log(`The 280 cap was wrong. Set ROLLDOG_MAX_NOTE in Vercel to a value you have`);
    console.log(`confirmed, then re-run the repair pass so every note written before today`);
    console.log(`gets its full text. Do not assume ${MAX} is the ceiling; it is only a floor.`);
  } else if (stored.length > beforeLen) {
    console.log(`SILENTLY TRUNCATED. Sent ${sending.length}, Rolldog stored ${stored.length}.`);
    console.log("");
    console.log(`It accepted the request and kept only part of it, which is why reading the`);
    console.log(`value back matters. ${stored.length} is the real limit. Set ROLLDOG_MAX_NOTE`);
    console.log(`slightly below it so our own ellipsis marks the cut rather than Rolldog`);
    console.log(`silently dropping the end of a sentence.`);
  } else {
    console.log(`NO CHANGE. Sent ${sending.length}, still ${stored.length} in Rolldog.`);
    console.log(`The write reported success and nothing moved, which is its own problem.`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
