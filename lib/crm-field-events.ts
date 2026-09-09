/**
 * Copy Salesforce's own field history into the ledger.
 *
 * Salesforce already holds the trajectory this product is trying to build.
 * Measured 2026-08-20: OpportunityFieldHistory has 147,777 readable rows,
 * StageName transitions back to 2025-02-19, plus Amount, CloseDate and
 * ForecastCategoryName. Field-history tracking was already on.
 *
 * Three modules read it live and none of them keeps a row. That costs three
 * things, and the third is the one that bites:
 *
 *   Retention. Salesforce field history ages out. The pre-pilot baseline that
 *   makes 26 closed deals interpretable is the first thing to go.
 *
 *   Joinability. "What did DealRipe tell the rep, did they do it, what did the
 *   buyer do next, how did it end" has its fourth term in Salesforce and its
 *   first three here. A cross-system join at query time is why nothing has
 *   actually asked the question yet.
 *
 *   Silent whole-run failure. loadCloseDateHistoryForAccounts is ONE call
 *   covering every account, correctly fail-closed, so a transient failure
 *   removes the dimension for everyone at once: two runs minutes apart produced
 *   11 deals flagged as repeatedly pushed and then 0. Reading a local table
 *   removes that class entirely.
 *
 * WHY THIS QUERIES SALESFORCE AGAIN RATHER THAN REUSING forecast-why's LOADER.
 * The SOQL there is embedded inside getForecastWhy and not exported, and
 * getForecastWhy is live in Monday's digest. The needs also differ: that one
 * wants a narrated 7-day window, this one wants everything ever, once. The
 * right end state is the reverse of today, with forecast-why reading THIS table
 * instead of Salesforce, which is what removes its transient-failure class.
 * Until then this is deliberately the only writer.
 */

import { getSalesforceClient } from "./salesforce";
import { runWithAuthorizedAccounts } from "./salesforce-scope";
import { supabaseAdmin } from "./supabase";

const API = "v60.0";

/** The same four fields forecast-why watches. Kept in sync deliberately. */
export const WATCHED_FIELDS = ["CloseDate", "StageName", "ForecastCategoryName", "Amount"] as const;

/** Salesforce's oldest tracked change in this org, measured 2026-08-20. */
export const HISTORY_BEGINS = "2025-02-19T00:00:00Z";

type HistoryRow = {
  OpportunityId: string;
  Field: string;
  OldValue: unknown;
  NewValue: unknown;
  CreatedDate: string;
  CreatedBy?: { Name?: string } | null;
  Opportunity?: { AccountId?: string } | null;
};

export type FieldEventLoad =
  | { status: "read"; rows: HistoryRow[] }
  /** Could not ask. NEVER folded into an empty result. */
  | { status: "unavailable"; error: string };

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const from = Date.parse(a);
  const to = Date.parse(b);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/**
 * Every tracked change on these accounts since `sinceIso`.
 *
 * Chunked at 60 accounts because a SOQL IN list has a practical ceiling and the
 * pilot is already past it at 90-odd. Returns unavailable with a reason rather
 * than an empty array, because "these accounts recorded no change" is a fact a
 * caller may act on and a failed read is not.
 */
