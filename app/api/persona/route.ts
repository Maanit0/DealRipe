import { NextRequest, NextResponse } from "next/server";
import { anthropic, MODEL } from "@/lib/anthropic";
import { Deal } from "@/lib/deal";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server." },
      { status: 500 }
    );
  }
  const { deal, missingAuthorityIds } = (await req.json()) as {
    deal: Deal;
    missingAuthorityIds: string[];
  };

  const system = `You are DealRipe's persona intelligence module. Paul Foreman (CRO, Topsort) said:

"You need to get in front of Jane. Here's Jane's role. She's an innovator or she's conservative or she's risk averse. These are the questions you have to determine that. And then this is the outcome you would want from that meeting from Jane. Yeah, that's valuable."

When Authority fields (A2/A3/A4) are Unknown, identify each likely missing stakeholder. For each, return:
- role: likely title (CFO, VP Product, Head of Procurement, etc.)
- whyMissing: which Authority gap they fill (A2/A3/A4) and why
- likelyPersona: exactly one of "Innovator" | "Conservative" | "Risk-Averse"
- howToGetInFront: 1-2 sentences, concrete path (intro from champion, exec sponsor outreach, mutual connection on LinkedIn, etc.)
- discoveryQuestions: 2-3 questions the rep can use to confirm the persona type
- desiredOutcome: MUST be phrased exactly as: "By the end of this meeting, [role] should have said [specific commitment]"

Return STRICT JSON only:
{
  "stakeholders": [
    {
      "role": "...",
      "whyMissing": "...",
      "likelyPersona": "Innovator|Conservative|Risk-Averse",
      "howToGetInFront": "...",
      "discoveryQuestions": ["...", "..."],
      "desiredOutcome": "By the end of this meeting, ... should have said ..."
    }
  ]
}`;

  const user = `DEAL: ${deal.name}
AE: ${deal.ae}
CONTEXT: ${deal.context}

Missing Authority gaps: ${missingAuthorityIds.join(", ")}
- A2 = Do we know who has authority to decide?
- A3 = Do we have access to the decision maker?
- A4 = Do we know who else is involved?

Identify the most likely missing stakeholders Topsort needs to reach for THIS deal. Return JSON only.`;

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

  return NextResponse.json(extractJson(text));
}

function extractJson(text: string): any {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return { stakeholders: [], _raw: text };
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return { stakeholders: [], _raw: text };
  }
}
