/**
 * Print or export the complete journey of a deal, across every channel.
 *
 *   npx tsx scripts/deal-journey.ts --deal <uuid>
 *   npx tsx scripts/deal-journey.ts --account Dunavant
 *   npx tsx scripts/deal-journey.ts --all --json      # every deal to .previews/
 *   npx tsx scripts/deal-journey.ts --account X --gathered   # + the framework answers
 *   npx tsx scripts/deal-journey.ts --account X --transcripts  # + every word said
 *
 * READ ONLY.
 *
 * NDA. The output contains transcript-derived text, email bodies and the
 * customer's own words from the extraction evidence. It goes to .previews/,
 * which is gitignored for exactly this reason. Do not commit an export, do not
 * paste one into a file in this repo, and do not send one anywhere. Anything
 * derived from a transcript is still transcript.
 *
 * WHY --json EXISTS. Reading one deal is how you understand the process;
 * reading 127 is how you find the pattern. The JSON export is the input to that
 * second question, and it is deliberately a local file rather than a table:
 * this is a projection over the ledger, so it is cheap to regenerate and must
 * never become a second source of truth that drifts.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildDealJourney, type DealJourney } from "../lib/deal-journey";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function render(j: DealJourney, showGathered: boolean, showTranscripts: boolean): string {
  const L: string[] = [];
  L.push("");
  L.push("=".repeat(100));
  L.push(`  ${j.account}${j.outcomeLabel ? `   [CLOSED ${j.outcomeLabel.toUpperCase()}]` : ""}`);
  L.push(`  deal ${j.dealId}`);
  L.push("=".repeat(100));

  L.push("");
  L.push(`  COVERAGE`);
  L.push(`    captured conversations:      ${j.coverage.capturedConversations}`);
  L.push(`    meetings with no capture:    ${j.coverage.callRowsWithoutConversation}`);
  L.push(`    emails held:                 ${j.coverage.emailsHeld}`);
  L.push(
    `    email bodies missing:        ${j.coverage.emailBodiesMissing.gone} gone, ` +
      `${j.coverage.emailBodiesMissing.skipped} skipped, ${j.coverage.emailBodiesMissing.notFetched} not fetched`,
  );
  for (const n of j.coverage.notes) L.push(`    NOTE: ${n}`);

  L.push("");
  L.push(`  WHO AUTHORED THE EVIDENCE`);
  const byAuthor: Record<string, number> = {};
  for (const e of j.events) byAuthor[e.authorship] = (byAuthor[e.authorship] ?? 0) + 1;
  for (const k of ["buyer", "system", "mixed", "seller", "dealripe"]) {
    if (!byAuthor[k]) continue;
    const note =
      k === "buyer" ? "  the customer's own words and actions. Ground truth."
      : k === "system" ? "  a third party asserting a fact neither side can edit."
      : k === "seller" ? "  the rep's assertions. Calibration material, not ground truth."
      : k === "dealripe" ? "  our own output. Never evidence for our own claims."
      : "  genuinely both sides.";
    L.push(`    ${k.padEnd(10)} ${String(byAuthor[k]).padStart(4)}${note}`);
  }

  L.push("");
  L.push(`  TIMELINE  (${j.events.length} events)`);
  L.push("  " + "-".repeat(96));
  let lastDay = "";
  for (const e of j.events) {
    const d = e.at.slice(0, 10);
    if (d !== lastDay) {
      L.push("");
      L.push(`  ${d}`);
      lastDay = d;
    }
    const tag = e.channel.toUpperCase().padEnd(9);
    // Authorship in the margin, because reading a stage move and a customer
    // reply as the same kind of fact is the mistake this column exists to stop.
    const who = `<${e.authorship}>`.padEnd(10);
    L.push(`    ${tag} ${who} ${e.summary}`);
    if (e.detail) {
      for (const line of String(e.detail).split("\n").slice(0, 6)) {
        if (line.trim()) L.push(`              | ${line.trim().slice(0, 96)}`);
      }
    }
  }

  if (showGathered && j.gathered.length > 0) {
    L.push("");
    L.push(`  WHAT WAS GATHERED  (${j.gathered.length} framework fields answered)`);
    L.push("  " + "-".repeat(96));
    for (const g of j.gathered) {
      L.push(`    ${g.fieldKey}  [${g.status}]  ${g.updatedAt.slice(0, 10)}`);
      if (g.answer) L.push(`        answer:   ${g.answer.slice(0, 140)}`);
      if (g.evidence) L.push(`        they said: ${g.evidence.slice(0, 140)}`);
    }
  }

  if (j.commitments.length > 0) {
    L.push("");
    L.push(`  WHAT WE SAID WE WOULD DO  (${j.commitments.length})`);
    L.push("  " + "-".repeat(96));
    for (const c of j.commitments) {
      // "unsent" is called out because a promise the customer never received is
      // not a commitment, and reading it as one invents an obligation.
      const tag = c.delivery === "sent" ? "sent  " : c.delivery === "unsent" ? "UNSENT" : "?     ";
      L.push(`    ${c.when.slice(0, 10)}  [${tag}] ${c.text.slice(0, 110)}`);
    }
  }

  if (showTranscripts && j.transcripts.length > 0) {
    L.push("");
    L.push(`  FULL TRANSCRIPTS  (${j.transcripts.length} conversations, ${j.transcripts.reduce((n, t) => n + t.chars, 0)} chars)`);
    for (const t of j.transcripts) {
      L.push("");
      L.push("  " + "=".repeat(96));
      L.push(`  ${t.at.slice(0, 10)}  ${t.subtype ?? "unclassified"}${t.meetingType ? ` / ${t.meetingType}` : ""}  ${t.chars} chars`);
      L.push("  " + "=".repeat(96));
      for (const line of t.text.split("\n")) if (line.trim()) L.push(`    ${line.trim()}`);
    }
  }

  L.push("");
  L.push(`  OUTCOMES  (${j.outcomes.length})`);
  L.push("  " + "-".repeat(96));
  for (const o of j.outcomes) L.push(`    ${o.occurredAt.slice(0, 10)}  ${o.kind.padEnd(26)} ${o.evidence}`);
  if (j.outcomes.length === 0) L.push("    none recorded. That is not the same as nothing having happened.");
  L.push("");
  return L.join("\n");
}

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const dealArg = arg("--deal");
  const account = arg("--account");
  const all = process.argv.includes("--all");
  const asJson = process.argv.includes("--json");
  const showGathered = process.argv.includes("--gathered");
  const showTranscripts = process.argv.includes("--transcripts");

  let dealIds: string[] = [];
  if (dealArg) dealIds = [dealArg];
  else if (account) {
    const r = await db.from("deals").select("id, account").eq("tenant_id", tenantId).ilike("account", `%${account}%`);
    if (r.error) throw new Error(r.error.message);
    dealIds = (r.data ?? []).map((d) => d.id);
    if (dealIds.length === 0) throw new Error(`no deal matching "${account}"`);
    if (dealIds.length > 1) console.log(`  ${dealIds.length} deals match "${account}"`);
  } else if (all) {
    const r = await db.from("deals").select("id").eq("tenant_id", tenantId);
    if (r.error) throw new Error(r.error.message);
    dealIds = (r.data ?? []).map((d) => d.id);
  } else {
    console.error("Pass --deal <uuid>, --account <name>, or --all.");
    process.exit(1);
  }

  const built: DealJourney[] = [];
  for (const id of dealIds) {
    try {
      built.push(await buildDealJourney(tenantId, id));
    } catch (err) {
      // Named, never skipped silently: a deal that failed to build is not a
      // deal with no journey.
      console.error(`  FAILED to build ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (asJson) {
    mkdirSync(".previews", { recursive: true });
    const path = resolve(".previews/deal-journeys.json");
    writeFileSync(path, JSON.stringify(built, null, 2), "utf8");
    console.log(`\n  ${built.length} journey/journeys written to ${path}`);
    console.log(`  ${built.reduce((n, j) => n + j.events.length, 0)} events total.`);
    console.log(
      `  ${built.reduce((n, j) => n + j.transcripts.length, 0)} full transcripts ` +
        `(${built.reduce((n, j) => n + j.transcripts.reduce((m, t) => m + t.chars, 0), 0)} chars), ` +
        `${built.reduce((n, j) => n + j.commitments.length, 0)} commitments.`,
    );
    console.log(`  GITIGNORED AND NDA MATERIAL. Do not commit it or send it anywhere.\n`);
    return;
  }

  for (const j of built.sort((a, b) => b.events.length - a.events.length)) {
    console.log(render(j, showGathered, showTranscripts));
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
