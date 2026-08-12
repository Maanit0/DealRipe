/**
 * What is actually sitting in Rolldog right now?
 *
 * Two questions this answers, both of which came up on 2026-08-11.
 *
 * 1. WHAT DID THIS MORNING'S WRITES PUT THERE?
 *
 * crm_access_log.field_values only started recording values at ~3pm, when the
 * write-time capture deployed. Writes before that (Bee Imagine 11:17, TW Customs
 * 2:36) landed in Rolldog but DealRipe kept no record of what it sent, so the
 * Activity view has nothing to show for them.
 *
 * This reads the opportunity back. Note the difference, because it matters:
 * this is WHAT IS IN THE FIELD NOW, not what we sent this morning. They are the
 * same only if nothing changed it since, and a rep editing the note in Rolldog
 * would look identical here. Never label this output as "what DealRipe wrote".
 *
 * 2. HOW LONG CAN THESE FIELDS ACTUALLY BE?
 *
 * lib/crm-writer.ts truncates every note at 280 characters on the strength of a
 * code comment saying "Rolldog note fields cap around 300". Nobody verified
 * that. If the real limit is 4000, the pilot has been throwing away most of
 * every qualification note, in the customer's CRM, for weeks.
 *
 * Probing by writing junk of increasing length into a live customer record is
 * not acceptable, so this measures instead: it reports the longest value it
 * finds in each field across the opportunities it reads. Anything longer than
 * 280 is proof the field holds more than we allow, and it costs nothing because
 * reps have been typing into these fields for years.
 *
 *   npx tsx scripts/rolldog-readback.ts --deal Beeimagine
 *   npx tsx scripts/rolldog-readback.ts --today          # every deal written to today
 *   npx tsx scripts/rolldog-readback.ts --today --full   # print values untruncated
 *
 * READ ONLY. Writes nothing to Rolldog or Supabase.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runWithAuthorizedOpportunities } from "../lib/crm-scope";
import { getDealRoom, type DealRoom } from "../lib/rolldog";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Text-bearing attributes worth showing. Rolldog returns plenty of ids and
 *  booleans that add noise and answer nothing. */
function textAttrs(attrs: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!attrs) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s.length === 0) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) continue; // timestamps
    out.push([k, s]);
  }
  return out.sort((a, b) => b[1].length - a[1].length);
}

const SECTIONS: Array<[string, (r: DealRoom) => Record<string, unknown> | undefined]> = [
  ["situation", (r) => r.situation?.attributes],
  ["timeline", (r) => r.timeline?.attributes],
  ["budget", (r) => r.budget?.attributes],
  ["competition", (r) => r.competition?.attributes],
  ["participant", (r) => r.participant?.attributes],
];

