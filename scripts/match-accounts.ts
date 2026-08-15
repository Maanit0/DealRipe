/**
 * Turn a pile of Salesforce account ids into deal links.
 *
 * On a live call a rep pastes account URLs faster than anyone can say which
 * deal each belongs to. This reads the name of each account from Salesforce and
 * proposes the deal it matches, so the mapping comes from the record rather
 * than from memory.
 *
 * It proposes. It does not decide. A confident wrong link is what put Dunavant
 * on a stale account for a week, so anything short of an unambiguous name match
 * is printed for a human and skipped.
 *
 * Read-only without --apply.
 *
 *   npx tsx scripts/match-accounts.ts --accounts 001RN...,001RN...,001RN...
 *   npx tsx scripts/match-accounts.ts --accounts 001RN...  --apply
 *
 * URLs work too; ids are extracted from them.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSalesforceClient } from "../lib/salesforce";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const API = "v61.0";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Accepts bare ids or full Lightning URLs. */
function extractIds(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/[\s,]+/)) {
    if (!piece) continue;
    const m = piece.match(/(001[A-Za-z0-9]{12,15})/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Lowercase, strip punctuation and the corporate suffixes that never match. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(
      /\b(inc|llc|ltd|limited|corp|corporation|co|company|group|enterprises|holdings|international|global|logistics|sa|srl|gmbh|bv|nv)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

async function main(): Promise<void> {
  const raw = arg("--accounts") ?? "";
  const apply = process.argv.includes("--apply");
  const ids = extractIds(raw);
  if (ids.length === 0) {
    console.log("\nPass --accounts with one or more Salesforce account ids or URLs.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const res = await db
    .from("deals")
    .select("id, account, rep_email, salesforce_account_id, salesforce_link_confidence, rolldog_opportunity_id")
    .eq("tenant_id", tenantId);
  if (res.error) throw new Error(res.error.message);
  const deals = (res.data ?? []) as Array<{
    id: string; account: string; rep_email: string | null;
    salesforce_account_id: string | null; salesforce_link_confidence: string | null;
    rolldog_opportunity_id: string | null;
  }>;

  const { token, instanceUrl } = await getSalesforceClient();
  const auth = { authorization: `Bearer ${token}` };

  for (const id of ids) {
    const r = await fetch(
      `${instanceUrl}/services/data/${API}/sobjects/Account/${id}?fields=Id,Name,ParentId,Type,OwnerId`,
      { headers: auth },
    );
    if (!r.ok) {
      console.log(`\n${id}\n  Salesforce would not return this account (${r.status}). Unknown, not missing.`);
      continue;
    }
    const acct = (await r.json()) as { Id: string; Name: string; ParentId?: string | null; Type?: string };

    console.log(`\n${acct.Name}   ${acct.Id}${acct.Type ? `  (${acct.Type})` : ""}`);

    if (acct.ParentId) {
      const pr = await fetch(
        `${instanceUrl}/services/data/${API}/sobjects/Account/${acct.ParentId}?fields=Id,Name`,
        { headers: auth },
      );
      if (pr.ok) {
        const parent = (await pr.json()) as { Id: string; Name: string };
        console.log(`  child of  ${parent.Name} (${parent.Id}) -- confirm which one the history belongs on`);
      }
    }

    const target = norm(acct.Name);
    const scored = deals
      .map((d) => {
        const n = norm(d.account ?? "");
        if (!n || !target) return { d, hit: false };
        return { d, hit: n === target || n.includes(target) || target.includes(n) };
      })
      .filter((x) => x.hit);

    if (scored.length === 0) {
      console.log(`  no deal name matches. Link it by hand:`);
      console.log(`    npx tsx scripts/relink-salesforce-account.ts --deal "<name>" --account ${acct.Id} --apply`);
      continue;
    }
    if (scored.length > 1) {
      console.log(`  ${scored.length} deals match this name. That is probably duplicate deal rows:`);
      for (const s of scored) {
        console.log(
          `    ${s.d.account}  rep ${s.d.rep_email ?? "none"}  sf ${s.d.salesforce_account_id ?? "none"}  rolldog ${s.d.rolldog_opportunity_id ?? "none"}`,
        );
      }
      console.log(`  Not touching these automatically.`);
      continue;
    }

    const deal = scored[0].d;
    if (deal.salesforce_account_id === acct.Id && deal.salesforce_link_confidence === "confirmed") {
      console.log(`  ${deal.account}: already linked here, and writable.`);
      continue;
    }
    if (deal.salesforce_account_id === acct.Id) {
      // Linked but not writable. Silently skipping this was how five deals
      // ended up pointed at the right account and still refusing every write.
      console.log(
        `  ${deal.account}: already linked here, but confidence is '${deal.salesforce_link_confidence ?? "none"}', so writes are refused.`,
      );
    }
    console.log(`  ${deal.account}: ${deal.salesforce_account_id ?? "not linked"} -> ${acct.Id}`);
    if (!apply) {
      console.log(`  Dry run.`);
      continue;
    }
    // Confidence, not just the id. resolveSalesforceWriteTarget fails closed on
    // anything below 'confirmed', and rightly so: an auto-matched link put
    // Dunavant on a stale account for a week. But the evidence here is stronger
    // than the domain match that normally earns 'confirmed'. The rep whose deal
    // it is read the id off his own screen. Recording only the id would leave
    // the link true and unwritable, which is the worst of both.
    const upd = await db
      .from("deals")
      .update({ salesforce_account_id: acct.Id, salesforce_link_confidence: "confirmed" })
      .eq("id", deal.id);
    if (upd.error) {
      console.log(`  FAILED to relink: ${upd.error.message}`);
      continue;
    }
    console.log(`  Relinked, confidence 'confirmed' (a person supplied this id). Backfill with:`);
    console.log(`    npx tsx scripts/log-salesforce-calls.ts --deal "${deal.account}" --also-rolldog --apply`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
