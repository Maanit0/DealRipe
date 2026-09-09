/**
 * Capture the rep-logged activity that DealRipe reads and throws away.
 *
 * DealRipe watches two channels: meetings a bot joined, and mail in the six
 * reps' Outlook mailboxes. Everything else is invisible, and the reps log a lot
 * of it by hand. All three sources here are ALREADY read by this codebase and
 * none is kept:
 *
 *   Salesforce Task     queried in several places, but only ever `SELECT Id`
 *                       for write dedupe, so Subject and Description are
 *                       fetched by nothing
 *   Salesforce Event    meetings booked in Salesforce rather than Outlook, so
 *                       no bot was ever dispatched
 *   Rolldog activity    listActivities returns title AND notes in full, and its
 *                       callers use them once
 *
 * Same shape OpportunityFieldHistory had this morning: the read path exists,
 * the result is discarded, and "what did the rep actually do" stays
 * unanswerable.
 *
 * IT MATTERS MOST WHERE WE HAVE LEAST. 36 deals hold no email at all, 22 of
 * them because the customer only ever writes from a free-mail address that the
 * ingest deliberately skips. For those, a logged Task is the only record of rep
 * effort that exists anywhere.
 *
 * DEALRIPE'S OWN WRITES ARE MARKED, NOT EXCLUDED. logCallToSalesforce writes a
 * Task and createActivity writes a Rolldog activity, so a naive ingest reads its
 * own output back as the rep's work. That is exactly how deal_messages came to
 * hold 31 of our own drafts as rep outbound. is_ours is computed here and every
 * consumer must filter on it.
 */

import { listActivities } from "./rolldog";
import { getSalesforceClient } from "./salesforce";
import { runWithAuthorizedAccounts } from "./salesforce-scope";
import { runWithAuthorizedOpportunities } from "./crm-scope";
import { supabaseAdmin } from "./supabase";

const API = "v60.0";

/**
 * The marker logCallToSalesforce puts in a Task subject, and createActivity in
 * a Rolldog title. Read from the same constant the writers use where possible;
 * matched loosely here because a rep can edit a subject after we write it.
 */
const OURS = /\bDealRipe\b/i;

export type ActivityRow = {
  tenant_id: string;
  deal_id: string | null;
  source_system: string;
  source_object: string;
  external_id: string;
  account_id: string | null;
  opportunity_id: string | null;
  subject: string | null;
  body: string | null;
  activity_type: string | null;
  status: string | null;
  actor: string | null;
  occurred_at: string | null;
  created_at_source: string | null;
  is_ours: boolean;
};

export type ActivityLoad =
  | { status: "read"; rows: ActivityRow[] }
  /** Could not ask. NEVER folded into an empty result. */
  | { status: "unavailable"; error: string };

const str = (v: unknown) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
};

type SfTask = {
  Id: string;
  Subject?: string | null;
  Description?: string | null;
  Status?: string | null;
  TaskSubtype?: string | null;
  ActivityDate?: string | null;
  CreatedDate?: string | null;
  WhatId?: string | null;
  Owner?: { Name?: string } | null;
};
type SfEvent = {
  Id: string;
  Subject?: string | null;
  Description?: string | null;
  Type?: string | null;
  StartDateTime?: string | null;
  ActivityDate?: string | null;
  CreatedDate?: string | null;
  WhatId?: string | null;
  Owner?: { Name?: string } | null;
};

/**
 * Salesforce Task and Event on the given accounts.
 *
 * Chunked at 60 accounts and paginated on nextRecordsUrl: a year of activity
 * across 90 accounts runs past Salesforce's 2000-record page, and taking the
 * first page only would drop the oldest records, which are the baseline.
 */
