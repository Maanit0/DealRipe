/**
 * Find a rep's Rolldog user id from any opportunity they own.
 *
 * REP_UID is how reconciliation attributes a captured call to the rep who ran
 * it. Steven Johnson has had no entry since the pilot began, so none of his
 * calls could ever be attributed. All he gave us is one opportunity link, which
 * is the right thing to have asked for: the owner of his own opportunity is his
 * user id.
 *
 * It does not guess field names. Rolldog's JSON:API attribute set is not
 * documented anywhere we control, so this prints every attribute that came back
 * and highlights the ones that look like a user reference. Guessing a field name
 * and reporting "not found" would be the same mistake as reading an empty
 * attendee list as "no external attendees".
 *
 * READ ONLY.
 *
 *   npx tsx scripts/rolldog-user-id.ts --opp 82443
 *   npx tsx scripts/rolldog-user-id.ts --opp 82443 --email sjohnson@magaya.com
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readOpportunity, listOpportunities, type OppSummary } from "../lib/rolldog";
import { REP_UID } from "../lib/rolldog-reconcile";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Attribute names that plausibly carry a user reference. */
const USERISH = /(owner|user|rep|assign|manage|created_?by|updated_?by|sales)/i;

/** A broad select. Rolldog ignores unknown names rather than erroring on them. */
const FIELDS = [
  "id",
  "name",
  "owner",
  "owner_id",
  "ownerId",
  "user",
  "user_id",
  "userId",
  "assigned_to",
  "assignedTo",
  "managed_by",
  "managedBy",
  "sales_rep",
  "salesRep",
  "created_by",
  "createdBy",
  "account",
  "account_id",
  "stage",
  "amount",
] as const;

