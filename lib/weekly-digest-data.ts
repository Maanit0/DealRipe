/**
 * Evidence-based weekly digest data. Reads what the CALLS actually captured (a
 * named budget owner never on a call, a real no-show, a deal single-threaded
 * through one person), not gate-absence, so it surfaces the deals that matter
 * and leaves not-yet-happened calls out. Each attention item carries one
 * flowing narrative paragraph, written the way a sales leader reads.
 */

import { isMeaningfulContact } from "./contacts-extract";
import { getRolldogSummary } from "./rolldog-summary";
import { supabaseAdmin } from "./supabase";

const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled", "placeholder"]);
const BUYER_RE = /budget|cfo|chief financ|owner|final (say|decision)|economic|controller/i;

// Clean display names for the pilot's domain-derived accounts.
const DISPLAY_NAMES: Record<string, string> = {
  "auto:corelogistics.net": "Core Logistics",
  "auto:cbxglobal.com": "CBX Global",
  "auto:fmgloballogistics.com": "FM Global Logistics",
  "auto:acecustomsinc.com": "Ace Customs",
  "auto:seaboardmarine.com": "Seaboard Marine",
  "auto:airamericas.com": "Air Americas",
  "auto:successchb.com": "Success CHB",
  "auto:cargocleared.com": "Cargo Cleared",
  "auto:cargoservicesgroup.com": "Cargo Services Group",
};
const REP_NAMES: Record<string, string> = {
  "jlopez@magaya.com": "Juan",
  "ebencomo@magaya.com": "Eduardo",
};

// The rep's Rolldog forecast, for setting next to DealRipe's evidence read.
export type RepForecast = { category: string | null; closeDate: string | null };

export type DigestAttention = {
  dealId: string;
  account: string;
  headline: string; // short, specific
  detail: string; // one flowing paragraph: context, why it matters, the action
  priority: number;
  repForecast?: RepForecast;
};
export type DigestMovement = { dealId: string; account: string; note: string; repForecast?: RepForecast };
export type DigestNoShow = { dealId: string; account: string; note: string };
export type WeeklyDigestData = {
  attention: DigestAttention[];
  movement: DigestMovement[];
  noShows: DigestNoShow[];
};

type Row = Record<string, unknown>;
const group = <T extends { deal_id: string }>(arr: T[]) =>
  arr.reduce<Record<string, T[]>>((m, r) => ((m[r.deal_id] ??= []).push(r), m), {});

function fmtNames(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  } catch {
    return "";
  }
}

