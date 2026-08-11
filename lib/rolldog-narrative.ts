/**
 * The rep's own written notes in Rolldog, for the briefing prompt.
 *
 * Rolldog carries five narrative tabs per opportunity, Situation, Timeline,
 * Budget, Competition and People, plus free text on the opportunity itself.
 * getDealRoom has been able to read all of it for months and no generator ever
 * called it, so a deal like GHY at SQL3 briefed off a BDR intake form while the
 * rep's own account of the deal sat one HTTP call away.
 *
 * This is also where the real negatives live. Mark's screen showed "Magaya is
 * not the Selected Vendor" and "There is an area of concern here" rendered
 * under Solution, which is the fact I tried and failed to infer from checklist
 * booleans earlier: the checklist stores one boolean with no third state, while
 * the narrative says what a human actually concluded.
 *
 * Rendering is deliberately schema-agnostic. I do not know Rolldog's attribute
 * names for these tabs and guessing them is exactly how the stage-requirements
 * endpoint went unfound for a day. So every attribute holding real prose is
 * printed under a humanized key, and anything that is not prose is skipped.
 * A new field Rolldog adds tomorrow shows up automatically; a renamed one does
 * not silently vanish.
 */

import { runWithAuthorizedOpportunities } from "./crm-scope";
import { getDealRoom } from "./rolldog";

/** Keys that are plumbing, not content. Matched case-insensitively. */
const SKIP_KEY = /(^id$|-id$|_id$|^type$|created|updated|deleted|-at$|_at$|order|position|sort|currency|guid|uuid)/i;

/** Below this a value is a label or a code, not something a rep wrote. */
const MIN_PROSE_LENGTH = 12;

/** Cap per tab, so one long note cannot crowd out the gaps and the checklist. */
const MAX_CHARS_PER_TAB = 700;

function humanize(key: string): string {
  return key
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Pull the prose out of one JSON:API attributes bag.
 *
 * Only strings, and only strings long enough to be a sentence rather than an
 * enum value. Booleans and numbers are deliberately excluded: they carry no
 * context on their own and, as this evening proved, a bare false invites
 * exactly the wrong inference.
 */
function proseFrom(attrs: Record<string, unknown> | null | undefined): string[] {
  if (!attrs) return [];
  const out: string[] = [];
  let used = 0;
  for (const [key, value] of Object.entries(attrs)) {
    if (SKIP_KEY.test(key)) continue;
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text.length < MIN_PROSE_LENGTH) continue;
    if (used >= MAX_CHARS_PER_TAB) break;
    const room = MAX_CHARS_PER_TAB - used;
    const clipped = text.length > room ? `${text.slice(0, room)}...` : text;
    out.push(`  ${humanize(key)}: ${clipped}`);
    used += clipped.length;
  }
  return out;
}

/**
 * The Rolldog narrative block, or null when the rep has written nothing.
 *
 * Throws are the caller's to handle. An unreadable opportunity must not render
 * as an opportunity with empty notes: the two look identical in the output and
 * mean opposite things.
 */
export async function buildRolldogNarrative(opportunityId: string): Promise<string | null> {
  const room = await runWithAuthorizedOpportunities([opportunityId], () =>
    getDealRoom(opportunityId),
  );

  const sections: Array<[string, string[]]> = [
    ["Opportunity notes", proseFrom(room.core)],
    ["Situation", proseFrom(room.situation?.attributes)],
    ["Timeline", proseFrom(room.timeline?.attributes)],
    ["Budget", proseFrom(room.budget?.attributes)],
    ["Competition", proseFrom(room.competition?.attributes)],
    ["People", proseFrom(room.participant?.attributes)],
  ];

  const lines: string[] = [];
  for (const [label, body] of sections) {
    if (body.length === 0) continue;
    lines.push(`${label}:`);
    lines.push(...body);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}
