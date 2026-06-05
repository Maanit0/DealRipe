import { NextRequest, NextResponse } from "next/server";
import {
  ApiKeyMissingError,
  ExtractionParseError,
  InvalidTranscriptSourceError,
  LLMServiceError,
  LLMTimeoutError,
  TranscriptIngestError,
  TranscriptTooShortError,
  UnknownCallError,
  ingestTranscript,
} from "@/lib/transcript-ingest";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Thin HTTP wrapper. All transcript handling, validation, model call,
 * and audit writes happen in lib/transcript-ingest.ts so a paste from
 * the UI and a future Recall.ai webhook flow through the same code.
 */
export async function POST(req: NextRequest) {
  let body: { transcript?: string; callId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!body.callId) {
    return NextResponse.json({ error: "callId required" }, { status: 400 });
  }

  try {
    const { extraction } = await ingestTranscript({
      source: "manual_paste",
      externalCallId: body.callId,
      transcript: body.transcript ?? "",
    });
    return NextResponse.json({ extraction });
  } catch (err) {
    return mapIngestError(err);
  }
}

function mapIngestError(err: unknown): NextResponse {
  if (err instanceof ApiKeyMissingError) {
    return NextResponse.json(
      {
        error:
          "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server.",
      },
      { status: 500 },
    );
  }
  if (err instanceof InvalidTranscriptSourceError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof TranscriptTooShortError) {
    return NextResponse.json({ error: "Transcript too short" }, { status: 400 });
  }
  if (err instanceof UnknownCallError) {
    return NextResponse.json({ error: "Unknown call id" }, { status: 404 });
  }
  if (err instanceof ExtractionParseError) {
    return NextResponse.json(
      { error: "Could not parse extraction output" },
      { status: 502 },
    );
  }
  if (err instanceof LLMTimeoutError) {
    return NextResponse.json({ error: "Extraction timed out" }, { status: 504 });
  }
  if (err instanceof LLMServiceError) {
    return NextResponse.json(
      { error: "Extraction service unavailable" },
      { status: 502 },
    );
  }
  if (err instanceof TranscriptIngestError) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
  console.error("[extract-scotsman] unexpected error:", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}
