/**
 * Everything one rep needs to hear on a check-in call, in one command.
 *
 * Before a rep conversation the questions are always the same: which of their
 * calls got captured, which did not and why, what landed in the CRM, and what
 * is still open. Answering that from four different scripts costs ten minutes
 * and usually gets one of them wrong.
 *
 * Nothing here is inferred. A capture failure prints Recall's own reason, and a
 * Salesforce activity is confirmed by asking Salesforce rather than by assuming
 * the backfill worked.
 *
 * READ ONLY.
 *
 *   npx tsx scripts/rep-status.ts --rep ebencomo@magaya.com
 *   npx tsx scripts/rep-status.ts --rep ebencomo --days 30
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSalesforceClient } from "../lib/salesforce";
import { getBot } from "../lib/recall";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { formatMeetingTime } from "../lib/graph-time";

const API = "v61.0";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const NO_CONTENT = new Set(["placeholder", "duplicate", "discarded", "rescheduled"]);

async function main(): Promise<void> {
  const who = (arg("--rep") ?? "").toLowerCase();
  const days = Number(arg("--days") ?? "14");
  if (!who) {
    console.log("\nPass --rep <email or fragment>.\n");
    process.exit(1);
  }
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rep_email, salesforce_account_id, rolldog_opportunity_id")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);
  const deals = (dealsRes.data ?? []).filter((d) =>
    (d.rep_email ?? "").toLowerCase().includes(who),
  ) as Array<{
    id: string; account: string; external_id: string | null; rep_email: string | null;
    salesforce_account_id: string | null; rolldog_opportunity_id: string | null;
  }>;

  if (deals.length === 0) {
    console.log(`\nNo deals with a rep_email matching "${who}".`);
    console.log(`That is not "this rep has no deals": the organiser of a meeting is`);
    console.log(`often someone else, and rep_email is what routes everything.\n`);
    return;
  }

  const byId = new Map(deals.map((d) => [d.id, d]));
  const callsRes = await db
    .from("calls")
    .select("id, deal_id, title, scheduled_start, call_date, outcome, recall_bot_id, ingest_error, organizer_email")
    .eq("tenant_id", tenantId)
    .in("deal_id", deals.map((d) => d.id))
    .gte("scheduled_start", since)
    .order("scheduled_start", { ascending: false });
  if (callsRes.error) throw new Error(callsRes.error.message);

  const calls = (callsRes.data ?? []).filter((c) => !NO_CONTENT.has(String(c.outcome ?? "")));

  // Salesforce activities, asked rather than assumed.
  const sfAccounts = deals.map((d) => d.salesforce_account_id).filter(Boolean) as string[];
  const tasksByAccount = new Map<string, Array<{ Subject: string; ActivityDate: string; Status: string }>>();
  if (sfAccounts.length > 0) {
    try {
      const { token, instanceUrl } = await getSalesforceClient();
      const soql =
        `SELECT Id, Subject, ActivityDate, Status, WhatId FROM Task ` +
        `WHERE WhatId IN (${sfAccounts.map((a) => `'${a}'`).join(",")}) ORDER BY CreatedDate DESC LIMIT 200`;
      const r = await fetch(`${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const rows = ((await r.json()) as {
          records?: Array<{ Subject: string; ActivityDate: string; Status: string; WhatId: string }>;
        }).records ?? [];
        for (const t of rows) {
          const list = tasksByAccount.get(t.WhatId) ?? [];
          list.push(t);
          tasksByAccount.set(t.WhatId, list);
        }
      } else {
        console.log(`\n  (Could not read Salesforce activities: ${r.status}. That is not "none".)`);
      }
    } catch (e) {
      console.log(`\n  (Could not reach Salesforce: ${e instanceof Error ? e.message : String(e)})`);
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`${deals[0].rep_email}  ·  last ${days} days  ·  ${calls.length} meeting(s)`);
  console.log(`${"=".repeat(80)}`);

  const lost: Array<{ account: string; when: string; why: string; organizer: string | null }> = [];
  const landed: string[] = [];

  for (const c of calls) {
    const d = byId.get(c.deal_id as string);
    if (!d) continue;
    const when = formatMeetingTime(c.scheduled_start ?? c.call_date);
    const outcome = c.outcome ?? "(not processed yet)";

    console.log(`\n${d.account}   ${when}`);
    console.log(`  outcome      ${outcome}`);

    if (outcome === "capture_failed") {
      let why = c.ingest_error ?? "no reason recorded";
      if (c.recall_bot_id) {
        try {
          const bot = await getBot(c.recall_bot_id);
          const raw = bot.raw as { status_changes?: unknown };
          const changes = Array.isArray(raw?.status_changes) ? raw.status_changes : [];
          const subs = changes
            .map((x) => (typeof x === "object" && x !== null ? (x as { sub_code?: unknown }).sub_code : null))
            .filter((x): x is string => typeof x === "string");
          const waited = changes.some(
            (x) => typeof x === "object" && x !== null && (x as { code?: unknown }).code === "in_waiting_room",
          );
          const recorded = changes.some(
            (x) => typeof x === "object" && x !== null && (x as { code?: unknown }).code === "in_call_recording",
          );
          why = recorded
            ? `joined and recorded, media lost (${subs.at(-1) ?? "no sub_code"})`
            : waited
              ? `sat in the WAITING ROOM and was never admitted (${subs.at(-1) ?? "no sub_code"})`
              : `never got into the meeting (${subs.at(-1) ?? "no sub_code"})`;
        } catch {
          why = `${why} (could not re-check the bot)`;
        }
      }
      console.log(`  NOT CAPTURED ${why}`);
      console.log(`  host         ${c.organizer_email ?? "not recorded"}`);
      lost.push({ account: d.account, when, why, organizer: c.organizer_email });
      continue;
    }

    const sfTasks = d.salesforce_account_id ? (tasksByAccount.get(d.salesforce_account_id) ?? []) : [];
    const day = (c.scheduled_start ?? c.call_date ?? "").slice(0, 10);
    const match = sfTasks.find((t) => t.ActivityDate === day && t.Status === "Completed");
    if (match) {
      console.log(`  SALESFORCE   call activity logged: "${match.Subject}"`);
      landed.push(`${d.account} (${when})`);
    } else if (d.rolldog_opportunity_id) {
      console.log(`  ROLLDOG      opportunity ${d.rolldog_opportunity_id} owns this deal's history`);
    } else if (!d.salesforce_account_id) {
      console.log(`  no CRM link  nothing to write to yet`);
    } else {
      console.log(`  SALESFORCE   no call activity found for this date`);
    }
    const open = sfTasks.filter((t) => t.Status !== "Completed");
    for (const t of open) console.log(`  NEXT STEP    open: "${t.Subject}" due ${t.ActivityDate}`);
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`SAY THIS`);
  console.log(`${"=".repeat(80)}`);
  if (landed.length > 0) {
    console.log(`\nRecaps now landing on the Salesforce account as a call activity:`);
    for (const l of landed) console.log(`  ${l}`);
  }
  if (lost.length > 0) {
    console.log(`\nCalls that were never captured:`);
    for (const l of lost) {
      console.log(`  ${l.account}  ${l.when}`);
      console.log(`     ${l.why}`);
      console.log(`     hosted by ${l.organizer ?? "unknown"}`);
    }
    const magayaHosted = lost.filter((l) => (l.organizer ?? "").endsWith("@magaya.com")).length;
    if (magayaHosted > 0) {
      console.log(
        `\n  ${magayaHosted} of ${lost.length} were in MAGAYA's own lobby, so a Teams policy change\n` +
          `  fixes them for the whole team rather than asking each rep to remember.`,
      );
    }
  }
  if (lost.length === 0 && landed.length === 0) {
    console.log(`\nNothing to report either way in this window.`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
