/**
 * What has actually moved on this deal, from the daily snapshot series.
 *
 * deal_signal_snapshots has been recording every deal daily since the pilot
 * started and NO ARTIFACT HAS EVER READ IT. Briefings, recaps and drafts all
 * describe the present; none of them can say what changed since last week,
 * which is the thing a rep opening an email actually wants and the thing a
 * generic model cannot know however good the transcript is.
 *
 * WHAT COUNTS AS MOVEMENT, and what only looks like it:
 *
 *   the CRM stage moved          the rep moved it. Real.
 *   the amount or close date     the rep changed a number. Real, and the
 *                                direction matters.
 *   a risk appeared or cleared   OUR assessment changed. Worth saying, and
 *                                worth attributing to us rather than to them.
 *   a gate became answered       WE captured something. Not deal movement:
 *                                the customer may have said it weeks ago and
 *                                we only just heard it. Reported as ours.
 *
 * capturedAt and daysInStage are excluded upstream by lib/snapshot-diff.ts,
 * which exists because a raw byte comparison called 47 of 48 days a change.
 */

import { supabaseAdmin } from "./supabase";

export type DealChange = { date: string; what: string };

type Signals = Record<string, unknown>;

function crm(s: Signals, key: "rolldog" | "salesforce"): Record<string, unknown> | null {
  const v = s[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function money(v: unknown): string | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? `$${Math.round(n).toLocaleString()}` : null;
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** One day against the day before it, in words a rep would use. */
function describe(prev: Signals, now: Signals): string[] {
  const out: string[] = [];

  for (const key of ["rolldog", "salesforce"] as const) {
    const a = crm(prev, key);
    const b = crm(now, key);
    if (!a || !b) continue;
    const label = key === "rolldog" ? "Rolldog" : "Salesforce";
    if (a.stageName !== b.stageName && b.stageName) {
      out.push(`${label} stage moved to ${String(b.stageName)}${a.stageName ? ` from ${String(a.stageName)}` : ""}`);
    }
    const ma = money(a.amount);
    const mb = money(b.amount);
    if (ma !== mb && mb) out.push(`${label} amount ${ma ? `changed from ${ma} to ${mb}` : `set to ${mb}`}`);
    if (a.closeDate !== b.closeDate && b.closeDate) {
      // Direction, not just difference. A pushed date and a pulled date are
      // opposite facts and "the close date changed" hides which.
      const moved = a.closeDate && String(b.closeDate) > String(a.closeDate) ? "pushed out" : "moved";
      out.push(`${label} close date ${a.closeDate ? `${moved} to ${String(b.closeDate)} from ${String(a.closeDate)}` : `set to ${String(b.closeDate)}`}`);
    }
  }

  const riskAdded = list(now.risks).filter((r) => !list(prev.risks).includes(r));
  const riskGone = list(prev.risks).filter((r) => !list(now.risks).includes(r));
  if (riskAdded.length) out.push(`DealRipe flagged ${riskAdded.join(", ").replace(/_/g, " ")}`);
  if (riskGone.length) out.push(`DealRipe cleared ${riskGone.join(", ").replace(/_/g, " ")}`);

  // OURS, NOT THEIRS. A gate becoming answered means we heard it, not that the
  // customer just said it, and phrasing it as the deal progressing would be a
  // claim about the buyer built on a fact about us.
  const newly = list(now.answered).filter((a) => !list(prev.answered).includes(a));
  if (newly.length) out.push(`we captured ${newly.join(", ").replace(/_/g, " ")}`);

  return out;
}

export async function readDealChangeHistory(args: {
  dealId: string;
  days?: number;
}): Promise<DealChange[]> {
  const days = args.days ?? 14;
  try {
    const { data, error } = await supabaseAdmin()
      .from("deal_signal_snapshots")
      .select("snapshot_date, signals")
      .eq("deal_id", args.dealId)
      .order("snapshot_date", { ascending: false })
      .limit(days + 1);
    if (error) return [];
    const rows = (data ?? []) as Array<{ snapshot_date: string; signals: Signals }>;
    const out: DealChange[] = [];
    for (let i = 0; i < rows.length - 1; i++) {
      for (const what of describe(rows[i + 1].signals, rows[i].signals)) {
        out.push({ date: rows[i].snapshot_date, what });
      }
    }
    return out.slice(0, 12);
  } catch {
    // No history is not "nothing happened". The caller renders nothing.
    return [];
  }
}

export function dealChangeBlock(changes: DealChange[]): string | null {
  if (changes.length === 0) return null;
  return (
    `WHAT HAS MOVED ON THIS DEAL, newest first. Movement the CUSTOMER caused is worth referencing; ` +
    `anything attributed to DealRipe or to "we captured" is our own record catching up and must never be ` +
    `mentioned to the customer:\n` +
    changes.map((c) => `- ${c.date}: ${c.what}`).join("\n")
  );
}
