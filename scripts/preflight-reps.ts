/**
 * Onboarding preflight: is DealRipe actually ready for every rep on the team?
 *
 * Written for the Aug 10 expansion from two reps to six. The failure mode this
 * exists to prevent is the quiet one: a rep whose calendar never connected, or
 * whose mailbox is missing from an env allowlist that was only ever set
 * locally, looks fine in the UI and simply receives nothing all week. Nobody
 * reports it, because nobody knows what they were supposed to receive.
 *
 * One row per rep, green or red per capability, and an exit code you can gate
 * a launch on. Run it the night before, then again an hour before the call.
 *
 *   npx tsx scripts/preflight-reps.ts
 *   npx tsx scripts/preflight-reps.ts --days 7
 *   npx tsx scripts/preflight-reps.ts --rep dblitstein@magaya.com --verbose
 *
 * --rep narrows to one rep (full address, mailbox name, or any part of their
 * display name). --verbose prints every meeting Graph returned for that rep,
 * with its organiser and its raw attendee list, because the summary line alone
 * cannot tell you whether a rep has no external meetings or whether Graph
 * returned no attendee data to judge them by.
 *
 * The meetings check asks the same question production asks, through the same
 * code: resolveMeetingDeal, then the join gate. It does not compare domains of
 * its own. A diagnostic that can disagree with production eventually will, and
 * it will disagree confidently.
 *
 * READ ONLY. Queries the database, Microsoft Graph, Salesforce, the invite
 * classifier and the env, and writes nothing anywhere. Safe to run against
 * production, which is the point. The join gate costs a Salesforce lookup and
 * sometimes an Anthropic call per external candidate, so a full six-rep run is
 * slower than it used to be. Internal-only meetings never reach the gate.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { allowedMailboxes } from "../lib/graph-mail";
import { shouldJoinAutoMeeting } from "../lib/join-gate";
import { listUpcomingMeetings, type NormalizedMeeting } from "../lib/microsoft-graph";
import { INTERNAL_DOMAINS, isAutoJoinRep, resolveMeetingDeal } from "../lib/pilot-config";
import { REP_UID } from "../lib/rolldog-reconcile";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

/**
 * The six reps as of the Aug 10 expansion. Kept here rather than read from an
 * env var on purpose: the whole point of this script is to catch an env var
 * that is missing or stale, so it cannot use that same env var as its
 * definition of who should be present.
 */
const TEAM: ReadonlyArray<{ name: string; email: string }> = [
  { name: "Juan Lopez", email: "jlopez@magaya.com" },
  { name: "Eduardo Bencomo", email: "ebencomo@magaya.com" },
  { name: "Alexandra Suntrup", email: "asuntrup@magaya.com" },
  // Confirmed against the Microsoft 365 directory, Aug 10.
  { name: "Ariel Rodriguez", email: "arodriguez@magaya.com" },
  { name: "Daniel Blitstein", email: "dblitstein@magaya.com" },
  { name: "Steven Johnson", email: "sjohnson@magaya.com" },
];

/** Who should receive the Monday digest. */
const DIGEST_EXPECTED = ["mbuman@magaya.com", "mnemmers@magaya.com", "ebencomo@magaya.com"];

type Check = { ok: boolean; note: string; unknown?: boolean };
type Row = {
  name: string;
  email: string;
  calendar: Check;
  autoJoin: Check;
  mailbox: Check;
  meetings: Check;
  rolldog: Check;
  /** --verbose only: one block per meeting Graph returned, printed under the row. */
  meetingDetail: string[];
};

const OK = "ok  ";
const NO = "FAIL";
const WARN = "warn";
/** Neither pass nor fail: the check could not reach an answer. */
const UNK = "??  ";

/**
 * What a meeting is, in three states rather than two.
 *
 * The two-state version asked "does any attendee have a domain that is not
 * magaya.com", which answers false both for a room full of colleagues and for
 * a meeting Graph returned with no attendees at all. Daniel Blitstein's week
 * read "11 meetings, none external" while six of the eleven had never been
 * judged by anything. That is the failure this codebase forbids: absence of
 * evidence rendered as evidence of absence.
 *
 * `unknown` is never folded into `internal`. It is a statement about our
 * information, not about the meeting.
 */
