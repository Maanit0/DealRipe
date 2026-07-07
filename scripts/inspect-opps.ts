/**
 * Read opportunities from Rolldog and print their account name, stage, close
 * date, and any contact email domains found (to help derive the join domain).
 * The opp ids must be in PILOT_OPPORTUNITY_IDS (scope guard) or the read fails.
 *
 *   npx tsx scripts/inspect-opps.ts                       # defaults to Eduardo's 4
 *   npx tsx scripts/inspect-opps.ts 80018 77742 81454
 *
 * Read-only. Requires Rolldog credentials + Supabase.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getDealRoom } from "../lib/rolldog";

const DEFAULT_IDS = ["80018", "77742", "81454", "80189"];

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function domainsIn(obj: unknown): string[] {
  const found = new Set<string>();
  const re = /[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi;
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      let m: RegExpExecArray | null;
      while ((m = re.exec(v)) !== null) found.add(m[1].toLowerCase());
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(obj);
  return Array.from(found);
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const list = ids.length > 0 ? ids : DEFAULT_IDS;

  console.log("");
  for (const id of list) {
    try {
      const room = await getDealRoom(id);
      const core = room.core as Record<string, unknown>;
      const name = str(core["account-name"]) || str(core["name"]) || "(no name)";
      const stage = str(core["stage-name"]) || str(core["stage"]) || "(no stage)";
      const close = str(core["close-date"]) || "(no close date)";
      const doms = domainsIn(room);
      console.log(`${id}  |  ${name}  |  ${stage}  |  close ${close}`);
      console.log(`        contact domains found: ${doms.length ? doms.join(", ") : "none (ask the rep)"}`);
    } catch (err) {
      console.log(`${id}  |  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
