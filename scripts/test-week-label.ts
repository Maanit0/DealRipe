/** npx tsx scripts/test-week-label.ts   Pure, no network. */
import { weekOfLabel } from "../lib/week-label";
let bad = 0;
const at = (iso: string) => weekOfLabel({ now: new Date(iso), withYear: true });
const cases: Array<[string, string, string]> = [
  // Every day of the week that touches Monday 2026-09-14 must print it.
  ["2026-09-12T18:00:00Z", "September 14, 2026", "Saturday rolls forward"],
  ["2026-09-13T18:00:00Z", "September 14, 2026", "Sunday rolls forward"],
  ["2026-09-14T11:00:00Z", "September 14, 2026", "Monday, the real cron time"],
  ["2026-09-15T11:00:00Z", "September 14, 2026", "Tuesday retry still says Monday"],
  ["2026-09-18T22:00:00Z", "September 14, 2026", "Friday still says Monday"],
  ["2026-09-19T18:00:00Z", "September 21, 2026", "next Saturday rolls to the next Monday"],
  // 06:00 Central is 11:00 UTC; an hour either side must not flip the day.
  ["2026-09-14T05:30:00Z", "September 14, 2026", "Mon 00:30 Central"],
  ["2026-09-15T04:30:00Z", "September 14, 2026", "Mon 23:30 Central, still Monday there"],
];
for (const [iso, want, why] of cases) {
  const got = at(iso);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${why.padEnd(38)} ${iso} -> ${got}`);
}
console.log(`\n${bad === 0 ? "PASS" : "FAIL"}: ${cases.length - bad}/${cases.length}\n`);
process.exit(bad === 0 ? 0 : 1);
