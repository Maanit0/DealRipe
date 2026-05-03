import { NextRequest, NextResponse } from "next/server";
import { anthropic, MODEL } from "@/lib/anthropic";
import { CRITERIA, CallScore } from "@/lib/scoring";
import { addScore } from "@/lib/callStore";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server." },
      { status: 500 }
    );
  }

  const { dealId, dealName, ae, notes, missingIds } = (await req.json()) as {
    dealId: string;
    dealName: string;
    ae: string;
    notes: string;
    missingIds: string[];
  };

  if (!notes || notes.trim().length < 20) {
    return NextResponse.json(
      { error: "Paste real call notes (at least a couple of sentences) so the rubric has something to score." },
      { status: 400 }
    );
  }

  const criteriaList = CRITERIA.map(c => `- ${c.key}: ${c.label}`).join("\n");

  const system = `You are DealRipe's "Skills of delivery" reviewer. Paul Foreman (CRO, Topsort) uses these EXACT 6 criteria to score every discovery call:

${criteriaList}

Criterion #6 (next_meeting) is binary and is the CARDINAL RULE — "the cardinal sin is not booking the next meeting before ending the call."

You will receive raw call notes from a Topsort AE. For each criterion, decide passed/failed based on whether the notes show evidence the rep actually did it. Quote a short snippet (or paraphrase) as evidence. Be strict — "we talked about timeline" is NOT evidence of confirming a timescale; "they confirmed Q2 launch with board approval Mar 15" IS.

Also extract any SCOTSMAN field updates the call surfaced. Possible fields:
T1=timescales aware, T2=timescale defined, A1=right person, A2=who decides, A3=access to decision maker, A4=who else involved, M1=budget defined, M2=budget approved, S1=size worth pursuing, N1=solution aligns, C1=competition known.

Return STRICT JSON only:
{
  "criteria": [
    { "key": "objective", "passed": true|false, "evidence": "..." },
    ...all 6 criteria in order...
  ],
  "summary": "one sentence — what went well and what to fix",
  "scotsmanUpdates": [
    { "fieldId": "T2", "newStatus": "Yes" }
  ]
}`;

  const user = `DEAL: ${dealName}
AE: ${ae}
Currently missing SCOTSMAN fields: ${missingIds.join(", ") || "(none)"}

CALL NOTES:
"""
${notes}
"""

Score the call against the 6 criteria. Return JSON only.`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");

  const parsed = extractJson(text);

  // Normalize: enforce all 6 criteria in order with labels
  const criteriaMap = new Map<string, any>();
  (parsed.criteria || []).forEach((c: any) => criteriaMap.set(c.key, c));
  const criteria = CRITERIA.map(c => {
    const m = criteriaMap.get(c.key) || { passed: false, evidence: "Not evidenced in notes." };
    return { key: c.key, label: c.label, passed: !!m.passed, evidence: String(m.evidence || "") };
  });

  const overall = criteria.filter(c => c.passed).length;
  const cardinalRuleMet = criteria.find(c => c.key === "next_meeting")?.passed === true;

  const score: CallScore = {
    id: `${dealId}-${Date.now()}`,
    dealId,
    ae,
    loggedAt: new Date().toISOString(),
    notes,
    criteria,
    overall,
    cardinalRuleMet,
    summary: String(parsed.summary || ""),
    scotsmanUpdates: parsed.scotsmanUpdates || [],
  };

  addScore(dealId, score);
  return NextResponse.json({ score });
}

function extractJson(text: string): any {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return {};
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return {};
  }
}
