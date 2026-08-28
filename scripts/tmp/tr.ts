import { config } from "dotenv"; config({ path: ".env.local" });
import { supabaseAdmin } from "../../lib/supabase";
(async () => {
  const db = supabaseAdmin();
  const { data: c } = await db.from("calls").select("id, transcript")
    .eq("deal_id","1f452ce5-503c-4b59-9fa1-7b775d7cd0ff")
    .order("scheduled_start",{ascending:false}).limit(1).maybeSingle();
  const t = String(c!.transcript ?? "");
  console.log(`transcript ${t.length} chars\n`);
  const lines = t.split("\n");
  lines.forEach((l, i) => {
    if (/questionnaire|cuestionario|question list|send.*list|separate email/i.test(l)) {
      console.log(`[${i}] ${l.slice(0,220)}`);
    }
  });
})().catch(e=>{console.error(e instanceof Error?e.message:e);process.exit(1);});
