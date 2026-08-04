/**
 * Split consumer-mail deal collisions into one deal per prospect.
 *
 * Run scripts/freemail-deal-collision.ts first to see what exists. This is the
 * migration for what it reports.
 *
 * What it does, per collided deal:
 *   1. Groups the deal's calls by the external counterparty they were with.
 *   2. Keeps the deal record for the FIRST prospect, rekeyed to that person's
 *      address and renamed. Reusing the record rather than retiring it keeps
 *      any snapshot history attached to something real.
 *   3. Creates a new deal for every other prospect and moves their calls over.
 *   4. Deletes field_extractions on every affected deal and re-extracts each
 *      call against its own deal, oldest first. This is the step that matters:
 *      without it you get correct deal counts with qualification fields still
 *      blended from unrelated conversations, which is worse than today.
 *
 * Refuses to touch a deal linked to a Rolldog opportunity. Moving calls under a
 * linked deal would write one prospect's answers onto another's opportunity,
 * which is not recoverable.
 *
 *   npx tsx scripts/split-freemail-deals.ts
 *   npx tsx scripts/split-freemail-deals.ts --name sunbizlatinoamerica@gmail.com="Sunbiz Latinoamerica"
 *   npx tsx scripts/split-freemail-deals.ts --name ... --apply
 *
 * DRY RUN by default: prints the exact plan and changes nothing.
 * Run on your Mac (the sandbox cannot reach Supabase or Anthropic).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  accountFromAddress,
  autoDealExternalIdForAddress,
  isFreeMailDomain,
  INTERNAL_DOMAINS,
} from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { extractAndStore } from "../lib/transcript-ingest";

const TENANT_SLUG = "magaya";

type Attendee = { email?: string | null; name?: string | null };
type CallRow = {
  id: string;
  external_id: string | null;
  title: string | null;
  scheduled_start: string | null;
  participants: unknown;
  has_been_extracted: boolean;
};

/** --name a@b.com="Real Name", repeatable. */
function nameOverrides(): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== "--name") continue;
    const raw = process.argv[i + 1] ?? "";
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    out.set(raw.slice(0, eq).trim().toLowerCase(), raw.slice(eq + 1).trim().replace(/^"|"$/g, ""));
  }
  return out;
}

