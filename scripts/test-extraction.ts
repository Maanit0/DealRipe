/**
 * Dry-run extraction tester. Runs the REAL extraction prompt + model call
 * against a transcript and prints the per-field result, with NO database
 * writes. Use it to eyeball extraction quality against the Magaya framework
 * (or any tenant's framework) and to tune the transcript / prompt.
 *
 *   npx tsx scripts/test-extraction.ts
 *   npx tsx scripts/test-extraction.ts path/to/transcript.txt
 *   npx tsx scripts/test-extraction.ts path/to/transcript.txt --tenant magaya
 *
 * Mirrors lib/transcript-ingest.ts extractAndStore() (same system prompt
 * from buildExtractionSystemPrompt, same model, temperature 0.1,
 * max_tokens 4000), minus the call-record lookup and Supabase writes.
 *
 * Requires ANTHROPIC_API_KEY in .env.local. Reads the framework from
 * Supabase (read-only).
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

const DEFAULT_TRANSCRIPT = path.join(
  __dirname,
  "fixtures",
  "sample-magaya-call.txt",
);
const DEFAULT_FRAMEWORK_NAME = "Magaya Rolldog";

function parseArgs(argv: string[]): { transcriptPath: string; tenantSlug: string } {
  let transcriptPath = DEFAULT_TRANSCRIPT;
  let tenantSlug = "magaya";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tenant") {
      tenantSlug = argv[++i] ?? tenantSlug;
    } else {
      transcriptPath = argv[i];
    }
  }
  return { transcriptPath, tenantSlug };
}

function parseExtraction(raw: string): Record<string, any> | null {
  let s = raw.trim();
  // strip ```json ... ``` or ``` ... ``` fences if present
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

async function main(): Promise<void> {
  const { transcriptPath, tenantSlug } = parseArgs(process.argv.slice(2));

  // 1. Resolve tenant + load the named framework (not the tenant default,
  //    which could be SCOTSMAN).
  const tenantId = await resolveTenantId(tenantSlug);
  const db = supabaseAdmin();
  const fwRow = await db
    .from("qualification_frameworks")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .eq("name", DEFAULT_FRAMEWORK_NAME)
    .maybeSingle();
  if (fwRow.error || !fwRow.data) {
    console.error(
      `Could not find framework "${DEFAULT_FRAMEWORK_NAME}" for tenant ${tenantSlug}. Run scripts/seed-magaya-framework.ts first.`,
    );
    process.exit(1);
  }
  const framework = await loadFramework(tenantId, fwRow.data.id);
  if (!framework) {
    console.error("loadFramework returned null.");
    process.exit(1);
  }

  // 2. Read the transcript.
  const transcript = readFileSync(transcriptPath, "utf8");

  console.log(`framework:  ${framework.name} (${framework.fields.length} fields)`);
  console.log(`transcript: ${transcriptPath} (${transcript.length} chars)`);
  console.log(`model:      ${getAnthropicModel()}`);
  console.log("running extraction (temp 0.1)...\n");

  // 3. Same model call as production extractAndStore().
  const t0 = Date.now();
  const response = await getAnthropicClient().messages.create({
    model: getAnthropicModel(),
    max_tokens: 4000,
    temperature: 0.1,
    system: buildExtractionSystemPrompt(framework),
    messages: [
      { role: "user", content: `<transcript>\n${transcript}\n</transcript>` },
    ],
  });
  const ms = Date.now() - t0;

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = textBlock && "text" in textBlock ? textBlock.text : "";
  const parsed = parseExtraction(raw);
  if (!parsed) {
    console.error("Could not parse model output as JSON. Raw output:\n");
    console.error(raw);
    process.exit(1);
  }

  // 4. Print per field, grouped by stage, in framework order.
  let currentStage = "__none__";
  const counts = { Yes: 0, No: 0, Unknown: 0, missing: 0 };
  for (const f of framework.fields) {
    const stage = f.stageKey ?? "(no stage)";
    if (stage !== currentStage) {
      currentStage = stage;
      console.log(`\n=== ${stage} ===`);
    }
    const r = parsed[f.fieldKey];
    if (!r || typeof r.status !== "string") {
      counts.missing++;
      console.log(`  [MISSING] ${f.fieldKey}`);
      continue;
    }
    const status = r.status as "Yes" | "No" | "Unknown";
    if (status in counts) (counts as any)[status]++;
    const conf = typeof r.confidence === "number" ? ` conf=${r.confidence}` : "";
    console.log(`  ${status.toUpperCase().padEnd(8)} ${f.fieldKey}${conf}`);
    if (status === "Yes") {
      if (r.answer) console.log(`           answer:   ${truncate(String(r.answer), 160)}`);
      if (r.evidence) console.log(`           evidence: "${truncate(String(r.evidence), 160)}"`);
    }
  }

  // 5. Summary.
  console.log("");
  console.log(
    `summary: ${counts.Yes} Yes, ${counts.No} No, ${counts.Unknown} Unknown, ${counts.missing} missing  (${ms} ms)`,
  );
  console.log("");
  console.log("Eyeball check:");
  console.log("  - Every Yes 'evidence' must be a VERBATIM CUSTOMER quote (not the rep).");
  console.log("  - Topics that never came up should be Unknown; deflections should be No.");
  console.log("  - No em-dashes in any 'answer' text.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
