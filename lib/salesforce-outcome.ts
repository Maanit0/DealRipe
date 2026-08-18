/**
 * Deal-level outcome resolution from Salesforce.
 *
 * WHY THIS EXISTS, and why it is not getOpportunityOutcome:
 *
 * outcome-sync used to pass `deals.external_id` to getOpportunityOutcome as a
 * Salesforce Opportunity id. In the Magaya pilot external_id is DealRipe's own
 * auto-created key (`auto:cbxglobal.com`), so zero of 108 deals ever resolved.
 * The Salesforce link lives on `salesforce_account_id`.
 *
 * An account is not an opportunity. 45 of Magaya's 91 linked accounts carry
 * more than one, and some carry twenty years of them, so this module has to
 * CHOOSE rather than take a first row. Two rules do the choosing, and both
 * exist because getting them wrong invents an outcome:
 *
 *   1. Any OPEN opportunity means the deal is still in play. Report open and
 *      label nothing, even when closed opportunities also sit on the account.
 *   2. A closed opportunity is only THIS deal's outcome if it closed on or
 *      after the first call DealRipe captured. Magaya accounts carry closes
 *      back to 2017; labelling a 2021 Closed Lost as the outcome of a call we
 *      ran last week would be fabrication. Those return `only_historical`.
 *
 * Every return value distinguishes "no" from "did not check", per the standing
 * rule in CLAUDE.md. `unavailable` means the read failed and the caller must
 * not treat it as an absence.
 */

import { getSalesforceClient } from "./salesforce";

const API = "v60.0";

export type DealOutcome =
  | {
      status: "won" | "lost";
      opportunityId: string;
      opportunityName: string;
      closeDate: string;
      amount: number | null;
      lossReason: string | null;
      /** Closed opportunities on the account that we deliberately ignored as
       *  predating our first call. Reported so a caller can show its work. */
      historicalIgnored: number;
    }
  | { status: "open"; openCount: number }
  /**
   * Still live, AND something closed on the account after our first call.
   *
   * Speed International is the case: an ABI opportunity closed won on
   * 2026-08-14, days after a call we captured, while other business on the
   * account stays open. Labelling the deal won would tell the digest a live
   * relationship is finished; reporting a bare `open` would throw away the one
   * outcome we actually observed. It is both, so it says both, and the
   * learning loop can use `closed` while the pipeline uses the open count.
   */
  | {
      status: "open_with_recent_close";
      openCount: number;
      closed: {
        won: boolean;
        opportunityId: string;
        opportunityName: string;
        closeDate: string;
        amount: number | null;
        lossReason: string | null;
      };
    }
  | { status: "no_opportunity" }
  | { status: "only_historical"; mostRecentClose: string; closedCount: number }
  | { status: "no_account" }
  | { status: "unavailable"; reason: string };

export type OppRecord = {
  Id: string;
  Name: string;
  AccountId: string;
  StageName: string;
  IsClosed: boolean;
  IsWon: boolean;
  CloseDate: string | null;
  Amount: number | null;
  Loss_Reason__c?: string | null;
};

/**
 * Fetch every opportunity on the given accounts in as few round trips as
 * possible, chunked because SOQL has a statement-length limit.
 *
 * Returns null rather than an empty map when the read itself failed, so a
 * caller can report `unavailable` instead of `no_opportunity`. That
 * distinction is the entire point of this file.
 */
