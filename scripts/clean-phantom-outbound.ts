/**
 * Remove our own unsent drafts from the record of the rep's outbound mail.
 *
 *   npx tsx scripts/clean-phantom-outbound.ts            dry run
 *   npx tsx scripts/clean-phantom-outbound.ts --apply    DELETES the phantom rows
 *
 * /users/{id}/messages spans every folder including Drafts, and DealRipe writes
 * its follow-up draft into the very mailbox lib/email-log.ts then reads, so the
 * tool ingested its own output as the rep's work. The ingest skips drafts now;
 * this is the backlog.
 *
 * THE ROWS ARE NOT ALL PHANTOM AND THIS IS WHY IT IS A SCRIPT AND NOT A DELETE.
 * The Message-ID survives the send, so where the rep sent our draft that row IS
 * the real send and removing it would erase genuine outbound and make a live
 * conversation look silent. Measured 2026-09-02: 31 rows across 28 deals carry
 * one of our draft ids and only some are unsent. The question is per row, and
 * lib/draft-adoption.ts is the only thing that answers it: a row is deleted
 * ONLY on a not_sent verdict. sent_ours, sent_edited, sent_own, too_soon and
 * unknown all keep the row, because four of those mean mail really went and the
 * fifth means we could not tell.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { readDraftAdoption } from "../lib/draft-adoption";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  const { data: drafts, error: dErr } = await db
    .from("sent_messages")
    .select("provider_id, deal_id, call_id, to_email, body_text, sent_at, kind")
    .eq("tenant_id", tenantId)
    .in("kind", ["followup_draft", "no_show_draft"])
    .not("provider_id", "is", null);
  if (dErr) throw new Error(`could not read drafts: ${dErr.message}`);
  const byId = new Map((drafts ?? []).map((d) => [String(d.provider_id), d]));
  const ids = [...byId.keys()];

  const hits: Array<{ id: string; deal_id: string; internet_message_id: string; sent_at: string }> = [];
  for (let i = 0; i < ids.length; i += 40) {
    const { data, error } = await db
      .from("deal_messages")
      .select("id, deal_id, internet_message_id, sent_at")
      .eq("tenant_id", tenantId)
      .in("internet_message_id", ids.slice(i, i + 40));
    if (error) throw new Error(`could not read deal_messages: ${error.message}`);
    hits.push(...((data ?? []) as typeof hits));
  }

  console.log(`\n${hits.length} row(s) in deal_messages carry one of our draft ids.\n`);
  let deleted = 0, kept = 0, unresolved = 0;

  for (const h of hits) {
    const d = byId.get(h.internet_message_id)!;
    const { data: deal } = await db.from("deals").select("account").eq("id", h.deal_id).maybeSingle();
    const account = (deal as { account?: string } | null)?.account ?? h.deal_id.slice(0, 8);

    let verdict: string;
    try {
      verdict = (
        await readDraftAdoption({
          dealId: h.deal_id,
          account,
          callId: d.call_id,
          kind: d.kind as "followup_draft" | "no_show_draft",
          mailbox: String(d.to_email),
          draftId: String(d.provider_id),
          draftText: String(d.body_text ?? ""),
          draftedAt: String(d.sent_at),
          domains: [],
        })
      ).verdict;
    } catch (err) {
      // Fail closed: a row we could not judge stays. Deleting on an unreadable
      // mailbox would silence a conversation that is actually alive.
      unresolved += 1;
      console.log(`  KEEP    ${account.padEnd(18)} could not check: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    if (verdict !== "not_sent") {
      kept += 1;
      console.log(`  KEEP    ${account.padEnd(18)} ${verdict}, so mail really went or we cannot tell`);
      continue;
    }
    if (apply) {
      const { error } = await db.from("deal_messages").delete().eq("id", h.id);
      if (error) {
        console.log(`  FAILED  ${account.padEnd(18)} ${error.message}`);
        continue;
      }
    }
    deleted += 1;
    console.log(`  ${apply ? "DELETED" : "WOULD  "} ${account.padEnd(18)} never sent, so it was never the rep's outbound`);
  }

  console.log(`\n  ${apply ? "deleted" : "would delete"} ${deleted}, kept ${kept}, could not judge ${unresolved}`);
  if (!apply && deleted > 0) console.log(`  Nothing was changed. Re-run with --apply.\n`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
