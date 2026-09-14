/**
 * EMPIRICAL capability audit. What can DealRipe actually observe, and how
 * populated is it on the live Magaya book?
 *
 *   npx tsx scripts/audit-data-capability.ts --section sf
 *   npx tsx scripts/audit-data-capability.ts --section local
 *
 * READ ONLY. Counts and field names; no customer prose.
 *
 * Naming is not capability. A field that exists on a describe and is null on
 * every record is not a source, and half this codebase's worst bugs came from
 * assuming otherwise: Account.Customer_Status__c reads 'Active' on 39,297 of
 * ~45,000 accounts and does not mean what it says.
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };

async function page<T>(t: string, c: string, tid: string | null): Promise<T[]> {
  const db = supabaseAdmin() as any; const o: T[] = [];
  for (let f = 0; ; f += 1000) {
    let q = db.from(t).select(c); if (tid) q = q.eq("tenant_id", tid);
    const r = await q.order("id", { ascending: true }).range(f, f + 999);
    if (r.error) throw new Error(`${t}: ${r.error.message}`);
    o.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break;
  } return o;
}
const pct = (a: number, b: number) => b ? `${String(Math.round(100*a/b)).padStart(3)}%` : "  n/a";

async function local(): Promise<void> {
  const tid = await resolveTenantId("magaya");
  const db = supabaseAdmin() as any;
  console.log(`\n${"=".repeat(72)}\n  LOCAL STORE: what DealRipe has persisted\n${"=".repeat(72)}`);
  for (const t of ["deals","calls","transcripts","deal_messages","contacts","deal_attachments",
                   "crm_field_events","crm_activities","calendar_response_events","rolldog_gate_events",
                   "rolldog_checklist_reads","field_extraction_events","deal_signal_snapshots","sent_messages",
                   "prescribed_actions","forecast_predictions","mined_plays","company_context_snapshots"]) {
    const r = await db.from(t).select("id", { count: "exact", head: true });
    if (r.error) { console.log(`  ${t.padEnd(28)} ABSENT (${r.error.message.slice(0,40)})`); continue; }
    const s = await db.from(t).select("*").limit(1);
    const cols = Object.keys((s.data ?? [{}])[0] ?? {}).length;
    console.log(`  ${t.padEnd(28)} ${String(r.count ?? 0).padStart(7)} rows, ${String(cols).padStart(2)} columns`);
  }

  // ---- identity keys present on deals ----
  const deals = await page<any>("deals","*",tid);
  const keys = ["salesforce_account_id","salesforce_link_confidence","rolldog_opportunity_id","external_id","rep_email","outcome_label"];
  console.log(`\n  DEAL IDENTITY KEYS  (n=${deals.length})`);
  for (const k of keys) {
    if (!(k in (deals[0] ?? {}))) { console.log(`    ${k.padEnd(30)} COLUMN ABSENT`); continue; }
    const n = deals.filter((d:any)=>d[k] !== null && d[k] !== undefined && d[k] !== "").length;
    console.log(`    ${k.padEnd(30)} ${String(n).padStart(4)} / ${deals.length}  ${pct(n,deals.length)}`);
  }
  console.log(`    ${"BOTH sf + rolldog".padEnd(30)} ${String(deals.filter((d:any)=>d.salesforce_account_id&&d.rolldog_opportunity_id).length).padStart(4)} / ${deals.length}`);
  console.log(`    ${"NEITHER".padEnd(30)} ${String(deals.filter((d:any)=>!d.salesforce_account_id&&!d.rolldog_opportunity_id).length).padStart(4)} / ${deals.length}`);

  // ---- multiple deals per account ----
  const byAcct = new Map<string,string[]>();
  for (const d of deals) if (d.salesforce_account_id) byAcct.set(d.salesforce_account_id,[...(byAcct.get(d.salesforce_account_id)??[]),d.account]);
  const multi = [...byAcct.entries()].filter(([,v])=>v.length>1);
  console.log(`\n  MULTI-DEAL ACCOUNTS`);
  console.log(`    salesforce accounts linked:            ${byAcct.size}`);
  console.log(`    accounts carrying >1 DealRipe deal:    ${multi.length}`);
  for (const [,v] of multi.slice(0,8)) console.log(`      ${v.join("  |  ")}`);

  // ---- email capability ----
  const m = await db.from("deal_messages").select("*").limit(1);
  console.log(`\n  EMAIL COLUMNS AVAILABLE\n    ${Object.keys((m.data??[{}])[0]??{}).join(", ")}`);
  const msgs = await page<any>("deal_messages","id, internet_message_id, graph_message_id, conversation_id, to_emails, cc_emails, body_status, has_attachments, attachment_status, sent_at, is_machine_sender",tid);
  console.log(`\n  EMAIL POPULATION  (n=${msgs.length})`);
  for (const k of ["internet_message_id","graph_message_id","conversation_id","to_emails","cc_emails","sent_at"]) {
    const n = msgs.filter((x:any)=>x[k]!==null&&x[k]!==undefined&&(Array.isArray(x[k])?x[k].length:String(x[k]).length)).length;
    console.log(`    ${k.padEnd(24)} ${pct(n,msgs.length)}`);
  }
  console.log(`\n  ATTACHMENT STATE`);
  const as = new Map<string,number>(); for (const x of msgs) as.set(String(x.attachment_status??"NULL"),(as.get(String(x.attachment_status??"NULL"))??0)+1);
  for (const [k,v] of [...as].sort((a,b)=>b[1]-a[1])) console.log(`    ${k.padEnd(24)} ${v}`);

  // ---- calls / calendar ----
  const calls = await page<any>("calls","*",tid);
  console.log(`\n  CALL COLUMNS\n    ${Object.keys(calls[0]??{}).join(", ")}`);
  console.log(`\n  CALL / CALENDAR LINKAGE  (n=${calls.length})`);
  for (const k of ["ical_uid","graph_event_id","organizer_email","participants","recall_bot_id","deal_id","capture_class"]) {
    if (!(k in (calls[0]??{}))) { console.log(`    ${k.padEnd(24)} COLUMN ABSENT`); continue; }
    const n = calls.filter((c:any)=>c[k]!==null&&c[k]!==undefined&&(Array.isArray(c[k])?c[k].length:String(c[k]).length)).length;
    console.log(`    ${k.padEnd(24)} ${pct(n,calls.length)}`);
  }
  // roster richness
  const withResp = calls.filter((c:any)=>Array.isArray(c.participants)&&c.participants.some((p:any)=>p?.responseStatus&&p.responseStatus!=="none"));
  console.log(`    roster with a real RSVP  ${pct(withResp.length,calls.length)}`);

  // ---- contacts ----
  const cts = await page<any>("contacts","*",tid);
  console.log(`\n  CONTACTS  (n=${cts.length})\n    columns: ${Object.keys(cts[0]??{}).join(", ")}`);
  if (cts.length) {
    for (const k of Object.keys(cts[0])) {
      const n = cts.filter((c:any)=>c[k]!==null&&c[k]!==undefined&&String(c[k]).length).length;
      if (n < cts.length) console.log(`      ${k.padEnd(24)} ${pct(n,cts.length)} populated`);
    }
  }
  const dealsWithContacts = new Set(cts.map((c:any)=>c.deal_id)).size;
  console.log(`    deals with >=1 contact row: ${dealsWithContacts} of ${deals.length}  ${pct(dealsWithContacts,deals.length)}`);

  // ---- crm history depth ----
  const fe = await page<any>("crm_field_events","id, field, changed_at, changed_by, opportunity_id, old_value, new_value",tid);
  console.log(`\n  CRM FIELD HISTORY  (n=${fe.length})`);
  const f = new Map<string,number>(); for (const x of fe) f.set(String(x.field),(f.get(String(x.field))??0)+1);
  for (const [k,v] of [...f].sort((a,b)=>b[1]-a[1])) console.log(`    ${k.padEnd(24)} ${v}`);
  const dates = fe.map((x:any)=>String(x.changed_at).slice(0,10)).sort();
  console.log(`    span: ${dates[0]} -> ${dates[dates.length-1]}`);
  console.log(`    has changed_by: ${pct(fe.filter((x:any)=>x.changed_by).length,fe.length)}`);
  console.log("");
}
async function main(){ await local(); }
main().catch((e)=>{console.error("Unexpected error:",e.message??e);process.exit(1);});
