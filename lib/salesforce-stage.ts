/**
 * The Salesforce opportunity stage for a deal, for the snapshot series.
 *
 * WHY THIS EXISTS
 *
 * deal_signal_snapshots carries a `rolldog` block holding Rolldog's own stage
 * verbatim, and readStageMoved differences it across a call to answer "did the
 * customer's CRM say this deal moved". There has never been a Salesforce
 * equivalent, so a Salesforce-only deal snapshots with no CRM stage at all and
 * readStageMoved reports `unknown` for it permanently. Its docstring says so
 * outright.
 *
 * Measured 2026-08-18: of 111 Magaya deals, 37 carry a Rolldog opportunity, 59
 * are Salesforce-only and 15 carry no link. So 74 of 111 could never report
 * movement, which is most of why outcome_stage_moved is unknown on 243 of 283
 * prescriptions. Kiddom is Salesforce throughout, so without this its outcome
 * column would be 100% unknown from day one.
 *
 * WHY NOT loadOpportunitiesForAccounts
 *
 * That function already fetches opportunities per account and it is the reader
 * outcome-sync depends on. outcome-sync started returning clean reads on
 * 2026-08-19 after weeks of refusals, and widening its SOQL to carry
 * CreatedDate for a different caller's benefit risks the one path that just
 * started working. This module asks its own question with its own query.
 *
 * WHY IT ONLY READS CONFIRMED LINKS
 *
 * salesforce_link_confidence fails closed below `confirmed` everywhere else in
 * this codebase, and for the same reason here: a `review`-grade link may point
 * at the wrong company, and recording another company's stage as this deal's
 * would not merely be missing data, it would manufacture movement. An
 * unconfirmed link reports `unconfirmed_link`, which is a fact about our
 * linking rather than a fact about the deal.
 *
 * Every return value distinguishes "no" from "did not check", per the standing
 * rule. Nothing here ever returns a bare null.
 */

import { getSalesforceClient } from "./salesforce";
import { supabaseAdmin } from "./supabase";

const API = "v60.0";

/**
 * Salesforce's own state for the deal's live opportunity, captured verbatim.
 * The mirror of RolldogSnapshot in lib/snapshot.ts and deliberately the same
 * shape of thing: what the customer's system says, not what we infer.
 */
export type SalesforceSnapshot = {
  opportunityId: string;
  opportunityName: string;
  stageName: string;
  closeDate: string | null;
  amount: number | null;
  /**
   * The rep's own forecast band on this opportunity.
   *
   * Carried so a caller can flag the CONTRADICTION between what the rep claims
   * and what the evidence supports, which is a different and more useful thing
   * than either alone. "Commit with no economic buyer" is a sentence; "no
   * economic buyer" is a checkbox.
   */
  forecastCategory: string | null;
  /**
   * How many open opportunities the account carried when this was read.
   *
   * Greater than 1 means this stage is a CHOICE, not the account's only
   * answer. 45 of Magaya's 91 linked accounts carry more than one opportunity,
   * so a consumer comparing two snapshots needs to know whether it is watching
   * one opportunity move or the choice flipping between two.
   */
  openCount: number;
};

/**
 * WHY the salesforce block is absent, which the block itself cannot say.
 *
 *   read                  Salesforce answered and the account has an open
 *                         opportunity. `snapshot` holds what it said.
 *   no_account            The deal has no salesforce_account_id. Nothing to
 *                         read. Rolldog-only and unlinked deals live here.
 *   unconfirmed_link      An account id is set but the link is below
 *                         `confirmed`, so we decline to attribute its stage to
 *                         this deal.
 *   no_open_opportunity   The read SUCCEEDED and the account carries no open
 *                         opportunity. A real, informative empty: distinct
 *                         from a failed read, and distinct from a deal with no
 *                         account at all.
 *   unavailable           The read failed. We know nothing, including whether
 *                         an opportunity exists.
 *
 * Absent on snapshots written before this shipped, which callers must treat as
 * unknown rather than assuming `read`. Same rule as rolldogRead.
 */
export type SalesforceReadStatus =
  | "read"
  | "no_account"
  | "unconfirmed_link"
  | "no_open_opportunity"
  | "unavailable";

export type SalesforceRead =
  | { status: "read"; snapshot: SalesforceSnapshot }
  | { status: "no_account"; snapshot: null }
  | { status: "unconfirmed_link"; snapshot: null; confidence: string | null }
  | { status: "no_open_opportunity"; snapshot: null; totalOpportunities: number }
  | { status: "unavailable"; snapshot: null; error: string };

type OppRow = {
  Id: string;
  Name: string;
  AccountId: string;
  StageName: string;
  IsClosed: boolean;
  CloseDate: string | null;
  Amount: number | null;
  ForecastCategoryName: string | null;
  CreatedDate: string;
};

/** SOQL has a statement-length limit, so accounts go in chunks. */
const CHUNK = 120;

/**
 * Resolve each deal's live Salesforce opportunity stage.
 *
 * Batched: one SOQL round trip per 120 accounts, against Rolldog's one HTTP
 * call per deal. That difference is the argument for reading Salesforce on
 * every snapshot and Rolldog on a slower cadence, given Rolldog have said they
 * intend to start enforcing limits.
 *
 * Returns a status for every deal id asked about, including the ones it could
 * not answer for. An absent key would let a caller conclude "no opportunity"
 * about a deal whose row simply failed to load.
 */
