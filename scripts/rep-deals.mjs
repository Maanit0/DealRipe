// List one rep's deals with their Rolldog link status, last captured call, and
// gate count, so you can walk a rep through which deals still need a Rolldog ID.
// Plain Node (no tsx). Read-only.
//
//   node scripts/rep-deals.mjs .env.local ebencomo@magaya.com
//   node scripts/rep-deals.mjs .env.local jlopez@magaya.com

import { readFileSync } from "node:fs";

const envPath = process.argv[2] ?? ".env.local";
const rep = (process.argv[3] ?? "").toLowerCase();
if (!rep) throw new Error("usage: node scripts/rep-deals.mjs .env.local <rep-email>");

const env = {};
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;

async function q(path) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// Seeded pilot deals are mapped to their Rolldog opp in pilot-config
// (PILOT_DEAL_ROLLDOG_IDS), not the deals column. Mirror that map here so they
// count as linked. external_id slug -> Rolldog opp id.
const STATIC_OPP = {
  morneau: "81714",
  alba: "78273",
  martinbrower: "80566",
  omniva: "80983",
  iff: "80018",
  norwegian: "77742",
  dutyfreeamericas: "81454",
  seino: "80189",
  capito: "81531",
  cltair: "81473",
};

const tid = (await q(`tenants?slug=eq.magaya&select=id`))[0]?.id;
const deals = await q(
  `deals?tenant_id=eq.${tid}&rep_email=eq.${encodeURIComponent(rep)}&select=id,account,external_id,rolldog_opportunity_id&order=account`,
);
const fe = await q(`field_extractions?tenant_id=eq.${tid}&select=deal_id,status`);
const calls = await q(`calls?tenant_id=eq.${tid}&select=deal_id,scheduled_start,call_date,outcome&order=scheduled_start.desc`);

const gatesByDeal = {};
for (const r of fe) if (r.status === "Yes") gatesByDeal[r.deal_id] = (gatesByDeal[r.deal_id] ?? 0) + 1;
const lastCallByDeal = {};
for (const c of calls) if (!lastCallByDeal[c.deal_id]) lastCallByDeal[c.deal_id] = c;

const linked = [];
const needsId = [];
for (const d of deals) {
  const g = gatesByDeal[d.id] ?? 0;
  const lc = lastCallByDeal[d.id];
  const lcDate = lc ? (lc.scheduled_start ?? lc.call_date ?? "").slice(0, 10) : "no calls yet";
  const opp = d.rolldog_opportunity_id ?? STATIC_OPP[d.external_id] ?? null;
  const row = { account: d.account, ext: d.external_id, opp, gates: g, lastCall: lcDate };
  (opp ? linked : needsId).push(row);
}

console.log(`\n${rep} — ${deals.length} deals\n${"=".repeat(60)}`);
console.log(`\nLINKED to Rolldog (write-back on): ${linked.length}`);
for (const r of linked) console.log(`  ✓ ${r.account}  opp ${r.opp}  · ${r.gates} gates · last call ${r.lastCall}`);
console.log(`\nNEEDS A ROLLDOG ID (ask Eduardo on the call): ${needsId.length}`);
for (const r of needsId) console.log(`  • ${r.account}  [${r.ext}]  · ${r.gates} gates · last call ${r.lastCall}`);
console.log();
