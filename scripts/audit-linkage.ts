/**
 * Is the right email on the right deal, and does the deal agree with the CRM?
 *
 *   npx tsx scripts/audit-linkage.ts
 *   npx tsx scripts/audit-linkage.ts --deal <uuid>
 *
 * READ ONLY.
 *
 * WHY THIS RUNS BEFORE STORING MORE. Email is mapped to a deal by CUSTOMER
 * DOMAIN and nothing else: lib/email-log.ts builds domain -> deal from
 * deals.external_id ("auto:cbxglobal.com") and from calls.participants, then
 * drops any domain claimed by two deals. That is a reasonable rule with four
 * ways to be wrong, and every one of them gets worse the more content we store
 * against it:
 *
 *   AMBIGUOUS   Magaya deploys per office, so one customer is legitimately
 *               several accounts. Medov Logistics is the parent of Medov
 *               Europe. Those deals share a domain and BOTH lose their mail.
 *   FREE MAIL   skipped outright, because matching %@gmail.com once returned an
 *               unrelated company's account. Gezairi was reachable only through
 *               a gmail invite.
 *   STALE       a domain claimed from an old call keeps claiming mail after the
 *               deal is dead.
 *   CROSSED     two deals, one domain, first writer wins.
 *
 * A message on the wrong deal is worse than a message on no deal. It shows up
 * in that deal's journey, its signals and its briefing as evidence, and nothing
 * downstream can tell it apart from a real one.
 *
 * SECOND QUESTION, same shape: does the deal agree with the CRM about who the
 * customer is? A deal linked to a Salesforce account whose own domain does not
 * match the deal's is either a mislink or a parent/child split, and those need
 * different fixes.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "live.com", "aol.com", "icloud.com", "me.com", "msn.com", "proton.me", "protonmail.com",
]);
const SELLER = "magaya.com";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const domainOf = (e: string | null | undefined) => {
  const s = String(e ?? "").toLowerCase();
  const at = s.lastIndexOf("@");
  return at > 0 ? s.slice(at + 1) : null;
};

async function page<T>(table: string, cols: string, tenantId: string | null): Promise<T[]> {
  const db = supabaseAdmin() as unknown as { from: (t: string) => { select: (c: string) => unknown } };
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: unknown = db.from(table).select(cols);
    if (tenantId) q = (q as { eq: (a: string, b: string) => unknown }).eq("tenant_id", tenantId);
    q = (q as { order: (c: string, o: unknown) => unknown }).order("id", { ascending: true });
    q = (q as { range: (a: number, b: number) => unknown }).range(from, from + 999);
    const res = (await (q as Promise<{ data: T[] | null; error: { message: string } | null }>));
    if (res.error) throw new Error(`${table} read failed: ${res.error.message}`);
    const rows = res.data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const onlyDeal = arg("--deal");

  const deals = await page<{ id: string; account: string; external_id: string | null; salesforce_account_id: string | null; salesforce_link_confidence: string | null; rolldog_opportunity_id: string | null; outcome_label: string | null }>(
    "deals",
    "id, account, external_id, salesforce_account_id, salesforce_link_confidence, rolldog_opportunity_id, outcome_label",
    tenantId,
  );
  const calls = await page<{ id: string; deal_id: string; participants: unknown; call_date: string | null }>(
    "calls",
    "id, deal_id, participants, call_date",
    tenantId,
  );
  const msgs = await page<{ id: string; deal_id: string; from_email: string | null; from_domain: string | null; to_emails: string[] | null; cc_emails: string[] | null; sent_at: string | null }>(
    "deal_messages",
    "id, deal_id, from_email, from_domain, to_emails, cc_emails, sent_at",
    tenantId,
  );

  const dealById = new Map(deals.map((d) => [d.id, d]));

  // 1. Which domains does each deal legitimately own, by the same two sources
  //    the ingest uses. Rebuilt here rather than imported because the ingest
  //    builds it inside ingestMailbox and never exposes it; this is the one
  //    place that duplication is the lesser evil, and it is flagged as such.
  const domainsOfDeal = new Map<string, Set<string>>();
  const claim = (dealId: string, dom: string | null) => {
    if (!dom || dom === SELLER || FREE_MAIL.has(dom)) return;
    const s = domainsOfDeal.get(dealId) ?? new Set<string>();
    s.add(dom);
    domainsOfDeal.set(dealId, s);
  };
  for (const d of deals) {
    const ext = d.external_id ?? "";
    if (ext.startsWith("auto:")) claim(d.id, ext.slice(5).trim().toLowerCase() || null);
  }
  for (const c of calls) {
    if (!Array.isArray(c.participants)) continue;
    for (const p of c.participants as Array<{ email?: string | null }>) claim(c.deal_id, domainOf(p?.email));
  }

  // 2. Domains claimed by more than one deal. These are the collisions: the
  //    ingest drops them, so BOTH deals silently lose their mail.
  const dealsByDomain = new Map<string, string[]>();
  for (const [dealId, doms] of domainsOfDeal) {
    for (const dom of doms) dealsByDomain.set(dom, [...(dealsByDomain.get(dom) ?? []), dealId]);
  }
  const collided = [...dealsByDomain.entries()].filter(([, ds]) => ds.length > 1);

  console.log("\n================ DOMAIN COLLISIONS ================\n");
  console.log(`  distinct customer domains seen: ${dealsByDomain.size}`);
  console.log(`  domains claimed by 2+ deals:    ${collided.length}   <- the ingest DROPS these, so both deals lose all mail`);
  for (const [dom, ds] of collided.slice(0, 15)) {
    const names = ds.map((id) => dealById.get(id)?.account ?? id).join("  |  ");
    console.log(`    ${dom.padEnd(34)} ${names}`);
  }
  if (collided.length > 15) console.log(`    ...and ${collided.length - 15} more`);
  const dealsAffected = new Set(collided.flatMap(([, ds]) => ds));
  console.log(`\n  deals affected: ${dealsAffected.size}`);
  const withNoMail = [...dealsAffected].filter((id) => !msgs.some((m) => m.deal_id === id));
  console.log(`  ...of which hold ZERO email today: ${withNoMail.length}`);

  // 3. Is every stored message actually about its deal? A message whose
  //    external domains are none of the deal's known domains was attached by a
  //    rule that no longer holds.
  console.log("\n================ MESSAGE ATTRIBUTION ================\n");
  let checked = 0;
  let mismatched = 0;
  const mismatchByDeal = new Map<string, number>();
  for (const m of msgs) {
    if (onlyDeal && m.deal_id !== onlyDeal) continue;
    const own = domainsOfDeal.get(m.deal_id);
    if (!own || own.size === 0) continue;
    const involved = [m.from_email, ...(m.to_emails ?? []), ...(m.cc_emails ?? [])]
      .map(domainOf)
      .filter((d): d is string => !!d && d !== SELLER && !FREE_MAIL.has(d));
    if (involved.length === 0) continue;
    checked += 1;
    if (!involved.some((d) => own.has(d))) {
      mismatched += 1;
      mismatchByDeal.set(m.deal_id, (mismatchByDeal.get(m.deal_id) ?? 0) + 1);
    }
  }
  console.log(`  messages checked:                    ${checked}`);
  console.log(`  whose external domain is NOT one of the deal's own: ${mismatched}  (${checked ? ((mismatched / checked) * 100).toFixed(1) : 0}%)`);
  for (const [dealId, n] of [...mismatchByDeal.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    const d = dealById.get(dealId);
    const own = [...(domainsOfDeal.get(dealId) ?? [])].join(",");
    console.log(`    ${String(d?.account).slice(0, 26).padEnd(28)} ${String(n).padStart(4)} msgs   deal owns: ${own.slice(0, 50)}`);
  }

  // 4. Deals holding no email at all, split by whether that is explicable.
  console.log("\n================ DEALS WITH NO EMAIL ================\n");
  const noMail = deals.filter((d) => !msgs.some((m) => m.deal_id === d.id));
  const noDomain = noMail.filter((d) => (domainsOfDeal.get(d.id)?.size ?? 0) === 0);
  const freeMailOnly = noMail.filter((d) => {
    const fromCalls = calls
      .filter((c) => c.deal_id === d.id && Array.isArray(c.participants))
      .flatMap((c) => (c.participants as Array<{ email?: string | null }>).map((p) => domainOf(p?.email)))
      .filter((x): x is string => !!x && x !== SELLER);
    return fromCalls.length > 0 && fromCalls.every((x) => FREE_MAIL.has(x));
  });
  console.log(`  deals with no email row:        ${noMail.length} of ${deals.length}`);
  console.log(`    no customer domain known:     ${noDomain.length}   <- nothing to match on`);
  console.log(`    only free-mail contacts:      ${freeMailOnly.length}   <- deliberately skipped`);
  console.log(`    domain collision:             ${withNoMail.length}   <- FIXABLE: the domain is claimed twice`);
  console.log(
    `    other:                        ${noMail.length - noDomain.length - freeMailOnly.length - withNoMail.length}`,
  );

  // 5. Does the CRM agree about who this customer is?
  console.log("\n================ CRM AGREEMENT ================\n");
  const linked = deals.filter((d) => d.salesforce_account_id);
  const byConf = new Map<string, number>();
  for (const d of deals) byConf.set(d.salesforce_link_confidence ?? "(none)", (byConf.get(d.salesforce_link_confidence ?? "(none)") ?? 0) + 1);
  console.log(`  deals with a Salesforce account:  ${linked.length} of ${deals.length}`);
  console.log(`  by link confidence:`, Object.fromEntries(byConf));
  console.log(`  deals with a Rolldog opportunity: ${deals.filter((d) => d.rolldog_opportunity_id).length}`);
  // salesforce_link_confidence fails closed below "confirmed": an id without
  // confidence is a deal that is linked and refuses every write, silently.
  const idNoConf = deals.filter((d) => d.salesforce_account_id && d.salesforce_link_confidence !== "confirmed");
  console.log(`  linked but NOT confirmed:         ${idNoConf.length}   <- these refuse every write, silently`);
  for (const d of idNoConf.slice(0, 10)) {
    console.log(`    ${String(d.account).slice(0, 30).padEnd(32)} ${d.salesforce_link_confidence ?? "(null)"}`);
  }

  console.log(
    `\n  A message on the WRONG deal is worse than a message on no deal: it appears\n` +
      `  in that deal's journey, signals and briefings as evidence, and nothing\n` +
      `  downstream can tell it from a real one.\n`,
  );
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
