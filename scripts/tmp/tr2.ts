import { config } from "dotenv"; config({ path: ".env.local" });
import { supabaseAdmin } from "../../lib/supabase";
(async () => {
  const db = supabaseAdmin();
  const { data, error } = await db.from("calls").select("id, scheduled_start, outcome, transcript")
    .eq("deal_id","1f452ce5-503c-4b59-9fa1-7b775d7cd0ff").order("scheduled_start",{ascending:false});
  if (error) throw new Error(error.message);
  for (const c of data ?? []) {
    console.log(`${String(c.scheduled_start).slice(0,16)} outcome=${c.outcome} transcript=${c.transcript ? String(c.transcript).length + " chars" : "none"}`);
  }
})().catch(e=>{console.error(e instanceof Error?e.message:e);process.exit(1);});
