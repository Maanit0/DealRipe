/**
 * The prescription ledger, read back.
 *
 *   npx tsx scripts/prescription-report.ts --rep ebencomo@magaya.com
 *   npx tsx scripts/prescription-report.ts --deal "Diamond Forwarding"
 *   npx tsx scripts/prescription-report.ts --deal "Diamond Forwarding" --why
 *   npx tsx scripts/prescription-report.ts --rep ebencomo@magaya.com --days 30
 *
 * --rep   per rep: follow-through rate, and the outcome rate for followed
 *         versus not followed. The second number is the interesting one: a
 *         follow-through rate on its own says whether reps use the briefing,
 *         but followed-versus-not says whether it was worth using.
 * --deal  every prescription on one deal, with its evidence.
 * --why   on --deal, ask the production outcome readers why an unknown is
 *         unknown. Costs a mailbox read per call, so it is off by default.
 *
 * READ ONLY. Writes nothing, ever.
 *
 * Every rule this prints is imported from the code that produced the rows:
 * the tri-state columns come from lib/prescription-scoring.ts, the reasons
 * from lib/prescription-outcomes.ts, the rep mapping from lib/pilot-config.ts.
 * Nothing here restates a rule. A checker that can disagree with the code it
 * checks will, and it will do so confidently.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import type { PrescriptionKind, Tristate } from "../lib/database.types";
import { ledgerError } from "../lib/prescription-ledger";
import {
  readCallOutcomes,
  repEmailFor,
  type OutcomeCall,
} from "../lib/prescription-outcomes";
import {
  OUTCOME_REFRESH_DAYS,
  OUTCOME_SETTLE_DAYS,
} from "../lib/prescription-scoring";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

type Row = {
  id: string;
  deal_id: string;
  call_id: string;
  issued_at: string;
  kind: PrescriptionKind;
  text: string;
  source: string;
  followed: Tristate;
  followed_evidence: string | null;
  scored_at: string | null;
  outcome_next_meeting: Tristate;
  outcome_draft_sent: Tristate;
  outcome_stage_moved: Tristate;
  framework_field_keys: string[] | null;
  email_checked_at: string | null;
};

type DealRow = { id: string; account: string; external_id: string | null; rep_email: string | null };
type CallRow = {
  id: string;
  deal_id: string;
  scheduled_start: string | null;
  call_date: string | null;
  title: string | null;
  outcome: string | null;
  participants: unknown;
  meeting_type: string | null;
  call_subtype: string | null;
};

/**
 * What kind of call this was, as one label.
 *
 * An existing customer is its own category regardless of subtype: a kickoff or
 * a contract review is not a sales call and a new-business question aimed at
 * one was wrong before the rep ever opened their mouth.
 */
function callType(c: CallRow | undefined): string {
  if (!c) return "unknown";
  if (c.meeting_type === "existing_customer") return "existing_customer";
  return c.call_subtype ?? c.meeting_type ?? "unclassified";
}

const SELECT =
  "id, deal_id, call_id, issued_at, kind, text, source, followed, followed_evidence, scored_at, " +
  "email_checked_at, outcome_next_meeting, outcome_draft_sent, outcome_stage_moved, framework_field_keys";

/**
 * A rate that reports its own denominator, and never counts an unknown as a
 * negative. "3 of 8" and "3 of 8, 5 not checked" are different claims about a
 * rep and only one of them is fair.
 */
function rate(rows: ReadonlyArray<Tristate>): string {
  const yes = rows.filter((v) => v === "yes").length;
  const no = rows.filter((v) => v === "no").length;
  const unknown = rows.filter((v) => v === "unknown").length;
  const decided = yes + no;
  if (decided === 0) return `no data (${unknown} not checked)`;
  const pct = Math.round((yes / decided) * 100);
  return `${pct}% (${yes}/${decided})${unknown > 0 ? `, ${unknown} not checked` : ""}`;
}

function shortDate(iso: string | null): string {
  if (!iso) return "?";
  return iso.slice(0, 10);
}

