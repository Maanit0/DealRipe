import { NextRequest, NextResponse } from "next/server";
import { getAnthropicClient, getAnthropicModel } from "@/lib/anthropic";
import {
  buildBriefingSystemPrompt,
  buildBriefingUserMessage,
  computeTopQuestionIds,
} from "@/lib/briefing-prompt";
import type { Json } from "@/lib/database.types";
import { loadFramework, type Framework } from "@/lib/framework";
import { SPIN_FOLLOWUPS, STAGES, type ExtractionResult } from "@/lib/scotsman";
import { getDealById, getStageForDeal } from "@/lib/seed-data";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveDealId, resolveTenantId } from "@/lib/tenant-deal-lookup";

const TENANT_SLUG = "topsort";
const PROMPT_VERSION = "v1";

export const runtime = "nodejs";
export const maxDuration = 60;

const REQUEST_TIMEOUT_MS = 45_000;

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server." },
      { status: 500 },
    );
  }

  let body: { dealId?: string; extraction?: ExtractionResult };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { dealId, extraction } = body;
  if (!dealId || !extraction) {
    return NextResponse.json(
      { error: "Missing dealId or extraction" },
      { status: 400 },
    );
  }

  const deal = getDealById(dealId);
  if (!deal) {
    return NextResponse.json({ error: "Deal not found" }, { status: 404 });
  }
  const stage = getStageForDeal(deal);
  if (!stage) {
    return NextResponse.json({ error: "Stage not found" }, { status: 404 });
  }

  const stageIndex = STAGES.findIndex((s) => s.key === stage.key);
  const nextStage =
    stageIndex >= 0 && stageIndex < STAGES.length - 1
      ? STAGES[stageIndex + 1]
      : null;

  // Load the framework for this deal's tenant. Briefing assembly is now
  // framework-driven; gate/stage logic still uses SCOTSMAN STAGES because
  // this route is reached only via seed-data deals (topsort).
  let framework: Framework | null;
  try {
    const topsortTenantId = await resolveTenantId(TENANT_SLUG);
    framework = await loadFramework(topsortTenantId);
  } catch (err) {
    console.error(
      `[prepare-briefing] dealId=${dealId} framework lookup failed:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "Briefing service misconfigured" },
      { status: 500 },
    );
  }
  if (!framework) {
    return NextResponse.json(
      {
        error:
          "No qualification framework registered for tenant topsort. Run `npm run seed:frameworks`.",
      },
      { status: 500 },
    );
  }

  const topQuestionIds = computeTopQuestionIds(
    framework,
    extraction,
    stage,
    nextStage,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  const modelName = getAnthropicModel();

  try {
    const response = await getAnthropicClient().messages.create(
      {
        model: modelName,
        max_tokens: 1500,
        temperature: 0.3,
        system: buildBriefingSystemPrompt(framework),
        messages: [
          {
            role: "user",
            content: buildBriefingUserMessage(
              deal,
              framework,
              stage,
              nextStage,
              extraction,
              topQuestionIds,
            ),
          },
        ],
      },
      { signal: controller.signal },
    );

    clearTimeout(timeout);

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");

    const parsed = parseBriefing(text);
    if (!parsed) {
      console.error(
        `[prepare-briefing] dealId=${dealId} parse_failed raw_length=${text.length}`,
      );
      return NextResponse.json(
        { error: "Could not parse briefing output" },
        { status: 502 },
      );
    }

    const topQuestions = topQuestionIds.map((id) => ({
      fieldId: id,
      question: SPIN_FOLLOWUPS[id] ?? "",
    }));

    const duration = Date.now() - start;
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    console.log(
      `[prepare-briefing] dealId=${dealId} ok duration=${duration}ms in=${inputTokens} out=${outputTokens}`,
    );

    // Audit trail: best-effort write. Failures are logged and swallowed.
    await writeBriefingAudit({
      dealExternalId: dealId,
      parsedBriefing: parsed,
      modelName,
      duration,
      inputTokens,
      outputTokens,
    });

    return NextResponse.json({
      callObjective: parsed.callObjective,
      topQuestions,
      nextStepCommitment: parsed.nextStepCommitment,
      whatsAtRisk: parsed.whatsAtRisk,
    });
  } catch (err: any) {
    clearTimeout(timeout);
    const duration = Date.now() - start;
    if (controller.signal.aborted || err?.name === "AbortError") {
      console.error(
        `[prepare-briefing] dealId=${dealId} timeout duration=${duration}ms`,
      );
      return NextResponse.json({ error: "Briefing timed out" }, { status: 504 });
    }
    console.error(
      `[prepare-briefing] dealId=${dealId} api_error duration=${duration}ms`,
      err?.message ?? err,
    );
    return NextResponse.json(
      { error: "Briefing service unavailable" },
      { status: 502 },
    );
  }
}

async function writeBriefingAudit(args: {
  dealExternalId: string;
  parsedBriefing: {
    callObjective: string;
    nextStepCommitment: string;
    whatsAtRisk: string;
  };
  modelName: string;
  duration: number;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const {
    dealExternalId,
    parsedBriefing,
    modelName,
    duration,
    inputTokens,
    outputTokens,
  } = args;

  try {
    const tenantId = await resolveTenantId(TENANT_SLUG);
    const dealUuid = await resolveDealId(dealExternalId, TENANT_SLUG);

    const ins = await supabaseAdmin().from("briefing_runs").insert({
      tenant_id: tenantId,
      deal_id: dealUuid,
      model_name: modelName,
      prompt_version: PROMPT_VERSION,
      raw_response: parsedBriefing as unknown as Json,
      token_input: inputTokens,
      token_output: outputTokens,
      duration_ms: duration,
    });

    if (ins.error) {
      console.error(
        `[prepare-briefing] briefing_runs insert failed:`,
        ins.error,
      );
      return;
    }

    console.log(
      `[prepare-briefing] audit ok dealId=${dealExternalId} run_inserted=1`,
    );
  } catch (err) {
    console.error("[prepare-briefing] audit write failed:", err);
  }
}

function parseBriefing(
  raw: string,
): {
  callObjective: string;
  nextStepCommitment: string;
  whatsAtRisk: string;
} | null {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) return null;
  cleaned = cleaned.slice(firstBrace, lastBrace + 1);

  try {
    const parsed = JSON.parse(cleaned);
    if (
      typeof parsed?.callObjective === "string" &&
      typeof parsed?.nextStepCommitment === "string" &&
      typeof parsed?.whatsAtRisk === "string"
    ) {
      return {
        callObjective: parsed.callObjective,
        nextStepCommitment: parsed.nextStepCommitment,
        whatsAtRisk: parsed.whatsAtRisk,
      };
    }
    return null;
  } catch {
    return null;
  }
}
