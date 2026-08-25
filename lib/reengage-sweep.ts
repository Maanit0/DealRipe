/**
 * The re-engagement sweep, as one function that both the script and the cron call.
 *
 * Extracted 2026-08-25 so this could run on a schedule. Deliberately NOT copied
 * into a cron route: every guard below is the difference between a useful draft
 * and one that embarrasses a rep in front of a customer, and a second copy of
 * them would drift. Same rule as resolveWriteTarget.
 *
 * The guards, none of them optional:
 *  - a deal whose Salesforce opportunities are ALL closed is skipped. Caught for
 *    real on 2026-08-20, when this generated a draft offering Aeronet workflow
 *    videos on a day Salesforce had marked that opportunity Closed Lost.
 *  - a Salesforce read that FAILED is skipped, never assumed live. Not knowing
 *    whether a deal is over is a reason not to mail, not a reason to mail.
 *  - a flag already drafted inside its cooldown is skipped.
 *  - a deal with no customer attendee on any captured call is skipped: there is
 *    nobody to write to.
 *  - each rep is capped, and the overflow is REPORTED rather than dropped, so a
 *    run never reads as "everything is handled" when it is not.
 *
 * Nothing is ever sent. Drafts land in the rep's own Drafts folder and a human
 * presses send.
 */
import { loadPortfolioRead } from "./deal-read-portfolio";
import { domainOf } from "./graph-mail";
import { DRAFTABLE, createReengageDraft, generateReengageDraft, recentlyDrafted } from "./reengage-draft";
import { supabaseAdmin } from "./supabase";

const INTERNAL_DOMAIN = "magaya.com";
export const DEFAULT_PER_REP = 3;

export type SweepSkip = { account: string; why: string };
export type SweepPreview = {
  account: string;
  mailbox: string;
  why: string;
  to: string[];
  subject: string;
  body: string;
  onThread: boolean;
};
export type SweepResult = {
  openDeals: number;
  flagged: number;
  cappedOut: number;
  drafted: number;
  would: number;
  failed: number;
  skips: SweepSkip[];
  previews: SweepPreview[];
};

async function customerEmailsFor(tenantId: string, dealId: string): Promise<string[]> {
  const res = await supabaseAdmin()
    .from("calls")
    .select("participants, scheduled_start")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId)
    .eq("outcome", "captured")
    .order("scheduled_start", { ascending: false })
    .limit(4);
  if (res.error) return [];
  const out = new Set<string>();
  for (const row of (res.data ?? []) as Array<{ participants: unknown }>) {
    const people = Array.isArray(row.participants) ? (row.participants as Array<{ email?: string | null }>) : [];
    for (const p of people) {
      const e = (p?.email ?? "").toLowerCase().trim();
      if (e.includes("@") && domainOf(e) !== INTERNAL_DOMAIN) out.add(e);
    }
  }
  return [...out];
}

export async function runReengageSweep(args: {
  tenantId: string;
  apply: boolean;
  perRep?: number;
  limit?: number;
  onlyRep?: string;
  onlyDeal?: string;
}): Promise<SweepResult> {
  const { tenantId, apply } = args;
  const perRep = args.perRep ?? DEFAULT_PER_REP;
  const limit = args.limit ?? Number.MAX_SAFE_INTEGER;
  const onlyRep = args.onlyRep?.toLowerCase();
  const onlyDeal = args.onlyDeal?.toLowerCase();

  const rows = await loadPortfolioRead({ tenantId });
  // Account ids for the standing check. One read for the whole sweep.
  const dealRows = await supabaseAdmin()
    .from("deals")
    .select("id, salesforce_account_id")
    .eq("tenant_id", tenantId);
  const sfByDeal = new Map(
    ((dealRows.data ?? []) as Array<{ id: string; salesforce_account_id: string | null }>).map((d) => [d.id, d.salesforce_account_id]),
  );
  const draftableIds = new Set(DRAFTABLE.map((d) => d.id));

  let candidates = rows.filter((r) => r.flags.some((f) => draftableIds.has(f.id)));
  if (onlyRep) candidates = candidates.filter((r) => (r.repEmail ?? "").toLowerCase().includes(onlyRep));
  if (onlyDeal) candidates = candidates.filter((r) => r.account.toLowerCase().includes(onlyDeal));
  const flagged = candidates.length;

  // Best deal first, so a capped rep gets their three biggest rather than
  // whichever three sorted first.
  const perRepCount = new Map<string, number>();
  const capped: typeof candidates = [];
  let cappedOut = 0;
  for (const r of candidates) {
    const key = (r.repEmail ?? "?").toLowerCase();
    const n = perRepCount.get(key) ?? 0;
    if (n >= perRep) {
      cappedOut += 1;
      continue;
    }
    perRepCount.set(key, n + 1);
    capped.push(r);
  }

  const skips: SweepSkip[] = [];
  const previews: SweepPreview[] = [];
  let drafted = 0;
  let would = 0;
  let failed = 0;
  let seen = 0;

  for (const r of capped) {
    if (seen >= limit) break;
    const flag = r.flags.find((f) => draftableIds.has(f.id))!;

    if (!r.repEmail) {
      skips.push({ account: r.account, why: "no rep email on the deal, so there is no mailbox to draft into" });
      continue;
    }
    if (r.crmRead?.status === "no_open_opportunity") {
      // Deliberately not phrased as "this deal is over". Best is a Magaya
      // customer since 2026-07-17 with an Active implementation, and every
      // opportunity on the account being closed means they BOUGHT, not that the
      // relationship ended. Skipping is still right, because there is no open
      // opportunity to write about, but the reason matters: this is the state an
      // expansion conversation starts from.
      skips.push({ account: r.account, why: "no open opportunity on the Salesforce account, so there is nothing to write about" });
      continue;
    }
    if (r.crmRead?.status === "unavailable") {
      skips.push({ account: r.account, why: `could not read Salesforce to confirm the deal is live (${r.crmRead.error})` });
      continue;
    }
    if (await recentlyDrafted(r.dealId, flag.id)) {
      skips.push({ account: r.account, why: `already drafted for '${flag.id}' inside the cooldown` });
      continue;
    }
    const customerEmails = await customerEmailsFor(tenantId, r.dealId);
    if (customerEmails.length === 0) {
      skips.push({ account: r.account, why: "no customer attendee on any captured call, so nobody to write to" });
      continue;
    }

    seen += 1;
    const draft = await generateReengageDraft({
      tenantId,
      dealId: r.dealId,
      account: r.account,
      mailbox: r.repEmail,
      customerEmails,
      signals: r.signals,
      flags: r.flags,
      salesforceAccountId: sfByDeal.get(r.dealId) ?? null,
    });
    if (!draft) {
      failed += 1;
      skips.push({ account: r.account, why: "generation returned nothing usable" });
      continue;
    }

    const res = await createReengageDraft(draft, { apply });
    if (res.status === "drafted") drafted += 1;
    else if (res.status === "would_draft") would += 1;
    else {
      failed += 1;
      skips.push({ account: r.account, why: res.why });
      continue;
    }
    previews.push({
      account: r.account,
      mailbox: draft.mailbox,
      why: flag.title,
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
      onThread: Boolean(draft.replyToMessageId),
    });
  }

  return { openDeals: rows.length, flagged, cappedOut, drafted, would, failed, skips, previews };
}
