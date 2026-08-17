/**
 * Link deals to their Salesforce Account, on a schedule.
 *
 * The Salesforce twin of lib/rolldog-reconcile.ts, and it exists for the same
 * reason: a deal is often created before the CRM record it belongs to. A BDR
 * converts a lead days after the rep has already taken the call, so a deal that
 * resolved to nothing on Monday resolves cleanly on Thursday. Re-sweeping means
 * that deal picks up its account without anyone remembering to go back for it.
 *
 * Only `confirmed` (email-domain-verified) resolutions are written. A name
 * match and an ambiguous match are both returned for a human and neither is
 * ever stored automatically, because the cost of a wrong link is one customer's
 * call notes landing on another customer's record.
 *
 * Both the cron and scripts/sync-salesforce-links.ts call this, so the schedule
 * and the diagnostic can never disagree about what would happen.
 */

import { resolutionSummary, type AccountResolution } from "./salesforce-context";
import {
  readSalesforceLink,
  resolveAccountForDeal,
  writeSalesforceLink,
  type StoredLink,
} from "./salesforce-link";
import { supabaseAdmin } from "./supabase";
import { describeMatch, matchAccountForMeeting } from "./salesforce-account-match";
import { resolveTenantId } from "./tenant-deal-lookup";

export type LinkRow = {
  dealId: string;
  account: string;
  externalId: string | null;
  stored: StoredLink;
  resolution: AccountResolution;
  summary: string;
  /** Set only when apply was requested and this row qualified. */
  write?: { written: boolean; reason?: string };
};

export type LinkSweep = {
  rows: LinkRow[];
  counts: {
    confirmed: number;
    review: number;
    ambiguous: number;
    noAccount: number;
    lookupFailed: number;
    written: number;
  };
  /** True when the link columns do not exist yet, so nothing could be stored. */
  schemaMissing: boolean;
};

/** The customer domain a deal was created from. auto:<domain> or auto:<address>. */
export function domainOfDeal(externalId: string | null): { domain: string | null; address: string | null } {
  if (!externalId?.startsWith("auto:")) return { domain: null, address: null };
  const tail = externalId.slice("auto:".length);
  if (tail.includes("@")) return { domain: tail.split("@")[1] ?? null, address: tail };
  return { domain: tail, address: null };
}

export async function sweepSalesforceLinks(
  tenantSlug: string,
  opts: { days?: number; apply?: boolean; dealFilter?: string | null } = {},
): Promise<LinkSweep> {
  const days = opts.days ?? 14;
  const tenantId = await resolveTenantId(tenantSlug);
  const db = supabaseAdmin();

  const calls = await db
    .from("calls")
    .select("deal_id, title, scheduled_start, participants")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", new Date().toISOString())
    .lte("scheduled_start", new Date(Date.now() + days * 86_400_000).toISOString())
    .order("scheduled_start", { ascending: true });
  if (calls.error) throw new Error(`could not list upcoming calls: ${calls.error.message}`);

  const subjectByDeal = new Map<string, string | null>();
  // Attendees and the meeting date, for the strong rungs below.
  const meetingByDeal = new Map<string, { emails: string[]; date: string | null }>();
  for (const c of calls.data ?? []) {
    if (!c.deal_id || subjectByDeal.has(c.deal_id)) continue;
    subjectByDeal.set(c.deal_id, c.title ?? null);
    const emails = Array.isArray(c.participants)
      ? (c.participants as Array<{ email?: string | null }>)
          .map((p) => (p?.email ?? "").trim())
          .filter(Boolean)
      : [];
    meetingByDeal.set(c.deal_id, {
      emails,
      date: (c.scheduled_start ?? "").slice(0, 10) || null,
    });
  }

  const counts = { confirmed: 0, review: 0, ambiguous: 0, noAccount: 0, lookupFailed: 0, written: 0 };
  const rows: LinkRow[] = [];
  let schemaMissing = false;

  if (subjectByDeal.size === 0) return { rows, counts, schemaMissing };

  const deals = await db
    .from("deals")
    .select("id, account, external_id")
    .eq("tenant_id", tenantId)
    .in("id", [...subjectByDeal.keys()]);
  if (deals.error) throw new Error(`could not load deals: ${deals.error.message}`);

  for (const d of deals.data ?? []) {
    if (
      opts.dealFilter &&
      !`${d.external_id ?? ""} ${d.account}`.toLowerCase().includes(opts.dealFilter.toLowerCase())
    ) {
      continue;
    }
    // Eduardo's ladder first: the exact attendee address against a Contact, then
    // an activity on the meeting's own date. Domain matching is what put
    // Dunavant on a stale 2021 record and left ten deals unlinked, so it is
    // now the FALLBACK rather than the primary, and it only runs when the
    // stronger rungs found nothing.
    const meeting = meetingByDeal.get(d.id);
    if (meeting && meeting.emails.length > 0) {
      const strong = await matchAccountForMeeting({
        attendeeEmails: meeting.emails,
        meetingDate: meeting.date,
        accountName: d.account,
      });
      if (strong.status === "matched" && strong.match.confidence === "confirmed") {
        const row: LinkRow = {
          dealId: d.id,
          account: d.account,
          externalId: d.external_id,
          stored: await readSalesforceLink(tenantId, d.id),
          resolution: {
            status: "resolved_by_domain",
            accountId: strong.match.accountId,
            accountName: strong.match.accountName,
            confidence: "confirmed",
          },
          summary: describeMatch(strong),
        };
        counts.confirmed += 1;
        if (opts.apply) {
          const w = await writeSalesforceLink(tenantId, d.id, strong.match.accountId, "confirmed");
          row.write = w;
          if (w.written) counts.written += 1;
        }
        rows.push(row);
        continue;
      }
    }

    const { domain, address } = domainOfDeal(d.external_id);
    const { resolution, stored } = await resolveAccountForDeal({
      tenantId,
      dealId: d.id,
      dealAccountName: d.account,
      domain,
      addresses: address ? [address] : [],
      meetingSubject: subjectByDeal.get(d.id) ?? null,
      // Always look. This sweep is what establishes links in the first place,
      // and a deal that resolved to nothing last week is exactly the one worth
      // re-checking now that the BDR may have converted the lead.
      force: true,
    });
    if (stored.status === "schema_missing") schemaMissing = true;

    const row: LinkRow = {
      dealId: d.id,
      account: d.account,
      externalId: d.external_id,
      stored,
      resolution,
      summary: resolutionSummary(resolution),
    };

    switch (resolution.status) {
      case "resolved_by_domain":
        counts.confirmed += 1;
        if (opts.apply) {
          const w = await writeSalesforceLink(tenantId, d.id, resolution.accountId, "confirmed");
          row.write = w;
          if (w.written) counts.written += 1;
        }
        break;
      case "resolved_by_name":
        counts.review += 1;
        break;
      case "ambiguous":
        counts.ambiguous += 1;
        break;
      case "lookup_failed":
        counts.lookupFailed += 1;
        break;
      default:
        counts.noAccount += 1;
    }
    rows.push(row);
  }

  return { rows, counts, schemaMissing };
}
