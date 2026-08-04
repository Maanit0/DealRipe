/**
 * Add the customer-side calendar invitees of a call as deal contacts, including
 * invited-but-silent people (no-shows). The transcript extractor only captures
 * people who SPOKE; this fills in the invited stakeholders who did not, marked
 * never-contacted, so a no-show deal shows the point of contact instead of "0
 * contacts". Manual and reviewable (dry-run by default), so it never auto-adds
 * calendar noise the way an always-on version might.
 *
 *   npx tsx scripts/add-invitee-contacts.ts --account "Flyfreight"
 *   npx tsx scripts/add-invitee-contacts.ts --call <callId> --apply
 *
 * Runs on your Mac with .env.local (Supabase access).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const titleCase = (s: string): string => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const looksLikeEmail = (s: string): boolean => /@/.test(s);

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  let callId = arg("--call") ?? null;
  if (!callId) {
    const acct = arg("--account");
    if (!acct) {
      console.error('Provide --call <callId> or --account "<name>".');
      process.exit(1);
    }
    const deal = await db.from("deals").select("id").eq("tenant_id", tenantId).ilike("account", `%${acct}%`).limit(1).maybeSingle();
    if (!deal.data) {
      console.error(`No deal matched "${acct}".`);
      process.exit(1);
    }
    const c = await db
      .from("calls")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("deal_id", deal.data.id)
      .order("scheduled_start", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!c.data) {
      console.error("Deal has no calls.");
      process.exit(1);
    }
    callId = c.data.id;
  }

  const call = await db
    .from("calls")
    .select("id, deal_id, participants, scheduled_start, call_date")
    .eq("tenant_id", tenantId)
    .eq("id", callId)
    .maybeSingle();
  if (!call.data) {
    console.error(`Call ${callId} not found.`);
    process.exit(1);
  }
  const deal = await db.from("deals").select("id, account").eq("tenant_id", tenantId).eq("id", call.data.deal_id).maybeSingle();
  if (!deal.data) {
    console.error("Deal not found.");
    process.exit(1);
  }
  const callDate = call.data.scheduled_start ?? call.data.call_date ?? null;

  const parts = Array.isArray(call.data.participants) ? (call.data.participants as Array<Record<string, unknown>>) : [];
  const customers = parts.filter((p) => {
    const email = typeof p.email === "string" ? p.email : "";
    const domain = email.split("@")[1]?.toLowerCase();
    return domain && domain !== "magaya.com";
  });
  if (customers.length === 0) {
    console.log(`No customer-side invitees on this call (deal: ${deal.data.account}). Nothing to add.`);
    return;
  }

  // Speaker tokens for spoke detection.
  const t = await db.from("transcripts").select("body").eq("tenant_id", tenantId).eq("call_id", callId).maybeSingle();
  const body = t.data?.body ?? "";
  const tokens = new Set<string>();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const idx = line.indexOf(":");
    if (idx <= 0 || idx > 60) continue;
    let label = line.slice(0, idx);
    const pipe = label.indexOf("|");
    if (pipe > 0) label = label.slice(0, pipe);
    for (const tok of label.trim().toLowerCase().split(/[^a-záéíóúñü]+/i)) if (tok.length >= 3) tokens.add(tok);
  }
  const spoke = (p: Record<string, unknown>): boolean => {
    const identity: string[] = [];
    const name = typeof p.name === "string" ? p.name : null;
    if (name) for (const w of name.toLowerCase().split(/[^a-záéíóúñü]+/i)) if (w.length >= 2) identity.push(w);
    const local = (typeof p.email === "string" ? p.email : "").split("@")[0]?.toLowerCase();
    if (local) identity.push(local);
    return identity.some((id) => [...tokens].some((s) => s === id || (s.length >= 4 && id.includes(s)) || (id.length >= 4 && s.includes(id))));
  };

  const existing = await db.from("contacts").select("name").eq("tenant_id", tenantId).eq("deal_id", deal.data.id);
  const have = new Set(((existing.data ?? []) as Array<{ name: string }>).map((c) => c.name.trim().toLowerCase()));

  type ContactInsert = {
    tenant_id: string;
    deal_id: string;
    external_id: string;
    name: string;
    role: string;
    relationship: "unknown";
    last_contacted_at: string | null;
  };
  const rows: ContactInsert[] = [];
  for (const p of customers) {
    const email = (typeof p.email === "string" ? p.email : "").toLowerCase();
    const rawName = typeof p.name === "string" ? p.name : "";
    const name = rawName && !looksLikeEmail(rawName) ? rawName.trim() : titleCase(email.split("@")[0] ?? email);
    if (have.has(name.toLowerCase())) continue;
    have.add(name.toLowerCase());
    const s = spoke(p);
    rows.push({
      tenant_id: tenantId,
      deal_id: deal.data.id,
      external_id: `invite:${email}`,
      name,
      role: s ? "Point of contact" : "Invited, no-show",
      relationship: "unknown",
      last_contacted_at: s && callDate ? callDate : null,
    });
  }

  console.log(`\nDeal: ${deal.data.account}  ·  call ${callId}`);
  if (rows.length === 0) {
    console.log("All customer invitees are already contacts. Nothing to add.");
    return;
  }
  for (const r of rows) console.log(`  + ${r.name}  [${r.role}]  ${r.last_contacted_at ? "contacted " + String(r.last_contacted_at).slice(0, 10) : "never contacted"}`);

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to add ${rows.length} contact(s).\n`);
    return;
  }
  const ins = await db.from("contacts").insert(rows);
  if (ins.error) {
    console.error(`Insert failed: ${ins.error.message}`);
    process.exit(1);
  }
  console.log(`\nAdded ${rows.length} contact(s) to ${deal.data.account}.\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