export async function loadSalesforceActivity(args: {
  tenantId: string;
  accountIds: string[];
  dealByAccount: Map<string, string>;
  sinceIso?: string;
}): Promise<ActivityLoad> {
  const accountIds = [...new Set(args.accountIds.filter(Boolean))];
  if (accountIds.length === 0) return { status: "read", rows: [] };
  const since = args.sinceIso ?? "2025-01-01T00:00:00Z";

  try {
    const { token, instanceUrl } = await getSalesforceClient();
    const rows: ActivityRow[] = [];

    const runQuery = async <T>(soql: string): Promise<T[]> => {
      const out: T[] = [];
      let url: string | null = `${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`;
      while (url) {
        const r: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) throw new Error(`${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
        const j = (await r.json()) as { records?: T[]; nextRecordsUrl?: string };
        out.push(...(j.records ?? []));
        url = j.nextRecordsUrl ? `${instanceUrl}${j.nextRecordsUrl}` : null;
      }
      return out;
    };

    await runWithAuthorizedAccounts(accountIds, async () => {
      for (let i = 0; i < accountIds.length; i += 60) {
        const inList = accountIds.slice(i, i + 60).map((a) => `'${a.replace(/'/g, "")}'`).join(",");

        const tasks = await runQuery<SfTask>(
          `SELECT Id, Subject, Description, Status, TaskSubtype, ActivityDate, CreatedDate, WhatId, Owner.Name ` +
            `FROM Task WHERE WhatId IN (${inList}) AND CreatedDate >= ${since} ORDER BY CreatedDate ASC`,
        );
        for (const t of tasks) {
          rows.push({
            tenant_id: args.tenantId,
            deal_id: (t.WhatId && args.dealByAccount.get(t.WhatId)) || null,
            source_system: "salesforce",
            source_object: "Task",
            external_id: t.Id,
            account_id: str(t.WhatId),
            opportunity_id: null,
            subject: str(t.Subject),
            body: str(t.Description),
            activity_type: str(t.TaskSubtype),
            status: str(t.Status),
            actor: str(t.Owner?.Name),
            occurred_at: t.ActivityDate ? `${t.ActivityDate}T00:00:00Z` : null,
            created_at_source: str(t.CreatedDate),
            is_ours: OURS.test(`${t.Subject ?? ""} ${t.Description ?? ""}`),
          });
        }

        const events = await runQuery<SfEvent>(
          `SELECT Id, Subject, Description, Type, StartDateTime, ActivityDate, CreatedDate, WhatId, Owner.Name ` +
            `FROM Event WHERE WhatId IN (${inList}) AND CreatedDate >= ${since} ORDER BY CreatedDate ASC`,
        );
        for (const e of events) {
          rows.push({
            tenant_id: args.tenantId,
            deal_id: (e.WhatId && args.dealByAccount.get(e.WhatId)) || null,
            source_system: "salesforce",
            source_object: "Event",
            external_id: e.Id,
            account_id: str(e.WhatId),
            opportunity_id: null,
            subject: str(e.Subject),
            body: str(e.Description),
            activity_type: str(e.Type),
            status: null,
            actor: str(e.Owner?.Name),
            occurred_at: str(e.StartDateTime) ?? (e.ActivityDate ? `${e.ActivityDate}T00:00:00Z` : null),
            created_at_source: str(e.CreatedDate),
            is_ours: OURS.test(`${e.Subject ?? ""} ${e.Description ?? ""}`),
          });
        }
      }
    });

    return { status: "read", rows };
  } catch (err) {
    return { status: "unavailable", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Rolldog's interactions tab, per opportunity.
 *
 * AUTHORIZATION SHAPE copied from lib/snapshot.ts: one opportunity per
 * runWithAuthorizedOpportunities call inside the loop, never a batch array
 * around the whole thing, because a batch would widen authorization for every
 * read in the callback. listActivities carries fromDealRipe already, so ours is
 * marked rather than guessed at.
 */
export async function loadRolldogActivity(args: {
  tenantId: string;
  /** opportunityId -> dealId, so an unlinked opportunity is not invented. */
  dealByOpportunity: Map<string, string>;
}): Promise<{ rows: ActivityRow[]; unavailable: Array<{ opportunityId: string; error: string }> }> {
  const rows: ActivityRow[] = [];
  const unavailable: Array<{ opportunityId: string; error: string }> = [];

  await Promise.all(
    [...args.dealByOpportunity.entries()].map(async ([oppId, dealId]) => {
      try {
        const acts = await runWithAuthorizedOpportunities([oppId], () => listActivities(oppId));
        for (const a of acts) {
          rows.push({
            tenant_id: args.tenantId,
            deal_id: dealId,
            source_system: "rolldog",
            source_object: "activity",
            external_id: `${oppId}:${a.id}`,
            account_id: null,
            opportunity_id: oppId,
            subject: str(a.title),
            body: str(a.notes),
            activity_type: null,
            status: a.isComplete === null ? null : a.isComplete ? "complete" : "open",
            actor: null,
            occurred_at: str(a.createdAt),
            created_at_source: str(a.createdAt),
            // Rolldog's own reader already decides this from our marker.
            is_ours: a.fromDealRipe === true,
          });
        }
      } catch (err) {
        // Named per opportunity. A failed read is not an opportunity with no
        // activity, and one bad opportunity must not empty the whole sweep.
        unavailable.push({ opportunityId: oppId, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  return { rows, unavailable };
}

export type ActivityBackfill = {
  salesforce: { read: number; ours: number; linked: number };
  rolldog: { read: number; ours: number; opportunitiesUnavailable: number };
  written: number;
  bySource: Record<string, number>;
  oldest: string | null;
  newest: string | null;
  errors: string[];
};

export async function backfillActivities(args: {
  tenantId: string;
  sinceIso?: string;
  dryRun?: boolean;
}): Promise<ActivityBackfill> {
  const db = supabaseAdmin();
  const deals = await db
    .from("deals")
    .select("id, salesforce_account_id, rolldog_opportunity_id, external_id")
    .eq("tenant_id", args.tenantId);
  if (deals.error) throw new Error(`deals read failed: ${deals.error.message}`);

  const dealByAccount = new Map<string, string>();
  const dealByOpportunity = new Map<string, string>();
  for (const d of deals.data ?? []) {
    if (d.salesforce_account_id && !dealByAccount.has(d.salesforce_account_id)) {
      dealByAccount.set(d.salesforce_account_id, d.id);
    }
    if (d.rolldog_opportunity_id) dealByOpportunity.set(String(d.rolldog_opportunity_id), d.id);
  }

  const out: ActivityBackfill = {
    salesforce: { read: 0, ours: 0, linked: 0 },
    rolldog: { read: 0, ours: 0, opportunitiesUnavailable: 0 },
    written: 0,
    bySource: {},
    oldest: null,
    newest: null,
    errors: [],
  };

  const sf = await loadSalesforceActivity({
    tenantId: args.tenantId,
    accountIds: [...dealByAccount.keys()],
    dealByAccount,
    sinceIso: args.sinceIso,
  });
  const rows: ActivityRow[] = [];
  if (sf.status === "unavailable") out.errors.push(`salesforce: ${sf.error}`);
  else {
    rows.push(...sf.rows);
    out.salesforce.read = sf.rows.length;
    out.salesforce.ours = sf.rows.filter((r) => r.is_ours).length;
    out.salesforce.linked = sf.rows.filter((r) => r.deal_id).length;
  }

  const rd = await loadRolldogActivity({ tenantId: args.tenantId, dealByOpportunity });
  rows.push(...rd.rows);
  out.rolldog.read = rd.rows.length;
  out.rolldog.ours = rd.rows.filter((r) => r.is_ours).length;
  out.rolldog.opportunitiesUnavailable = rd.unavailable.length;
  for (const u of rd.unavailable.slice(0, 5)) out.errors.push(`rolldog opp ${u.opportunityId}: ${u.error}`);

  for (const r of rows) out.bySource[`${r.source_system}:${r.source_object}`] = (out.bySource[`${r.source_system}:${r.source_object}`] ?? 0) + 1;
  const times = rows.map((r) => r.occurred_at ?? r.created_at_source).filter((x): x is string => !!x).sort();
  out.oldest = times[0] ?? null;
  out.newest = times[times.length - 1] ?? null;

  if (args.dryRun || rows.length === 0) return out;

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await db
      .from("crm_activities")
      .upsert(chunk, { onConflict: "source_system,source_object,external_id", ignoreDuplicates: true })
      .select("id");
    if (res.error) throw new Error(`crm_activities write failed at offset ${i}: ${res.error.message}`);
    out.written += res.data?.length ?? 0;
  }
  return out;
}