export async function buildWeeklyDigestData(tenantId: string): Promise<WeeklyDigestData> {
  const db = supabaseAdmin();
  const [deals, fe, contacts, calls] = await Promise.all([
    db.from("deals").select("id, account, external_id, stage_key, rep_email, rolldog_opportunity_id").eq("tenant_id", tenantId),
    db.from("field_extractions").select("deal_id, status").eq("tenant_id", tenantId),
    db.from("contacts").select("deal_id, name, role, relationship, last_contacted_at").eq("tenant_id", tenantId),
    db.from("calls").select("deal_id, outcome, scheduled_start, call_date, meeting_type").eq("tenant_id", tenantId),
  ]);

  const feBy = group((fe.data ?? []) as Array<Row & { deal_id: string }>);
  const contactsBy = group((contacts.data ?? []) as Array<Row & { deal_id: string }>);
  const callsBy = group((calls.data ?? []) as Array<Row & { deal_id: string }>);

  // Each deal's linked Rolldog opp, for the rep-forecast enrichment below.
  const oppByDeal = new Map<string, string>();
  for (const d of (deals.data ?? []) as Array<{ id: string; rolldog_opportunity_id: string | null }>) {
    if (d.rolldog_opportunity_id) oppByDeal.set(d.id, d.rolldog_opportunity_id);
  }

  const attention: DigestAttention[] = [];
  const movement: DigestMovement[] = [];
  const noShows: DigestNoShow[] = [];
  const tenDaysAgo = Date.now() - 10 * 864e5;

  for (const d of (deals.data ?? []) as Array<{
    id: string;
    account: string;
    external_id: string | null;
    stage_key: string | null;
    rep_email: string | null;
  }>) {
    // Skip non-opportunity meetings (existing customer / internal): they get a
    // recap, but they are not sales pipeline and shouldn't appear in the digest.
    // A deal is excluded only when every classified call is non-opportunity;
    // unclassified calls default to keeping it (safe).
    const classifiedTypes = (callsBy[d.id] ?? [])
      .map((c) => c.meeting_type)
      .filter((t): t is string => !!t);
    if (classifiedTypes.length > 0 && classifiedTypes.every((t) => t !== "new_opportunity")) {
      continue;
    }

    const account = DISPLAY_NAMES[d.external_id ?? ""] ?? d.account;
    const rep = REP_NAMES[d.rep_email ?? ""] ?? "the rep";
    const gates = (feBy[d.id] ?? []).filter((x) => x.status === "Yes").length;
    const cts = (contactsBy[d.id] ?? []).filter((c) =>
      isMeaningfulContact(c as { relationship?: string | null; role?: string | null }),
    );
    const engaged = cts.filter((c) => c.last_contacted_at);
    const hasContent = gates > 0 || engaged.length > 0;

    // No-show: own section, fires regardless of captured content.
    const now = Date.now();
    const noShowCall = (callsBy[d.id] ?? []).find((c) => {
      if (!c.outcome || !NO_CONTENT.has(String(c.outcome))) return false;
      const t = Date.parse(String(c.scheduled_start ?? c.call_date ?? ""));
      // Only a call that has already happened can be a no-show. A future
      // scheduled call is "upcoming", never a no-show.
      return Number.isFinite(t) && t >= tenDaysAgo && t <= now;
    });
    if (noShowCall) {
      const dt = shortDate(String(noShowCall.scheduled_start ?? noShowCall.call_date ?? ""));
      noShows.push({
        dealId: d.id,
        account,
        note: `The ${dt ? dt + " " : ""}meeting was a no-show. The bot joined, no one was there. Flagged for ${rep}'s one-on-one, worth confirming whether this is still a live deal.`,
      });
      continue;
    }

    if (!hasContent) continue; // no real call yet: pending, not a risk

    const champion = engaged.find((c) => String(c.relationship) === "champion");
    const championName = champion ? String(champion.name) : null;

    // Budget owner named on a call but never engaged.
    const darkBuyers = cts
      .filter(
        (c) =>
          !c.last_contacted_at &&
          (String(c.relationship) === "economic_buyer" ||
            BUYER_RE.test(String(c.role ?? "")) ||
            BUYER_RE.test(String(c.relationship ?? ""))),
      )
      .map((c) => String(c.name));

    if (darkBuyers.length > 0) {
      const one = darkBuyers.length === 1;
      const detail =
        `${gates} qualification gates are confirmed` +
        (championName ? ` and ${championName} is engaged as the champion` : "") +
        `, but ${fmtNames(darkBuyers)}, who control the budget, ${one ? "has" : "have"} never been on a call. ` +
        `Until the person who signs is in the room, this cannot close. ` +
        `Ask ${rep} to get ${darkBuyers[0]} into the next meeting and lock a proposal-review date.`;
      attention.push({
        dealId: d.id,
        account,
        headline: one ? "the budget holder has never been on a call" : "the budget holders have never been on a call",
        detail,
        priority: 100,
      });
      continue;
    }

    // Single-threaded: qualified deal riding on one engaged person.
    if (engaged.length === 1 && gates >= 5) {
      const solo = String(engaged[0].name);
      const secondName = cts.find((c) => !c.last_contacted_at && String(c.name) !== solo)?.name;
      const detail =
        `This deal is qualified, ${gates} gates confirmed, but only ${solo} has been on a call, so it depends on one person. ` +
        (secondName
          ? `A second contact, ${secondName}, was named but never brought in. Ask ${rep} to get them on a call `
          : `Ask ${rep} to widen to a second contact `) +
        `so the deal is not riding on a single relationship.`;
      attention.push({
        dealId: d.id,
        account,
        headline: "riding on one relationship",
        detail,
        priority: 45,
      });
      continue;
    }

    // Real, healthy activity this week.
    if (engaged.length > 0) {
      movement.push({
        dealId: d.id,
        account,
        note: `Call captured, ${gates} qualification gate${gates === 1 ? "" : "s"} confirmed, ${engaged.length} contact${engaged.length === 1 ? "" : "s"} engaged.`,
      });
    }
  }

  attention.sort((a, b) => b.priority - a.priority);

  // Set the rep's Rolldog forecast (category + close date) next to the evidence,
  // for the surfaced deals that are linked. Best-effort per deal; a Rolldog read
  // failure just omits the rep-forecast line. Only the few surfaced+linked deals
  // are read, not every deal.
  await Promise.all(
    [...attention, ...movement].map(async (item) => {
      const opp = oppByDeal.get(item.dealId);
      if (!opp) return;
      const sum = await getRolldogSummary(opp);
      if (sum && (sum.forecastCategory || sum.closeDate)) {
        item.repForecast = { category: sum.forecastCategory, closeDate: sum.closeDate };
      }
    }),
  );

  return { attention, movement, noShows };
}
