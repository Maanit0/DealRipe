/**
 * Which weekly digests actually went out, and to whom.
 *
 * The recipient list being configured and the mail having been delivered are
 * different claims, and a rep asking "am I getting these" is asking about the
 * second one. This reads what was recorded as sent rather than what was
 * intended.
 *
 * READ ONLY.
 *
 *   npx tsx scripts/digest-log.ts
 *   npx tsx scripts/digest-log.ts --weeks 8
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const weeks = Number(arg("--weeks") ?? "8");
  const since = new Date(Date.now() - weeks * 7 * 86_400_000).toISOString();

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const res = await db
    .from("sent_messages")
    .select("id, kind, to_email, subject, sent_at")
    .eq("tenant_id", tenantId)
    .gte("sent_at", since)
    .order("sent_at", { ascending: false });
  if (res.error) throw new Error(res.error.message);

  const rows = (res.data ?? []) as Array<{
    id: string; kind: string | null; to_email: string | null;
    subject: string | null; sent_at: string | null;
  }>;

  const digests = rows.filter((r) => String(r.kind ?? "").includes("digest"));

  console.log(`\nLast ${weeks} weeks: ${rows.length} message(s) recorded, ${digests.length} digest(s).`);

  if (digests.length === 0) {
    console.log(`\nNo digest rows. That is "none recorded", not proof none were sent:`);
    console.log(`if the kind is stored under a different label this query misses them.`);
    console.log(`Kinds present in the window: ${[...new Set(rows.map((r) => r.kind ?? "(null)"))].join(", ")}\n`);
    return;
  }

  // Group by send, since one digest run produces a row per recipient.
  const byDay = new Map<string, Array<{ to: string; subject: string; at: string }>>();
  for (const d of digests) {
    const day = String(d.sent_at ?? "").slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push({ to: d.to_email ?? "(no address)", subject: d.subject ?? "", at: String(d.sent_at ?? "") });
    byDay.set(day, list);
  }

  for (const [day, list] of [...byDay.entries()].sort().reverse()) {
    console.log(`\n${day}   ${list.length} recipient(s)`);
    console.log(`  ${list[0].subject}`);
    for (const r of list) console.log(`    ${r.to}`);
  }

  const everyone = [...new Set(digests.map((d) => d.to_email ?? "").filter(Boolean))].sort();
  console.log(`\n${"-".repeat(70)}`);
  console.log(`Distinct recipients across the window:`);
  for (const e of everyone) {
    const n = digests.filter((d) => d.to_email === e).length;
    console.log(`  ${e.padEnd(34)} ${n} digest(s)`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