type Counterparty = "external" | "internal" | "unknown";

type Classified = {
  state: Counterparty;
  /** The join gate's own reason where it ran, otherwise why it did not need to. */
  reason: string;
  detail: string;
  /** Production briefs and joins only these. Cancelled or no join url: no. */
  briefable: boolean;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Does this rep match the --rep filter? Accepts the full address, the mailbox
 * name on its own, or any fragment of the display name, because nobody running
 * this at 7am remembers whether Daniel is dblitstein or dblitstien.
 */
function matchesRep(rep: { name: string; email: string }, filter: string): boolean {
  const f = filter.toLowerCase().trim();
  if (!f) return true;
  const email = rep.email.toLowerCase();
  return email === f || email.split("@")[0] === f || rep.name.toLowerCase().includes(f);
}

/**
 * Is there a customer on this invite, and would DealRipe act on it?
 *
 * Every judgement here is production's. `resolveMeetingDeal` decides whether a
 * counterparty exists and which deal it belongs to; `shouldJoinAutoMeeting`
 * decides whether an auto-created one is commercial. This function only sorts
 * their answers into three buckets and never forms an opinion of its own.
 *
 * autoJoin is passed as true on purpose, the same way meeting-readiness.ts does
 * it. The question this row answers is "is there a customer meeting on this
 * calendar at all"; whether DealRipe is switched on for the rep is the separate
 * auto-join row directly above it, and conflating the two would report a real
 * customer call as an internal one for any rep not yet enrolled.
 */
async function classifyMeeting(m: NormalizedMeeting, tenantId: string): Promise<Classified> {
  const briefable = !m.isCancelled && Boolean(m.joinUrl);
  const skipNote = m.isCancelled ? "cancelled" : m.joinUrl ? null : "no join url";

  // An attendee entry with no address, or with an address Graph truncated to
  // something without a domain, carries no information either way.
  const emails = m.attendees
    .map((a) => a.email)
    .filter((e): e is string => typeof e === "string" && e.trim().length > 0);
  const parseable = emails.filter((e) => {
    const at = e.lastIndexOf("@");
    return at > 0 && e.slice(at + 1).trim().length > 0;
  });

  if (parseable.length === 0) {
    const organiser = m.organizerEmail ? `; organiser ${m.organizerEmail}` : "";
    return {
      state: "unknown",
      reason: "no_attendee_data",
      detail:
        m.attendees.length === 0
          ? `Graph returned no attendees, so nothing judged this meeting${organiser}`
          : `${m.attendees.length} attendee(s), none with a parseable address${organiser}`,
      briefable,
    };
  }

  // From here on, pass the same list production passes: `emails`, not the
  // parseable subset. The subset exists only to answer "was there anything to
  // judge", and handing the resolver a different list from the one calendar-sync
  // hands it is how a diagnostic starts drifting.
  const resolved = resolveMeetingDeal(emails, m.subject, true);
  if (!resolved) {
    // The resolver returns null for a room full of colleagues and for a meeting
    // whose only outside attendee is on the auto-join exclusion list. Both are
    // correctly skipped, but they are skipped for different reasons, and the
    // second is one env var away from hiding a real customer.
    const outside = [
      ...new Set(
        parseable
          .map((e) => e.slice(e.lastIndexOf("@") + 1).toLowerCase())
          .filter((d) => !INTERNAL_DOMAINS.includes(d)),
      ),
    ];
    return outside.length > 0
      ? {
          state: "internal",
          reason: "excluded_domain",
          detail: `outside attendees are all on the auto-join exclusion list: ${outside.join(", ")}`,
          briefable,
        }
      : {
          state: "internal",
          reason: "no_external_counterparty",
          detail: `${parseable.length} attendee(s), all on ${INTERNAL_DOMAINS.join(", ")}`,
          briefable,
        };
  }
  if (!resolved.isAuto || !resolved.domain || !resolved.address) {
    // A hand-seeded pilot deal. Production never consults the gate for these.
    return {
      state: "external",
      reason: "pilot_deal",
      detail: `pilot deal ${resolved.dealExternalId}${skipNote ? `; ${skipNote}` : ""}`,
      briefable,
    };
  }

  const verdict = await shouldJoinAutoMeeting({
    tenantId,
    dealExternalId: resolved.dealExternalId,
    domain: resolved.domain,
    address: resolved.address,
    isFreeMail: resolved.isFreeMail === true,
    subject: m.subject,
    attendeeEmails: emails,
    sellerName: "Magaya",
  });

  const detail = `${verdict.detail} [crm: ${verdict.crmCheck}]${skipNote ? `; ${skipNote}` : ""}`;

  if (verdict.join) {
    return { state: "external", reason: verdict.reason, detail, briefable };
  }
  // A decline is only "internal" when production actually read something and
  // judged it. The gate distinguishes these itself, in crmCheck and in reason;
  // all this does is respect the distinction. `no_evidence` means the invite was
  // never classified, and `unavailable` means Salesforce, the strongest evidence
  // source, went unread. Both are "did not check", not "no".
  if (verdict.crmCheck === "unavailable" || verdict.reason === "no_evidence") {
    return { state: "unknown", reason: verdict.reason, detail, briefable };
  }
  return { state: "internal", reason: verdict.reason, detail, briefable };
}

/**
 * One meeting, rendered exactly as Graph handed it over, with the verdict.
 *
 * The attendee list is printed raw and unfiltered, including the case where it
 * is empty. "no external attendee" and "Graph returned no attendee data" are
 * different findings with different fixes, and no summary count can separate
 * them for you.
 */
function describeMeeting(m: NormalizedMeeting, c: Classified): string[] {
  const lines: string[] = [];
  const flags = [
    m.isCancelled ? "CANCELLED" : null,
    m.joinUrl ? null : "no join url",
  ].filter(Boolean);
  lines.push(
    `      ${formatMeetingTime(m.start?.dateTime)}  ${m.subject ?? "(no subject)"}${
      flags.length > 0 ? `  [${flags.join(", ")}]` : ""
    }`,
  );
  lines.push(`         verdict    ${c.state.toUpperCase()} · ${c.reason} · ${c.detail}`);
  lines.push(`         organiser  ${m.organizerEmail ?? "(none on the event)"}`);
  if (m.attendees.length === 0) {
    lines.push(`         attendees  (none returned by Graph)`);
    return lines;
  }
  for (const a of m.attendees) {
    const who = a.email ?? "(no address)";
    const name = a.name ? ` "${a.name}"` : "";
    const resp = a.responseStatus ? ` · ${a.responseStatus}` : "";
    lines.push(`         attendee   ${who}${name}${resp}`);
  }
  return lines;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 7);
  const onlyRep = arg("--rep") ?? null;
  const verbose = process.argv.includes("--verbose");
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const conns = await db
    .from("microsoft_connections")
    .select("id, user_principal_name, connected_at, last_synced_at")
    .eq("tenant_id", tenantId);
  if (conns.error) throw new Error(`connections query failed: ${conns.error.message}`);

  const byUpn = new Map<string, { id: string; last_synced_at: string | null }>();
  for (const c of conns.data ?? []) {
    byUpn.set((c.user_principal_name ?? "").toLowerCase(), { id: c.id, last_synced_at: c.last_synced_at });
  }

  const mailboxes = allowedMailboxes().map((m) => m.toLowerCase());

  const team = onlyRep ? TEAM.filter((r) => matchesRep(r, onlyRep)) : TEAM;

  console.log("");
  console.log(`DealRipe preflight  ·  tenant '${TENANT_SLUG}'  ·  ${new Date().toISOString()}`);
  console.log(`Looking ${days} days ahead for scheduled meetings.`);
  if (onlyRep) {
    console.log(
      `Filtered to --rep '${onlyRep}': ${team.length} of ${TEAM.length} reps${
        team.length === 0 ? ". Nothing matched, so nothing below is a verdict on that rep." : ""
      }`,
    );
  }
  console.log("");

  const rows: Row[] = [];

  for (const rep of team) {
    const email = rep.email.toLowerCase();

    if (!email) {
      rows.push({
        name: rep.name,
        email: "(unknown)",
        calendar: { ok: false, note: "no email on file" },
        autoJoin: { ok: false, note: "no email on file" },
        mailbox: { ok: false, note: "no email on file" },
        meetings: { ok: false, note: "no email on file" },
        rolldog: { ok: false, note: "no email on file" },
        meetingDetail: [],
      });
      continue;
    }

    const conn = byUpn.get(email) ?? null;

    const calendar: Check = conn
      ? { ok: true, note: conn.last_synced_at ? `last synced ${conn.last_synced_at.slice(0, 16).replace("T", " ")}` : "connected, never synced" }
      : { ok: false, note: "no calendar connection; rep has not completed the Connect flow" };

    const autoJoin: Check = isAutoJoinRep(email)
      ? { ok: true, note: "on AUTO_JOIN_REP_EMAILS" }
      : { ok: false, note: "NOT on AUTO_JOIN_REP_EMAILS; DealRipe will not join their calls" };

    const mailbox: Check = mailboxes.includes(email)
      ? { ok: true, note: "on GRAPH_MAIL_ALLOWED_MAILBOXES" }
      : { ok: false, note: "NOT on GRAPH_MAIL_ALLOWED_MAILBOXES; no follow-up drafts" };

    // Upcoming meetings: the real proof that there is anything to brief on.
    let meetings: Check;
    const meetingDetail: string[] = [];
    if (!conn) {
      meetings = { ok: false, note: "cannot check without a calendar connection" };
    } else {
      try {
        const upcoming = await listUpcomingMeetings(conn.id, days);
        const classified: Array<{ meeting: NormalizedMeeting; c: Classified }> = [];
        for (const m of upcoming) {
          classified.push({ meeting: m, c: await classifyMeeting(m, tenantId) });
        }
        if (verbose) {
          if (upcoming.length === 0) {
            meetingDetail.push(`      (Graph returned no meetings in the next ${days} days)`);
          }
          for (const { meeting, c } of classified) meetingDetail.push(...describeMeeting(meeting, c));
        }

        const external = classified.filter((x) => x.c.state === "external");
        const internal = classified.filter((x) => x.c.state === "internal");
        const unknown = classified.filter((x) => x.c.state === "unknown");
        const briefable = external.filter((x) => x.c.briefable).length;
        // An unknown meeting production would never have joined anyway is still
        // unknown, but it is not a missed customer call. Daniel's six were all
        // self-organised blocks with no online meeting attached.
        const unknownNoJoin = unknown.filter((x) => !x.c.briefable).length;

        const counts = `${external.length} external (${briefable} briefable), ${internal.length} internal, ${unknown.length} unknown of ${upcoming.length}`;
        // Say which kind of unknown. "Graph gave us no attendees" sends someone
        // to the calendar; "the gate could not read its evidence" sends them to
        // Salesforce or to ANTHROPIC_API_KEY.
        const noData = unknown.filter((x) => x.c.reason === "no_attendee_data").length;
        const unread = unknown.length - noData;
        const why: string[] = [];
        if (noData > 0) why.push(`${noData} with no parseable attendee address`);
        if (unread > 0) why.push(`${unread} where the join gate could not read its evidence`);
        if (unknownNoJoin > 0) why.push(`${unknownNoJoin} with no join url, which no bot could join anyway`);
        const unknownTail = unknown.length === 0 ? "" : `  · unknown: ${why.join(", ")}`;

        if (upcoming.length === 0) {
          meetings = { ok: false, note: `no meetings in the next ${days} days` };
        } else if (external.length > 0) {
          meetings = { ok: briefable > 0, note: `${counts}${unknownTail}` };
        } else if (unknown.length > 0) {
          // Not "none external". We do not know that.
          meetings = { ok: false, unknown: true, note: `${counts}${unknownTail}` };
        } else {
          meetings = { ok: false, note: `${counts}; all internal, nothing to brief` };
        }
      } catch (e) {
        // Graph failing is a third thing again: not "no meetings", not "no
        // external meetings", but no answer at all.
        meetings = {
          ok: false,
          unknown: true,
          note: `Graph error, meetings unknown: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    // Rolldog attribution. Unmapped is a warning rather than a failure: the rep
    // still gets briefings and recaps, we just cannot attribute their activity
    // during reconciliation.
    const rolldog: Check = REP_UID[email]
      ? { ok: true, note: `user id ${REP_UID[email]}` }
      : { ok: false, note: "no Rolldog user id; reconciliation cannot attribute their calls" };

    rows.push({ name: rep.name, email, calendar, autoJoin, mailbox, meetings, rolldog, meetingDetail });
  }

  // ---- Render -------------------------------------------------------------
  // A check that could not reach an answer gets its own mark. Rendering it as
  // FAIL sends someone to fix a thing that may not be broken; rendering it as
  // ok hides it entirely.
  const label = (c: Check, warnOnly = false) => (c.ok ? OK : c.unknown ? UNK : warnOnly ? WARN : NO);
  const blockingOf = (r: Row) =>
    [r.calendar, r.autoJoin, r.mailbox, r.meetings].filter((c) => !c.ok && !c.unknown).length;
  const unknownOf = (r: Row) =>
    [r.calendar, r.autoJoin, r.mailbox, r.meetings].filter((c) => c.unknown).length;

  for (const r of rows) {
    const blocking = blockingOf(r);
    const unknown = unknownOf(r);
    const head =
      blocking === 0 && unknown === 0
        ? "READY"
        : [blocking > 0 ? `${blocking} BLOCKING` : null, unknown > 0 ? `${unknown} UNKNOWN` : null]
            .filter(Boolean)
            .join(", ");
    console.log(`${r.name}  <${r.email}>   ${head}`);
    console.log(`   ${label(r.calendar)}  calendar        ${r.calendar.note}`);
    console.log(`   ${label(r.autoJoin)}  auto-join       ${r.autoJoin.note}`);
    console.log(`   ${label(r.mailbox)}  mailbox         ${r.mailbox.note}`);
    console.log(`   ${label(r.meetings)}  meetings        ${r.meetings.note}`);
    console.log(`   ${label(r.rolldog, true)}  rolldog id      ${r.rolldog.note}`);
    if (r.meetingDetail.length > 0) {
      console.log("");
      console.log(`   meetings as Graph returned them:`);
      for (const line of r.meetingDetail) console.log(line);
    }
    console.log("");
  }

  // ---- Team-level checks --------------------------------------------------
  console.log("TEAM");

  const digestTo = (process.env.DIGEST_TO ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const missingDigest = DIGEST_EXPECTED.filter((e) => !digestTo.includes(e));
  console.log(
    `   ${missingDigest.length === 0 ? OK : NO}  digest recipients   ${
      digestTo.length === 0 ? "DIGEST_TO is empty" : digestTo.join(", ")
    }${missingDigest.length > 0 ? `  · missing: ${missingDigest.join(", ")}` : ""}`,
  );

  const sfReady = Boolean(process.env.SF_CLIENT_ID && process.env.SF_USERNAME && process.env.SF_PRIVATE_KEY_PATH);
  console.log(
    `   ${sfReady ? OK : WARN}  salesforce env      ${sfReady ? "client id, user and key path set" : "not configured; briefings lose BDR context on non-Rolldog deals"}`,
  );

  const mailboxesNotOnTeam = mailboxes.filter((m) => !TEAM.some((t) => t.email.toLowerCase() === m));
  if (mailboxesNotOnTeam.length > 0) {
    console.log(`   ${WARN}  extra mailboxes     on the allowlist but not on the team: ${mailboxesNotOnTeam.join(", ")}`);
  }

  console.log("");

  const blockingTotal = rows.reduce((s, r) => s + blockingOf(r), 0);
  const unknownTotal = rows.reduce((s, r) => s + unknownOf(r), 0);
  const unmappedRolldog = rows.filter((r) => !r.rolldog.ok).length;

  if (blockingTotal === 0 && unknownTotal === 0 && missingDigest.length === 0) {
    console.log(`All ${rows.length} reps ready.${unmappedRolldog > 0 ? `  (${unmappedRolldog} without a Rolldog id, non-blocking)` : ""}`);
    console.log("");
    return;
  }

  if (blockingTotal > 0) {
    console.log(`${blockingTotal} blocking issue(s) across ${rows.length} reps.`);
  }
  if (unknownTotal > 0) {
    // Fail closed, the same way the join gate does. An unresolved question is
    // not a pass, and a launch gate that treats it as one is worse than no gate.
    console.log(
      `${unknownTotal} check(s) could not be determined. Not the same as failing: go and look before you call it either.`,
    );
  }
  console.log("Env vars set only in .env.local do nothing in production. Check Vercel too.");
  console.log("");
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