async function main(): Promise<void> {
  const repArg = arg("--rep");
  const dealArg = arg("--deal");
  const days = Number(arg("--days") ?? 90);
  if (!repArg && !dealArg) {
    console.log("Usage: --rep <email> | --deal <name>  [--days N] [--why]");
    process.exit(1);
  }

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rep_email")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(`deals read failed: ${dealsRes.error.message}`);
  const allDeals = (dealsRes.data ?? []) as DealRow[];

  let deals: DealRow[];
  if (dealArg) {
    const needle = dealArg.toLowerCase();
    deals = allDeals.filter(
      (d) =>
        d.account.toLowerCase().includes(needle) ||
        (d.external_id ?? "").toLowerCase().includes(needle),
    );
    if (deals.length === 0) {
      console.log(`No deal matching "${dealArg}".`);
      return;
    }
  } else {
    const rep = (repArg ?? "").trim().toLowerCase();
    deals = allDeals.filter(
      (d) => repEmailFor({ repEmail: d.rep_email, dealExternalId: d.external_id }) === rep,
    );
    if (deals.length === 0) {
      console.log(`No deals for ${rep}.`);
      return;
    }
  }

  const rowsRes = await db
    .from("prescribed_actions")
    .select(SELECT)
    .eq("tenant_id", tenantId)
    .in("deal_id", deals.map((d) => d.id))
    .gte("issued_at", since)
    .order("issued_at", { ascending: true });
  if (rowsRes.error) throw new Error(ledgerError(`ledger read failed: ${rowsRes.error.message}`));
  const rows = (rowsRes.data ?? []) as unknown as Row[];

  if (rows.length === 0) {
    console.log(
      `No prescriptions in the last ${days} days for ${dealArg ?? repArg}. ` +
        `The ledger fills from briefings issued after supabase/add-prescription-ledger.sql was applied, ` +
        `plus whatever scripts/backfill-prescriptions.ts recovered.`,
    );
    return;
  }

  const callsRes = await db
    .from("calls")
    .select("id, deal_id, scheduled_start, call_date, title, outcome, participants, meeting_type, call_subtype")
    .in("id", [...new Set(rows.map((r) => r.call_id))]);
  if (callsRes.error) throw new Error(`calls read failed: ${callsRes.error.message}`);
  const calls = new Map(((callsRes.data ?? []) as CallRow[]).map((c) => [c.id, c]));
  const dealById = new Map(deals.map((d) => [d.id, d]));

  if (dealArg) {
    await printDeal(rows, calls, dealById, tenantId);
  } else {
    printRep(repArg as string, rows, calls, dealById, days);
  }
}

// =====================================================================
// --rep
// =====================================================================

function printRep(
  rep: string,
  rows: ReadonlyArray<Row>,
  calls: Map<string, CallRow>,
  dealById: Map<string, DealRow>,
  days: number,
): void {
  console.log(`\nPRESCRIPTION LEDGER  ${rep}  last ${days} days\n`);

  const scored = rows.filter((r) => r.scored_at !== null);
  const awaiting = rows.filter((r) => r.scored_at === null);

  console.log(`  prescriptions issued     ${rows.length} across ${new Set(rows.map((r) => r.call_id)).size} call(s)`);
  console.log(`  follow-through           ${rate(rows.map((r) => r.followed))}`);
  if (awaiting.length > 0) {
    console.log(`  still unscored           ${awaiting.length} (no transcript yet, or the scorer has not run)`);
  }

  // By kind, because "did the rep ask the question" and "did the rep secure the
  // next step" are different skills and a single blended rate hides which one
  // is the problem.
  const kinds = [...new Set(rows.map((r) => r.kind))];
  if (kinds.length > 1) {
    console.log(`\n  by kind`);
    for (const k of kinds) {
      const of = rows.filter((r) => r.kind === k);
      console.log(`    ${k.padEnd(16)} ${rate(of.map((r) => r.followed))}`);
    }
    // A commitment can be secured after the call, so its rate is only fair
    // once the rep's mail has been searched. Say how much of it has been.
    const commitments = rows.filter((r) => r.kind === "end_commitment");
    const unchecked = commitments.filter(
      (r) => r.followed === "no" && r.email_checked_at === null,
    ).length;
    const byEmail = rows.filter((r) => (r.followed_evidence ?? "").startsWith("[email]")).length;
    if (commitments.length > 0) {
      // Named explicitly rather than indented under whichever kind happened to
      // print last, which read as though it described the questions.
      console.log(
        `    end commitments secured by email after the call: ${byEmail}` +
          (unchecked > 0
            ? `, ${unchecked} whose email has not been searched yet (call still inside the ${OUTCOME_SETTLE_DAYS} day settle window, or the mailbox could not be read)`
            : ""),
      );
    }
  }

  // BY CALL TYPE, and this is the block to read first.
  //
  // The first run of the ledger showed follow-through at 25% on discovery
  // calls and 0% on demos, proposals and existing-customer calls. That is not
  // a rep who stops trying after discovery. It is briefings issuing
  // first-discovery questions to a customer mid-implementation and to a demo
  // that ends "appreciate the demo". A low number here on a late-stage or
  // existing-customer row is evidence about the BRIEFING, not the rep, and
  // reading it the other way would blame six people for our own bug.
  const byType = new Map<string, Tristate[]>();
  const callsOfType = new Map<string, Set<string>>();
  for (const r of rows) {
    const t = callType(calls.get(r.call_id));
    byType.set(t, [...(byType.get(t) ?? []), r.followed]);
    callsOfType.set(t, (callsOfType.get(t) ?? new Set()).add(r.call_id));
  }
  if (byType.size > 1) {
    console.log(`\n  BY CALL TYPE`);
    const ordered = [...byType.entries()].sort((a, b) => {
      const score = (v: Tristate[]) => {
        const d = v.filter((x) => x !== "unknown").length;
        return d === 0 ? -1 : v.filter((x) => x === "yes").length / d;
      };
      return score(b[1]) - score(a[1]);
    });
    for (const [t, vals] of ordered) {
      console.log(
        `    ${t.padEnd(20)} ${String(callsOfType.get(t)?.size ?? 0).padStart(2)} call(s)   ${rate(vals)}`,
      );
    }
    console.log(
      `    A low rate on demo, proposal or existing_customer usually means the briefing asked\n` +
        `    for the wrong things, not that the rep ignored it. Check one before drawing a conclusion.`,
    );
  }

  // The point of the whole ledger: does following the prescription change what
  // happens. Only rows we actually scored can appear here.
  const followed = scored.filter((r) => r.followed === "yes");
  const notFollowed = scored.filter((r) => r.followed === "no");

  console.log(`\n  OUTCOME RATE, followed versus not`);
  console.log(`    ${"".padEnd(20)} ${"followed".padEnd(28)} not followed`);
  const outcomes: Array<[string, (r: Row) => Tristate]> = [
    ["next meeting", (r) => r.outcome_next_meeting],
    ["rep emailed", (r) => r.outcome_draft_sent],
    ["CRM stage moved", (r) => r.outcome_stage_moved],
  ];
  for (const [label, get] of outcomes) {
    console.log(
      `    ${label.padEnd(20)} ${rate(followed.map(get)).padEnd(28)} ${rate(notFollowed.map(get))}`,
    );
  }

  console.log(
    `\n  Outcomes are written once a call is ${OUTCOME_SETTLE_DAYS} days old and refreshed until it is ` +
      `${OUTCOME_REFRESH_DAYS} days old. "not checked" is not a zero: it means we did not look, ` +
      `usually because the rep has no connected calendar, the mailbox could not be read, or the deal has no ` +
      `Rolldog opportunity. Read it as missing data, never as a rep who did nothing.`,
  );

  // Worst first, since that is what a manager acts on.
  const missed = notFollowed.slice(0, 8);
  if (missed.length > 0) {
    console.log(`\n  ISSUED AND NOT DONE`);
    for (const r of missed) {
      const c = calls.get(r.call_id);
      const d = dealById.get(r.deal_id);
      console.log(
        `    ${shortDate(c?.scheduled_start ?? c?.call_date ?? r.issued_at)}  ${(d?.account ?? "?").padEnd(24)} ${r.text}`,
      );
    }
  }
  console.log("");
}