export async function resolveSalesforceSnapshots(
  tenantId: string,
  dealIds: string[],
): Promise<Map<string, SalesforceRead>> {
  const out = new Map<string, SalesforceRead>();
  if (dealIds.length === 0) return out;

  const db = supabaseAdmin();
  const res = await db
    .from("deals")
    .select("id, salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", tenantId)
    .in("id", dealIds);

  if (res.error) {
    // Say it for every deal asked about. An empty map would have each caller
    // conclude "no Salesforce account" for deals that have one, which is the
    // exact substitution this file exists to prevent.
    const error = `deals lookup failed: ${res.error.message}`;
    console.error(`[sf-stage] ${error}; no deal can be read from Salesforce this run`);
    for (const id of dealIds) out.set(id, { status: "unavailable", snapshot: null, error });
    return out;
  }

  const rows = (res.data ?? []) as Array<{
    id: string;
    salesforce_account_id: string | null;
    salesforce_link_confidence: string | null;
  }>;
  const seen = new Set(rows.map((r) => r.id));
  for (const id of dealIds) {
    if (!seen.has(id)) {
      out.set(id, { status: "unavailable", snapshot: null, error: "deal not found in tenant" });
    }
  }

  // Classify first, so the SOQL only asks about accounts whose answer we would
  // actually attribute to a deal.
  const wanted = new Map<string, string[]>(); // accountId -> dealIds
  for (const r of rows) {
    if (!r.salesforce_account_id) {
      out.set(r.id, { status: "no_account", snapshot: null });
      continue;
    }
    if (r.salesforce_link_confidence !== "confirmed") {
      out.set(r.id, {
        status: "unconfirmed_link",
        snapshot: null,
        confidence: r.salesforce_link_confidence,
      });
      continue;
    }
    const list = wanted.get(r.salesforce_account_id) ?? [];
    list.push(r.id);
    wanted.set(r.salesforce_account_id, list);
  }
  if (wanted.size === 0) return out;

  let client: { instanceUrl: string; token: string };
  try {
    client = await getSalesforceClient();
  } catch (err) {
    const error = `auth failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[sf-stage] ${error}`);
    for (const ids of wanted.values()) {
      for (const id of ids) out.set(id, { status: "unavailable", snapshot: null, error });
    }
    return out;
  }

  const accountIds = [...wanted.keys()];
  const byAccount = new Map<string, OppRow[]>();

  for (let i = 0; i < accountIds.length; i += CHUNK) {
    const chunk = accountIds.slice(i, i + CHUNK);
    const inList = chunk.map((id) => `'${id.replace(/[^a-zA-Z0-9]/g, "")}'`).join(",");
    const soql =
      `SELECT Id, Name, AccountId, StageName, IsClosed, CloseDate, Amount, ForecastCategoryName, CreatedDate ` +
      `FROM Opportunity WHERE AccountId IN (${inList})`;
    const r = await fetch(
      `${client.instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`,
      { headers: { Authorization: `Bearer ${client.token}` } },
    );
    if (!r.ok) {
      // This chunk failed. Only the deals in THIS chunk are unavailable; the
      // others may still be answered, so the failure is scoped rather than
      // fatal to the whole run.
      const error = `SOQL ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`;
      console.error(`[sf-stage] ${error}`);
      for (const acc of chunk) {
        for (const id of wanted.get(acc) ?? []) {
          out.set(id, { status: "unavailable", snapshot: null, error });
        }
      }
      continue;
    }
    const records = ((await r.json()) as { records?: OppRow[] }).records ?? [];
    for (const rec of records) {
      const list = byAccount.get(rec.AccountId) ?? [];
      list.push(rec);
      byAccount.set(rec.AccountId, list);
    }
    // An account we asked about that returned nothing is a real empty, not a
    // missing key.
    for (const acc of chunk) if (!byAccount.has(acc)) byAccount.set(acc, []);
  }

  for (const [accountId, dealsOnAccount] of wanted) {
    const opps = byAccount.get(accountId);
    if (opps === undefined) continue; // its chunk failed and was already marked

    const open = opps.filter((o) => !o.IsClosed);
    if (open.length === 0) {
      for (const id of dealsOnAccount) {
        out.set(id, {
          status: "no_open_opportunity",
          snapshot: null,
          totalOpportunities: opps.length,
        });
      }
      continue;
    }

    // The most recently created open opportunity, which is the rule
    // findOpenOpportunity already uses for choosing a write target. Same
    // question, so the same answer: a deal whose stage we report and whose
    // opportunity we write to must not be two different opportunities.
    const chosen = open.reduce((a, b) => (a.CreatedDate >= b.CreatedDate ? a : b));
    for (const id of dealsOnAccount) {
      out.set(id, {
        status: "read",
        snapshot: {
          opportunityId: chosen.Id,
          opportunityName: chosen.Name,
          stageName: chosen.StageName,
          closeDate: chosen.CloseDate,
          amount: chosen.Amount,
          forecastCategory: chosen.ForecastCategoryName,
          openCount: open.length,
        },
      });
    }
  }

  return out;
}
