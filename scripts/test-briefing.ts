/**
 * Dry-run pre-call briefing tester. Runs the real extraction on a
 * transcript, computes the open SQL gaps for the deal's stage, then
 * generates a rep-facing briefing with the real briefing prompt. NO
 * database writes.
 *
 *   npx tsx scripts/test-briefing.ts
 *   npx tsx scripts/test-briefing.ts path/to/transcript.txt --stage SQL3 \
 *      --account "Harbor Freight Logistics" --close "2026-10-01" \
 *      --attendees "David Okafor (Director of Operations, champion); Priya Nair (IT Manager)"
 *
 * Mirrors the production path: extraction (lib/extraction-prompt) -> open
 * gaps off stage_key (lib/briefing-magaya) -> briefing (lib/briefing-magaya).
 * Requires ANTHROPIC_API_KEY in .env.local.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import path from "node:path";

import { loadFramework } from "../lib/framework";
import { buildExtractionSystemPrompt } from "../lib/extraction-prompt";
import { getAnthropicClient, getAnthropicModel } from "../lib/anthropic";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { supabaseAdmin } from "../lib/supabase";
import {
  buildMagayaBriefingSystemPrompt,
  buildMagayaBriefingUserMessage,
  openGapsForStage,
  nextStageOf,
  type ExtractionMap,
} from "../lib/briefing-magaya";

const DEFAULT_TRANSCRIPT = path.join(__dirname, "fixtures", "sample-magaya-call.txt");
const FRAMEWORK_NAME = "Magaya Rolldog";

type Args = {
  transcriptPath: string;
  stage: string;
  account: string;
  close?: string;
  attendees: string;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    transcriptPath: DEFAULT_TRANSCRIPT,
    stage: "SQL3",
    account: "Harbor Freight Logistics",
    close: "first week of October 2026",
    attendees:
      "David Okafor (Director of Operations, champion); Priya Nair (IT Manager, technical)",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--stage") a.stage = argv[++i] ?? a.stage;
    else if (k === "--account") a.account = argv[++i] ?? a.account;
    else if (k === "--close") a.close = argv[++i] ?? a.close;
    else if (k === "--attendees") a.attendees = argv[++i] ?? a.attendees;
    else a.transcriptPath = k;
  }
  return a;
}

function parseJson(raw: string): any | null {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function callModel(system: string, user: string): Promise<string> {
  const resp = await getAnthropicClient().messages.create({
    model: getAnthropicModel(),
    max_tokens: 4000,
    temperature: 0.1,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = resp.content.find((b) => b.type === "text");
  return block && "text" in block ? block.text : "";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const fwRow = await db
    .from("qualification_frameworks")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("name", FRAMEWORK_NAME)
    .maybeSingle();
  if (fwRow.error || !fwRow.data) {
    console.error(`Framework "${FRAMEWORK_NAME}" not found. Seed it first.`);
    process.exit(1);
  }
  const framework = await loadFramework(tenantId, fwRow.data.id);
  if (!framework) {
    console.error("loadFramework returned null.");
    process.exit(1);
  }

  const transcript = readFileSync(args.transcriptPath, "utf8");

  // 1. Extraction (same call as production).
  console.log(`Extracting against ${framework.name} (${framework.fields.length} fields)...`);
  const exRaw = await callModel(
    buildExtractionSystemPrompt(framework),
    `<transcript>\n${transcript}\n</transcript>`,
  );
  const exParsed = parseJson(exRaw);
  if (!exParsed) {
    console.error("Could not parse extraction output.\n" + exRaw);
    process.exit(1);
  }
  const extraction: ExtractionMap = exParsed;

  // 2. Open gaps for the current + next stage.
  const nextStage = nextStageOf(args.stage);
  const currentGaps = openGapsForStage(framework, extraction, args.stage);
  const nextGaps = nextStage ? openGapsForStage(framework, extraction, nextStage) : [];

  // 3. Generate the briefing.
  console.log("Generating briefing...\n");
  const brRaw = await callModel(
    buildMagayaBriefingSystemPrompt(framework),
    buildMagayaBriefingUserMessage({
      account: args.account,
      stage: args.stage,
      nextStage,
      closeDate: args.close,
      attendees: args.attendees,
      framework,
      extraction,
      currentGaps,
      nextGaps,
    }),
  );
  const br = parseJson(brRaw);
  if (!br) {
    console.error("Could not parse briefing output.\n" + brRaw);
    process.exit(1);
  }

  // 4. Print email-ready.
  const qCount = Array.isArray(br.questions) ? br.questions.length : 0;
  console.log("=".repeat(72));
  console.log(`Subject: Prep for your ${args.account} call: ${qCount} thing${qCount === 1 ? "" : "s"} to nail`);
  console.log("=".repeat(72));
  console.log(`Deal: ${args.account}  |  Stage: ${args.stage}  |  On the call: ${args.attendees}`);
  console.log("");
  console.log(`Objective: ${br.callObjective ?? "(missing)"}`);
  console.log("");
  console.log(`Where it stands: ${br.whereItStands ?? "(missing)"}`);
  console.log("");
  console.log("Ask these:");
  if (Array.isArray(br.questions)) {
    br.questions.forEach((q: any, i: number) => {
      const tag = q.targetLabel ? `   [${q.targetLabel}]` : "";
      console.log(`  ${i + 1}. ${q.ask ?? "(missing ask)"}${tag}`);
      if (q.why) console.log(`     why: ${q.why}`);
      if (Array.isArray(q.targetFields) && q.targetFields.length) {
        console.log(`     (internal -> prescribed_actions: ${q.targetFields.join(", ")})`);
      }
    });
  }
  console.log("");
  console.log(`Secure this next step: ${br.nextStepCommitment ?? "(missing)"}`);
  console.log("");
  console.log(`What's at risk: ${br.whatsAtRisk ?? "(missing)"}`);
  if (br.signalFlag) {
    console.log("");
    console.log(`Signal: ${br.signalFlag}`);
  }
  console.log("");
  console.log("-".repeat(72));
  console.log(`open gaps fed in: current ${args.stage} = ${currentGaps.length}, next ${nextStage ?? "n/a"} = ${nextGaps.length}`);
  console.log("Eyeball: questions are rep-facing (asked TO the customer), targeted to who's on the call, tied to real open gaps. No em-dashes.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