// =====================================================================
// --deal
// =====================================================================

async function printDeal(
  rows: ReadonlyArray<Row>,
  calls: Map<string, CallRow>,
  dealById: Map<string, DealRow>,
  tenantId: string,
): Promise<void> {
  const why = flag("--why");
  const byCall = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byCall.get(r.call_id);
    if (list) list.push(r);
    else byCall.set(r.call_id, [r]);
  }

  for (const [callId, callRows] of byCall) {
    const c = calls.get(callId);
    const d = dealById.get(callRows[0].deal_id);
    const when = shortDate(c?.scheduled_start ?? c?.call_date ?? callRows[0].issued_at);
    console.log(`\n${"=".repeat(78)}`);
    console.log(`${d?.account ?? "?"}  ${when}  ${c?.title ?? "(no title)"}`);
    if (c?.outcome) console.log(`call outcome: ${c.outcome}`);
    console.log(`${"=".repeat(78)}`);

    for (const r of callRows) {
      const mark =
        r.followed === "yes" ? "DONE    " : r.followed === "no" ? "NOT DONE" : "UNKNOWN ";
      console.log(`\n  [${mark}] ${r.kind}  (${r.source}, issued ${shortDate(r.issued_at)})`);
      console.log(`    ${r.text}`);
      if (r.framework_field_keys?.length) {
        console.log(`    targets: ${r.framework_field_keys.join(", ")}`);
      } else {
        // Say which of the two this is. A backfilled row genuinely cannot know.
        console.log(`    targets: not recorded (row recovered from the sent email, which carries no field ids)`);
      }
      if (r.followed === "yes" && r.followed_evidence) {
        console.log(`    evidence: "${r.followed_evidence}"`);
      }
      if (r.followed === "no") {
        console.log(`    evidence: none found in the transcript`);
      }
      if (r.followed === "unknown") {
        console.log(
          `    evidence: not checked${r.scored_at ? " (call had no conversation to score against)" : " (not scored yet)"}`,
        );
      }
    }

    const head = callRows[0];
    console.log(
      `\n  outcomes: next meeting ${head.outcome_next_meeting}, rep emailed ${head.outcome_draft_sent}, ` +
        `CRM stage moved ${head.outcome_stage_moved}`,
    );

    if (why && c) {
      const at = c.scheduled_start ?? c.call_date;
      if (!at) {
        console.log(`  why: the call has no date, so no outcome can be read`);
        continue;
      }
      // Production readers, not a local re-derivation.
      const call: OutcomeCall = {
        tenantId,
        callId,
        dealId: head.deal_id,
        at,
        participants: c.participants,
        repEmail: d?.rep_email ?? null,
        dealExternalId: d?.external_id ?? null,
      };
      const o = await readCallOutcomes(call);
      console.log(`  why next meeting:  ${o.nextMeeting.value}  ${o.nextMeeting.reason}`);
      console.log(`  why rep emailed:   ${o.draftSent.value}  ${o.draftSent.reason}`);
      console.log(`  why stage moved:   ${o.stageMoved.value}  ${o.stageMoved.reason}`);
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