async function main(): Promise<void> {
  const only = arg("--deal")?.toLowerCase() ?? null;
  const today = process.argv.includes("--today");
  const full = process.argv.includes("--full");
  if (!only && !today) {
    console.log("\nPass --deal <name> or --today.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);
  let deals = (dealsRes.data ?? []) as Array<Record<string, unknown>>;

  if (only) {
    deals = deals.filter((d) => String(d.account ?? "").toLowerCase().includes(only));
  } else {
    // Deals we wrote to today, from the audit log, so this follows what actually
    // happened rather than a guess about which deals had calls.
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const logRes = await db
      .from("crm_access_log")
      .select("opportunity_external_id, created_at, operation, allowed")
      .eq("tenant_id", tenantId)
      .eq("operation", "write")
      .eq("allowed", true)
      .gte("created_at", since.toISOString());
    if (logRes.error) throw new Error(logRes.error.message);
    const opps = new Set(
      (logRes.data ?? []).map((r) => String((r as { opportunity_external_id: string }).opportunity_external_id)),
    );
    deals = deals.filter((d) => {
      const t = resolveWriteTarget(d as never);
      return t.authorized && opps.has(String(t.opportunityId));
    });
  }

  if (deals.length === 0) {
    console.log(only ? `\nNo deal matching "${only}".\n` : "\nNo deals were written to Rolldog today.\n");
    return;
  }

  // Longest value seen per field, across everything read. This is the evidence
  // about the real ceiling.
  const longest = new Map<string, { len: number; account: string }>();
  /** Stored values ending in capNote's ellipsis: proof of a cut, not a guess. */
  const truncated: string[] = [];

  for (const d of deals) {
    const account = String(d.account ?? "?");
    const target = resolveWriteTarget(d as never);
    if (!target.authorized) {
      console.log(`\n${account}: not writable (${target.reason}), skipping.`);
      continue;
    }
    const opp = target.opportunityId;

    console.log(`\n${"=".repeat(78)}`);
    console.log(`${account}   opportunity ${opp}`);
    console.log(`${"=".repeat(78)}`);

    let room: DealRoom;
    try {
      // Reads are scope-gated too, and an auto-linked deal is only authorized
      // inside this wrapper. Same route the writer uses.
      room = await runWithAuthorizedOpportunities(target.runtimeAuth, () => getDealRoom(opp));
    } catch (err) {
      console.log(`  COULD NOT READ: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  This says nothing about what is in Rolldog. We failed to ask.`);
      continue;
    }

    for (const [name, pick] of SECTIONS) {
      const attrs = textAttrs(pick(room));
      if (attrs.length === 0) continue;
      console.log(`\n  ${name.toUpperCase()}`);
      for (const [k, v] of attrs) {
        const key = `${name}.${k}`;
        const prev = longest.get(key);
        if (!prev || v.length > prev.len) longest.set(key, { len: v.length, account });
        if (v.endsWith("…")) truncated.push(`${account}  ${key}  (${v.length} chars)`);
        const shown = full || v.length <= 200 ? v : `${v.slice(0, 200)}  [+${v.length - 200} more, use --full]`;
        console.log(`    ${k}  (${v.length} chars)`);
        console.log(`      ${shown.replace(/\n/g, "\n      ")}`);
      }
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log("LONGEST VALUE SEEN IN EACH FIELD");
  console.log(`${"=".repeat(78)}`);
  console.log("");
  const effectiveCap = Number(process.env.ROLLDOG_MAX_NOTE) || 1000;
  const rows = [...longest.entries()].sort((a, b) => b[1].len - a[1].len);
  for (const [field, info] of rows) {
    // Compare against the cap in force, not the old 280. Flagging every value
    // over a number we no longer use trains you to ignore the flag.
    const flag = info.len > effectiveCap * 0.8 ? "  <- approaching the cap" : "";
    console.log(`  ${String(info.len).padStart(6)}  ${field.padEnd(38)} ${info.account}${flag}`);
  }
  // Truncation detected directly, rather than inferred from a cap this script
  // would otherwise have to guess at. capNote is the only thing that appends
  // this character, so a stored value ending in it was cut short by us.
  const cap = Number(process.env.ROLLDOG_MAX_NOTE) || 280;
  console.log("");
  console.log(`Effective cap for this run: ${cap} (ROLLDOG_MAX_NOTE${process.env.ROLLDOG_MAX_NOTE ? "" : " unset, default"}).`);
  if (truncated.length > 0) {
    console.log("");
    console.log(`${truncated.length} stored value(s) end in an ellipsis, so they were cut short:`);
    for (const t of truncated) console.log(`    ${t}`);
    console.log("");
    console.log(`Raise ROLLDOG_MAX_NOTE and run scripts/repair-truncated-notes.ts --apply.`);
  } else {
    console.log(`No stored value ends in an ellipsis, so nothing read here is truncated.`);
  }
  console.log("");
  console.log(`Reminder: everything above is the CURRENT state of the record, not a log of`);
  console.log(`what DealRipe sent. A rep editing the note in Rolldog looks identical here.`);
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
