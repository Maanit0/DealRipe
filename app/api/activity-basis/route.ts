import { NextRequest, NextResponse } from "next/server";
import { anthropic, MODEL } from "@/lib/anthropic";
import { Deal } from "@/lib/deal";
import { SCOTSMAN_FIELDS } from "@/lib/scotsman";

export const runtime = "nodejs";

// The cardinal-rule footer Paul requires on EVERY activity basis output.
const CARDINAL_FOOTER = `

BEFORE YOU END THIS CALL:
[ ] Book the next meeting — date, time, who else joins
[ ] Confirm the economic buyer by name
[ ] Update SCOTSMAN fields after the call`;

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server." },
      { status: 500 }
    );
  }
  const { deal, missingIds, unaskedQuestions } = (await req.json()) as {
    deal: Deal;
    missingIds: string[];
    unaskedQuestions: { fieldId: string; text: string }[];
  };

  const missing = SCOTSMAN_FIELDS.filter(f => missingIds.includes(f.id))
    .map(f => `- ${f.id} (${f.category}): ${f.question}`)
    .join("\n");

  const unasked = unaskedQuestions
    .map(q => `- [${q.fieldId}] ${q.text}`)
    .join("\n");

  const system = `You are DealRipe. Generate an "Activity Basis" call prep one-pager for a Topsort AE.

Paul Foreman's framework:
1. System interrogation — what we know
2. Data interrogation — what to ask
3. Skills of delivery — how the call should run

Output format (PLAIN TEXT, no markdown headers, no asterisks). Use this exact structure:

CALL OBJECTIVE
<one sentence — sharp, specific to this deal>

WHAT WE KNOW
<3-4 short bullets starting with "- ">

WHAT WE NEED TO LEARN (grouped by SCOTSMAN gap)
<For each missing field, the field id + label, then the unasked questions as "- " bullets>

STAKEHOLDERS TO CONFIRM
<2-3 bullets — who must be named/met>

NEXT MEETING ASK
<one sentence the rep should literally say to book the next meeting>

DO NOT include the "BEFORE YOU END THIS CALL" checklist — the system appends it. End your output right after NEXT MEETING ASK.`;

  const user = `DEAL: ${deal.name}
AE: ${deal.ae}
Stage: ${deal.stageKey} (BLOCKED — cannot advance)
Last activity: ${deal.lastActivityDays} days ago

CONTEXT:
${deal.context}

MISSING SCOTSMAN FIELDS:
${missing}

UNASKED QUESTIONS THE REP HAS NOT YET ASKED:
${unasked || "(none flagged — generate from missing fields)"}

Write the Activity Basis now.`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("")
    .trim();

  // ALWAYS append the cardinal-rule footer. Non-negotiable.
  const output = text + CARDINAL_FOOTER;

  return NextResponse.json({ activityBasis: output });
}
