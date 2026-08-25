/**
 * Generate real briefings across several deals at different stages, so a change
 * to the briefing can be judged on output rather than on intent.
 *
 * Uses the production path: getDealContext -> briefingStateFromContext ->
 * generateBriefingFromState, with the same attendee assembly briefing-sync does.
 * A test harness that builds its own state proves nothing about what a rep gets.
 *
 *   npx tsx scripts/test-briefings.ts
 *   npx tsx scripts/test-briefings.ts --deal iff --deal dunavant
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { getDealContext, briefingStateFromContext } from "../lib/deal-context";
import { generateBriefingFromState } from "../lib/generate-briefing";
import { buildAttendeeContext } from "../lib/attendee-context";
import { shapeForCallType } from "../lib/briefing-shapes";

const args = process.argv.slice(2);
const wanted = args.reduce<string[]>((a, v, i) => (v === "--deal" ? [...a, args[i + 1]] : a), []);
const DEFAULT = ["dunavant", "iff", "ghy", "cargocleared", "ativzla"];

(async () => {
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const deals = await db.from("deals").select("id, account").eq("tenant_id", tenantId);
  const all = (deals.data ?? []) as Array<{ id: string; account: string }>;
  const picks = (wanted.length ? wanted : DEFAULT)
    .map((n) => all.find((d) => d.account.toLowerCase().includes(n.toLowerCase())))
    .filter((d): d is { id: string; account: string } => !!d);

  for (const d of picks) {
    const calls = await db
      .from("calls")
      .select("scheduled_start, participants, outcome, title, call_subtype")
      .eq("deal_id", d.id)
      .order("scheduled_start");
    const cs = (calls.data ?? []) as Array<{ scheduled_start: string; participants: unknown; outcome: string | null; title: string | null; call_subtype: string | null }>;
    const upcoming = cs.find((c) => Date.parse(c.scheduled_start) > Date.now()) ?? cs[cs.length - 1];
    const priorCaptured = cs.filter((c) => c.outcome === "captured" && c !== upcoming);
    const lastSubtype = priorCaptured[priorCaptured.length - 1]?.call_subtype ?? null;

    const ctx = await getDealContext(tenantId, d.id, { withEmailBodies: true });
    if (!ctx) { console.log(`\n${d.account}: no context`); continue; }

    const ac = buildAttendeeContext({
      thisMeeting: (Array.isArray(upcoming?.participants) ? upcoming.participants : []) as never,
      priorCallAttendees: priorCaptured.map((c) => (Array.isArray(c.participants) ? c.participants : [])) as never,
      internalDomain: "magaya.com",
    });

    // Call type: the invite title is the strongest pre-call signal, same as
    // briefing-sync. Falling back to the last captured call's subtype.
    const title = (upcoming?.title ?? "").toLowerCase();
    const type = /demo/.test(title) ? "demo" : /proposal|pricing|quote/.test(title) ? "proposal" : lastSubtype ?? "discovery";
    const shape = shapeForCallType(type);

    console.log(`\n${"=".repeat(84)}`);
    console.log(`${d.account}   stage ${ctx.effectiveStageKey}   call type "${type}"   ${shape.blocks.length} block(s), ${shape.questionBudget} ask(s)`);
    console.log(`meeting: ${upcoming?.title ?? "(none)"}  ${upcoming?.scheduled_start?.slice(0, 10) ?? ""}`);
    console.log("=".repeat(84));

    const b = await generateBriefingFromState({
      ...briefingStateFromContext(ctx),
      attendeeContext: ac.lines.join("\n"),
      meetingSubject: upcoming?.title ?? null,
      meetingDate: upcoming?.scheduled_start?.slice(0, 10) ?? null,
      callType: { type, confidence: "high", basis: "test harness" } as never,
    });
    if (!b) { console.log("  briefing generation returned nothing (lint suppressed it)"); continue; }

    const show = (k: string, v: unknown) => {
      if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return;
      console.log(`\n  ${k.toUpperCase()}`);
      if (typeof v === "string") console.log(`    ${v}`);
      else console.log(JSON.stringify(v, null, 2).split("\n").map((l) => "    " + l).join("\n"));
    };
    show("commit to", b.callObjective);
    show("if you don't", b.whatsAtRisk);
    show("in the room", b.inTheRoom);
    show("open items", b.openItems);
    show("since last contact", b.sinceLastContact);
    show("the numbers", b.theNumbers);
    show("where it stands", b.whereItStands);
    show("show this", b.showThis);
    show("ask", b.questions);
    show("fork", b.fork);
    show("do not", b.doNotDo);
    show("next step", b.nextStepCommitment);
    show("flag", b.signalFlag);
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
