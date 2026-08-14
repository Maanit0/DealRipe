/**
 * What does Magaya actually maintain in Salesforce?
 *
 * Every field decision so far came from a list of twenty-one Account fields I
 * read out of one validation rule formula. That is not their schema, it is one
 * rule's opinion of their schema, and it says nothing about Opportunity or Lead
 * at all. Choosing what to extract from a partial list means extracting into
 * whatever we happened to see, which is the opposite of the intent: the
 * extraction should be derived from what this customer keeps up to date.
 *
 * So this enumerates every writeable custom field on Account, Opportunity and
 * Lead, then measures how often each one is actually populated across their
 * real records, and ranks by that. A field their reps fill on 60% of accounts
 * is worth extracting. A field at 0% is a field nobody reads, whatever its
 * name suggests.
 *
 * It also prints the type and, for picklists, the exact allowed values, because
 * those belong in the extraction prompt. Accounting_System_Used accepts
 * "Cargowise" and not "they use Cargowise", so a question that does not carry
 * the vocabulary produces answers Salesforce will silently reject.
 *
 * Three things it is careful about:
 *
 *   A checkbox that is false is indistinguishable from one never set. Booleans
 *   are counted as "ticked" rather than "filled", and reported separately, so a
 *   50% checkbox is not read as a well-maintained field.
 *
 *   A query that fails is reported as unreadable, never as zero.
 *
 *   Formula and rollup fields are excluded. They are populated by Salesforce
 *   and would look like diligent rep behaviour while being nothing of the kind.
 *
 * READ ONLY.
 *
 *   npx tsx scripts/salesforce-schema-survey.ts
 *   npx tsx scripts/salesforce-schema-survey.ts --object Opportunity
 *   npx tsx scripts/salesforce-schema-survey.ts --min 20      # only >=20% filled
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSalesforceClient } from "../lib/salesforce";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const API = "v61.0";
/** SOQL in a URL has a length ceiling, so field lists are queried in chunks. */
const FIELDS_PER_QUERY = 80;
const MAX_RECORDS = 500;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type FieldDesc = {
  name: string;
  label: string;
  type: string;
  custom: boolean;
  updateable: boolean;
  calculated: boolean;
  autoNumber?: boolean;
  length?: number;
  picklistValues?: Array<{ value: string; active: boolean }>;
};

