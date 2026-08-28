/**
 * Is the coaching line saying anything, or the same thing every time?
 *
 * Measured 2026-08-28 by grepping recap bodies: 18 of 28 were a variant of "you
 * moved on quickly, a follow-up question could have deepened the pain". That
 * grep was a proxy and good enough to act on, and it is not good enough to keep
 * checking with, because it cannot tell a counterfactual it has no phrase for
 * from a real observation that happens to contain the word "quickly".
 *
 * This classifies each line against the rule the prompt now states: coaching
 * must cite an EVENT with a witness, checkable against the transcript by
 * someone who disagrees. It reads the recaps DealRipe actually sent, so it
 * measures the artifact rather than a fresh generation.
 *
 * Read-only.
 *
 *   npx tsx scripts/coaching-audit.ts
 *   npx tsx scripts/coaching-audit.ts --limit 80
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runModel } from "../lib/model-run";
import { supabaseAdmin } from "../lib/supabase";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SYSTEM = `You are auditing one line of post-call coaching written for a sales rep.

Reply with ONLY one word.

observation: it cites something that HAPPENED on the call, checkable by someone who disagrees. The customer redirected the rep or asked them to move on. The rep quoted a price or committed before a gate their process requires. The customer raised the same thing repeatedly and it was never answered. The rep contradicted themselves. The rep talked over a question.

counterfactual: its substance is that the rep could have done more, asked another question, probed deeper, paused longer, or explored further. True of every sales call ever recorded and therefore worth nothing to the rep. If the line's only claim is that more was possible, it is counterfactual even when it names a topic.

Choose the one that carries the line's actual point.`;

async function classify(line: string): Promise<"observation" | "counterfactual" | "unreadable"> {
  try {
    const resp = await runModel({
      task: "coaching_audit",
      maxTokens: 8,
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: "user", content: line }],
    });
    const t = resp.message.content
      .map((b: { type: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : ""))
      .join("")
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    if (t === "observation") return "observation";
    if (t === "counterfactual") return "counterfactual";
    return "unreadable";
  } catch {
    // NOT a category. A failed classification is not a verdict about the line,
    // and folding it into either bucket would move the number this script
    // exists to report.
    return "unreadable";
  }
}

async function main(): Promise<void> {
  const limit = Number(arg("--limit") ?? 60);
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("sent_messages")
    .select("subject, body_text, sent_at")
    .eq("kind", "recap")
    .order("sent_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const rows: Array<{ account: string; line: string }> = [];
  let withoutCoaching = 0;
  for (const m of data ?? []) {
    const text = String(m.body_text ?? "");
    const i = text.toUpperCase().indexOf("COACHING");
    if (i < 0) {
      withoutCoaching++;
      continue;
    }
    const line = text
      .slice(i + "COACHING".length)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (!line) {
      withoutCoaching++;
      continue;
    }
    rows.push({ account: String(m.subject ?? "").replace(/^Recap:\s*/, "").slice(0, 22), line });
  }

  const tally = { observation: 0, counterfactual: 0, unreadable: 0 };
  console.log(`\n${rows.length} recaps carry a coaching line, ${withoutCoaching} carry none.\n`);
  for (const r of rows) {
    const verdict = await classify(r.line);
    tally[verdict]++;
    console.log(`  ${verdict.padEnd(15)} ${r.account.padEnd(24)} ${r.line.slice(0, 92)}`);
  }

  const judged = tally.observation + tally.counterfactual;
  console.log(
    `\n  ${tally.observation} observation, ${tally.counterfactual} counterfactual, ${tally.unreadable} could not be classified.`,
  );
  if (judged > 0) {
    console.log(`  ${Math.round((tally.counterfactual / judged) * 100)}% of classified lines say only that more was possible.`);
  }
  // The target is not zero coaching. It is that a line, when it appears, tells
  // the rep something they could not have written themselves.
  console.log(
    `\n  Coverage is not the goal here. Silence on a well-run call is correct, and the number to watch is the counterfactual share, not the count.\n`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
