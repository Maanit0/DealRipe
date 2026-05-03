import { NextRequest, NextResponse } from "next/server";
import { anthropic, MODEL } from "@/lib/anthropic";
import { SCOTSMAN_FIELDS } from "@/lib/scotsman";
import { Deal } from "@/lib/deal";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server." },
      { status: 500 }
    );
  }
  const { deal, missingIds } = (await req.json()) as { deal: Deal; missingIds: string[] };

  const missingFields = SCOTSMAN_FIELDS.filter(f => missingIds.includes(f.id));
  const missingDescription = missingFields
    .map(f => `- ${f.id} (${f.category}): ${f.question}`)
    .join("\n");

  const knownFields = SCOTSMAN_FIELDS
    .filter(f => deal.status[f.id] === "Yes")
    .map(f => `- ${f.id}: ${f.question}`)
    .join("\n");

  const system = `You are DealRipe, a deal interrogation tool for Topsort sellers using SCOTSMAN qualification + SPIN selling.

Paul Foreman (CRO at Topsort) wants this exact behavior:
"Looking at this deal in your pipeline, the information I'm seeing in the CRM so far leads me to ask these questions — have you asked those already? If not, what's the opportunity and who can you ask them?"

For each missing SCOTSMAN field, generate 2-3 SPIN-style discovery questions the rep should ask. Use Topsort context (retail media, sponsored listings, vendor marketplaces, GMV, take-rate). Be specific to THIS deal — never generic.

Return STRICT JSON only, no prose, matching:
{
  "groups": [
    {
      "fieldId": "T2",
      "fieldLabel": "Timescale — Is the timescale defined?",
      "category": "Timescale",
      "questions": [
        { "spinType": "Situation|Problem|Implication|Need-Payoff", "text": "...", "whatYouLearn": "..." }
      ]
    }
  ]
}`;

  const user = `DEAL: ${deal.name}
AE: ${deal.ae}
Stage: ${deal.stageKey} (BLOCKED — cannot advance)
Last activity: ${deal.lastActivityDays} days ago

CONTEXT:
${deal.context}

WHAT WE ALREADY KNOW (Yes):
${knownFields}

MISSING SCOTSMAN FIELDS (generate questions for these):
${missingDescription}

Return JSON only.`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");

  const json = extractJson(text);
  return NextResponse.json(json);
}

function extractJson(text: string): any {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return { groups: [], _raw: text };
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return { groups: [], _raw: text };
  }
}
