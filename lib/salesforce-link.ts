/**
 * The stored Salesforce link on a deal, and how it is established.
 *
 * Resolution is sticky on purpose. Searching Salesforce on every call is slow,
 * costs an API budget shared with the rest of Magaya's org, and is
 * non-deterministic in the one way that matters: a fuzzy name search can return
 * a different winner on a different day. Once an account is confirmed for a
 * deal it is written to the deal row and read from there.
 *
 * Three states, kept apart:
 *   confirmed  reached by email domain, or promoted by a human. Writes allowed.
 *   review     reached by company name only. Briefings may read it. Writes are
 *              refused, because a name match is not evidence enough to edit a
 *              paying customer's CRM.
 *   (absent)   no link established.
 *
 * Nothing here ever persists a failure. If Salesforce could not be reached, the
 * deal row is left exactly as it was, so a transient outage can never be read
 * later as "this company is not in Salesforce".
 */

import {
  resolveAccount,
  type AccountResolution,
} from "./salesforce-context";
import { supabaseAdmin } from "./supabase";

export type SalesforceLinkConfidence = "confirmed" | "review";

/**
 * What is stored on the deal today.
 *
 * `schema_missing` is not paranoia. The salesforce_account_id column arrives in
 * supabase/add-deal-salesforce-link.sql, and until someone runs it every read
 * of that column errors. Reporting that as "this deal has no link" would send
 * someone hunting a matching bug that does not exist.
 */
export type StoredLink =
  | { status: "linked"; accountId: string; confidence: SalesforceLinkConfidence }
  | { status: "none" }
  | { status: "deal_not_found" }
  | { status: "schema_missing"; error: string }
  | { status: "unavailable"; error: string };

/** Postgres "column does not exist". The migration has not been run. */
function isMissingColumn(message: string): boolean {
  return /column .* does not exist/i.test(message);
}

export async function readSalesforceLink(tenantId: string, dealId: string): Promise<StoredLink> {
  const db = supabaseAdmin();
  const res = await db
    .from("deals")
    .select("salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", tenantId)
    .eq("id", dealId)
    .maybeSingle();
  if (res.error) {
    return isMissingColumn(res.error.message)
      ? { status: "schema_missing", error: res.error.message }
      : { status: "unavailable", error: res.error.message };
  }
  if (!res.data) return { status: "deal_not_found" };
  const id = res.data.salesforce_account_id;
  const conf = res.data.salesforce_link_confidence;
  if (!id) return { status: "none" };
  return {
    status: "linked",
    accountId: id,
    confidence: conf === "confirmed" ? "confirmed" : "review",
  };
}

export type LinkWriteResult = { written: boolean; reason?: string };

/** Store a link. Only ever called with a resolution we are willing to stand behind. */
export async function writeSalesforceLink(
  tenantId: string,
  dealId: string,
  accountId: string,
  confidence: SalesforceLinkConfidence,
): Promise<LinkWriteResult> {
  const db = supabaseAdmin();
  const res = await db
    .from("deals")
    .update({ salesforce_account_id: accountId, salesforce_link_confidence: confidence })
    .eq("tenant_id", tenantId)
    .eq("id", dealId);
  if (res.error) {
    return {
      written: false,
      reason: isMissingColumn(res.error.message)
        ? `schema not migrated: run supabase/add-deal-salesforce-link.sql (${res.error.message})`
        : res.error.message,
    };
  }
  return { written: true };
}

/**
 * The resolution for a deal, preferring what is already stored.
 *
 * `fresh` says whether Salesforce was actually consulted on this call, which
 * matters to a diagnostic deciding whether it is reporting a live answer or a
 * remembered one.
 */
export type DealResolution = {
  resolution: AccountResolution;
  fresh: boolean;
  stored: StoredLink;
};

export async function resolveAccountForDeal(args: {
  tenantId: string;
  dealId: string;
  dealAccountName?: string | null;
  domain?: string | null;
  addresses?: ReadonlyArray<string>;
  meetingSubject?: string | null;
  /** Ignore a stored link and re-derive. Used by the relink sweep. */
  force?: boolean;
}): Promise<DealResolution> {
  const stored = await readSalesforceLink(args.tenantId, args.dealId);

  if (!args.force && stored.status === "linked") {
    // Stored links are trusted without a round trip, but the account name is
    // worth having for display, so this is one cheap read rather than a search.
    return {
      stored,
      fresh: false,
      resolution:
        stored.confidence === "confirmed"
          ? {
              status: "resolved_by_domain",
              accountId: stored.accountId,
              accountName: "",
              confidence: "confirmed",
            }
          : {
              status: "resolved_by_name",
              accountId: stored.accountId,
              accountName: "",
              confidence: "review",
              matchedName: "(stored link)",
            },
    };
  }

  const resolution = await resolveAccount({
    domain: args.domain,
    addresses: args.addresses,
    dealAccountName: args.dealAccountName,
    meetingSubject: args.meetingSubject,
  });
  return { resolution, fresh: true, stored };
}
