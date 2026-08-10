/**
 * Where does each upcoming meeting live: Salesforce, Rolldog, both, or neither?
 *
 * Magaya's motion is lead in Salesforce, BDR qualifies, the lead converts to a
 * Rolldog opportunity, and the Salesforce account persists behind it. So the
 * honest states are BOTH, SF-ONLY (pre-conversion) and NEITHER (brand new, or
 * a consumer-mail prospect with no account yet).
 *
 * A fourth state, RD-ONLY, is almost never real here. It means the Rolldog
 * opportunity exists and DealRipe cannot find the Salesforce account, which is
 * a matching failure on our side rather than a gap in their CRM. Seeing it
 * called out separately is the point: those are the accounts whose contacts or
 * website need fixing before briefings can pull BDR context for them.
 *
 * The DEALRIPE column is the safety net. A meeting in NEITHER CRM but with
 * captured calls is one we already know something about; a meeting in NEITHER
 * with no calls is genuinely cold.
 *
 *   npx tsx scripts/crm-coverage.ts
 *   npx tsx scripts/crm-coverage.ts --days 14
 *
 * READ ONLY. Writes nothing.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { crosswalkRolldogOpportunityId } from "../lib/crm-crosswalk";
import { listUpcomingMeetings } from "../lib/microsoft-graph";
import {
  autoDealExternalIdForAddress,
  firstExternalAddress,
  isAutoJoinRep,
  isFreeMailDomain,
  rolldogOppIdForDeal,
} from "../lib/pilot-config";
import { searchOpportunities } from "../lib/rolldog";
import { normalizeName } from "../lib/rolldog-match";
import { getAccountContextByDomain } from "../lib/salesforce-context";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Row = {
  rep: string;
  subject: string;
  domain: string;
  sf: string | null;
  rd: string | null;
  rdSearched: boolean;
  deal: string | null;
  calls: number;
};

function stateOf(r: Row): string {
  if (r.sf && r.rd) return "BOTH";
  if (r.sf) return "SF-ONLY";
  if (r.rd) return "RD-ONLY";
  return "NEITHER";
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 7);
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const conns = await db
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  if (conns.error) throw new Error(conns.error.message);

  const rows: Row[] = [];
  const seen = new Set<string>();

  for (const c of conns.data ?? []) {
    const rep = (c.user_principal_name ?? "").toLowerCase();
    if (!rep || !isAutoJoinRep(rep)) continue;

    let meetings;
    try {
      meetings = await listUpcomingMeetings(c.id, days);
    } catch {
      continue;
    }

    for (const m of meetings) {
      const emails = (m.attendees ?? [])
        .map((a) => a.email)
        .filter((e): e is string => typeof e === "string" && e.length > 0);
      const address = firstExternalAddress(emails);
      if (!address) continue;
      const domain = address.split("@")[1] ?? "";
      const key = `${rep}|${domain}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // --- Salesforce. Never swallow the error: an unreachable Salesforce and
      // a company with no account both render as "-", and the whole point of
      // this table is telling those two apart.
      let sf: string | null = null;
      let sfError = false;
      try {
        const ctx = await getAccountContextByDomain(domain, [address]);
        sf = ctx?.accountName ?? null;
      } catch (e) {
        sfError = true;
        console.error(`   salesforce lookup failed for ${domain}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // --- DealRipe
      const externalId = autoDealExternalIdForAddress(address);
      const dealRow = await db
        .from("deals")
        .select("id, account, rolldog_opportunity_id")
        .eq("tenant_id", tenantId)
        .eq("external_id", externalId)
        .maybeSingle();
      let calls = 0;
      if (dealRow.data) {
        const cnt = await db
          .from("calls")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("deal_id", dealRow.data.id);
        calls = cnt.count ?? 0;
      }

      // --- Rolldog: the mapped id, then a name search so an unmapped but
      //     existing opportunity is reported rather than counted as absent.
      let rd =
        dealRow.data?.rolldog_opportunity_id ??
        rolldogOppIdForDeal(externalId) ??
        crosswalkRolldogOpportunityId(domain) ??
        null;
      let rdSearched = false;
      if (!rd && !isFreeMailDomain(domain)) {
        const stem = domain.split(".")[0];
        if (stem.length >= 4) {
          try {
            const hits = await searchOpportunities(stem, { pageSize: 10 });
            rdSearched = true;
            const want = normalizeName(sf ?? stem);
            const hit =
              hits.find((h) => normalizeName(h.accountName ?? "").startsWith(normalizeName(stem))) ??
              hits.find((h) => normalizeName(h.accountName ?? "") === want) ??
              null;
            if (hit) rd = `${hit.id} (unmapped)`;
          } catch {
            /* search is best-effort */
          }
        }
      }

      rows.push({
        rep,
        subject: (m.subject ?? "(untitled)").slice(0, 46),
        domain,
        sf,
        rd,
        rdSearched,
        deal: dealRow.data?.account ?? null,
        calls,
      });
    }
  }

  console.log("");
  console.log(`CRM coverage · next ${days} days · ${rows.length} external counterpart(ies)`);
  console.log("");
  console.log(
    `${"STATE".padEnd(9)}${"DOMAIN".padEnd(26)}${"SALESFORCE".padEnd(30)}${"ROLLDOG".padEnd(18)}${"DEALRIPE".padEnd(24)}MEETING`,
  );
  console.log("-".repeat(150));

  const tally = new Map<string, number>();
  for (const r of rows.sort((a, b) => stateOf(a).localeCompare(stateOf(b)) || a.domain.localeCompare(b.domain))) {
    const st = stateOf(r);
    tally.set(st, (tally.get(st) ?? 0) + 1);
    const dealCol = r.deal ? `${r.deal.slice(0, 16)} (${r.calls} call${r.calls === 1 ? "" : "s"})` : "-";
    console.log(
      `${st.padEnd(9)}${r.domain.padEnd(26)}${(r.sf ?? "-").slice(0, 28).padEnd(30)}${(r.rd ?? "-").padEnd(18)}${dealCol.padEnd(24)}${r.subject}`,
    );
  }

  console.log("");
  for (const [k, v] of [...tally.entries()].sort()) console.log(`  ${k.padEnd(9)} ${v}`);

  const rdOnly = rows.filter((r) => stateOf(r) === "RD-ONLY");
  if (rdOnly.length > 0) {
    console.log("");
    console.log("RD-ONLY means we could not find the Salesforce account, not that it is missing.");
    console.log("These accounts need a contact with a matching email domain, or a Website value:");
    for (const r of rdOnly) console.log(`   ${r.domain}`);
  }

  const cold = rows.filter((r) => stateOf(r) === "NEITHER" && r.calls === 0);
  if (cold.length > 0) {
    console.log("");
    console.log("NEITHER with no prior calls. Genuinely cold, so briefings have nothing to draw on:");
    for (const r of cold) console.log(`   ${r.domain}  ${r.subject}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
