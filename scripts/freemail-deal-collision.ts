/**
 * Show which auto-created deals are consumer-mail collisions, and what a split
 * would look like.
 *
 * Auto deals were keyed `auto:<domain>`. That is right for corelogistics.net,
 * where every meeting with anyone at the company belongs on one deal. It is
 * wrong for gmail.com: small brokers and forwarders run on consumer mail, so
 * every unrelated Gmail prospect collapsed into a single deal rendered as
 * "Gmail". Their qualification fields merged into one row and the pipeline
 * counted them as one deal.
 *
 * Deal creation is fixed going forward (autoDealExternalIdForAddress). This
 * reports the damage already in the database so the split can be a decision
 * rather than a surprise.
 *
 *   npx tsx scripts/freemail-deal-collision.ts
 *   npx tsx scripts/freemail-deal-collision.ts --verbose
 *
 * READ ONLY. Prints a plan; changes nothing. Run on your Mac.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  accountFromAddress,
  autoDealExternalIdForAddress,
  isFreeMailDomain,
  INTERNAL_DOMAINS,
} from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

type Attendee = { email?: string | null; name?: string | null };

function externalAttendees(participants: unknown): Attendee[] {
  if (!Array.isArray(participants)) return [];
  return (participants as Attendee[]).filter((a) => {
    const e = (a?.email ?? "").toLowerCase();
    const d = e.split("@")[1] ?? "";
    return Boolean(d) && !INTERNAL_DOMAINS.includes(d);
  });
}

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const { data: dealData, error } = await db
    .from("deals")
    .select("id, account, external_id, rep_email")
    .eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);

  const suspect = (dealData ?? []).filter((d) => {
    const ext = d.external_id ?? "";
    if (!ext.startsWith("auto:")) return false;
    const key = ext.slice(5);
    return !key.includes("@") && isFreeMailDomain(key);
  });

  if (suspect.length === 0) {
    console.log("\nNo consumer-mail deals found. Nothing collided.\n");
    return;
  }

  console.log(`\nCONSUMER-MAIL DEAL COLLISIONS  (${suspect.length} deal record(s))\n`);
  let totalDistinct = 0;
  let dealsNeedingSplit = 0;

  for (const d of suspect) {
    const { data: calls } = await db
      .from("calls")
      .select("id, title, scheduled_start, participants, has_been_extracted")
      .eq("tenant_id", tenantId)
      .eq("deal_id", d.id)
      .order("scheduled_start", { ascending: true });

    // Group this deal's calls by the counterparty they were actually with.
    const byPerson = new Map<string, { name: string | null; calls: typeof calls }>();
    for (const c of calls ?? []) {
      const ext = externalAttendees(c.participants);
      const primary = ext[0];
      const email = (primary?.email ?? "").toLowerCase();
      if (!email) continue;
      const cur = byPerson.get(email);
      if (cur) cur.calls?.push(c);
      else byPerson.set(email, { name: primary?.name ?? null, calls: [c] });
    }

    const n = byPerson.size;
    totalDistinct += n;
    if (n > 1) dealsNeedingSplit += 1;

    const flag = n > 1 ? `  <-- ${n} UNRELATED PROSPECTS MERGED` : "";
    console.log(`${d.external_id}  "${d.account}"  [${d.rep_email ?? "no rep"}]  ${calls?.length ?? 0} call(s)${flag}`);

    for (const [email, info] of byPerson) {
      const proposedId = autoDealExternalIdForAddress(email);
      const proposedName = accountFromAddress(email, info.name);
      const extracted = (info.calls ?? []).filter((c) => c.has_been_extracted).length;
      console.log(`    ${email}`);
      console.log(`       would become:  ${proposedId}  "${proposedName}"`);
      console.log(`       calls: ${info.calls?.length ?? 0} (${extracted} extracted)`);
      if (verbose) {
        for (const c of info.calls ?? []) {
          console.log(`         ${(c.scheduled_start ?? "").slice(0, 16).replace("T", " ")}  ${c.title ?? "(untitled)"}`);
        }
      }
    }
    console.log("");
  }

  console.log("SUMMARY");
  console.log(`  consumer-mail deal records:        ${suspect.length}`);
  console.log(`  distinct prospects inside them:    ${totalDistinct}`);
  console.log(`  records holding >1 prospect:       ${dealsNeedingSplit}`);
  console.log("");
  console.log("New meetings key correctly from now on. These existing records still");
  console.log("merge their prospects, so their qualification fields are a blend of");
  console.log("unrelated conversations and the pipeline undercounts by");
  console.log(`  ${totalDistinct - suspect.length} deal(s).`);
  console.log("");
  console.log("Splitting rewrites live records Mark inspects, so it is a decision,");
  console.log("not a cleanup. The safe order is: split, re-extract each new deal from");
  console.log("its own calls, then confirm the pipeline count before the next digest.\n");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
