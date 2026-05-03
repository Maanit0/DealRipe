import { NextRequest, NextResponse } from "next/server";
import { getScores } from "@/lib/callStore";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const dealId = req.nextUrl.searchParams.get("dealId");
  if (!dealId) return NextResponse.json({ scores: [] });
  return NextResponse.json({ scores: getScores(dealId) });
}
