/**
 * Salesforce's own record of when an opportunity changed stage.
 *
 * WHY THIS IS BETTER THAN DIFFERENCING SNAPSHOTS
 *
 * readStageMoved answers "did the CRM stage move across this call" by comparing
 * the snapshot before the call to the snapshot after it. That works, and it has
 * two costs that this does not:
 *
 *   1. Resolution. Snapshots are one per deal per day at best, and in practice
 *      about one every five days early in the pilot, so a move is located
 *      inside a window rather than at a moment.
 *
 *   2. Absence is ambiguous. If either snapshot has no CRM reading, the answer
 *      is `unknown`, because a deal we could not read is not a deal that did
 *      not move.
 *
 * Field history has neither. A transition carries an exact timestamp, and
 * because Salesforce records EVERY tracked change, the absence of a transition
 * is a real negative rather than a gap in our sampling. This is the rare case
 * in this codebase where "nothing recorded" honestly means "nothing happened",
 * and it is worth being explicit about why: the completeness comes from
 * Salesforce, not from us.
 *
 * WHAT IS ACTUALLY AVAILABLE, measured 2026-08-20
 *
 * Magaya already has field history tracking switched on and readable with the
 * access we hold. No admin request was needed and one was nearly sent:
 *
 *   OpportunityFieldHistory   147,777 rows readable
 *     StageName                15,459 transitions, oldest 2025-02-19
 *     Amount                   21,320
 *     CloseDate                15,206
 *     ForecastCategoryName     13,112
 *
 * So the pilot window is fully covered, and so is a pre-pilot baseline.
 *
 * READ ONLY.
 */

import { getSalesforceClient } from "./salesforce";

const API = "v60.0";

/** The date Magaya's oldest tracked StageName change carries. Anything asked
 *  about before this is outside recorded history, which is not the same as a
 *  deal that did not move. */
export const HISTORY_BEGINS = "2025-02-19";

export type StageTransition = {
  opportunityId: string;
  accountId: string | null;
  /** Null when Salesforce recorded no previous value, which happens on create. */
  from: string | null;
  to: string | null;
  /** ISO timestamp of the change, from Salesforce. */
  at: string;
};

export type StageHistoryLoad =
  | { status: "read"; byAccount: Map<string, StageTransition[]> }
  | { status: "unavailable"; error: string };

type HistoryRow = {
  OpportunityId: string;
  Opportunity: { AccountId: string | null } | null;
  OldValue: unknown;
  NewValue: unknown;
  CreatedDate: string;
};

const CHUNK = 100;

/** Salesforce serialises picklist history values as strings, but the field is
 *  polymorphic and can carry null or a non-string. Anything that is not a
 *  non-empty string is recorded as null rather than coerced to "null". */
