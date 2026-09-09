/**
 * What the reps ACTUALLY write after each kind of call.
 *
 *   npx tsx scripts/mine-followup-shapes.ts
 *   npx tsx scripts/mine-followup-shapes.ts --type demo --per 8
 *
 * Same method that produced lib/magaya-collateral.ts: recover the real artifact
 * from the reps' own sent mail rather than designing one and hoping it matches.
 * The per-call-type blocks in the draft prompt are currently one thin sentence
 * each, and writing five better ones from intuition would be inventing sales
 * convention. This prints the evidence to write them from.
 *
 * READ ONLY, and it writes nothing to disk. Magaya is under NDA and these are
 * real customer emails: they are printed for reading and must not be committed,
 * pasted into a file, or exported. Anything derived from them is still
 * transcript, which is why the OUTPUT of this analysis belongs in a prompt as
 * generalised guidance, never as quoted customer text.
 *
 * Bodies come from Graph, since deal_messages stores metadata only.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { isMeetingInviteBoilerplate } from "../lib/followup-draft";
import { stripMailChrome, trimMessageBody } from "../lib/mail-body";
import { getMessageBody } from "../lib/graph-mail";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const GRAPH_TENANT = process.env.GRAPH_TENANT_DOMAIN ?? "magaya.com";
const WINDOW_MS = 48 * 3600 * 1000;

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Rough overlap between two bodies, for spotting a DealRipe draft the rep sent
 * as-is. Mining our own output would teach us our own voice, which is the one
 * thing this exercise must not do.
 */
function overlaps(a: string, b: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);
  const A = new Set(norm(a));
  const B = norm(b);
  if (A.size < 10 || B.length < 10) return false;
  const hit = B.filter((w) => A.has(w)).length / B.length;
  return hit > 0.55;
}

/**
 * The Safelinks and disclaimer stripping that used to live here is now in
 * lib/mail-body.ts, which is also what production stores. A diagnostic that
 * trims differently from the ingest is reading a different email than the one
 * the model will see.
 */

async function main(): Promise<void> {
  const only = arg("--type");
  const per = Number(arg("--per") ?? 5);
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  const { data: calls } = await db
    .from("calls")
    .select("id, deal_id, call_date, scheduled_start, call_subtype, meeting_type")
    .eq("tenant_id", tenantId)
    .not("call_subtype", "is", null)
    .not("call_subtype", "in", '("internal")');

  const byType = new Map<string, Array<{ dealId: string; at: number }>>();
  for (const c of calls ?? []) {
    const at = Date.parse(String(c.call_date ?? c.scheduled_start ?? ""));
    if (!Number.isFinite(at)) continue;
    const t = c.meeting_type === "existing_customer" ? "existing_customer" : String(c.call_subtype);
    byType.set(t, [...(byType.get(t) ?? []), { dealId: c.deal_id, at }]);
  }

  for (const [type, occurrences] of byType) {
    if (only && type !== only) continue;
    console.log("\n" + "=".repeat(78));
    console.log(`${type.toUpperCase()}  (${occurrences.length} calls)`);
    console.log("=".repeat(78));

    let shown = 0;
    for (const occ of occurrences) {
      if (shown >= per) break;
      const { data: msgs } = await db
        .from("deal_messages")
        .select("graph_message_id, mailbox, sent_at, subject, from_email, customer_side")
        .eq("deal_id", occ.dealId)
        .eq("customer_side", false)
        .eq("is_calendar_response", false)
        .gte("sent_at", new Date(occ.at).toISOString())
        .lte("sent_at", new Date(occ.at + WINDOW_MS).toISOString())
        .order("sent_at", { ascending: true })
        .limit(1);
      const m = msgs?.[0];
      if (!m?.graph_message_id || !m.mailbox) continue;

      const body = await getMessageBody({
        tenantIdOrDomain: GRAPH_TENANT,
        mailbox: m.mailbox,
        messageId: m.graph_message_id,
      }).catch(() => null);
      if (!body) continue;
      const t = trimMessageBody(body).text;
      if (t.length < 120) continue;
      // A Teams invite or reminder is not a follow-up.
      if (isMeetingInviteBoilerplate(`${m.subject ?? ""}\n${t}`)) continue;
      if (stripMailChrome(t).length < 120) continue;
      // Exclude anything the rep sent that is substantially DealRipe's draft.
      const { data: ours } = await db
        .from("sent_messages")
        .select("body_text")
        .eq("deal_id", occ.dealId)
        .limit(8);
      if ((ours ?? []).some((d) => overlaps(String(d.body_text ?? ""), t))) {
        console.log(`\n--- (skipped: matches a DealRipe draft on this deal)`);
        continue;
      }

      shown++;
      const words = t.split(/\s+/).filter(Boolean).length;
      const bullets = (t.match(/^\s*(?:[-•*]|\d+[.)])\s+/gm) ?? []).length;
      const hasRecapHeader = /\b(recap|summary|what we (?:covered|discussed)|as discussed)\b/i.test(t);
      const hasNextHeader = /\bnext steps?\b/i.test(t);
      console.log(
        `\n--- ${String(m.from_email).split("@")[0]}  ${String(m.sent_at).slice(0, 10)}  ` +
          `${words}w  ${bullets} bullets  recap-header=${hasRecapHeader}  next-steps-header=${hasNextHeader}`,
      );
      console.log(t.slice(0, 1300));
    }
    if (shown === 0) console.log("  (no rep-written follow-up found within 48h)");
  }
  console.log("");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
