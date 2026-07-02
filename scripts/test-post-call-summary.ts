/**
 * Dry-run the post-call summary end to end: extract a transcript, generate
 * the rep-facing recap, render the email, and write an HTML preview you can
 * open in a browser. Optionally send it.
 *
 *   npx tsx scripts/test-post-call-summary.ts
 *   npx tsx scripts/test-post-call-summary.ts path/to/transcript.txt
 *   npx tsx scripts/test-post-call-summary.ts --account "Aqua Gulf" --stage SQL2
 *   npx tsx scripts/test-post-call-summary.ts --send you@example.com
 *
 * Requires ANTHROPIC_API_KEY (extraction + recap) and reads the framework
 * from Supabase. --send additionally requires RESEND_API_KEY + MAIL_FROM.
 * No database writes.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getAnthropicClient, getAnthropicModel } from "../lib/anthropic";
import type { ExtractionMap } from "../lib/briefing-magaya";
import { renderPostCallSummaryEmail } from "../lib/emails/post-call-summary";
import { buildExtractionSystemPrompt } from "../lib/extraction-prompt";
import { loadFramework } from "../lib/framework";
import { generatePostCallSummary } from "../lib/post-call-summary";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const DEFAULT_TRANSCRIPT = path.join(__dirname, "fixtures", "sample-magaya-call.txt");
const FRAMEWORK_NAME = "Magaya Rolldog";

type Args = {
  transcriptPath: string;
  tenantSlug: string;
  account: string;
  stage: string;
  closeDate?: string;
  send?: string;
  out: string;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    transcriptPath: DEFAULT_TRANSCRIPT,
    tenantSlug: "magaya",
    account: "Aqua Gulf",
    stage: "SQL2",
    out: path.join(process.cwd(), ".previews", "post-call-summary.html"),
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--tenant") a.tenantSlug = argv[++i] ?? a.tenantSlug;
    else if (v === "--account") a.account = argv[++i] ?? a.account;
    else if (v === "--stage") a.stage = argv[++i] ?? a.stage;
    else if (v === "--close") a.closeDate = argv[++i];
    else if (v === "--send") a.send = argv[++i];
    else if (v === "--out") a.out = argv[++i] ?? a.out;
    else if (!v.startsWith("--")) a.transcriptPath = v;
  }
  return a;
}

function parseJson(raw: string): Record<string, { status?: string; answer?: string; evidence?: string; confidence?: number }> | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const tenantId = await resolveTenantId(args.tenantSlug);
  const db = supabaseAdmin();
  const fwRow = await db
    .from("qualification_frameworks")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("name", FRAMEWORK_NAME)
    .maybeSingle();
  if (fwRow.error || !fwRow.data) {
    console.error(`Framework "${FRAMEWORK_NAME}" not found. Run scripts/seed-magaya-framework.ts first.`);
    process.exit(1);
  }
  const framework = await loadFramework(tenantId, fwRow.data.id);
  if (!framework) {
    console.error("loadFramework returned null.");
    process.exit(1);
  }

  const transcript = readFileSync(args.transcriptPath, "utf8");

  console.log(`framework:  ${framework.name} (${framework.fields.length} fields)`);
  console.log(`transcript: ${args.transcriptPath} (${transcript.length} chars)`);
  console.log(`deal:       ${args.account} (${args.stage})`);
  console.log(`model:      ${getAnthropicModel()}`);
  console.log("");

  // 1. Extract (same call as production ingest / test-extraction).
  console.log("extracting transcript...");
  const exResp = await getAnthropicClient().messages.create({
    model: getAnthropicModel(),
    max_tokens: 4000,
    temperature: 0.1,
    system: buildExtractionSystemPrompt(framework),
    messages: [{ role: "user", content: `<transcript>\n${transcript}\n</transcript>` }],
  });
  const exBlock = exResp.content.find((b) => b.type === "text");
  const exRaw = exBlock && "text" in exBlock ? exBlock.text : "";
  const parsed = parseJson(exRaw);
  if (!parsed) {
    console.error("Could not parse extraction JSON. Raw:\n" + exRaw);
    process.exit(1);
  }

  const extraction: ExtractionMap = {};
  for (const f of framework.fields) {
    const r = parsed[f.fieldKey];
    if (r && r.status === "Yes") {
      extraction[f.fieldKey] = {
        status: "Yes",
        answer: r.answer ?? "",
        evidence: r.evidence ?? "",
        confidence: typeof r.confidence === "number" ? r.confidence : undefined,
      };
    } else if (r && r.status === "No") {
      extraction[f.fieldKey] = { status: "No" };
    } else {
      extraction[f.fieldKey] = { status: "Unknown" };
    }
  }

  // 2. Generate the summary.
  console.log("generating post-call recap...");
  const summary = await generatePostCallSummary({
    account: args.account,
    stageKey: args.stage,
    closeDate: args.closeDate,
    framework,
    extraction,
    transcript,
  });

  // 3. Render the email.
  const email = renderPostCallSummaryEmail(summary);

  // 4. Write the HTML preview + print the text.
  mkdirSync(path.dirname(args.out), { recursive: true });
  writeFileSync(args.out, email.html, "utf8");

  console.log("");
  console.log("================= EMAIL (text) =================");
  console.log(`Subject: ${email.subject}`);
  console.log("");
  console.log(email.text);
  console.log("===============================================");
  console.log("");
  console.log(`captured: ${summary.captured.length}   still open: ${summary.stillOpen.length}`);
  console.log(`HTML preview written to: ${args.out}`);
  console.log("Open it in a browser to see exactly what the rep receives.");

  // 5. Optionally send.
  if (args.send) {
    console.log("");
    console.log(`sending to ${args.send} ...`);
    const { sendEmail } = await import("../lib/mailer");
    const res = await sendEmail({
      to: args.send,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    console.log(`sent. id=${res.id}`);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