async function main(): Promise<void> {
  const only = arg("--object");
  const minPct = Number(arg("--min") ?? "0");
  const { token, instanceUrl } = await getSalesforceClient();
  const auth = { authorization: `Bearer ${token}` };

  const q = async <T>(soql: string): Promise<T[] | null> => {
    let url: string | null = `${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`;
    const out: T[] = [];
    while (url && out.length < MAX_RECORDS) {
      const r: Response = await fetch(url, { headers: auth });
      if (!r.ok) return null;
      const j = (await r.json()) as { records?: T[]; nextRecordsUrl?: string; done?: boolean };
      out.push(...(j.records ?? []));
      url = j.done === false && j.nextRecordsUrl ? `${instanceUrl}${j.nextRecordsUrl}` : null;
    }
    return out;
  };

  // Which records to measure against. Accounts are the ones DealRipe is linked
  // to, since those are the ones a write would touch. Opportunities and Leads
  // are the most recent, because a field's fill rate five years ago says
  // nothing about whether the team maintains it now.
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");
  const dealsRes = await db
    .from("deals")
    .select("salesforce_account_id")
    .eq("tenant_id", tenantId)
    .not("salesforce_account_id", "is", null);
  const accountIds = ((dealsRes.data ?? []) as Array<{ salesforce_account_id: string }>)
    .map((d) => d.salesforce_account_id)
    .filter(Boolean);

  const targets: Array<{ object: string; where: string; note: string }> = [
    {
      object: "Account",
      where: accountIds.length > 0 ? `Id IN (${accountIds.map((i) => `'${i}'`).join(",")})` : "CreatedDate = LAST_N_DAYS:365",
      note: accountIds.length > 0 ? `${accountIds.length} accounts DealRipe is linked to` : "accounts created in the last year",
    },
    {
      object: "Opportunity",
      where: "CreatedDate = LAST_N_DAYS:365",
      note: "opportunities created in the last year",
    },
    {
      object: "Lead",
      where: "CreatedDate = LAST_N_DAYS:365",
      note: "leads created in the last year",
    },
  ].filter((t) => !only || t.object.toLowerCase() === only.toLowerCase());

  for (const t of targets) {
    console.log(`\n${"=".repeat(84)}`);
    console.log(`${t.object.toUpperCase()}  (measured across ${t.note})`);
    console.log(`${"=".repeat(84)}`);

    const dres = await fetch(`${instanceUrl}/services/data/${API}/sobjects/${t.object}/describe`, { headers: auth });
    if (!dres.ok) {
      console.log(`  COULD NOT DESCRIBE (${dres.status}). That is not "no fields".`);
      continue;
    }
    const all = ((await dres.json()) as { fields?: FieldDesc[] }).fields ?? [];

    // Only fields a human or DealRipe could fill. Formula and rollup fields are
    // Salesforce's own work and would masquerade as rep diligence.
    const candidates = all.filter(
      (f) => f.custom && f.updateable && !f.calculated && !f.autoNumber && f.type !== "reference",
    );
    if (candidates.length === 0) {
      console.log(`  No writeable custom fields visible on ${t.object}.`);
      continue;
    }

    // Fetch in chunks; a hundred field names in one SOQL blows the URL limit.
    const filled = new Map<string, number>();
    const boolTrue = new Map<string, number>();
    let total = 0;
    let unreadable = 0;

    for (let i = 0; i < candidates.length; i += FIELDS_PER_QUERY) {
      const chunk = candidates.slice(i, i + FIELDS_PER_QUERY);
      const soql = `SELECT Id, ${chunk.map((f) => f.name).join(", ")} FROM ${t.object} WHERE ${t.where} LIMIT ${MAX_RECORDS}`;
      const rows = await q<Record<string, unknown>>(soql);
      if (rows === null) {
        unreadable += chunk.length;
        for (const f of chunk) filled.set(f.name, -1);
        continue;
      }
      total = Math.max(total, rows.length);
      for (const f of chunk) {
        let n = 0;
        let t2 = 0;
        for (const r of rows) {
          const v = r[f.name];
          if (v === null || v === undefined || v === "") continue;
          if (typeof v === "boolean") {
            if (v) t2 += 1;
            continue;
          }
          n += 1;
        }
        filled.set(f.name, n);
        boolTrue.set(f.name, t2);
      }
    }

    if (total === 0) {
      console.log(`  No records matched, so nothing can be said about fill rates.`);
      continue;
    }
    console.log(`  ${candidates.length} writeable custom field(s), measured over ${total} record(s).`);
    if (unreadable > 0) console.log(`  ${unreadable} field(s) could not be read. Those are unknown, not empty.\n`);

    const scored = candidates
      .map((f) => {
        const isBool = f.type === "boolean";
        const count = isBool ? (boolTrue.get(f.name) ?? 0) : (filled.get(f.name) ?? 0);
        return { f, count, isBool, pct: count < 0 ? -1 : Math.round((count / total) * 100) };
      })
      .filter((s) => s.pct < 0 || s.pct >= minPct)
      .sort((a, b) => b.pct - a.pct);

    for (const s of scored) {
      if (s.pct < 0) {
        console.log(`  ????  ${s.f.label.padEnd(40)} ${s.f.name}   COULD NOT READ`);
        continue;
      }
      const bar = "#".repeat(Math.round(s.pct / 5)).padEnd(20, ".");
      const kind = s.isBool ? "ticked" : "filled";
      console.log(
        `  ${bar} ${String(s.pct).padStart(3)}% ${kind}  ${s.f.label.slice(0, 38).padEnd(38)} ` +
          `${s.f.name}  [${s.f.type}${s.f.length ? `(${s.f.length})` : ""}]`,
      );
      const picks = (s.f.picklistValues ?? []).filter((p) => p.active).map((p) => p.value);
      if (picks.length > 0 && s.pct > 0) {
        // The vocabulary belongs in the extraction prompt. Printed in full for
        // the fields worth extracting, because a truncated list produces a
        // question that quietly cannot answer correctly.
        console.log(`        allowed: ${picks.join(" | ")}`);
      }
    }

    const boolCount = scored.filter((s) => s.isBool).length;
    if (boolCount > 0) {
      console.log(
        `\n  ${boolCount} of these are checkboxes. "ticked" counts only true, because false and\n` +
          `  never-set are the same value in Salesforce. A checkbox at 20% is not a field\n` +
          `  filled 20% of the time; it is a field that is true 20% of the time.`,
      );
    }
  }

  console.log(`\n${"=".repeat(84)}`);
  console.log(`Read the top of each list. Those are the fields this team keeps current, and`);
  console.log(`they are what DealRipe should be filling. Anything at 0% is a field nobody has`);
  console.log(`ever used, whatever its name promises.`);
  console.log(`${"=".repeat(84)}\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  let cause: unknown = (e as { cause?: unknown })?.cause;
  while (cause) {
    const c = cause as { message?: string; code?: string; cause?: unknown };
    console.error(`  caused by: ${c.code ?? ""} ${c.message ?? String(cause)}`);
    cause = c.cause;
  }
  console.error("");
  process.exit(1);
});
