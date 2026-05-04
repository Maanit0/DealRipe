import { NextRequest, NextResponse } from "next/server";
import { anthropic, MODEL } from "@/lib/anthropic";
import type { Database, Json } from "@/lib/database.types";
import { mergeExtraction } from "@/lib/extraction-merge";
import { buildExtractionSystemPrompt } from "@/lib/extraction-prompt";
import {
  SCOTSMAN_FIELDS,
  type ExtractionResult,
  type FieldExtraction,
} from "@/lib/scotsman";
import { getDealById } from "@/lib/seed-data";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveDealId, resolveTenantId } from "@/lib/tenant-deal-lookup";

const TENANT_SLUG = "topsort";
const PROMPT_VERSION = "v1";

type FieldExtractionInsert =
  Database["public"]["Tables"]["field_extractions"]["Insert"];

export const runtime = "nodejs";
export const maxDuration = 60;

const MIN_TRANSCRIPT_CHARS = 50;
const REQUEST_TIMEOUT_MS = 45_000;

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server." },
      { status: 500 },
    );
  }

  let body: { transcript?: string; dealId?: string; callId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const transcript = (body.transcript ?? "").trim();
  const dealId = body.dealId ?? "unknown";
  const callId = body.callId ?? "";

  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    return NextResponse.json({ error: "Transcript too short" }, { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();

  try {
    const response = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: 4000,
        temperature: 0.1,
        system: buildExtractionSystemPrompt(),
        messages: [
          {
            role: "user",
            content: `<transcript>\n${transcript}\n</transcript>`,
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

    const parsed = parseExtractionResponse(text);
    if (!parsed) {
      console.error(
        `[extract-scotsman] dealId=${dealId} parse_failed raw_length=${text.length}`,
      );
      return NextResponse.json(
        { error: "Could not parse extraction output" },
        { status: 502 },
      );
    }

    const extraction = validateAndFillExtraction(parsed);
    const duration = Date.now() - start;
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    console.log(
      `[extract-scotsman] dealId=${dealId} ok duration=${duration}ms in=${inputTokens} out=${outputTokens}`,
    );

    // Audit trail: best-effort write. Failures are logged and swallowed
    // so the demo flow keeps working when Supabase has a transient issue.
    await writeAuditTrail({
      dealExternalId: dealId,
      callExternalId: callId,
      extraction,
      modelName: MODEL,
      duration,
      inputTokens,
      outputTokens,
    });

    return NextResponse.json({ extraction });
  } catch (err: any) {
    clearTimeout(timeout);
    const duration = Date.now() - start;

    if (controller.signal.aborted || err?.name === "AbortError") {
      console.error(`[extract-scotsman] dealId=${dealId} timeout duration=${duration}ms`);
      return NextResponse.json({ error: "Extraction timed out" }, { status: 504 });
    }

    console.error(
      `[extract-scotsman] dealId=${dealId} api_error duration=${duration}ms`,
      err?.message ?? err,
    );
    return NextResponse.json(
      { error: "Extraction service unavailable" },
      { status: 502 },
    );
  }
}

function parseExtractionResponse(raw: string): Record<string, unknown> | null {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) return null;
  cleaned = cleaned.slice(firstBrace, lastBrace + 1);

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function validateAndFillExtraction(raw: Record<string, unknown>): ExtractionResult {
  const result: ExtractionResult = {};
  for (const field of SCOTSMAN_FIELDS) {
    const validated = validateFieldExtraction(raw[field.id]);
    result[field.id] = validated ?? { status: "Unknown" };
  }
  return result;
}

async function writeAuditTrail(args: {
  dealExternalId: string;
  callExternalId: string;
  extraction: ExtractionResult;
  modelName: string;
  duration: number;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const {
    dealExternalId,
    callExternalId,
    extraction,
    modelName,
    duration,
    inputTokens,
    outputTokens,
  } = args;

  try {
    const deal = getDealById(dealExternalId);
    if (!deal) {
      console.error(
        `[extract-scotsman] audit skipped: deal not in seed (id=${dealExternalId})`,
      );
      return;
    }

    const tenantId = await resolveTenantId(TENANT_SLUG);
    const dealUuid = await resolveDealId(dealExternalId, TENANT_SLUG);
    // calls aren't migrated yet; last_updated_from_call_id stays null
    const callUuid: string | null = null;

    const { merged, changedIds } = mergeExtraction(
      deal.extraction,
      extraction,
      callExternalId,
    );

    const db = supabaseAdmin();

    const runInsert = await db.from("extraction_runs").insert({
      tenant_id: tenantId,
      deal_id: dealUuid,
      call_id: callUuid,
      model_name: modelName,
      prompt_version: PROMPT_VERSION,
      raw_response: extraction as unknown as Json,
      token_input: inputTokens,
      token_output: outputTokens,
      duration_ms: duration,
    });
    if (runInsert.error) {
      console.error(
        `[extract-scotsman] extraction_runs insert failed:`,
        runInsert.error,
      );
    }

    if (changedIds.length === 0) {
      console.log(
        `[extract-scotsman] audit ok dealId=${dealExternalId} no field changes`,
      );
      return;
    }

    const upsertRows: FieldExtractionInsert[] = changedIds.map((id) => {
      const entry = merged[id];
      const row: FieldExtractionInsert = {
        tenant_id: tenantId,
        deal_id: dealUuid,
        scotsman_field_id: id,
        status: entry.status,
        last_updated_from_call_id: callUuid,
      };
      if (entry.status === "Yes") {
        row.answer = entry.answer;
        row.evidence = entry.evidence;
        row.confidence = entry.confidence;
      } else {
        row.answer = null;
        row.evidence = null;
        row.confidence = null;
      }
      return row;
    });

    const upsert = await db
      .from("field_extractions")
      .upsert(upsertRows, { onConflict: "deal_id,scotsman_field_id" });
    if (upsert.error) {
      console.error(
        `[extract-scotsman] field_extractions upsert failed:`,
        upsert.error,
      );
      return;
    }

    console.log(
      `[extract-scotsman] audit ok dealId=${dealExternalId} run_inserted=1 fields_upserted=${changedIds.length} (${changedIds.join(",")})`,
    );
  } catch (err) {
    console.error("[extract-scotsman] audit write failed:", err);
  }
}

function validateFieldExtraction(entry: unknown): FieldExtraction | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;

  if (e.status === "Yes") {
    if (
      typeof e.answer !== "string" ||
      typeof e.evidence !== "string" ||
      typeof e.confidence !== "number"
    ) {
      return null;
    }
    return {
      status: "Yes",
      answer: e.answer,
      evidence: e.evidence,
      confidence: Math.max(0, Math.min(1, e.confidence)),
    };
  }

  if (e.status === "No" || e.status === "Unknown") {
    return { status: e.status };
  }

  return null;
}
