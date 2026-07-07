/**
 * Pull a single Rolldog opportunity's full deal-room contents.
 *
 * Reads only. Uses lib/rolldog.ts getDealRoom (which enforces scope
 * against PILOT_OPPORTUNITY_IDS and appends audit rows to crm_access_log).
 *
 * Usage:
 *   npx tsx scripts/pull-rolldog-deal.ts --opp 80018     # IFF Inc (Eduardo)
 *   npx tsx scripts/pull-rolldog-deal.ts --opp 80566     # Martin Brower
 *   npx tsx scripts/pull-rolldog-deal.ts --opp <id>
 *
 * The opp id must be in PILOT_OPPORTUNITY_IDS or the assert throws
 * ScopeViolationError before any HTTP runs.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { flushAuditWrites } from "../lib/crm-scope";
import { RolldogApiError, getDealRoom } from "../lib/rolldog";

function parseArgs(argv: string[]): { opp: string } {
  let opp: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--opp") {
      const v = argv[i + 1];
      if (!v) {
        console.error("--opp requires an opportunity id (e.g. --opp 80018)");
        process.exit(1);
      }
      opp = v;
      i++;
    } else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  if (!opp) {
    console.error("Usage: npx tsx scripts/pull-rolldog-deal.ts --opp <id>");
    process.exit(1);
  }
  return { opp };
}

function pick(
  obj: Record<string, unknown> | null | undefined,
  keys: string[],
): void {
  if (!obj) {
    console.log("  (no data)");
    return;
  }
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null || v === "") {
      console.log(`  ${k}: (empty)`);
    } else if (typeof v === "string" && v.length > 500) {
      console.log(`  ${k}: ${v.slice(0, 500)}... (truncated, ${v.length} chars)`);
    } else if (typeof v === "object") {
      console.log(`  ${k}: ${JSON.stringify(v)}`);
    } else {
      console.log(`  ${k}: ${v}`);
    }
  }
}

async function main(): Promise<void> {
  const { opp } = parseArgs(process.argv.slice(2));

  console.log("");
  console.log(`Pulling Rolldog deal room for opportunity ${opp}...`);
  console.log("");

  let room;
  try {
    room = await getDealRoom(opp);
  } catch (err) {
    if (err instanceof RolldogApiError) {
      console.error(
        `Rolldog API error: status=${err.status} endpoint=${err.endpoint}`,
      );
      console.error("body:", JSON.stringify(err.body, null, 2));
    } else if (err instanceof Error) {
      console.error(`${err.name}: ${err.message}`);
    } else {
      console.error(String(err));
    }
    await flushAuditWrites();
    process.exit(1);
  }

  // --- HIGHLIGHTS: the fields most likely to hold prior meeting context ---

  console.log("========================================================================");
  console.log("HIGHLIGHTS (fields most likely to hold prior meeting context)");
  console.log("========================================================================");

  console.log("");
  console.log("CORE (opportunity scalars)");
  pick(room.core, [
    "name",
    "account-name",
    "stage-name",
    "stage",
    "percentage",
    "score",
    "close-date",
    "deal-size",
    "next-step",
    "notes",
    "age",
    "days-in-stage",
    "created-at",
    "updated-at",
  ]);

  console.log("");
  console.log("SITUATION");
  pick(room.situation?.attributes, [
    "why-looking",
    "why-looking-now",
    "existing-systems",
    "business-status",
    "notes",
  ]);

  console.log("");
  console.log("TIMELINE");
  pick(room.timeline?.attributes, [
    "close-date-validator",
    "is-close-date-validated",
    "notes",
  ]);

  console.log("");
  console.log("BUDGET");
  pick(room.budget?.attributes, [
    "low-range",
    "high-range",
    "budget-fit",
    "approver",
    "department",
    "is-tied-to-fye",
    "notes",
    "funding-notes",
  ]);

  console.log("");
  console.log("COMPETITION");
  pick(room.competition?.attributes, ["notes"]);

  console.log("");
  console.log("PARTICIPANT");
  pick(room.participant?.attributes, [
    "has-partner",
    "partner-name",
    "has-consultant",
    "consultant-name",
    "notes",
    "consultant-notes",
  ]);

  // --- FULL DUMP: everything, so you can see any attributes I didn't ---
  // --- highlight above (e.g. drivers/solution or newer Rolldog fields). ---

  console.log("");
  console.log("========================================================================");
  console.log("FULL RESPONSE (raw JSON from Rolldog)");
  console.log("========================================================================");
  console.log(JSON.stringify(room, null, 2));

  await flushAuditWrites();
}

main().catch(async (err) => {
  console.error("Unexpected error:", err);
  await flushAuditWrites();
  process.exit(1);
});
