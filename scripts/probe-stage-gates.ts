/**
 * Find where Rolldog keeps the stage-requirement checklist.
 *
 * Mark's screen share shows, per opportunity, a per-stage checklist with ticks
 * and crosses: "Initial Prospect Meeting", "Positioned Storyboard", "Is Magaya
 * Selected Vendor?", "Validate Who Negotiates and Signs". A rep maintains it,
 * and it is the richest qualification signal in their CRM. We read none of it,
 * which is why every deal briefs as 0/27 while Juan has three stages ticked.
 *
 * This prints the opportunity's own attribute keys, its advertised
 * relationships, and the status of every candidate endpoint, so the reader can
 * be written against the real shape instead of a guess.
 *
 *   npx tsx scripts/probe-stage-gates.ts --opp 65462
 *   npx tsx scripts/probe-stage-gates.ts --opp 65462 --path opportunity-stage-requirements
 *
 * 65462 is GHY, at SQL3 with earlier stages ticked, so a working endpoint
 * should come back with content rather than an empty collection.
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runWithAuthorizedOpportunities } from "../lib/crm-scope";
import { probeRelatedPath, probeStageGates } from "../lib/rolldog";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Pretty-print a JSON body if it parses, otherwise show it raw. */
function show(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

async function main(): Promise<void> {
  const opp = arg("--opp");
  if (!opp) {
    console.error("Usage: --opp <rolldog opportunity id> [--path <related-path>]");
    process.exit(1);
  }

  // Authorize this one opportunity for the duration of the probe. The scope
  // guard is fail-closed and only the static pilot ids pass by default.
  await runWithAuthorizedOpportunities([opp], async () => {
    const only = arg("--path");
    if (only) {
      const r = await probeRelatedPath(opp, only);
      console.log(`\n${only}  ->  HTTP ${r.status}\n`);
      console.log(show(r.body));
      console.log("");
      return;
    }

    const p = await probeStageGates(opp);

    console.log("");
    console.log(`OPPORTUNITY ${opp}`);
    console.log("=".repeat(78));
    console.log("");
    console.log("Attributes on the opportunity itself:");
    console.log(p.coreAttributeKeys.length ? `  ${p.coreAttributeKeys.join(", ")}` : "  (none)");
    console.log("");
    console.log("Relationships the opportunity advertises:");
    console.log(p.relationshipNames.length ? `  ${p.relationshipNames.join(", ")}` : "  (none)");
    console.log("");
    console.log("Candidate endpoints:");
    console.log("");

    for (const a of p.attempts) {
      const verdict =
        a.status === 200 ? "FOUND" : a.status === 404 ? "not found" : `HTTP ${a.status}`;
      console.log(`  ${a.path.padEnd(38)} ${verdict}`);
      if (a.status === 200) {
        console.log("");
        console.log(
          show(a.sample)
            .split("\n")
            .map((l) => `      ${l}`)
            .join("\n"),
        );
        console.log("");
      }
    }

    console.log("");
    console.log("If nothing returned 200, the gates are probably inline on the");
    console.log("opportunity: look for a likely key in the attribute list above and");
    console.log("re-run with --path, or send me the attribute list.");
    console.log("");
  });
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