function asStage(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/**
 * Every StageName transition on the given accounts since `sinceIso`.
 *
 * Batched by account, and filtered server-side by date so a long-running org's
 * full 147k rows never cross the wire.
 *
 * Returns `unavailable` with a reason rather than an empty map on failure. An
 * empty map means "these accounts genuinely recorded no stage change in the
 * window", which is a fact the caller may act on; a failed read is not.
 */
export async function loadStageHistoryForAccounts(
  accountIds: string[],
  sinceIso: string,
): Promise<StageHistoryLoad> {
  const byAccount = new Map<string, StageTransition[]>();
  const unique = [...new Set(accountIds.filter(Boolean))];
  if (unique.length === 0) return { status: "read", byAccount };

  let client: { instanceUrl: string; token: string };
  try {
    client = await getSalesforceClient();
  } catch (err) {
    return {
      status: "unavailable",
      error: `auth failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Accounts asked about start as a real empty rather than a missing key, so a
  // caller can tell "no transitions" from "never asked".
  for (const id of unique) byAccount.set(id, []);

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const inList = chunk.map((id) => `'${id.replace(/[^a-zA-Z0-9]/g, "")}'`).join(",");
    const soql =
      `SELECT OpportunityId, Opportunity.AccountId, OldValue, NewValue, CreatedDate ` +
      `FROM OpportunityFieldHistory ` +
      `WHERE Field = 'StageName' AND CreatedDate >= ${sinceIso} ` +
      `AND Opportunity.AccountId IN (${inList}) ` +
      `ORDER BY CreatedDate ASC`;

    let url: string | null =
      `${client.instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`;

    // History is high-volume, so paginate rather than assuming one page.
    while (url) {
      const r: Response = await fetch(url, {
        headers: { Authorization: `Bearer ${client.token}` },
      });
      if (!r.ok) {
        return {
          status: "unavailable",
          error: `SOQL ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`,
        };
      }
      const page = (await r.json()) as {
        records?: HistoryRow[];
        nextRecordsUrl?: string;
        done?: boolean;
      };
      for (const rec of page.records ?? []) {
        const accountId = rec.Opportunity?.AccountId ?? null;
        if (!accountId) continue;
        const list = byAccount.get(accountId);
        if (!list) continue; // an account we did not ask about
        list.push({
          opportunityId: rec.OpportunityId,
          accountId,
          from: asStage(rec.OldValue),
          to: asStage(rec.NewValue),
          at: rec.CreatedDate,
        });
      }
      url = page.done === false && page.nextRecordsUrl
        ? `${client.instanceUrl}${page.nextRecordsUrl}`
        : null;
    }
  }

  return { status: "read", byAccount };
}

export type StageMoveVerdict = {
  value: "yes" | "no" | "unknown";
  reason: string;
  /** The transitions that produced a "yes", for a diagnostic to show its work. */
  transitions: StageTransition[];
};

/**
 * Did this deal's stage move in the window after a call?
 *
 * `transitions` is every StageName change on the deal's ACCOUNT, which is not
 * the same as on the deal. An account can carry several opportunities, and 45
 * of Magaya's 91 linked accounts do. Three rules keep that from inventing a
 * move:
 *
 *   - Only opportunities that already existed at the time of the call count.
 *     A renewal opened afterwards moving to Closed Won is not this call's work.
 *
 *   - "no" and "yes" are NOT symmetric, and this is the important one.
 *
 *     If NOTHING on the account moved, the deal did not move, whichever
 *     opportunity the deal is. That holds at any opportunity count, so a clean
 *     "no" survives on a 38-opportunity account.
 *
 *     A "yes" needs attribution. On an account with one qualifying
 *     opportunity, a move is that opportunity's and the answer is yes. On an
 *     account with several, a single move tells us the ACCOUNT moved and not
 *     that this DEAL did, so the answer is unknown unless the caller can say
 *     which opportunity is the deal's.
 *
 *     Measured on the first backfill: 7 verdicts came back yes, six on
 *     single-opportunity accounts and one on Medovlog, which carries 33. That
 *     one was "Active Renewal to Renewal Discussion", a renewal opportunity
 *     moving on an account whose new-business deal DealRipe was tracking. It
 *     would have been recorded as a call advancing a deal it had nothing to do
 *     with.
 *
 *   - If SEVERAL moved, the answer is `unknown` and it names them.
 *
 * And the property that makes this worth having at all: when the account had a
 * qualifying opportunity and history records no transition, that is a real
 * "no". Salesforce logs every tracked change, so absence here is evidence,
 * unlike absence in a sampled snapshot series.
 */
export function stageMovedAfterCall(args: {
  transitions: StageTransition[];
  /** ISO time of the call. */
  callAt: string;
  /** How long after the call a move still counts as following from it. */
  windowDays: number;
  /**
   * Opportunity ids on the account with the date each was created, so a move
   * on an opportunity that did not yet exist is excluded. Pass an empty array
   * when unknown, and the verdict says so rather than assuming.
   */
  opportunities: Array<{ id: string; createdAt: string }>;
  /**
   * The opportunity this deal actually is, when the caller knows it. Supplying
   * it makes a "yes" attributable on a multi-opportunity account. Omitting it
   * is safe: the verdict degrades to `unknown` rather than guessing.
   */
  dealOpportunityId?: string | null;
}): StageMoveVerdict {
  const callMs = Date.parse(args.callAt);
  if (!Number.isFinite(callMs)) {
    return { value: "unknown", reason: `call has no readable timestamp`, transitions: [] };
  }
  if (args.callAt.slice(0, 10) < HISTORY_BEGINS) {
    return {
      value: "unknown",
      reason: `the call predates Salesforce's recorded history, which begins ${HISTORY_BEGINS}`,
      transitions: [],
    };
  }
  if (args.opportunities.length === 0) {
    return {
      value: "unknown",
      reason: "no opportunity on this deal's account, so there was nothing that could change stage",
      transitions: [],
    };
  }

  const existedAtCall = new Set(
    args.opportunities.filter((o) => Date.parse(o.createdAt) <= callMs).map((o) => o.id),
  );
  if (existedAtCall.size === 0) {
    return {
      value: "unknown",
      reason: `the account's ${args.opportunities.length} opportunity(ies) were all created after this call, so none of them could have moved because of it`,
      transitions: [],
    };
  }

  const windowEnd = callMs + args.windowDays * 86_400_000;
  const inWindow = args.transitions.filter((t) => {
    if (!existedAtCall.has(t.opportunityId)) return false;
    const ms = Date.parse(t.at);
    return Number.isFinite(ms) && ms > callMs && ms <= windowEnd;
  });

  if (inWindow.length === 0) {
    return {
      value: "no",
      reason:
        `Salesforce records no stage change on ${existedAtCall.size} opportunity(ies) ` +
        `in the ${args.windowDays} days after the call. History is complete for tracked ` +
        `fields, so this is a recorded negative rather than a gap`,
      transitions: [],
    };
  }

  const movedOpps = [...new Set(inWindow.map((t) => t.opportunityId))];
  if (movedOpps.length > 1) {
    return {
      value: "unknown",
      reason:
        `${movedOpps.length} opportunities on this account changed stage in the window ` +
        `(${movedOpps.join(", ")}), so we cannot say which one this call moved`,
      transitions: inWindow,
    };
  }

  // Exactly one opportunity moved. Whether that is THIS deal moving depends on
  // whether the account had anything else it could have been.
  if (args.dealOpportunityId && movedOpps[0] !== args.dealOpportunityId) {
    return {
      value: "no",
      reason:
        `${movedOpps[0]} changed stage, but this deal is ${args.dealOpportunityId}, ` +
        `which did not move in the ${args.windowDays} days after the call`,
      transitions: [],
    };
  }
  if (!args.dealOpportunityId && existedAtCall.size > 1) {
    return {
      value: "unknown",
      reason:
        `${movedOpps[0]} changed stage, but the account carried ${existedAtCall.size} ` +
        `opportunities at the time of the call and we cannot say which one is this deal. ` +
        `The account moved; this deal may not have`,
      transitions: inWindow,
    };
  }

  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const path =
    inWindow.length === 1
      ? `${first.from ?? "(unset)"} to ${first.to ?? "(unset)"}`
      : `${first.from ?? "(unset)"} to ${last.to ?? "(unset)"} over ${inWindow.length} changes`;
  return {
    value: "yes",
    reason: `Salesforce moved ${movedOpps[0]} ${path} on ${first.at.slice(0, 10)}`,
    transitions: inWindow,
  };
}

/**
 * When each opportunity on these accounts was created.
 *
 * Needed by stageMovedAfterCall to exclude opportunities that did not exist at
 * the time of the call. Kept here rather than in lib/salesforce-stage.ts
 * because that module answers "what stage is this deal in now" and this one
 * answers "what changed and when", and the two should be able to move
 * independently.
 */
export async function loadOpportunityCreationForAccounts(
  accountIds: string[],
): Promise<Map<string, Array<{ id: string; createdAt: string }>> | { error: string }> {
  const out = new Map<string, Array<{ id: string; createdAt: string }>>();
  const unique = [...new Set(accountIds.filter(Boolean))];
  if (unique.length === 0) return out;

  let client: { instanceUrl: string; token: string };
  try {
    client = await getSalesforceClient();
  } catch (err) {
    return { error: `auth failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  for (const id of unique) out.set(id, []);

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const inList = chunk.map((id) => `'${id.replace(/[^a-zA-Z0-9]/g, "")}'`).join(",");
    const soql = `SELECT Id, AccountId, CreatedDate FROM Opportunity WHERE AccountId IN (${inList})`;
    const r = await fetch(
      `${client.instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`,
      { headers: { Authorization: `Bearer ${client.token}` } },
    );
    if (!r.ok) {
      return { error: `SOQL ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
    }
    const recs =
      ((await r.json()) as { records?: Array<{ Id: string; AccountId: string; CreatedDate: string }> })
        .records ?? [];
    for (const rec of recs) {
      out.get(rec.AccountId)?.push({ id: rec.Id, createdAt: rec.CreatedDate });
    }
  }
  return out;
}
