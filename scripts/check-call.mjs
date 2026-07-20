// Answer "is there a transcript for this deal's call, or was it a no-show?"
// Prints each call with its outcome, duration, invitee count, whether a
// transcript row exists (and its length), and how many gates were extracted.
//
//   node scripts/check-call.mjs .env.local aeronet
//
// Read-only.

import { readFileSync } from "node:fs";

const envPath = process.argv[2] ?? ".env.local";
const needle = (process.argv[3] ?? "").toLowerCase();
if (!needle) throw new Error("usage: node scripts/check-call.mjs .env.local <account-substring>");

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
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const tid = (await q(`tenants?slug=eq.magaya&select=id`))[0]?.id;
const deals = await q(
  `deals?tenant_id=eq.${tid}&account=ilike.*${needle}*&select=id,account,external_id`,
);
if (deals.length === 0) { console.log("no deal matches"); process.exit(0); }

for (const d of deals) {
  console.log(`\n● ${d.account}  [${d.external_id}]`);
  const calls = await q(
    `calls?deal_id=eq.${d.id}&select=id,scheduled_start,call_date,outcome,duration_minutes,recall_bot_id,participants&order=scheduled_start.desc`,
  );
  for (const c of calls) {
    const inv = Array.isArray(c.participants) ? c.participants.length : 0;
    const tr = await q(`transcripts?call_id=eq.${c.id}&select=body`);
    const bodyLen = tr[0]?.body ? tr[0].body.length : 0;
    const runs = await q(`extraction_runs?call_id=eq.${c.id}&select=id`).catch(() => []);
    console.log(
      `   ${c.scheduled_start ?? c.call_date}  outcome=${c.outcome ?? "(none)"}  dur=${c.duration_minutes ?? "null"}m  bot=${c.recall_bot_id ? "yes" : "no"}  invitees=${inv}`,
    );
    console.log(
      `     transcript: ${bodyLen > 0 ? `YES (${bodyLen} chars)` : "NONE"}   extraction runs: ${runs.length}`,
    );
  }
}
console.log();
