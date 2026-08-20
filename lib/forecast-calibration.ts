/**
 * What is a given rep's "Commit" actually worth?
 *
 * WHAT THIS IS FOR
 *
 * A rep puts a deal in a band. A leader sums the bands and that number goes
 * upstairs. The whole roll-up rests on an assumption nobody checks: that a
 * Commit means the same thing coming from every rep. It does not. One rep's
 * Commit closes nine times in ten, another's closes half the time, and a third
 * sandbags so hard their Best Case is worth more than someone else's Commit.
 *
 * This measures each of those from the customer's own history, so a leader can
 * weight the roll-up by what a band has been worth rather than by a flat
 * probability map, and spend inspection time where it changes an outcome.
 *
 * It needs no DealRipe involvement to be valid. That is the point: every other
 * claim this product can make is n=7 and will be for months, while this is
 * 10,873 closed opportunities against 12,740 band changes going back to
 * 2025-02-19, available on day one for any Salesforce tenant including a new
 * one. It is also what makes an independent read of a band mean something
 * rather than being an opinion.
 *
 * It replaces a fabrication. CALIBRATION in lib/forecast-room.ts reads 90%
 * against the rep's 63% over 184 deals and is a hardcoded demo constant that
 * has never been computed from a Magaya outcome. CLAUDE.md flags it as one of
 * two figures the evidence pack refuses to print.
 *
 * THE SPLIT THAT MATTERS
 *
 * Magaya closed 8,780 won against 2,093 lost since history begins, an 81% win
 * rate. That is a renewal-heavy book, and pooling it would produce "Commit
 * converts at 85%" as a headline that is true of the company and useless to a
 * rep working new business. Every rate here is reported per deal type, and a
 * pooled number is deliberately not offered.
 *
 * HOW A BAND SEQUENCE IS RECONSTRUCTED
 *
 * Salesforce field history records CHANGES, not states, so an opportunity
 * created directly in Commit and never moved has no history row at all. Reading
 * "bands this deal touched" from NewValue alone would miss its starting band
 * and undercount early Commits. The starting band is recoverable: it is the
 * OldValue of the first transition. So the sequence is the first OldValue
 * followed by every NewValue, and an opportunity with no transitions is treated
 * as having only its current band.
 *
 * READ ONLY.
 */

import { getSalesforceClient } from "./salesforce";

const API = "v60.0";

/** Magaya's bands, ordered weakest to strongest commitment. `Closed` and
 *  `Omitted` are terminal states rather than forecasts and are excluded from
 *  the rates: every won deal ends in Closed, so counting it would report a
 *  100% conversion that means nothing. */
export const FORECAST_BANDS = ["Pipeline", "Expect", "Commit"] as const;
export type ForecastBand = (typeof FORECAST_BANDS)[number];

const TERMINAL = new Set(["Closed", "Omitted"]);

export type DealType = "new_business" | "renewal" | "unknown";

export type BandStat = {
  band: ForecastBand;
  /** Opportunities that entered this band at any point before closing. */
  entered: number;
  won: number;
  /** null when `entered` is below the reporting floor: a rate on four deals is
   *  noise wearing a percentage sign. */
  winRate: number | null;
  /** Total closed-won amount for deals that touched this band. */
  wonAmount: number;
};

export type RepCalibration = {
  ownerId: string;
  ownerName: string;
  dealType: DealType;
  closed: number;
  won: number;
  bands: BandStat[];
};

/** Below this, a rate is not reported. Chosen so a single deal cannot move a
 *  reported number by more than ten points. */
export const MIN_SAMPLE = 10;

type OppRow = {
  Id: string;
  OwnerId: string;
  Owner: { Name: string | null } | null;
  IsWon: boolean;
  CloseDate: string | null;
  Amount: number | null;
  ForecastCategoryName: string | null;
  Is_Renewal__c?: boolean | null;
  Opportunity_Type__c?: string | null;
};

