import { NextRequest, NextResponse } from "next/server";
import { anthropic, MODEL } from "@/lib/anthropic";
import { buildExtractionSystemPrompt } from "@/lib/extraction-prompt";
import {
  SCOTSMAN_FIELDS,
  type ExtractionResult,
  type FieldExtraction,
} from "@/lib/scotsman";

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

  let body: { transcript?: string; dealId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const transcript = (body.transcript ?? "").trim();
  const dealId = body.dealId ?? "unknown";

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
