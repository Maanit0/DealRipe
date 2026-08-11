/**
 * One meeting, two call rows. Merge them onto one.
 *
 * Confirmed on August 11: Gezairi had the briefing on one row and the capture,
 * recap and draft on another, so the Activity card showed "Briefing never sent"
 * next to a completed recap. FTZ had the bot on the Monday row and a second row
 * created 25 minutes before the call.
 *
 * This does NOT prevent new duplicates. Prevention is a calendar-sync change:
 * when the external_id lookup misses, match on deal plus start instant and adopt
 * the existing row instead of inserting. This script only repairs what exists.
 *
 * Three levels, deliberately:
 *
 *   (default)   report only, changes nothing
 *   --apply     merge fields onto the survivor, re-point child rows, mark the
 *               loser outcome='duplicate'
 *   --delete    additionally delete the loser row (only with --apply)
 *
 * Marking rather than deleting is the default because a delete cannot be undone
 * and this repo has child tables keyed on call_id that are easy to miss. Note
 * that 'duplicate' must be added to the NO_CONTENT sets in briefing-history.ts
 * and weekly-digest-data.ts or the marked rows keep inflating counts.
 *
 *   npx tsx scripts/merge-duplicate-calls.ts
 *   npx tsx scripts/merge-duplicate-calls.ts --apply
 *
 * There are live bots attached to some of these rows. Read the dry run first.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

type CallRow = {
  id: string;
  deal_id: string;
  title: string | null;
  scheduled_start: string | null;
  created_at: string;
  external_id: string | null;
  recall_bot_id: string | null;
  transcript_id: string | null;
  has_been_extracted: boolean;
  briefing_sent_at: string | null;
  outcome: string | null;
  meeting_type: string | null;
  call_subtype: string | null;
  participants: unknown;
};

/** Fields worth carrying from a loser onto a survivor that lacks them. */
const MERGEABLE: Array<keyof CallRow> = [
  "recall_bot_id",
  "transcript_id",
  "briefing_sent_at",
  "outcome",
  "meeting_type",
  "call_subtype",
  "title",
  "participants",
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  // Merge one deal at a time. A call still being processed by transcript-sync
  // should not be touched mid-flight, and without this the only options were
  // "all of them" or "none".
  const only = arg("--deal")?.toLowerCase() ?? null;
  const del = process.argv.includes("--delete");
  if (del && !apply) {
    console.log("\n--delete requires --apply.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const calls = await db
    .from("calls")
    .select(
      "id, deal_id, title, scheduled_start, created_at, external_id, recall_bot_id, transcript_id, has_been_extracted, briefing_sent_at, outcome, meeting_type, call_subtype, participants",
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (calls.error) throw new Error(calls.error.message);
  const rows = (calls.data ?? []) as unknown as CallRow[];

  const deals = await db.from("deals").select("id, account").eq("tenant_id", tenantId);
  if (deals.error) throw new Error(deals.error.message);
  const dealName = new Map((deals.data ?? []).map((d) => [d.id, d.account ?? "?"]));

  // Same deal, same instant. Compare parsed instants: Supabase renders
  // timestamptz as "+00:00" and other code renders "Z", and string equality on
  // those is false for the same moment.
  const groups = new Map<string, CallRow[]>();
  for (const c of rows) {
    const t = c.scheduled_start ? Date.parse(c.scheduled_start) : NaN;
    if (!Number.isFinite(t)) continue;
    const key = `${c.deal_id}|${t}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }

  const dupes = [...groups.values()]
    .filter((g) => g.length > 1)
    .filter((g) => !only || (dealName.get(g[0].deal_id) ?? "").toLowerCase().includes(only));

  console.log("");
  if (dupes.length === 0) {
    console.log(only ? `No duplicate call rows for "${only}".\n` : "No duplicate call rows. Nothing to merge.\n");
    return;
  }
  console.log(`${dupes.length} meeting(s) have more than one call row.`);
  console.log(apply ? (del ? "APPLYING, and deleting losers." : "APPLYING, marking losers.") : "Dry run. Nothing will change.");
  console.log("");

  // Which child tables actually point at a call. Enumerated rather than assumed,
  // because deleting a row whose children we did not re-point loses a transcript
  // and there is no undo.
  const CHILD_TABLES = [
    { table: "transcripts", column: "call_id" },
    { table: "sent_messages", column: "call_id" },
    { table: "field_extractions", column: "last_updated_from_call_id" },
  ] as const;

  for (const g of dupes) {
    // Survivor: a transcript beats a bot beats being oldest. The row holding the
    // real conversation is the one everything else should attach to.
    const sorted = [...g].sort((a, b) => {
      const score = (r: CallRow) =>
        (r.transcript_id || r.has_been_extracted || r.outcome === "captured" ? 4 : 0) +
        (r.recall_bot_id ? 2 : 0);
      const d = score(b) - score(a);
      return d !== 0 ? d : Date.parse(a.created_at) - Date.parse(b.created_at);
    });
    const survivor = sorted[0];
    const losers = sorted.slice(1);

    console.log(`${formatMeetingTime(survivor.scheduled_start)}   ${dealName.get(survivor.deal_id)}   ${(survivor.title ?? "").slice(0, 40)}`);
    console.log(`   survivor  ${survivor.id}  created ${formatMeetingTime(survivor.created_at)}`);

    const patch: Record<string, unknown> = {};
    for (const l of losers) {
      console.log(`   loser     ${l.id}  created ${formatMeetingTime(l.created_at)}`);
      for (const f of MERGEABLE) {
        const sv = survivor[f];
        const lv = l[f];
        const survivorHas = sv !== null && sv !== undefined && sv !== "";
        const loserHas = lv !== null && lv !== undefined && lv !== "";
        if (!survivorHas && loserHas && patch[f as string] === undefined) {
          patch[f as string] = lv;
          console.log(`      carry over ${String(f)} = ${String(lv).slice(0, 40)}`);
        }
      }
    }
    if (Object.keys(patch).length === 0) {
      console.log(`      survivor already holds everything`);
    }

    for (const { table, column } of CHILD_TABLES) {
      const q = await db
        .from(table)
        .select("*", { count: "exact", head: true })
        .in(column, losers.map((l) => l.id));
      if (q.error) {
        console.log(`      ${table}: COULD NOT COUNT (${q.error.message}). Not re-pointing, and not safe to delete.`);
        continue;
      }
      if ((q.count ?? 0) > 0) {
        console.log(`      ${table}: ${q.count} row(s) to re-point onto the survivor`);
      }
    }

    if (apply) {
      if (Object.keys(patch).length > 0) {
        const up = await db
          .from("calls")
          // The patch is built dynamically from MERGEABLE, so its shape is not
          // statically known. Cast at the boundary rather than widening the
          // generated types.
          .update(patch as never)
          .eq("id", survivor.id);
        if (up.error) {
          console.log(`      MERGE FAILED: ${up.error.message}`);
          console.log(`      Leaving this group alone.`);
          console.log("");
          continue;
        }
      }
      let childOk = true;
      for (const { table, column } of CHILD_TABLES) {
        const up = await db
          .from(table)
          .update({ [column]: survivor.id } as never)
          .in(column, losers.map((l) => l.id));
        if (up.error) {
          childOk = false;
          console.log(`      re-point ${table} FAILED: ${up.error.message}`);
        }
      }
      for (const l of losers) {
        const mk = await db.from("calls").update({ outcome: "duplicate" }).eq("id", l.id);
        if (mk.error) console.log(`      mark ${l.id} failed: ${mk.error.message}`);
      }
      if (del) {
        if (!childOk) {
          console.log(`      NOT DELETING: a child re-point failed, so a delete would lose data.`);
        } else {
          for (const l of losers) {
            const rm = await db.from("calls").delete().eq("id", l.id);
            if (rm.error) console.log(`      delete ${l.id} failed: ${rm.error.message}`);
            else console.log(`      deleted ${l.id}`);
          }
        }
      }
      console.log(`      done`);
    }
    console.log("");
  }

  if (!apply) {
    console.log("Re-run with --apply to merge. Add --delete only if the dry run looks right.");
  } else {
    console.log("Add 'duplicate' to the NO_CONTENT sets in lib/briefing-history.ts and");
    console.log("lib/weekly-digest-data.ts so the marked rows stop inflating counts.");
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
