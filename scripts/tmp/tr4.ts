import { config } from "dotenv"; config({ path: ".env.local" });
import { supabaseAdmin } from "../../lib/supabase";
(async () => {
  const db = supabaseAdmin();
  const { data: calls } = await db.from("calls").select("id").eq("deal_id","1f452ce5-503c-4b59-9fa1-7b775d7cd0ff").order("scheduled_start",{ascending:false}).limit(3);
  for (const c of calls as any[]) {
    const { data: tr } = await db.from("transcripts").select("body").eq("call_id", c.id).maybeSingle();
    if (!tr?.body) continue;
    const t = String(tr.body);
    console.log("FIRST 700 CHARS:\n" + t.slice(0, 700));
    console.log("\n--- lines mentioning a send/commitment ---");
    for (const l of t.split("\n")) {
      if (/formulario|preguntas|encuesta|enviar|mandar|correo|lista de/i.test(l)) console.log(`  ${l.slice(0,180)}`);
    }
    break;
  }
})().catch(e=>{console.error(e instanceof Error?e.message:e);process.exit(1);});
