/**
 * The company's own context bank: facts about how this business actually sells.
 *
 *   npx tsx scripts/company-context.ts            # human readable
 *   npx tsx scripts/company-context.ts --json     # the object, to .previews/
 *   npx tsx scripts/company-context.ts --record   # WRITES a snapshot, prints the diff
 *
 * READ ONLY. Counts, spans and distributions only: no transcript text, no email
 * bodies, no customer names beyond the account label. That is deliberate and it
 * is what makes this the one derived object safe to reason over without
 * handling call content.
 *
 * FACTS, NOT VERDICTS. "84 reached a demo and 41 reached a proposal" belongs
 * here; "the demo to proposal step is a bottleneck" does not. An inference
 * written into the context becomes an input to the next inference, and two hops
 * later nobody can tell what was measured from what was asserted.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildCompanyContext, diffContext, lastCompanyContext, recordCompanyContext } from "../lib/company-context";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const slug = "magaya";
  const tenantId = await resolveTenantId(slug);
  const ctx = await buildCompanyContext(tenantId, slug);

  if (process.argv.includes("--record")) {
    // The diff is taken BEFORE the write, against the previous stored snapshot,
    // so a run reports what moved rather than comparing itself to itself.
    const prev = await lastCompanyContext(tenantId);
    const id = await recordCompanyContext(tenantId, ctx);
    console.log(`\n  snapshot ${id ? "written " + id.slice(0, 8) : "FAILED"}`);
    if (!prev) {
      console.log("  no previous snapshot: this is the first, so there is nothing to diff.\n");
      return;
    }
    const changes = diffContext(prev, ctx);
    console.log(`  ${changes.length} field(s) changed since the last snapshot\n`);
    for (const c of changes.slice(0, 40)) {
      console.log(`    ${c.path}`);
      console.log(`      was ${JSON.stringify(c.was)}`);
      console.log(`      now ${JSON.stringify(c.now)}`);
    }
    if (changes.length > 40) console.log(`\n    ...and ${changes.length - 40} more`);
    console.log("");
    return;
  }

  if (process.argv.includes("--json")) {
    mkdirSync(".previews", { recursive: true });
    const p = resolve(".previews/company-context.json");
    writeFileSync(p, JSON.stringify(ctx, null, 2), "utf8");
    console.log(`\n  written to ${p}\n`);
    return;
  }

  const L = console.log;
  L(`\n================ ${ctx.tenant.toUpperCase()} : COMPANY CONTEXT ================`);
  L(`  generated ${ctx.generatedAt.slice(0, 19)}Z\n`);

  L(`WHAT WE CAN SEE`);
  for (const c of ctx.observability.channels) {
    L(`  ${c.channel.padEnd(28)} ${String(c.rows).padStart(5)} rows   ${c.span.from ?? "?"} -> ${c.span.to ?? "?"} (${c.span.days ?? "?"}d)`);
    for (const b of c.blindSpots) L(`      blind: ${b}`);
  }
  L(`\n  first observed conversation: ${ctx.observability.firstObservedConversation}`);
  L(`  deals ever observed:         ${ctx.observability.dealsEverObserved} of ${ctx.observability.dealsTotal}`);

  L(`\nTHE BOOK`);
  L(`  deals ${ctx.book.deals}   SF-linked ${ctx.book.withSalesforceAccount}   Rolldog-linked ${ctx.book.withRolldogOpportunity}`);
  L(`  by outcome:`, ctx.book.byOutcome);
  L(`  by segment:`, ctx.book.bySegment);
  L(`  by stage:  `, ctx.book.byStage);

  L(`\nTHE MOTION`);
  L(`  captured conversations ${ctx.motion.capturedConversations}, meeting rows with none ${ctx.motion.callRowsWithoutConversation}`);
  L(`  by call type:`, ctx.motion.byCallType);
  L(`  days between consecutive calls:`, ctx.motion.daysBetweenCalls.state === "measured"
    ? `median ${ctx.motion.daysBetweenCalls.value.median}, p25 ${ctx.motion.daysBetweenCalls.value.p25}, p75 ${ctx.motion.daysBetweenCalls.value.p75} (n=${ctx.motion.daysBetweenCalls.n})`
    : `insufficient (n=${(ctx.motion.daysBetweenCalls as {n:number}).n})`);
  L(`  observed call-to-call transitions:`);
  for (const t of ctx.motion.transitions.slice(0, 12)) L(`    ${t.from.padEnd(16)} -> ${t.to.padEnd(16)} ${t.count}`);

  L(`\nTHE FRAMEWORK (${ctx.framework.fields} gates)`);
  L(`  gate                            answered  open   observed moves`);
  for (const g of [...ctx.framework.gates].sort((a, b) => b.answered - a.answered).slice(0, 40)) {
    L(`  ${g.gate.padEnd(32)} ${String(g.answered).padStart(6)}  ${String(g.open).padStart(4)}   ${String(g.observedMoves).padStart(6)}`);
  }

  L(`\nARTIFACTS`);
  L(`  documents seen ${ctx.artifacts.attachmentsSeen} on ${ctx.artifacts.dealsWithADocument} deals`, ctx.artifacts.byClassification);
  L(`  agreements ${ctx.artifacts.agreementsSeen}`, ctx.artifacts.byAgreementState);

  L(`\nWHAT WE TOLD REPS TO DO`);
  L(`  ${ctx.prescriptions.total} prescriptions, ${ctx.prescriptions.scored} scored, ${ctx.prescriptions.targetingAGate} target a gate`);
  L(`  by kind:`, ctx.prescriptions.byKind);
  L(`  followed:`, ctx.prescriptions.byFollowed);

  L(`\nPEOPLE`);
  L(`  contacts ${ctx.people.contacts}, RSVP events ${ctx.people.rsvpEventsSeen}`, ctx.people.byResponse);
  for (const s of ctx.people.schemaLimits) L(`    limit: ${s}`);
  L("");
}

main().catch((e) => { console.error("Unexpected error:", e); process.exit(1); });
