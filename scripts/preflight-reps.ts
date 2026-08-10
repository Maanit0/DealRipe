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
 *
 * READ ONLY. Queries the database, Microsoft Graph and the env, and writes
 * nothing anywhere. Safe to run against production, which is the point.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { allowedMailboxes } from "../lib/graph-mail";
import { listUpcomingMeetings } from "../lib/microsoft-graph";
import { isAutoJoinRep } from "../lib/pilot-config";
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

type Check = { ok: boolean; note: string };
type Row = {
  name: string;
  email: string;
  calendar: Check;
  autoJoin: Check;
  mailbox: Check;
  meetings: Check;
  rolldog: Check;
};

const OK = "ok  ";
const NO = "FAIL";
const WARN = "warn";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 7);
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

  console.log("");
  console.log(`DealRipe preflight  ·  tenant '${TENANT_SLUG}'  ·  ${new Date().toISOString()}`);
  console.log(`Looking ${days} days ahead for scheduled meetings.`);
  console.log("");

  const rows: Row[] = [];

  for (const rep of TEAM) {
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
    if (!conn) {
      meetings = { ok: false, note: "cannot check without a calendar connection" };
    } else {
      try {
        const upcoming = await listUpcomingMeetings(conn.id, days);
        const external = upcoming.filter((m) =>
          (m.attendees ?? []).some((a) => {
            const d = (a.email ?? "").split("@")[1]?.toLowerCase() ?? "";
            return d && d !== "magaya.com";
          }),
        );
        meetings =
          external.length > 0
            ? { ok: true, note: `${external.length} external of ${upcoming.length} total` }
            : { ok: false, note: `${upcoming.length} meetings, none external; nothing to brief` };
      } catch (e) {
        meetings = { ok: false, note: `Graph error: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    // Rolldog attribution. Unmapped is a warning rather than a failure: the rep
    // still gets briefings and recaps, we just cannot attribute their activity
    // during reconciliation.
    const rolldog: Check = REP_UID[email]
      ? { ok: true, note: `user id ${REP_UID[email]}` }
      : { ok: false, note: "no Rolldog user id; reconciliation cannot attribute their calls" };

    rows.push({ name: rep.name, email, calendar, autoJoin, mailbox, meetings, rolldog });
  }

  // ---- Render -------------------------------------------------------------
  const label = (c: Check, warnOnly = false) => (c.ok ? OK : warnOnly ? WARN : NO);

  for (const r of rows) {
    const blocking = [r.calendar, r.autoJoin, r.mailbox, r.meetings].filter((c) => !c.ok).length;
    const head = blocking === 0 ? "READY" : `${blocking} BLOCKING`;
    console.log(`${r.name}  <${r.email}>   ${head}`);
    console.log(`   ${label(r.calendar)}  calendar        ${r.calendar.note}`);
    console.log(`   ${label(r.autoJoin)}  auto-join       ${r.autoJoin.note}`);
    console.log(`   ${label(r.mailbox)}  mailbox         ${r.mailbox.note}`);
    console.log(`   ${label(r.meetings)}  meetings        ${r.meetings.note}`);
    console.log(`   ${label(r.rolldog, true)}  rolldog id      ${r.rolldog.note}`);
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

  const blockingTotal = rows.reduce(
    (s, r) => s + [r.calendar, r.autoJoin, r.mailbox, r.meetings].filter((c) => !c.ok).length,
    0,
  );
  const unmappedRolldog = rows.filter((r) => !r.rolldog.ok).length;

  if (blockingTotal === 0 && missingDigest.length === 0) {
    console.log(`All ${rows.length} reps ready.${unmappedRolldog > 0 ? `  (${unmappedRolldog} without a Rolldog id, non-blocking)` : ""}`);
    console.log("");
    return;
  }

  console.log(`${blockingTotal} blocking issue(s) across ${rows.length} reps.`);
  console.log("Env vars set only in .env.local do nothing in production. Check Vercel too.");
  console.log("");
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
