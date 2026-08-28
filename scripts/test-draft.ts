/**
 * Smoke test the follow-up draft, end to end, WITHOUT touching any mailbox.
 *
 * generateFollowUpDraft composes and returns; createFollowUpDraft is what
 * writes. So this exercises the whole path that matters, the prompt build and
 * the model call, and creates nothing.
 *
 * It exists because of 2026-08-28. 7ac7e42 removed a local named `open` from
 * the prompt and left one reader behind. tsc passed, because tsconfig carries
 * the DOM lib and `open` is a browser global, and every draft for every rep
 * threw "open is not defined" for six hours. A single run of this before the
 * deploy would have caught it.
 *
 * Run it before trusting a draft change:
 *   npx tsx scripts/test-draft.ts                 # newest captured call
 *   npx tsx scripts/test-draft.ts --rep sjohnson  # a given rep's newest
 *   npx tsx scripts/test-draft.ts --all           # one per rep, all six
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { generateFollowUpDraft } from "../lib/followup-draft";
import { domainOf } from "../lib/graph-mail";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };

async function one(rep?: string): Promise<boolean> {
  let q = sb.from("calls")
    .select("id, title, scheduled_start, participants, meeting_type, call_subtype, deals!inner(account, rep_email)")
    .eq("outcome", "captured").order("scheduled_start", { ascending: false }).limit(1);
  if (rep) q = q.ilike("deals.rep_email", `%${rep}%`);
  const { data } = await q.maybeSingle();
  const c = data as unknown as {
    id: string; title: string | null; scheduled_start: string; participants: unknown;
    meeting_type: string | null; call_subtype: string | null;
    deals: { account: string; rep_email: string | null };
  } | null;
  if (!c) { console.log(`  ${rep ?? "any"}: no captured call to test against`); return true; }

  const tr = await sb.from("transcripts").select("body").eq("call_id", c.id).maybeSingle();
  const transcript = tr.data?.body ?? "";
  const people = Array.isArray(c.participants) ? (c.participants as Array<{ email?: string | null }>) : [];
  const emails = people.map((p) => String(p?.email ?? "").toLowerCase()).filter((e) => e.includes("@") && domainOf(e) !== "magaya.com");
  const label = `${String(c.deals.rep_email).split("@")[0]} / ${c.deals.account}`;

  if (!c.deals.rep_email || emails.length === 0 || transcript.length < 50) {
    console.log(`  ${label}: skipped (rep ${c.deals.rep_email ? "ok" : "missing"}, ${emails.length} external, ${transcript.length} transcript chars)`);
    return true;
  }
  try {
    const draft = await generateFollowUpDraft({
      mailbox: c.deals.rep_email,
      account: c.deals.account,
      customerDomains: [...new Set(emails.map((e) => domainOf(e)).filter(Boolean))] as string[],
      customerEmails: emails,
      callSubtype: c.call_subtype,
      transcript,
      callDate: c.scheduled_start,
      // No summary on purpose: the general-recap path is the one that used to
      // skip silently, so the test should run without it.
    });
    if (!draft) { console.log(`  FAIL ${label}: generateFollowUpDraft returned null`); return false; }
    console.log(`  ok   ${label}`);
    console.log(`         subj: ${draft.subject}`);
    console.log(`         ${draft.body.replace(/\s+/g, " ").slice(0, 150)}...`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

(async () => {
  console.log("\n  Composing real drafts. Nothing is written to any mailbox.\n");
  const reps = process.argv.includes("--all")
    ? ["jlopez", "ebencomo", "arodriguez", "asuntrup", "dblitstein", "sjohnson"]
    : [arg("--rep")];
  let ok = true;
  for (const r of reps) ok = (await one(r)) && ok;
  console.log(ok ? "\n  PASS\n" : "\n  FAIL: the draft path is broken for at least one rep.\n");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ERR:", e instanceof Error ? e.message : e); process.exit(1); });