function flatten(obj: unknown, prefix = "", out: Array<[string, string]> = []): Array<[string, string]> {
  if (obj === null || obj === undefined) return out;
  if (typeof obj !== "object") {
    out.push([prefix || "(root)", String(obj)]);
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/**
 * Find one opportunity through the unscoped listing. Rolldog's filter support is
 * not documented anywhere we control, so several forms are tried and the one
 * that worked is named. A form that 400s is reported rather than swallowed:
 * "this filter is unsupported" and "no such opportunity" are different answers.
 */
async function viaListing(opp: string): Promise<OppSummary | null> {
  const attempts: Array<[string, string]> = [
    ["filter[id]", `filter[id]=${encodeURIComponent(opp)}&page[size]=5`],
    ["filter[opportunity-id]", `filter[opportunity-id]=${encodeURIComponent(opp)}&page[size]=5`],
    ["filter[search]", `filter[search]=${encodeURIComponent(opp)}&page[size]=20`],
  ];
  for (const [label, q] of attempts) {
    try {
      const rows = await listOpportunities(q);
      const hit = rows.find((r) => String(r.id) === String(opp));
      if (hit) {
        console.log(`  found via ${label}`);
        return hit;
      }
      console.log(`  ${label}: returned ${rows.length} row(s), none with id ${opp}`);
    } catch (e) {
      console.log(`  ${label}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  }
  console.log(`\n  No listing form returned opportunity ${opp}.`);
  console.log(`  That is "not found by these filters", not "does not exist".`);
  console.log(`  Open the opportunity in Rolldog and read the owner from the UI instead.\n`);
  return null;
}

function report(opp: string, s: OppSummary, email: string): void {
  console.log(`\nOpportunity ${opp}`);
  console.log(`  ${s.name}${s.accountName ? `  ·  ${s.accountName}` : ""}`);
  console.log(`  stage        ${s.stageName ?? "(none)"}`);
  console.log(`  user-id      ${s.owner ?? "(none returned)"}`);

  const known = Object.entries(REP_UID);
  if (known.length > 0) {
    console.log(`\n  Already mapped, for shape comparison:\n`);
    for (const [e, id] of known) console.log(`    ${e.padEnd(30)} ${id}`);
  }

  if (!s.owner) {
    console.log(`\n  No user-id on this record. Not the same as "no owner"; the summary`);
    console.log(`  simply did not carry the attribute. Read it from the Rolldog UI.\n`);
    return;
  }
  const clash = known.find(([, id]) => String(id) === String(s.owner));
  if (clash) {
    console.log(`\n  WARNING: ${s.owner} is already mapped to ${clash[0]}.`);
    console.log(`  This opportunity is not owned by the rep you are looking up.\n`);
    return;
  }
  if (email) {
    console.log(`\n  Add to REP_UID in lib/rolldog-reconcile.ts, then deploy:\n`);
    console.log(`    "${email}": ${s.owner},   // owner of opportunity ${opp}`);
  }
  console.log(`\n  Verify with: npx tsx scripts/preflight-reps.ts\n`);
}

async function main(): Promise<void> {
  const opp = arg("--opp");
  const email = (arg("--email") ?? "").toLowerCase();
  if (!opp) {
    console.log("\nPass --opp <rolldog opportunity id>. Optionally --email <rep> to print the REP_UID line.\n");
    process.exit(1);
  }

  let attrs: Record<string, unknown>;
  try {
    attrs = await readOpportunity(opp, FIELDS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Scope refusal and a genuinely missing record are different problems.
    // A refusal is expected here and is not a dead end: listOpportunities is
    // deliberately unscoped, returns only summary metadata, and carries the
    // user-id we are after. So fall through to it rather than widening
    // PILOT_OPPORTUNITY_IDS, which is a write boundary and should not be
    // touched to satisfy a lookup.
    if (/PILOT_OPPORTUNITY_IDS|scope|allowlist|authoriz/i.test(msg)) {
      console.log(`\nDirect read refused by scope, which is correct. Falling back to the`);
      console.log(`unscoped summary listing, which carries user-id.\n`);
      const summary = await viaListing(opp);
      if (!summary) process.exit(1);
      report(opp, summary, email);
      return;
    }
    console.log(`\nCould not read opportunity ${opp}.`);
    console.log(`  ${msg}`);
    console.log(`\nThis is "could not read", not "does not exist". Nothing was concluded.\n`);
    process.exit(1);
  }

  const flat = flatten(attrs);
  const userish = flat.filter(([k]) => USERISH.test(k));

  console.log(`\nOpportunity ${opp}`);
  const name = flat.find(([k]) => k === "name" || k.endsWith(".name"));
  if (name) console.log(`  ${name[1]}`);

  if (userish.length === 0) {
    console.log(`\n  No attribute on this record looks like a user reference.`);
    console.log(`  That is not "the opportunity has no owner". Every attribute returned:\n`);
    for (const [k, v] of flat) console.log(`    ${k.padEnd(34)} ${v}`);
    console.log("");
    return;
  }

  console.log(`\n  Candidates:\n`);
  for (const [k, v] of userish) console.log(`    ${k.padEnd(34)} ${v}`);

  // Numeric ids in the same range as the ones already mapped are the likeliest
  // answer, so show what a known-good value looks like for comparison.
  const known = Object.entries(REP_UID);
  if (known.length > 0) {
    console.log(`\n  Already mapped, for shape comparison:\n`);
    for (const [e, id] of known) console.log(`    ${e.padEnd(34)} ${id}`);
  }

  const numeric = userish.filter(([, v]) => /^\d{1,6}$/.test(v));
  if (numeric.length === 1 && email) {
    // REP_UID is a map in lib/rolldog-reconcile.ts, not an env var, so this is
    // a code change and a deploy rather than a Vercel setting.
    console.log(`\n  Add to REP_UID in lib/rolldog-reconcile.ts, then deploy:\n`);
    console.log(`    "${email}": ${numeric[0][1]},   // from opportunity ${opp}, field ${numeric[0][0]}`);
  } else if (email) {
    console.log(`\n  More than one numeric candidate, so pick by hand rather than let this guess.`);
  }

  console.log(`\n  Verify with: npx tsx scripts/preflight-reps.ts\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