function primaryExternal(participants: unknown): Attendee | null {
  if (!Array.isArray(participants)) return null;
  for (const a of participants as Attendee[]) {
    const e = (a?.email ?? "").toLowerCase();
    const d = e.split("@")[1] ?? "";
    if (d && !INTERNAL_DOMAINS.includes(d)) return a;
  }
  return null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const overrides = nameOverrides();
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const { data: deals, error } = await db
    .from("deals")
    .select("id, account, external_id, rep_email, rolldog_opportunity_id, framework_id")
    .eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);

  const collided = (deals ?? []).filter((d) => {
    const ext = d.external_id ?? "";
    if (!ext.startsWith("auto:")) return false;
    const key = ext.slice(5);
    return !key.includes("@") && isFreeMailDomain(key);
  });

  if (collided.length === 0) {
    console.log("\nNothing to split.\n");
    return;
  }

  console.log(`\n${apply ? "APPLYING" : "DRY RUN"}  ·  ${collided.length} consumer-mail deal record(s)\n`);
  const reextract: Array<{ dealExternalId: string; callId: string; callExternalId: string }> = [];

  for (const d of collided) {
    if (d.rolldog_opportunity_id) {
      console.log(`SKIP  ${d.external_id} "${d.account}" is linked to Rolldog opp ${d.rolldog_opportunity_id}.`);
      console.log(`      Splitting a linked deal risks writing one prospect's answers onto another's`);
      console.log(`      opportunity. Unlink it first, or split it by hand.\n`);
      continue;
    }

    const { data: callData } = await db
      .from("calls")
      .select("id, external_id, title, scheduled_start, participants, has_been_extracted")
      .eq("tenant_id", tenantId)
      .eq("deal_id", d.id)
      .order("scheduled_start", { ascending: true });
    const calls = (callData ?? []) as CallRow[];

    const groups = new Map<string, { name: string | null; calls: CallRow[] }>();
    for (const c of calls) {
      const p = primaryExternal(c.participants);
      const email = (p?.email ?? "").toLowerCase();
      if (!email) continue;
      const g = groups.get(email);
      if (g) g.calls.push(c);
      else groups.set(email, { name: p?.name ?? null, calls: [c] });
    }
    if (groups.size === 0) {
      console.log(`SKIP  ${d.external_id}: no external attendee on any call.\n`);
      continue;
    }

    const entries = [...groups.entries()];
    console.log(`${d.external_id}  "${d.account}"  ->  ${entries.length} deal(s)`);

    for (let i = 0; i < entries.length; i++) {
      const [email, info] = entries[i];
      const newExt = autoDealExternalIdForAddress(email);
      const newName = overrides.get(email) ?? accountFromAddress(email, info.name);
      const keep = i === 0;

      console.log(`  ${keep ? "REKEY existing" : "CREATE new    "}  ${newExt}  "${newName}"  (${info.calls.length} call(s))`);
      if (!overrides.has(email)) {
        console.log(`      no --name given, using "${newName}". Titles seen: ${info.calls.map((c) => c.title ?? "(untitled)").join(" | ")}`);
      }

      if (apply) {
        let targetDealId = d.id;
        if (keep) {
          const upd = await db
            .from("deals")
            .update({ external_id: newExt, account: newName })
            .eq("id", d.id);
          if (upd.error) throw new Error(`rekey failed for ${d.id}: ${upd.error.message}`);
        } else {
          const ins = await db
            .from("deals")
            .insert({
              tenant_id: tenantId,
              external_id: newExt,
              account: newName,
              stage_key: "SQL0",
              framework_id: d.framework_id,
              rep_email: d.rep_email,
              rep_notes: `Split out of ${d.external_id} on ${new Date().toISOString().slice(0, 10)}: that record had merged unrelated consumer-mail prospects.`,
            })
            .select("id")
            .single();
          if (ins.error || !ins.data) throw new Error(`create failed for ${newExt}: ${ins.error?.message}`);
          targetDealId = ins.data.id;

          const mv = await db
            .from("calls")
            .update({ deal_id: targetDealId })
            .in("id", info.calls.map((c) => c.id));
          if (mv.error) throw new Error(`call move failed for ${newExt}: ${mv.error.message}`);
        }

        // Blended fields must go before anything is re-derived.
        const del = await db.from("field_extractions").delete().eq("deal_id", targetDealId);
        if (del.error) throw new Error(`extraction clear failed for ${newExt}: ${del.error.message}`);

        for (const c of info.calls) {
          if (c.external_id) reextract.push({ dealExternalId: newExt, callId: c.id, callExternalId: c.external_id });
        }
      }
    }
    console.log("");
  }

  if (!apply) {
    console.log("Dry run. Nothing written.");
    console.log("Add --name <email>=\"Real Name\" for each prospect, then re-run with --apply.\n");
    return;
  }

  // Re-extract last, so a failure here leaves correct deals with empty fields
  // (visibly incomplete) rather than correct deals with another prospect's answers.
  console.log(`Re-extracting ${reextract.length} call(s), oldest first...`);
  for (const r of reextract) {
    const tr = await db.from("transcripts").select("body").eq("call_id", r.callId).maybeSingle();
    if (!tr.data?.body) {
      console.log(`  skip ${r.dealExternalId} (no transcript stored for call ${r.callId})`);
      continue;
    }
    try {
      await extractAndStore({
        transcript: tr.data.body,
        dealExternalId: r.dealExternalId,
        callExternalId: r.callExternalId,
      });
      console.log(`  ok   ${r.dealExternalId}`);
    } catch (e) {
      console.log(`  FAIL ${r.dealExternalId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("\nDone. Re-run scripts/freemail-deal-collision.ts to confirm it reports nothing,");
  console.log("and check the pipeline count before the next digest goes out.\n");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
