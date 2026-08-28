import { config } from "dotenv"; config({ path: ".env.local" });
import { supabaseAdmin } from "../../lib/supabase";
(async () => {
  const db = supabaseAdmin();
  const { data: calls } = await db.from("calls").select("id, scheduled_start")
    .eq("deal_id","1f452ce5-503c-4b59-9fa1-7b775d7cd0ff").order("scheduled_start",{ascending:false}).limit(3);
  for (const c of calls as any[]) {
    const { data: tr } = await db.from("transcripts").select("body").eq("call_id", c.id).maybeSingle();
    if (!tr?.body) { console.log(`${String(c.scheduled_start).slice(0,16)}: no transcript`); continue; }
    const t = String(tr.body);
    console.log(`\n=== ${String(c.scheduled_start).slice(0,16)}  ${t.length} chars ===`);
    for (const l of t.split("\n")) {
      if (/questionnaire|cuestionario|separate email|send you|I'll send|send it/i.test(l)) console.log(`  ${l.slice(0,200)}`);
    }
  }
})().catch(e=>{console.error(e instanceof Error?e.message:e);process.exit(1);});
