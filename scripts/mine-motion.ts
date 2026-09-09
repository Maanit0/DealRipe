/**
 * What reps actually DID, across both channels, against what happened next.
 *
 *   npx tsx scripts/mine-motion.ts
 *
 * READ ONLY, and it prints no customer text: counts and rates only.
 *
 * WHY THIS EXISTS ALONGSIDE lib/sales-brain.ts. The brain reads
 * prescribed_actions, which is only what DealRipe HAPPENED TO SUGGEST: 289
 * usable rows, and biased by our own choices about what to prescribe. The
 * transcripts and the mailbox hold everything the reps did whether we suggested
 * it or not, which is the bigger and less biased question.
 *
 * TWO CHANNELS, because a deal moves in both:
 *
 *   CALLS   mined_plays, the specific moves reps made in their own words,
 *           already carrying next_meeting_in_a_week and preceded_advance.
 *   EMAIL   what the rep wrote in the 14 days AFTER a captured call, against
 *           whether another captured call followed within 30.
 *
 * FIRST RUN, 2026-09-09, AND THE ANSWER IS NOT YET.
 *
 *   preempt_with_evidence     n=35   +7pp over a 28% base
 *   proposed a specific date  n=123 windows  +6pp over a 32% base
 *   named a next step                        +5pp
 *   everything else                          within 8pp either way
 *
 * At those sample sizes a 5 to 7 point difference is noise, and reporting
 * "preempting with evidence works" off n=35 is exactly the confident wrong
 * finding this codebase keeps paying for. NOTHING HERE IS WIRED INTO A
 * BRIEFING, deliberately. Re-run it as n grows; the shape is right and the
 * evidence is not there yet.
 *
 * The honest third state matters: "we can measure it and there is no signal
 * yet" is not the same as "not built", and not the same as "it works".
 */

import { config } from "dotenv"; config({ path: ".env.local" });
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
async function page<T>(t:string,c:string,tid:string|null):Promise<T[]>{const db=supabaseAdmin() as any;const o:T[]=[];
 for(let f=0;;f+=1000){let q=db.from(t).select(c); if(tid)q=q.eq("tenant_id",tid); q=q.order("id").range(f,f+999);
 const r=await q; if(r.error)throw new Error(`${t}: ${r.error.message}`); o.push(...(r.data??[])); if((r.data??[]).length<1000)break;} return o;}
const pct=(a:number,b:number)=>b===0?"  -":`${String(Math.round(a/b*100)).padStart(3)}%`;

async function main(){const t=await resolveTenantId("magaya");
 // ---- CHANNEL 1: what reps DID on calls (mined_plays) ----
 const mp=await page<any>("mined_plays","id, kind, next_meeting_in_a_week, preceded_advance, stage",null);
 const byKind:Record<string,{n:number;m:number;a:number}>={};
 for(const x of mp){const k=x.kind; byKind[k]=byKind[k]??{n:0,m:0,a:0}; byKind[k].n++; if(x.next_meeting_in_a_week)byKind[k].m++; if(x.preceded_advance)byKind[k].a++;}
 const base={n:mp.length,m:mp.filter(x=>x.next_meeting_in_a_week).length};
 console.log("CALL MOVES (what reps actually did, mined from transcripts)");
 console.log("  move                      n   next-mtg  vs base");
 for(const [k,v] of Object.entries(byKind).sort((a,b)=>b[1].m/b[1].n-a[1].m/a[1].n))
   console.log(`  ${k.padEnd(24)} ${String(v.n).padStart(3)}    ${pct(v.m,v.n)}    ${String(Math.round(v.m/v.n*100-base.m/base.n*100)).padStart(4)}pp`);
 console.log(`  ${"BASE".padEnd(24)} ${String(base.n).padStart(3)}    ${pct(base.m,base.n)}`);

 // ---- CHANNEL 2: what reps DID in email between calls ----
 const calls=await page<any>("calls","id, deal_id, call_date, scheduled_start, call_subtype",t);
 const trs=await page<any>("transcripts","id, call_id, body",null);
 const chars=new Map(trs.map(x=>[x.call_id,String(x.body??"").length]));
 const real=calls.filter(c=>(chars.get(c.id)??0)>=2000)
   .map(c=>({...c,at:String(c.call_date??c.scheduled_start??"").slice(0,10)})).filter(c=>c.at)
   .sort((a,b)=>a.at.localeCompare(b.at));
 const msgs=await page<any>("deal_messages","id, deal_id, direction, customer_side, is_machine_sender, is_calendar_response, sent_at, body_trimmed",t);

 // For each captured call, look at rep emails in the 14 days AFTER it, and ask
 // whether ANOTHER captured call followed within 30 days.
 const byDeal=new Map<string,any[]>(); for(const c of real) byDeal.set(c.deal_id,[...(byDeal.get(c.deal_id)??[]),c]);
 const feats=[
  ["proposed a specific date", /\b(mon|tues|wednes|thurs|fri)day\b|\b\d{1,2}(st|nd|rd|th)?\s+(of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i],
  ["asked a question", /\?/],
  ["named a next step", /\bnext steps?\b/i],
  ["referenced a number", /\b\d[\d,.]*\s*(shipments?|users?|entries|hours?|offices?|%)/i],
  ["offered something concrete", /\b(i'?ll send|i will send|here is|attached|sharing)\b/i],
 ] as [string,RegExp][];
 const rows:Array<{f:Record<string,boolean>;followed:boolean}>=[];
 for(const [deal,cs] of byDeal){
  for(let i=0;i<cs.length;i++){
   const c=cs[i]; const start=Date.parse(c.at); if(!Number.isFinite(start))continue;
   const win=msgs.filter(m=>m.deal_id===deal&&m.direction==="outbound"&&!m.customer_side&&!m.is_machine_sender&&!m.is_calendar_response&&m.body_trimmed&&
     Date.parse(String(m.sent_at))>start&&Date.parse(String(m.sent_at))<=start+14*864e5);
   if(win.length===0)continue;
   const text=win.map(m=>m.body_trimmed).join("\n");
   const followed=cs.slice(i+1).some(n=>Date.parse(n.at)<=start+30*864e5);
   const f:Record<string,boolean>={}; for(const [name,re] of feats) f[name]=re.test(text);
   rows.push({f,followed});
  }
 }
 console.log(`\nBETWEEN-CALL EMAIL (rep emails in the 14d after a call, n=${rows.length} call-windows)`);
 const bf=rows.filter(r=>r.followed).length;
 console.log(`  base rate: another captured call within 30d = ${pct(bf,rows.length)}`);
 console.log("  behaviour                       fires  followed  vs base");
 for(const [name] of feats){
   const has=rows.filter(r=>r.f[name]); const hf=has.filter(r=>r.followed).length;
   console.log(`  ${name.padEnd(30)} ${pct(has.length,rows.length)}    ${pct(hf,has.length)}   ${has.length?String(Math.round(hf/has.length*100-bf/rows.length*100)).padStart(4):"   -"}pp`);
 }
}
main().catch(e=>{console.error(e);process.exit(1);});
