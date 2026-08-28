import { config } from "dotenv"; config({ path: ".env.local" });
import { supabaseAdmin } from "../../lib/supabase";
(async () => {
  const db = supabaseAdmin();
  const { data } = await db.from("sent_messages").select("subject, body_text, sent_at")
    .eq("kind","recap").order("sent_at",{ascending:false}).limit(60);
  const lines: string[] = [];
  for (const m of data as any[]) {
    const t = String(m.body_text ?? "");
    const i = t.toUpperCase().indexOf("COACHING");
    if (i < 0) continue;
    const seg = t.slice(i + 8).split("\n").map(s=>s.trim()).filter(Boolean)[0];
    if (seg) lines.push(`${String(m.subject).replace("Recap: ","").slice(0,20).padEnd(22)} ${seg.slice(0,150)}`);
  }
  console.log(`${lines.length} recaps with a coaching line\n`);
  for (const l of lines.slice(0,25)) console.log(`  ${l}`);
  const movedOn = lines.filter(l => /moved on|move on|did not follow|didn't follow|could have (asked|probed|followed)|brief follow-up|quickly/i.test(l)).length;
  console.log(`\n  ${movedOn} of ${lines.length} are a variant of "you moved on / could have asked a follow-up"`);
})().catch(e=>{console.error(e instanceof Error?e.message:e);process.exit(1);});
