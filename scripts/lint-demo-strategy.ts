/**
 * Lint a generated demo strategy JSON. READ ONLY.
 *
 *   npx tsx scripts/lint-demo-strategy.ts .previews/demo-strategy-*.json
 */
import fs from "node:fs";
import { lintDemoStrategy, worstTier } from "../lib/demo-strategy-lint";

let bad = 0;
for (const f of process.argv.slice(2)) {
  const doc = JSON.parse(fs.readFileSync(f, "utf8")).doc;
  const findings = lintDemoStrategy(doc);
  const worst = worstTier(findings);
  const name = f.split("/").pop();
  console.log(`\n${name}  ${findings.length === 0 ? "CLEAN" : `${findings.length} finding(s), worst: ${worst}`}`);
  for (const x of findings) console.log(`  [${x.tier}] ${x.rule} @ ${x.where}: ${x.detail}`);
  if (worst === "suppress" || worst === "regenerate") bad++;
}
process.exit(bad > 0 ? 1 : 0);