export async function loadFieldHistory(args: {
  accountIds: string[];
  sinceIso?: string;
}): Promise<FieldEventLoad> {
  const accountIds = [...new Set(args.accountIds.filter(Boolean))];
  if (accountIds.length === 0) return { status: "read", rows: [] };
  const since = args.sinceIso ?? HISTORY_BEGINS;

  try {
    const { token, instanceUrl } = await getSalesforceClient();
    const rows = await runWithAuthorizedAccounts(accountIds, async () => {
      const out: HistoryRow[] = [];
      for (let i = 0; i < accountIds.length; i += 60) {
        const chunk = accountIds.slice(i, i + 60);
        const inList = chunk.map((a) => `'${a.replace(/'/g, "")}'`).join(",");
        const soql =
          `SELECT OpportunityId, Opportunity.AccountId, Field, OldValue, NewValue, ` +
          `CreatedDate, CreatedBy.Name FROM OpportunityFieldHistory ` +
          `WHERE Field IN (${WATCHED_FIELDS.map((f) => `'${f}'`).join(",")}) ` +
          `AND CreatedDate >= ${since} ` +
          `AND Opportunity.AccountId IN (${inList}) ORDER BY CreatedDate ASC`;

        // PAGINATED. A query over 15 months of history on 90 accounts runs past
        // Salesforce's 2000-record page, and taking only the first page would
        // silently drop the oldest changes, which are exactly the pre-pilot
        // baseline this exists to preserve.
        let url: string | null = `${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`;
        while (url) {
          const r: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) throw new Error(`field history ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
          const json = (await r.json()) as { records?: HistoryRow[]; nextRecordsUrl?: string; done?: boolean };
          out.push(...(json.records ?? []));
          url = json.nextRecordsUrl ? `${instanceUrl}${json.nextRecordsUrl}` : null;
        }
      }
      return out;
    });
    return { status: "read", rows };
  } catch (err) {
    return { status: "unavailable", error: err instanceof Error ? err.message : String(err) };
  }
}

export type FieldEventRow = {
  tenant_id: string;
  deal_id: string | null;
  source_system: string;
  opportunity_id: string;
  account_id: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  days_moved: number | null;
  changed_by: string | null;
  changed_at: string;
};

/**
 * Shape Salesforce rows for storage. Pure, so it is testable and cannot
 * disagree with what the writer persists.
 *
 * dealByAccount maps a Salesforce account id to a DealRipe deal. A row with no
 * match is still returned with deal_id null: Magaya's history predates the
 * pilot, and that pre-pilot baseline is what makes the pilot's 26 closes
 * interpretable. Dropping unlinked rows would throw away the comparison.
 */
export function toFieldEventRows(args: {
  tenantId: string;
  rows: ReadonlyArray<HistoryRow>;
  dealByAccount: Map<string, string>;
}): FieldEventRow[] {
  const out: FieldEventRow[] = [];
  for (const r of args.rows) {
    const accountId = r.Opportunity?.AccountId ?? null;
    const oldValue = str(r.OldValue);
    const newValue = str(r.NewValue);
    out.push({
      tenant_id: args.tenantId,
      deal_id: (accountId && args.dealByAccount.get(accountId)) || null,
      source_system: "salesforce",
      opportunity_id: r.OpportunityId,
      account_id: accountId,
      field: r.Field,
      old_value: oldValue,
      new_value: newValue,
      // CloseDate only. Everything else has no meaningful day delta, and
      // computing one for Amount would produce a number that reads like a date.
      days_moved: r.Field === "CloseDate" ? daysBetween(oldValue, newValue) : null,
      changed_by: r.CreatedBy?.Name ?? null,
      changed_at: r.CreatedDate,
    });
  }
  return out;
}

export type BackfillResult = {
  accountsAsked: number;
  rowsRead: number;
  rowsLinked: number;
  rowsUnlinked: number;
  written: number;
  byField: Record<string, number>;
  oldest: string | null;
  newest: string | null;
};

/**
 * Read Salesforce's history for the tenant's linked accounts and persist it.
 *
 * Idempotent at the database level on
 * (source_system, opportunity_id, field, changed_at): these are immutable facts
 * Salesforce already decided, so a re-run is a no-op rather than a duplicate.
 */
export async function backfillFieldEvents(args: {
  tenantId: string;
  sinceIso?: string;
  dryRun?: boolean;
}): Promise<BackfillResult> {
  const db = supabaseAdmin();

  const deals = await db
    .from("deals")
    .select("id, salesforce_account_id")
    .eq("tenant_id", args.tenantId)
    .not("salesforce_account_id", "is", null);
  if (deals.error) throw new Error(`deals read failed: ${deals.error.message}`);

  const dealByAccount = new Map<string, string>();
  for (const d of deals.data ?? []) {
    const acc = d.salesforce_account_id;
    // First deal wins. Magaya deploys per office so one customer is several
    // accounts, but the reverse (one account, several deals) also happens and
    // picking silently is better here than dropping the history entirely: the
    // opportunity id is stored either way, so a later fix can re-attribute.
    if (acc && !dealByAccount.has(acc)) dealByAccount.set(acc, d.id);
  }

  const load = await loadFieldHistory({ accountIds: [...dealByAccount.keys()], sinceIso: args.sinceIso });
  if (load.status === "unavailable") throw new Error(`Salesforce field history unavailable: ${load.error}`);

  const rows = toFieldEventRows({ tenantId: args.tenantId, rows: load.rows, dealByAccount });
  const byField: Record<string, number> = {};
  for (const r of rows) byField[r.field] = (byField[r.field] ?? 0) + 1;
  const times = rows.map((r) => r.changed_at).sort();

  const result: BackfillResult = {
    accountsAsked: dealByAccount.size,
    rowsRead: rows.length,
    rowsLinked: rows.filter((r) => r.deal_id).length,
    rowsUnlinked: rows.filter((r) => !r.deal_id).length,
    written: 0,
    byField,
    oldest: times[0] ?? null,
    newest: times[times.length - 1] ?? null,
  };
  if (args.dryRun || rows.length === 0) return result;

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await db
      .from("crm_field_events")
      .upsert(chunk, { onConflict: "source_system,opportunity_id,field,changed_at", ignoreDuplicates: true })
      .select("id");
    if (res.error) throw new Error(`crm_field_events write failed at offset ${i}: ${res.error.message}`);
    result.written += res.data?.length ?? 0;
  }
  return result;
}
