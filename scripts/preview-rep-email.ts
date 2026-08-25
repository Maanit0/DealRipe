/**
 * Render the email a rep actually receives, from a REAL generated briefing.
 *
 * Not a hand-written fixture. An earlier version of this used one and it was
 * thin by construction, so the layout got judged on content that no rep would
 * ever see. This runs the production path and renders the result.
 *
 *   npx tsx scripts/preview-rep-email.ts --deal dunavant
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { getDealContext, briefingStateFromContext } from "../lib/deal-context";
import { generateBriefingFromState } from "../lib/generate-briefing";
import { buildAttendeeContext } from "../lib/attendee-context";
import { briefingRoster } from "../lib/attendees";
import { buildCoachingContext, coachingLinesForBriefing } from "../lib/coaching";
import { computeDealFlags, renderFlagsForBriefing } from "../lib/deal-flags";
import { assessDeal, computeBuyerSignals } from "../lib/deal-signals-buyer";
import { resolvePreCallType } from "../lib/call-type-precall";
import { renderPreCallBriefingEmail } from "../lib/emails/pre-call-briefing";

const argv = process.argv.slice(2);
const names = argv.reduce<string[]>((a, v, i) => (v === "--deal" ? [...a, argv[i + 1]] : a), []);

(async () => {
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const deals = await db.from("deals").select("id, account, rep_email").eq("tenant_id", tenantId);
  const all = (deals.data ?? []) as Array<{ id: string; account: string; rep_email: string | null }>;
  const picks = (names.length ? names : ["dunavant", "cargocleared"])
    .map((n) => all.find((d) => d.account.toLowerCase().includes(n.toLowerCase())))
    .filter((d): d is (typeof all)[number] => !!d);

  const parts: string[] = [];
  for (const d of picks) {
    const calls = await db
      .from("calls")
      .select("scheduled_start, participants, outcome, title")
      .eq("deal_id", d.id)
      .order("scheduled_start");
    const cs = (calls.data ?? []) as Array<{ scheduled_start: string; participants: unknown; outcome: string | null; title: string | null }>;
    const meeting = cs.find((c) => Date.parse(c.scheduled_start) > Date.now()) ?? cs[cs.length - 1];
    const ctx = await getDealContext(tenantId, d.id, { withEmailBodies: true });
    if (!ctx || !meeting) continue;
    const callType = await resolvePreCallType({ tenantId, dealId: d.id, subject: meeting.title, beforeIso: meeting.scheduled_start });
    const ac = buildAttendeeContext({
      thisMeeting: (Array.isArray(meeting.participants) ? meeting.participants : []) as never,
      priorCallAttendees: cs.filter((c) => c.outcome === "captured" && c !== meeting).map((c) => (Array.isArray(c.participants) ? c.participants : [])) as never,
      internalDomain: "magaya.com",
    });
    process.stdout.write(`  ${d.account.padEnd(20)} ${callType.type.padEnd(14)} `);
    const coaching = await buildCoachingContext({ tenantId, dealId: d.id, repEmail: d.rep_email });
    // THE MEASURED FLAGS, exactly as briefing-sync passes them.
    //
    // Without these the preview cannot produce a signalFlag at all, because the
    // prompt forbids inventing one, so every previewed briefing came back with
    // an empty signal box and looked like the feature had been removed. A
    // preview that omits an input the production path supplies is not a
    // preview of the production path.
    let dealFlags: string | null = null;
    try {
      const signals = await computeBuyerSignals({ tenantId, dealId: d.id });
      dealFlags = renderFlagsForBriefing(computeDealFlags({ signals, assessment: assessDeal(signals) }));
    } catch (err) {
      console.log(`(flags unavailable: ${err instanceof Error ? err.message : String(err)})`);
    }
    process.stdout.write(`coaching:${coaching.status} `);
    const b = await generateBriefingFromState({
      ...briefingStateFromContext(ctx),
      attendeeContext: ac.lines.join("\n"),
      coachingContext: coachingLinesForBriefing(coaching),
      dealFlags,
      meetingSubject: meeting.title,
      meetingDate: meeting.scheduled_start?.slice(0, 10) ?? null,
      callType,
    });
    if (!b) { console.log("SUPPRESSED"); continue; }
    console.log("rendered");
    const email = renderPreCallBriefingEmail(b, {
      account: d.account,
      stageKey: ctx.effectiveStageKey,
      attendees: ctx.attendees,
      roster: briefingRoster({
        meetingAttendees: (Array.isArray(meeting.participants) ? meeting.participants : []) as never,
        crmContacts: ctx.crmContacts,
        dealContacts: ctx.contacts,
      }),
      callType: callType.type,
      minutesUntil: 35,
    });
    parts.push(email.html);
  }
  mkdirSync(".previews", { recursive: true });
  const out = ".previews/rep-email.html";
  writeFileSync(out, parts.join('<div style="height:40px"></div>'), "utf8");
  console.log(`\n  wrote ${out}`);
  execFile("open", [out], () => {});
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
