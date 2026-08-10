/**
 * Check the one assumption the stage-gate reader rests on.
 *
 * lib/stage-gates.ts joins Rolldog's checklist to our framework on the numeric
 * item id, because the names are unreliable (" Create Initial Close Plan and
 * Presented" carries a leading space, "Validate Who Negotiate and Signs" a
 * grammatical error, and either could be tidied at any time). That join is only
 * sound if a given id means the same thing on every opportunity.
 *
 * It looked true on 65462. One opportunity is an anecdote. This reads several
 * and reports any id that carries different names on different deals, which
 * would mean the ids are per-opportunity and the mapping is wrong.
 *
 *   npx tsx scripts/verify-stage-gates.ts --opps 65462,80731,82445,83271,80082
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runWithAuthorizedOpportunities } from "../lib/crm-scope";
import { getStageRequirements } from "../lib/rolldog";
import { ROLLDOG_GATE_TO_FIELD } from "../lib/stage-gates";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const opps = (arg("--opps") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (opps.length === 0) {
    console.error("Usage: --opps 65462,80731,82445");
    process.exit(1);
  }

  // id -> names seen, and which opportunities showed each name.
  const seen = new Map<number, Map<string, string[]>>();
  const readOk: string[] = [];

  for (const opp of opps) {
    let reqs;
    try {
      reqs = await runWithAuthorizedOpportunities([opp], () => getStageRequirements(opp));
    } catch (e) {
      console.log(`${opp.padEnd(9)} read failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!reqs) {
      console.log(`${opp.padEnd(9)} no checklist (404)`);
      continue;
    }
    readOk.push(opp);
    const ticked = reqs.stages.flatMap((s) => s.attributes).filter((a) => a.value).length;
    const total = reqs.stages.flatMap((s) => s.attributes).length;
    console.log(
      `${opp.padEnd(9)} ${String(ticked).padStart(2)}/${total} ticked, current stage position ${reqs.currentStagePosition ?? "?"}`,
    );

    for (const stage of reqs.stages) {
      for (const item of stage.attributes) {
        const byName = seen.get(item.id) ?? new Map<string, string[]>();
        const list = byName.get(item.name) ?? [];
        list.push(opp);
        byName.set(item.name, list);
        seen.set(item.id, byName);
      }
    }
  }

  console.log("");
  const unstable = [...seen.entries()].filter(([, names]) => names.size > 1);
  if (unstable.length === 0) {
    console.log(`Every item id carried one consistent name across ${readOk.length} opportunities.`);
    console.log("The id join in lib/stage-gates.ts is sound.");
  } else {
    console.log("PROBLEM: these ids mean different things on different opportunities,");
    console.log("so the ids are per-opportunity and ROLLDOG_GATE_TO_FIELD is unsafe:");
    console.log("");
    for (const [id, names] of unstable) {
      console.log(`  id ${id}`);
      for (const [name, where] of names) {
        console.log(`    "${name}"  on ${where.join(", ")}`);
      }
    }
  }

  console.log("");
  const mapped = Object.keys(ROLLDOG_GATE_TO_FIELD).map(Number);
  const missing = mapped.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    console.log(`Mapped ids never seen in this sample: ${missing.join(", ")}`);
    console.log("Either the sample is too small or the mapping references a stale id.");
  }
  const unmapped = [...seen.keys()].filter((id) => !mapped.includes(id)).sort((a, b) => a - b);
  console.log("");
  console.log(`${mapped.length} of ${seen.size} item ids map to a framework field.`);
  console.log("Unmapped ids are internal-action gates a call cannot evidence:");
  for (const id of unmapped) {
    console.log(`  ${String(id).padEnd(5)} ${[...(seen.get(id)?.keys() ?? [])][0]}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
