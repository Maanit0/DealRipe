/**
 * Bring the rep feedback queue into .feedback/ so it can be worked on.
 *
 *   npx tsx scripts/sync-feedback.ts        write any new items, then list
 *   npx tsx scripts/sync-feedback.ts --list just list what is already there
 *
 * WHY A SYNC AND NOT THE CRON WRITING FILES. Vercel's filesystem is ephemeral
 * and the cron runs there, so it cannot put anything in this repo. The verdict
 * lives in the database, which is the only place both the cron and this machine
 * can see, and this materialises it here for triage.
 *
 * .feedback IS GITIGNORED AND MUST STAY THAT WAY. Each file quotes what we sent
 * a rep about a named account, which is call-derived content, and Magaya is
 * under NDA. Same rule that keeps mined_plays in the database.
 *
 * AN EXISTING FILE IS NEVER OVERWRITTEN. The file is the triage state: once it
 * exists, the status line in it is the truth and a re-sync leaves it alone.
 * That is why status is not in the database. If you delete a file it comes back
 * as open on the next sync, which is the right direction for a queue that must
 * not lose items.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import * as fs from "node:fs";
import * as path from "node:path";

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const DIR = ".feedback";

/** open -> someone should look. claimed -> being worked. fixed / dismissed -> done. */
const STATUSES = ["open", "claimed", "fixed", "dismissed"] as const;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 34);
}

function statusOf(file: string): string {
  const m = /^status:\s*(\w+)/m.exec(fs.readFileSync(file, "utf8"));
  return m ? m[1] : "unknown";
}

async function main(): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  const listOnly = process.argv.includes("--list");
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  let wrote = 0;
  if (!listOnly) {
    const { data, error } = await db
      .from("sent_messages")
      .select("id, kind, deal_id, to_email, subject, feedback, feedback_note, feedback_at, feedback_verdict")
      .eq("tenant_id", tenantId)
      .not("feedback_verdict", "is", null)
      .neq("feedback_verdict", "no_signal")
      .order("feedback_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(`could not read diagnosed feedback: ${error.message}`);

    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      let account = "unknown";
      if (r.deal_id) {
        const d = await db.from("deals").select("account").eq("id", String(r.deal_id)).maybeSingle();
        account = (d.data as { account?: string } | null)?.account ?? "unknown";
      }
      const day = String(r.feedback_at).slice(0, 10);
      const file = path.join(DIR, `${day}-${slug(account)}-${r.kind}-${String(r.id).slice(0, 8)}.md`);
      if (fs.existsSync(file)) continue;

      fs.writeFileSync(
        file,
        `---\n` +
          `status: open\n` +
          `verdict: ${r.feedback_verdict}\n` +
          `vote: ${r.feedback}\n` +
          `rep: ${r.to_email}\n` +
          `account: ${account}\n` +
          `artifact: ${r.kind}\n` +
          `at: ${r.feedback_at}\n` +
          `row: ${r.id}\n` +
          `---\n\n` +
          `# ${r.feedback === "down" ? "Thumbs down" : "Thumbs up"} on the ${r.kind}, ${account}\n\n` +
          `**Their note:** ${r.feedback_note ? String(r.feedback_note) : "_they left none_"}\n\n` +
          `**Subject:** ${r.subject}\n\n` +
          `## What to do\n\n` +
          `_Set status to claimed while working it, then fixed or dismissed._\n` +
          `_Dismissing is a real answer: not every vote is about the artifact._\n`,
        "utf8",
      );
      wrote += 1;
    }
  }

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".md"));
  const byStatus = new Map<string, string[]>();
  for (const f of files) {
    const st = statusOf(path.join(DIR, f));
    byStatus.set(st, [...(byStatus.get(st) ?? []), f]);
  }

  console.log(`\n${DIR}/  ${wrote} new, ${files.length} total\n`);
  for (const st of [...STATUSES, "unknown"]) {
    const list = byStatus.get(st) ?? [];
    if (list.length === 0) continue;
    console.log(`${st.toUpperCase()} (${list.length})`);
    for (const f of list) console.log(`  ${f}`);
    console.log();
  }
  if ((byStatus.get("open") ?? []).length === 0 && files.length > 0) console.log("  Nothing open.\n");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
