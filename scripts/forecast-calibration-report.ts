/**
 * What is each rep's forecast band actually worth?
 *
 * Run this before anything is built on top of calibration. It answers the
 * question that decides whether the feature is worth having: is there real
 * spread between reps, or does everyone's Commit convert at about the same
 * rate? If the spread is narrow, a leader gains nothing by weighting per rep
 * and the honest thing is to say so rather than ship a dashboard.
 *
 * Every rule is imported from lib/forecast-calibration.ts. Nothing here
 * restates one.
 *
 *   npx tsx scripts/forecast-calibration-report.ts
 *   npx tsx scripts/forecast-calibration-report.ts --since 2025-02-19
 *   npx tsx scripts/forecast-calibration-report.ts --pilot     the six reps only
 *
 * READ ONLY. Touches no Supabase table and writes nothing to Salesforce.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  computeForecastCalibration,
  FORECAST_BANDS,
  MIN_SAMPLE,
  type DealType,
  type RepCalibration,
} from "../lib/forecast-calibration";
import { autoJoinRepEmails } from "../lib/pilot-config";
import { getSalesforceClient } from "../lib/salesforce";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const pct = (r: number | null): string => (r === null ? "  n/a" : `${(r * 100).toFixed(0).padStart(4)}%`);
const money = (n: number): string =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;

const TYPE_LABEL: Record<DealType, string> = {
  new_business: "new business",
  renewal: "renewal",
  unknown: "type not recorded",
};

/** Resolve the pilot reps to Salesforce owner ids, by email then by local part.
 *  Same two-step as lib/deal-ownership.ts and for the same reason: Steven
 *  Johnson's Salesforce user is sjohnson@acelynk.com while his deals carry
 *  sjohnson@magaya.com, and sjohnson@magaya.com belongs to a deactivated user. */
async function pilotOwnerIds(): Promise<string[]> {
  const emails = autoJoinRepEmails();
  if (emails.length === 0) return [];
  const { token, instanceUrl } = await getSalesforceClient();
  const locals = [...new Set(emails.map((e) => e.split("@")[0].toLowerCase()))];
  const likes = locals.map((l) => `Email LIKE '${l.replace(/[%_']/g, "")}@%'`).join(" OR ");
  const q = `SELECT Id, Name, Email, IsActive FROM User WHERE (${likes}) AND IsActive = true`;
  const r = await fetch(`${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(q)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) return [];
  const users = ((await r.json()) as { records?: Array<{ Id: string; Email: string }> }).records ?? [];
  const wanted = new Set(locals);
  return users.filter((u) => wanted.has(u.Email.split("@")[0].toLowerCase())).map((u) => u.Id);
}

function printGroup(label: string, reps: RepCalibration[]): void {
  if (reps.length === 0) return;
  console.log(`\n  ${label.toUpperCase()}`);
  console.log(`  ${"rep".padEnd(24)} ${"closed".padStart(6)} ${"won".padStart(5)}   ` +
    FORECAST_BANDS.map((b) => `${b.padStart(9)}`).join("  ") + `     won value`);
  console.log(`  ${"-".repeat(24)} ${"-".repeat(6)} ${"-".repeat(5)}   ` +
    FORECAST_BANDS.map(() => "-".repeat(9)).join("  ") + `     ---------`);

  for (const r of reps) {
    const cells = FORECAST_BANDS.map((b) => {
      const s = r.bands.find((x) => x.band === b)!;
      return `${pct(s.winRate)} ${String(s.entered).padStart(3)}`.padStart(9);
    });
    const wonValue = r.bands.reduce((m, b) => Math.max(m, b.wonAmount), 0);
    console.log(
      `  ${r.ownerName.slice(0, 24).padEnd(24)} ${String(r.closed).padStart(6)} ${String(r.won).padStart(5)}   ` +
        cells.join("  ") +
        `     ${money(wonValue).padStart(9)}`,
    );
  }
}

async function main(): Promise<void> {
  const since = arg("--since") ?? "2025-02-19";
  const pilotOnly = process.argv.includes("--pilot");

  const ownerIds = pilotOnly ? await pilotOwnerIds() : undefined;
  if (pilotOnly && (!ownerIds || ownerIds.length === 0)) {
    console.error("\nCould not resolve any pilot rep to a Salesforce user.\n");
    process.exit(1);
  }

  console.log(`\n${"=".repeat(96)}`);
  console.log(`FORECAST CALIBRATION, closed opportunities since ${since}${pilotOnly ? `, ${ownerIds!.length} pilot rep(s)` : ", whole org"}`);
  console.log(`Each cell is the share of deals that closed WON among those that ever entered that band,`);
  console.log(`followed by the sample size. A rate is withheld below ${MIN_SAMPLE} deals.`);
  console.log(`${"=".repeat(96)}`);

  const res = await computeForecastCalibration({ sinceDate: since, ownerIds });
  if (res.status === "unavailable") {
    console.error(`\n  Could not read: ${res.error}\n`);
    process.exit(1);
  }
  console.log(`\n  ${res.opportunities} closed opportunities, ${res.bandChanges} band changes\n`);

  for (const type of ["new_business", "renewal", "unknown"] as DealType[]) {
    const group = res.reps.filter((r) => r.dealType === type && r.closed >= MIN_SAMPLE);
    printGroup(TYPE_LABEL[type], group);
  }

  // The question this report exists to answer.
  const nb = res.reps.filter((r) => r.dealType === "new_business");
  const commits = nb
    .map((r) => r.bands.find((b) => b.band === "Commit")!)
    .filter((b) => b.winRate !== null)
    .map((b) => b.winRate as number);
  console.log(`\n${"=".repeat(96)}`);
  if (commits.length >= 2) {
    const lo = Math.min(...commits);
    const hi = Math.max(...commits);
    console.log(
      `SPREAD ON NEW BUSINESS COMMIT: ${(lo * 100).toFixed(0)}% to ${(hi * 100).toFixed(0)}% across ${commits.length} reps with a reportable sample.`,
    );
    console.log(
      hi - lo >= 0.15
        ? `That is a real spread. Weighting the roll-up per rep changes the number a leader reports.`
        : `That is a narrow spread. Per-rep weighting would move the roll-up very little, and saying so`,
    );
    if (hi - lo < 0.15) console.log(`is more useful than shipping a dashboard that implies otherwise.`);
  } else {
    console.log(`NOT ENOUGH REPS carry ${MIN_SAMPLE} or more new-business Commit deals to compare a spread.`);
    console.log(`That is a finding: calibration needs volume, and this book may not have it per rep yet.`);
  }
  console.log(`${"=".repeat(96)}\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