type BandChange = { opportunityId: string; from: string | null; to: string | null; at: string };

function asBand(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Which kind of deal this is.
 *
 * Is_Renewal__c first because it is the field that means it. Opportunity_Type__c
 * is the fallback and is free text in places, so it is matched loosely and any
 * value that does not clearly say renewal stays `unknown` rather than being
 * assumed to be new business. An unknown is reported as its own row: folding it
 * into new business would quietly inflate whichever rate is larger.
 */
export function dealTypeOf(o: OppRow): DealType {
  if (o.Is_Renewal__c === true) return "renewal";
  const t = (o.Opportunity_Type__c ?? "").toLowerCase();
  if (t.includes("renew")) return "renewal";
  if (o.Is_Renewal__c === false && t.length > 0) return "new_business";
  if (t.includes("new")) return "new_business";
  return "unknown";
}

async function soql<T>(
  client: { instanceUrl: string; token: string },
  query: string,
): Promise<T[] | { error: string }> {
  const out: T[] = [];
  let url: string | null =
    `${client.instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(query)}`;
  while (url) {
    const r: Response = await fetch(url, { headers: { Authorization: `Bearer ${client.token}` } });
    if (!r.ok) return { error: `SOQL ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
    const page = (await r.json()) as { records?: T[]; nextRecordsUrl?: string; done?: boolean };
    out.push(...(page.records ?? []));
    url = page.done === false && page.nextRecordsUrl ? `${client.instanceUrl}${page.nextRecordsUrl}` : null;
  }
  return out;
}

export type CalibrationResult =
  | { status: "read"; reps: RepCalibration[]; opportunities: number; bandChanges: number }
  | { status: "unavailable"; error: string };

/**
 * Per-rep, per-band conversion over closed opportunities since `sinceDate`.
 *
 * `ownerIds` restricts to specific reps; omit for the whole org, which is worth
 * doing at least once because a rep's band is only interpretable next to the
 * spread of everyone else's.
 */
export async function computeForecastCalibration(args: {
  /** YYYY-MM-DD. Opportunities closing on or after this. */
  sinceDate: string;
  ownerIds?: string[];
}): Promise<CalibrationResult> {
  let client: { instanceUrl: string; token: string };
  try {
    client = await getSalesforceClient();
  } catch (err) {
    return {
      status: "unavailable",
      error: `auth failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const ownerFilter =
    args.ownerIds && args.ownerIds.length > 0
      ? ` AND OwnerId IN (${args.ownerIds.map((i) => `'${i.replace(/[^a-zA-Z0-9]/g, "")}'`).join(",")})`
      : "";

  // Is_Renewal__c and Opportunity_Type__c are Magaya custom fields. Probe them
  // once: if either is absent or hidden by field-level security, fall back
  // rather than failing the run, and every deal reports type `unknown`, which
  // is honest about what we could not read.
  let opps: OppRow[] | null = null;
  for (const withCustom of [true, false]) {
    const fields =
      `Id, OwnerId, Owner.Name, IsWon, CloseDate, Amount, ForecastCategoryName` +
      (withCustom ? `, Is_Renewal__c, Opportunity_Type__c` : "");
    const res = await soql<OppRow>(
      client,
      `SELECT ${fields} FROM Opportunity WHERE IsClosed = true AND CloseDate >= ${args.sinceDate}${ownerFilter}`,
    );
    if (!("error" in res)) {
      opps = res;
      break;
    }
    if (withCustom && /Is_Renewal__c|Opportunity_Type__c/.test(res.error)) {
      console.warn("[calibration] renewal fields unreadable, every deal will report type unknown");
      continue;
    }
    return { status: "unavailable", error: res.error };
  }
  if (!opps) return { status: "unavailable", error: "opportunity read produced nothing" };
  if (opps.length === 0) {
    return { status: "read", reps: [], opportunities: 0, bandChanges: 0 };
  }

  const hist = await soql<{
    OpportunityId: string;
    OldValue: unknown;
    NewValue: unknown;
    CreatedDate: string;
  }>(
    client,
    `SELECT OpportunityId, OldValue, NewValue, CreatedDate FROM OpportunityFieldHistory ` +
      `WHERE Field = 'ForecastCategoryName' AND Opportunity.IsClosed = true ` +
      `AND Opportunity.CloseDate >= ${args.sinceDate}${ownerFilter ? ownerFilter.replace(/OwnerId/g, "Opportunity.OwnerId") : ""} ` +
      `ORDER BY CreatedDate ASC`,
  );
  if ("error" in hist) return { status: "unavailable", error: hist.error };

  const changesByOpp = new Map<string, BandChange[]>();
  for (const h of hist) {
    const list = changesByOpp.get(h.OpportunityId) ?? [];
    list.push({
      opportunityId: h.OpportunityId,
      from: asBand(h.OldValue),
      to: asBand(h.NewValue),
      at: h.CreatedDate,
    });
    changesByOpp.set(h.OpportunityId, list);
  }

  // ---- bands each opportunity actually touched -------------------------
  const bandsTouched = (o: OppRow): Set<string> => {
    const changes = changesByOpp.get(o.Id);
    if (!changes || changes.length === 0) {
      // No recorded change: the only band we can attribute is where it sits.
      return new Set(asBand(o.ForecastCategoryName) ? [o.ForecastCategoryName as string] : []);
    }
    const touched = new Set<string>();
    // The starting band is the OldValue of the first change, which is the only
    // place it is recorded.
    const start = changes[0].from;
    if (start) touched.add(start);
    for (const c of changes) if (c.to) touched.add(c.to);
    return touched;
  };

  // ---- group by rep and deal type --------------------------------------
  const key = (ownerId: string, type: DealType) => `${ownerId}::${type}`;
  const groups = new Map<
    string,
    { ownerId: string; ownerName: string; dealType: DealType; opps: OppRow[] }
  >();
  for (const o of opps) {
    const type = dealTypeOf(o);
    const k = key(o.OwnerId, type);
    const g =
      groups.get(k) ??
      groups
        .set(k, {
          ownerId: o.OwnerId,
          ownerName: o.Owner?.Name ?? o.OwnerId,
          dealType: type,
          opps: [],
        })
        .get(k)!;
    g.opps.push(o);
  }

  const reps: RepCalibration[] = [];
  for (const g of groups.values()) {
    const bands: BandStat[] = FORECAST_BANDS.map((band) => {
      const entered = g.opps.filter((o) => bandsTouched(o).has(band));
      const won = entered.filter((o) => o.IsWon);
      return {
        band,
        entered: entered.length,
        won: won.length,
        winRate: entered.length >= MIN_SAMPLE ? won.length / entered.length : null,
        wonAmount: won.reduce((n, o) => n + (o.Amount ?? 0), 0),
      };
    });
    reps.push({
      ownerId: g.ownerId,
      ownerName: g.ownerName,
      dealType: g.dealType,
      closed: g.opps.length,
      won: g.opps.filter((o) => o.IsWon).length,
      bands,
    });
  }

  // Terminal bands are excluded above; assert the assumption rather than
  // trusting it, since a new band value appearing would silently skew rates.
  const unexpected = new Set<string>();
  for (const o of opps) for (const b of bandsTouched(o)) {
    if (!TERMINAL.has(b) && !(FORECAST_BANDS as readonly string[]).includes(b)) unexpected.add(b);
  }
  if (unexpected.size > 0) {
    console.warn(
      `[calibration] band value(s) not in FORECAST_BANDS and not terminal, so excluded from every rate: ${[...unexpected].join(", ")}`,
    );
  }

  reps.sort((a, b) => b.closed - a.closed);
  return { status: "read", reps, opportunities: opps.length, bandChanges: hist.length };
}
