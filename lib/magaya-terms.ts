/**
 * Magaya product and competitor names, spelled the way Magaya spells them.
 *
 * Steven Johnson, 2026-08-27, on a drafted follow-up that reached a customer:
 * "Acelink is wrong. It's one word, all uppercase, A C E L Y N K. And we
 * shouldn't be referencing ACELYNK at all, we should be saying Magaya Customs
 * Compliance." He had corrected reps on live calls several times; the model was
 * copying the rep's own spoken mistake straight back into a customer-facing
 * email.
 *
 * The same call showed what an error of this size actually costs. On a recap
 * that misspelled a competitor: "I saw the error and I just disregarded the
 * email, honestly. Now I'm having trouble trusting what else might be there."
 * One wrong proper noun did not get corrected, it discarded the whole artifact.
 *
 * Two layers, because neither is sufficient alone:
 *
 *   1. GLOSSARY, into the prompt. Stops the model producing the wrong name from
 *      a mis-transcribed call. A diarized transcript renders ACELYNK as "ace
 *      link", "a slink" and "a sling", and no substitution table can safely
 *      rewrite "a sling" without also rewriting the word sling.
 *   2. SUBSTITUTION, over generated copy. Catches the variants that ARE
 *      unambiguous, so a prompt the model half-followed still cannot ship the
 *      wrong name to a customer. A prompt makes it unlikely; only code makes it
 *      impossible.
 *
 * Magaya only. Nothing here is applied to another tenant's copy.
 */

/** Unambiguous rewrites. Ordered, applied case-insensitively on word boundaries. */
const REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  // ACELYNK is the internal product name. Customer-facing copy says the
  // marketing name instead, which is what Magaya sales has standardised on.
  [/\bace[\s-]?ly?n?k\b/gi, "Magaya Customs Compliance"],
  [/\bace[\s-]?link\b/gi, "Magaya Customs Compliance"],
  // Names Magaya writes a particular way. Case and spacing only, never a guess
  // at what a garbled word was meant to be.
  [/\bnet[\s-]?chb\b/gi, "NetCHB"],
  [/\bcargo[\s-]?wise\b/gi, "CargoWise"],
];

/**
 * Apply to any generated customer-facing copy: draft subjects and bodies,
 * recaps, briefings. Idempotent, so running it twice changes nothing.
 */
export function applyMagayaTerms(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, to] of REWRITES) out = out.replace(re, to);
  // "Magaya Magaya Customs Compliance" is what a rewrite over text that already
  // carried the prefix produces. Cheaper to collapse than to make every pattern
  // account for it.
  return out.replace(/\bMagaya\s+Magaya\b/g, "Magaya");
}

/** Same, over the three-part shape the email renderers return. */
export function applyMagayaTermsToEmail<T extends { subject: string; html: string; text: string }>(e: T): T {
  return { ...e, subject: applyMagayaTerms(e.subject), html: applyMagayaTerms(e.html), text: applyMagayaTerms(e.text) };
}

/** Dropped into generation prompts so the wrong name is not produced at all. */
export const MAGAYA_GLOSSARY = `NAMES, spelled exactly this way. Transcripts garble them and reps say them
loosely; neither is a licence to copy the mistake into customer-facing copy.
- The customs product is written "Magaya Customs Compliance". Its internal name
  is ACELYNK and a transcript may render that as "ace link", "acelink",
  "a slink" or "a sling". Never write any of those. Write Magaya Customs
  Compliance.
- Competitors: CargoWise, NetCHB, Descartes. If a transcript gives a competitor
  name you cannot resolve with confidence, describe it ("their current customs
  filing system") rather than guessing at the spelling. A wrong product name
  costs the reader the whole document.`;
