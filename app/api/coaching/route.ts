import { NextRequest, NextResponse } from "next/server";
import { anthropic, MODEL } from "@/lib/anthropic";
import { Deal } from "@/lib/deals";
import { CallScore } from "@/lib/scoring";
import { SCOTSMAN_FIELDS } from "@/lib/scotsman";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server." },
      { status: 500 }
    );
  }

  const { deal, scores } = (await req.json()) as { deal: Deal; scores: CallScore[] };

  const missing = SCOTSMAN_FIELDS
    .filter(f => deal.status[f.id] !== "Yes")
    .map(f => `${f.id} (${f.question})`)
    .join("; ");

  const recent = scores.slice(0, 3).map(s => {
    const failed = s.criteria.filter(c => !c.passed).map(c => c.label).join("; ");
    return `- ${new Date(s.loggedAt).toLocaleDateString()} score ${s.overall}/6, cardinal-rule ${s.cardinalRuleMet ? "MET" : "MISSED"}, failed: ${failed || "none"}. Summary: ${s.summary}`;
  }).join("\n") || "(no scored calls yet)";

  const system = `You are DealRipe's CRO coaching assistant. Paul Foreman (CRO, Topsort) is reviewing one of his AE's deals. Your job: give him ONE specific, hard-edged coaching intervention to deliver to the rep this week. It should be:
- Specific to this deal (name people, fields, dates)
- Actionable in one sentence ("Ask Regina why...", "Push Regina to book...", "Sit in on Regina's next call to...")
- Focused on the BIGGEST risk: stale + cardinal-rule misses + missing authority + repeat skill gaps
- Not generic CRO platitudes

Return STRICT JSON only:
{ "insight": "one sentence — start with a verb directed at the CRO" }`;

  const user = `DEAL: ${deal.name}
AE: ${deal.ae}
Stage: ${deal.stageKey}
Last activity: ${deal.lastActivityDays} days ago
Missing SCOTSMAN: ${missing || "(none)"}

RECENT CALL SCORES:
${recent}

Give Paul his coaching intervention.`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let insight = "";
  if (start !== -1 && end !== -1) {
    try {
      insight = JSON.parse(text.slice(start, end + 1)).insight || "";
    } catch {}
  }
  if (!insight) insight = text.trim();

  return NextResponse.json({ insight });
}
