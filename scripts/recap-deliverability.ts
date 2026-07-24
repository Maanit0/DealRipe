/**
 * Debugs why a rep isn't receiving recaps that show as "sent". For each recap /
 * no-show email to the rep, it asks Resend the actual delivery status (delivered,
 * bounced, complained, delayed). This tells you whether the mail reached Magaya
 * and got filtered (allowlist fix) or never got there (domain-auth / bounce fix).
 *
 * Runs on your Mac (reads Supabase + Resend API). Sends nothing.
 *
 *   npx tsx scripts/recap-deliverability.ts --rep juan
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { repName } from "../lib/display-names";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function dt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "—";
  }
}

async function resendStatus(id: string, key: string): Promise<string> {
  if (!id) return "(dry-run archive, not emailed)";
  try {
    const res = await fetch(`https://api.resend.com/emails/${id}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return `resend ${res.status}`;
    const j = (await res.json()) as { last_event?: string };
    return j.last_event ?? "(no event)";
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function main(): Promise<void> {
  const rep = (arg("--rep") ?? "juan").toLowerCase();
  const key = process.env.RESEND_API_KEY ?? "";
  console.log(`\nMAIL_FROM = ${process.env.MAIL_FROM ?? "(unset)"}\n`);

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const dealsRes = await db.from("deals").select("id, account, rep_email").eq("tenant_id", tenantId);
  const deals = ((dealsRes.data ?? []) as Array<{ id: string; account: string; rep_email: string | null }>).filter(
    (x) => (x.rep_email ?? "").toLowerCase().includes(rep) || repName(x.rep_email).toLowerCase().includes(rep),
  );
  const acct = new Map(deals.map((x) => [x.id, x.account] as const));
  const dealIds = deals.map((x) => x.id);

  const msgRes = await db
    .from("sent_messages")
    .select("deal_id, kind, to_email, subject, provider_id, sent_at")
    .eq("tenant_id", tenantId)
    .in("deal_id", dealIds)
    .in("kind", ["recap", "no_show_draft"])
    .order("sent_at", { ascending: false });
  const msgs = (msgRes.data ?? []) as Array<{ deal_id: string; kind: string; to_email: string; subject: string; provider_id: string | null; sent_at: string | null }>;

  console.log(`Recap / no-show emails to ${rep.toUpperCase()}: ${msgs.length}\n`);
  for (const m of msgs) {
    const status = key ? await resendStatus(m.provider_id ?? "", key) : "(no RESEND_API_KEY)";
    console.log(`  ${dt(m.sent_at)}  [${m.kind}]  ${acct.get(m.deal_id) ?? "?"}  -> ${m.to_email}`);
    console.log(`      resend status: ${status}   id: ${m.provider_id ?? "—"}`);
  }
  console.log(`\nRead: "delivered" = it reached Magaya and Barracuda filtered it (allowlist the sender).`);
  console.log(`      "bounced"/"complained" = it never landed (domain auth / Magaya reject).\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