export async function loadOpportunitiesForAccounts(
  accountIds: string[],
): Promise<Map<string, OppRecord[]> | null> {
  if (accountIds.length === 0) return new Map();

  let client: { instanceUrl: string; token: string };
  try {
    client = await getSalesforceClient();
  } catch (err) {
    console.error(
      `[sf-outcome] auth failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // Loss_Reason__c is a Magaya custom field. Probe it once: if it is absent or
  // hidden by field-level security we fall back to the standard fields rather
  // than failing the whole run, and the caller sees lossReason null (which
  // means "did not read", not "no reason recorded").
  let withReason = true;
  const byAccount = new Map<string, OppRecord[]>();
  const unique = [...new Set(accountIds)];
  const CHUNK = 120;

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const inList = chunk.map((id) => `'${id.replace(/'/g, "")}'`).join(",");
    const fields = (reason: boolean) =>
      `Id, Name, AccountId, StageName, IsClosed, IsWon, CloseDate, Amount${reason ? ", Loss_Reason__c" : ""}`;

    let records: OppRecord[] | null = null;
    for (const attemptReason of withReason ? [true, false] : [false]) {
      const soql = `SELECT ${fields(attemptReason)} FROM Opportunity WHERE AccountId IN (${inList})`;
      const res = await fetch(
        `${client.instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`,
        { headers: { Authorization: `Bearer ${client.token}` } },
      );
      if (res.ok) {
        records = ((await res.json()).records ?? []) as OppRecord[];
        if (!attemptReason) withReason = false;
        break;
      }
      const body = await res.text();
      if (attemptReason && /Loss_Reason__c/.test(body)) {
        console.warn("[sf-outcome] Loss_Reason__c unreadable, continuing without it");
        continue;
      }
      console.error(`[sf-outcome] SOQL ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    if (!records) return null;

    for (const r of records) {
      const list = byAccount.get(r.AccountId) ?? [];
      list.push(r);
      byAccount.set(r.AccountId, list);
    }
  }

  // Accounts we asked about but that returned nothing are a real empty, not a
  // missing key, so callers can tell them apart from "we never asked".
  for (const id of unique) if (!byAccount.has(id)) byAccount.set(id, []);
  return byAccount;
}

/**
 * Decide one deal's outcome.
 *
 * `firstCallDate` is the date of the earliest call DealRipe has on the deal
 * (YYYY-MM-DD). Closes before it are treated as the account's history rather
 * than as this deal's result. Pass null when the deal has no calls, which
 * makes every close historical: a deal we never observed cannot have been won
 * or lost BY us.
 */
export function resolveDealOutcome(args: {
  salesforceAccountId: string | null;
  firstCallDate: string | null;
  opportunitiesByAccount: Map<string, OppRecord[]> | null;
}): DealOutcome {
  if (!args.salesforceAccountId) return { status: "no_account" };
  if (!args.opportunitiesByAccount) {
    return { status: "unavailable", reason: "salesforce opportunity read failed" };
  }
  const opps = args.opportunitiesByAccount.get(args.salesforceAccountId);
  if (!opps) {
    return { status: "unavailable", reason: "account was not included in the read" };
  }
  if (opps.length === 0) return { status: "no_opportunity" };

  const closed = opps.filter((o) => o.IsClosed && o.CloseDate);
  const inWindowAll = args.firstCallDate
    ? closed
        .filter((o) => String(o.CloseDate) >= args.firstCallDate!)
        .sort((a, b) => String(b.CloseDate).localeCompare(String(a.CloseDate)))
    : [];

  const open = opps.filter((o) => !o.IsClosed);
  if (open.length > 0) {
    const recent = inWindowAll[0];
    if (!recent) return { status: "open", openCount: open.length };
    return {
      status: "open_with_recent_close",
      openCount: open.length,
      closed: {
        won: recent.IsWon,
        opportunityId: recent.Id,
        opportunityName: recent.Name,
        closeDate: String(recent.CloseDate),
        amount: typeof recent.Amount === "number" ? recent.Amount : null,
        lossReason: recent.Loss_Reason__c ?? null,
      },
    };
  }

  if (closed.length === 0) return { status: "no_opportunity" };

  const sorted = [...closed].sort((a, b) =>
    String(b.CloseDate).localeCompare(String(a.CloseDate)),
  );

  if (!args.firstCallDate) {
    return {
      status: "only_historical",
      mostRecentClose: String(sorted[0].CloseDate),
      closedCount: closed.length,
    };
  }

  const inWindow = sorted.filter(
    (o) => String(o.CloseDate) >= args.firstCallDate!,
  );
  if (inWindow.length === 0) {
    return {
      status: "only_historical",
      mostRecentClose: String(sorted[0].CloseDate),
      closedCount: closed.length,
    };
  }

  const chosen = inWindow[0];
  return {
    status: chosen.IsWon ? "won" : "lost",
    opportunityId: chosen.Id,
    opportunityName: chosen.Name,
    closeDate: String(chosen.CloseDate),
    amount: typeof chosen.Amount === "number" ? chosen.Amount : null,
    lossReason: chosen.Loss_Reason__c ?? null,
    historicalIgnored: closed.length - inWindow.length,
  };
}

/** One-line human description, for scripts and logs. */
export function describeOutcome(o: DealOutcome): string {
  switch (o.status) {
    case "won":
    case "lost":
      return `${o.status.toUpperCase()} ${o.closeDate} ${o.opportunityName.slice(0, 40)}${
        o.lossReason ? ` reason=${o.lossReason}` : ""
      }${o.historicalIgnored ? ` (ignored ${o.historicalIgnored} older closes)` : ""}`;
    case "open":
      return `open (${o.openCount} open opportunit${o.openCount === 1 ? "y" : "ies"})`;
    case "open_with_recent_close":
      return `open (${o.openCount}) but ${o.closed.won ? "WON" : "LOST"} ${o.closed.closeDate} ${o.closed.opportunityName.slice(0, 36)}`;
    case "no_opportunity":
      return "no opportunity on the account";
    case "only_historical":
      return `only historical closes (${o.closedCount}, most recent ${o.mostRecentClose})`;
    case "no_account":
      return "deal has no salesforce_account_id";
    case "unavailable":
      return `did not check: ${o.reason}`;
  }
}
