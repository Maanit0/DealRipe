// Pull the live Magaya deal context (deals active in the last N days) straight
// from Supabase and flag the signals worth putting in Mark's pipeline-review
// brief. Plain Node (no tsx/esbuild), reads .env.local for credentials.
//
//   node scripts/pull-magaya.mjs .env.local
//   node scripts/pull-magaya.mjs .env.local 14      # look back 14 days
//
// Read-only. Prints nothing sensitive (no keys).

import { readFileSync } from "node:fs";

const envPath = process.argv[2] ?? ".env.local";
const lookback = Number(process.argv[3] ?? 8);
const env = {};
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) throw new Error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

async function q(path) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled", "placeholder"]);

const tid = (await q(`tenants?slug=eq.magaya&select=id`))[0]?.id;
const deals = await q(
  `deals?tenant_id=eq.${tid}&select=id,external_id,account,stage_key,rolldog_opportunity_id&order=account`,
);
const since = new Date(Date.now() - lookback * 864e5).toISOString().slice(0, 10);
const calls = await q(
  `calls?tenant_id=eq.${tid}&call_date=gte.${since}&select=id,deal_id,call_date,scheduled_start,outcome,duration_minutes,participants&order=scheduled_start.desc`,
);
const fe = await q(
  `field_extractions?tenant_id=eq.${tid}&select=deal_id,framework_field_key,status,answer,evidence`,
);
const contacts = await q(
  `contacts?tenant_id=eq.${tid}&select=deal_id,name,role,relationship,last_contacted_at`,
);

const group = (arr) => arr.reduce((m, r) => ((m[r.deal_id] ??= []).push(r), m), {});
const callsBy = group(calls), feBy = group(fe), contactsBy = group(contacts);

console.log(`Magaya  ·  deals=${deals.length}  ·  calls since ${since}=${calls.length}\n${"=".repeat(72)}`);

for (const d of deals) {
  const dc = callsBy[d.id] ?? [];
  if (dc.length === 0) continue;
  const conf = (feBy[d.id] ?? []).filter((x) => x.status === "Yes");
  const ct = contactsBy[d.id] ?? [];

  const signals = [];
  if (dc.some((c) => c.outcome && NO_CONTENT.has(c.outcome))) signals.push("NO-SHOW / placeholder call");
  const eb = ct.filter((p) => /economic|budget|cfo/i.test(p.relationship ?? "") || /economic|budget|cfo/i.test(p.role ?? ""));
  if (eb.some((p) => !p.last_contacted_at)) signals.push("ECONOMIC BUYER never on a call");
  const dm = ct.filter((p) => /decision|final/i.test(p.relationship ?? "") || /decision|final/i.test(p.role ?? ""));
  if (dm.some((p) => !p.last_contacted_at)) signals.push("DECISION-MAKER mentioned but never engaged");
  if (conf.length <= 3) signals.push(`thin qualification (${conf.length} gates confirmed)`);
  if (!d.rolldog_opportunity_id) signals.push("not linked to Rolldog");

  console.log(`\n● ${d.account}   [${d.external_id}]`);
  console.log(`   stage=${d.stage_key ?? "?"}   rolldogOpp=${d.rolldog_opportunity_id ?? "—"}   gatesConfirmed=${conf.length}`);
  for (const c of dc) {
    const inv = Array.isArray(c.participants) ? c.participants.length : 0;
    console.log(`   call ${(c.scheduled_start ?? c.call_date)}  outcome=${c.outcome ?? "captured"}  dur=${c.duration_minutes ?? "?"}m  invitees=${inv}`);
  }
  for (const p of ct) {
    console.log(`     contact: ${p.name}  (${p.role ?? "?"} / ${p.relationship ?? "?"})  last=${p.last_contacted_at ?? "never"}`);
  }
  if (signals.length) console.log(`   >> SIGNALS: ${signals.join("  ·  ")}`);
}
console.log(`\n${"=".repeat(72)}`);
