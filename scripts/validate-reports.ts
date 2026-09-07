/**
 * Check the generated Monday reports against the raw sources, and fail on any
 * claim the evidence contradicts. READ ONLY.
 *
 *   npx tsx scripts/validate-reports.ts
 *   npx tsx scripts/validate-reports.ts --review .previews/monday-activity.html
 *
 * This validates the ARTIFACT, not the builder's intermediate state, because
 * the artifact is what Mark reads and a contradiction that only appears after
 * rendering is still a contradiction.
 *
 * Every check below exists because the September 7 reconciliation found the
 * failure in a live document. None of them names a company: they compare what
 * a row asserts against what the sources establish for that row's deal.
 *
 * Exits non-zero when a material contradiction survives, so it can gate a send.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";

import { isMachineSender, meetingFacts } from "../lib/meeting-state";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const DAY = 86_400_000;

type Finding = { deal: string; rule: string; claim: string; evidence: string };

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Rendered rows, as text, keyed by the account name the row leads with. */
function rowsFromHtml(html: string): Array<{ account: string; text: string }> {
  const body = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, "");
  const out: Array<{ account: string; text: string }> = [];
  for (const m of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
      c[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(),
    );
    if (cells.length < 2) continue;
    const account = cells[0].split("·")[0].trim().replace(/\s+(Eduardo|Alexandra|Juan|Ariel|Steven|Daniel)$/i, "").trim();
    if (!account || account.toLowerCase() === "deal") continue;
    out.push({ account, text: cells.join(" | ") });
  }
  return out;
}

async function main(): Promise<void> {
  const reviewPath = arg("--review") ?? ".previews/monday-activity.html";
  const html = readFileSync(reviewPath, "utf8");
  const rows = rowsFromHtml(html);
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");
  const now = Date.now();

  const { data: deals } = await db.from("deals").select("id, account").eq("tenant_id", tenantId);
  const byName = new Map((deals ?? []).map((d) => [d.account.toLowerCase(), d.id]));

  const findings: Finding[] = [];
  let checked = 0;

  for (const row of rows) {
    // Match the rendered account back to a deal. Rendered names are display
    // names and can differ from deals.account, so try both directions.
    const key = row.account.toLowerCase();
    let dealId = byName.get(key);
    if (!dealId) {
      for (const [n, id] of byName) {
        if (n.length > 3 && (key.includes(n) || n.includes(key.slice(0, Math.max(6, n.length))))) { dealId = id; break; }
      }
    }
    if (!dealId) continue;
    checked++;

    const { data: msgs } = await db
      .from("deal_messages")
      .select("customer_side, sent_at, from_email")
      .eq("deal_id", dealId)
      .eq("is_calendar_response", false)
      .order("sent_at", { ascending: false })
      .limit(30);
    const lastHuman = (msgs ?? []).find((m) => m.customer_side && m.sent_at && !isMachineSender(m.from_email));
    const humanDays = lastHuman?.sent_at ? Math.floor((now - Date.parse(lastHuman.sent_at)) / DAY) : null;

    const { data: calls } = await db
      .from("calls")
      .select("id, scheduled_start, call_date, outcome, capture_class, title")
      .eq("deal_id", dealId);
    const ids = (calls ?? []).map((c) => c.id);
    const chars = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data: tx } = await db.from("transcripts").select("call_id, body").in("call_id", ids.slice(i, i + 100));
      for (const t of tx ?? []) chars.set(t.call_id, String(t.body ?? "").length);
    }
    const facts = (calls ?? []).map((c) => ({ c, f: meetingFacts({ ...c, transcriptChars: chars.get(c.id) ?? 0 }, now) }));
    const future = facts.filter((x) => x.f.occurrence === "scheduled");
    

    // A. ACTIVITY. A silence claim contradicted by a human customer message.
    const silence = row.text.match(/no reply (?:from [\w\s]+ )?in (\d+) days|(\d+)d silent|gone silent for (\d+) days/i);
    if (silence && humanDays !== null) {
      const claimed = Number(silence[1] ?? silence[2] ?? silence[3]);
      if (Number.isFinite(claimed) && humanDays + 2 < claimed) {
        findings.push({
          deal: row.account,
          rule: "activity/silence-contradicted",
          claim: silence[0],
          evidence: `a human customer message exists ${humanDays}d ago (${String(lastHuman?.from_email)})`,
        });
      }
    }

    // B. NEXT STEP. "never booked" where a meeting ran SINCE the commitment.
    //
    // "Since" is the whole rule. The meeting on which a commitment is made
    // cannot discharge it, and an earlier meeting cannot either. Testing merely
    // that some meeting ever ran flagged five rows where the commitment was
    // agreed on the last call and genuinely never booked after it, which is the
    // validator inventing work rather than finding it.
    if (/never booked/i.test(row.text)) {
      const { data: fx } = await db
        .from("field_extractions")
        .select("updated_at")
        .eq("deal_id", dealId)
        .ilike("framework_field_key", "%next%step%")
        .order("updated_at", { ascending: false })
        .limit(1);
      const agreedAt = fx?.[0]?.updated_at ? Date.parse(fx[0].updated_at) : null;
      const after = agreedAt
        ? facts.find((x) => {
            const at = x.c.call_date ?? x.c.scheduled_start;
            return (
              (x.f.occurrence === "ran" || x.f.occurrence === "no_show") &&
              at !== null &&
              Date.parse(at) > agreedAt
            );
          })
        : undefined;
      if (after) {
        findings.push({
          deal: row.account,
          rule: "nextstep/never-booked-but-ran",
          claim: "Agreed, never booked",
          evidence: `${after.f.phrase} (${after.f.basis}), after the commitment was recorded`,
        });
      }
    }

    // C. NEXT STEP. "None" while a future meeting is on the calendar.
    if (/\|\s*None\s*\|/i.test(row.text) && future.length > 0) {
      findings.push({
        deal: row.account,
        rule: "nextstep/none-but-booked",
        claim: "Next step: None",
        evidence: `future meeting ${future[0].c.scheduled_start} "${future[0].c.title ?? ""}"`,
      });
    }

    // D. DATE. Relative language frozen from an older source.
    const stale = row.text.match(/\b(today|tomorrow|yesterday|this (?:morning|afternoon|Friday|week)|next morning|tonight)\b/i);
    if (stale) {
      findings.push({
        deal: row.account,
        rule: "date/stale-relative-language",
        claim: stale[0],
        evidence: "a weekly report must carry absolute dates; relative words resolve against the source timestamp, not the send date",
      });
    }

    // E. PROVENANCE. "on the call" with no captured conversation anywhere.
    if (/\bon the call\b/i.test(row.text) && !facts.some((x) => x.f.content === "captured")) {
      findings.push({
        deal: row.account,
        rule: "provenance/call-without-content",
        claim: "on the call",
        evidence: "no meeting on this deal has a captured conversation",
      });
    }
  }

  console.log(`\nValidated ${checked} rendered rows against raw sources.\n`);
  if (findings.length === 0) {
    console.log("  No material contradiction found.\n");
    process.exit(0);
  }
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  for (const [rule, fs] of byRule) {
    console.log(`  ${rule}  (${fs.length})`);
    for (const f of fs) {
      console.log(`     ${f.deal}`);
      console.log(`        claims:   ${f.claim}`);
      console.log(`        evidence: ${f.evidence}`);
    }
    console.log("");
  }
  console.log(`  ${findings.length} contradiction(s). This is the send gate.\n`);
  process.exit(1);
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(2);
});
