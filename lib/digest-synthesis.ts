/**
 * Writes the concrete "Do this" for each attention deal in the digest from the
 * deal's actual facts, so it reads like a sales leader, not a template. Grounded
 * in the agreed next step, the named people, the specific gap, and whether a
 * meeting is booked. Best-effort: falls back to a grounded template if the model
 * is unavailable, and never throws.
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import type { DealChangeRecord } from "./pipeline-changes";

function dstr(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" });
  } catch {
    return "";
  }
}

function buyerRef(d: DealChangeRecord): string | null {
  if (!d.economicBuyer || d.economicBuyer.engaged) return null;
  if (!d.economicBuyer.name) return "the economic buyer (still unidentified)";
  return `${d.economicBuyer.name}${d.economicBuyer.role ? ` (${d.economicBuyer.role})` : ""}`;
}

/** A grounded fallback when the model is not available. Third person, rep-named. */
function fallback(d: DealChangeRecord): string {
  const rep = d.repName;
  if (d.isNoShow) return `${rep} should call or email ${d.account} to reschedule the missed meeting, then confirm it is still live.`;
  const buyer = buyerRef(d);
  const gapList = d.missing.filter((m) => m !== "Economic buyer").slice(0, 2).map((m) => m.toLowerCase());
  const gap = [buyer ? `get ${buyer} on a call` : "", gapList.length ? `confirm ${gapList.join(" and ")}` : ""].filter(Boolean).join(" and ");
  if (d.repOwedMeeting) return `${rep} should book the follow-up call that was agreed${gap ? `, and ${gap}` : ""}.`;
  if (d.nextStepIsCustomerWait) {
    const by = d.followUpBy ? ` around ${dstr(d.followUpBy)}` : "";
    return `Expect the customer to respond${by}; ${rep} should put a call on the calendar for then.${gap ? ` Before it, ${rep} should ${gap}.` : ""}`;
  }
  return gap ? `${rep} should ${gap}.` : `${rep} should lock a concrete next step with ${d.account}.`;
}

const SYSTEM = `You prepare a CRO's weekly pipeline review. For ONE deal you produce two things and return them as strict JSON.

(1) "action": the single concrete next move for the sales rep. The reader is the CRO (Mark), not the rep, so write it as coaching about what the rep should do.
- Write in the THIRD PERSON with the rep as the subject, using the rep's name, e.g. "Juan should email...". Never write it as an instruction to the reader.
- Be specific and grounded ONLY in the facts given. Reference the actual agreed next step and the biggest gap. Name the economic buyer if given (with role); if unknown, say the rep needs to identify who signs.
- If a specific meeting was agreed and is not booked, say the rep should book it, with the date if known.
- If the customer owes a response, say when it is expected and the one useful thing the rep should do before then.
- Do NOT use filler: no "best reps", no "lock it in", no "move the needle", no "use the window", no "get in the room".
- One or two plain sentences.

(2) "bullets": rewrite each provided "what changed" detail into ONE crisp, COMPLETE clause.
- Keep every specific fact: names, figures, competitor names, dates, systems. Lose nothing material.
- Cut filler and hedging so it is short and straight to the point. No trailing ellipsis, ever.
- Return EXACTLY the same number of bullets, in the SAME order. Do not merge, drop, or add.
- Each should read complete and stand on its own, ideally under ~110 characters, but never truncate a fact to hit that.

No em-dashes anywhere. Return ONLY minified JSON: {"action":"...","bullets":["...","..."]}. No markdown, no code fences.`;

type Synth = { action: string; bullets: string[] };

function parseSynth(raw: string): Synth | null {
  const s = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const o = JSON.parse(s) as Synth;
    if (typeof o.action === "string" && Array.isArray(o.bullets)) return o;
  } catch {
    /* fall through */
  }
  return null;
}

async function synthDeal(d: DealChangeRecord): Promise<Synth> {
  const inputBullets = d.whatChanged.map((w) => w.text);
  const facts = [
    `Account: ${d.account} (rep ${d.repName})`,
    `Rolldog: ${d.stageName ?? "unknown stage"}, forecast ${d.forecastCategory ?? "none"}, close ${dstr(d.closeDate) || "unset"}`,
    d.isNoShow ? `The last scheduled meeting was a NO-SHOW.` : d.lastConversationAt ? `Last call: ${dstr(d.lastConversationAt)}` : "",
    d.primaryContact ? `Main customer contact on the calls: ${d.primaryContact.name}${d.primaryContact.role ? `, ${d.primaryContact.role}` : ""}${d.primaryContact.relationship ? ` (${d.primaryContact.relationship})` : ""}` : "",
    `Movement this week: ${d.movement.summary}`,
    d.agreedNextStep ? `Agreed next step on the call: ${d.agreedNextStep}` : "No next step was agreed on the call.",
    d.captured.length ? `Captured: ${d.captured.map((c) => `${c.label}=${c.value}`).join("; ")}` : "",
    d.missing.length ? `Still missing: ${d.missing.join(", ")}` : "",
    d.economicBuyer ? `Economic buyer: ${d.economicBuyer.name ?? "unknown"}, ${d.economicBuyer.engaged ? "has been on a call" : "never on a call"}` : "",
    `Next meeting booked on the calendar: ${d.nextMeetingBooked ? "yes" : "no"}`,
    d.repOwedMeeting ? `The rep agreed a specific call but it is NOT on the calendar.` : "",
    d.nextStepIsCustomerWait ? `The ball is in the customer's court${d.followUpBy ? ` (expected ~${dstr(d.followUpBy)})` : ""}.` : "",
    "",
    inputBullets.length
      ? `"What changed" details to rewrite (return exactly ${inputBullets.length} bullets, same order):\n${inputBullets.map((b, i) => `${i + 1}. ${b}`).join("\n")}`
      : `No "what changed" details; return "bullets": [].`,
  ]
    .filter(Boolean)
    .join("\n");

  const resp = await getAnthropicClient().messages.create({
    model: getAnthropicModel(),
    max_tokens: 400,
    temperature: 0.2,
    system: SYSTEM,
    messages: [{ role: "user", content: facts }],
  });
  const block = resp.content.find((b) => b.type === "text");
  const text = block && "text" in block ? block.text : "";
  const parsed = parseSynth(text);
  return {
    action: parsed?.action?.trim() || fallback(d),
    // Only trust the rewrite if the count matches, so bullets never misalign
    // with their labels; otherwise keep the deterministic (verbatim) versions.
    bullets: parsed && parsed.bullets.length === inputBullets.length ? parsed.bullets.map((b) => String(b).trim()) : inputBullets,
  };
}

/**
 * Fill `doThis` and rewrite the `whatChanged` bullets into crisp complete
 * clauses on the top attention deals (mutates in place). One model call per
 * deal, capped, since only the top handful surface. Records arrive sorted by
 * attention, so this is the visible set. Best-effort: on any failure the deal
 * keeps its deterministic action and verbatim bullets.
 */
export async function attachDoThis(records: DealChangeRecord[], limit = 8): Promise<void> {
  const targets = records.filter((r) => r.needsAttention).slice(0, limit);
  if (!process.env.ANTHROPIC_API_KEY) {
    for (const r of targets) r.doThis = fallback(r);
    return;
  }
  await Promise.all(
    targets.map(async (r) => {
      try {
        const { action, bullets } = await synthDeal(r);
        r.doThis = action;
        r.whatChanged.forEach((w, i) => {
          if (bullets[i]) w.text = bullets[i];
        });
      } catch {
        r.doThis = fallback(r);
      }
    }),
  );
}
