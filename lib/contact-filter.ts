/**
 * Pure contact predicates. No I/O, no SDK, no Node built-ins.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * components/ContactsCard.tsx is rendered inside a client component and
 * imported one function from lib/contacts-extract.ts: isMeaningfulContact,
 * which is a regex over two strings. That import pulled the whole extractor
 * into the browser bundle, and with it lib/model-run.ts and the Anthropic SDK.
 *
 * It was already wrong and it was invisible, because a bundler tree-shakes most
 * of it and ships the rest. It only became a build failure when model-run began
 * importing node:async_hooks, which webpack cannot resolve for a client target.
 * The failure was the useful part: it named a dependency edge that should never
 * have existed. Same story as lib/meeting-labels.ts.
 */

/**
 * A contact is worth showing a CRO only if it's a real stakeholder. Keep anyone
 * with a defined relationship (including a mentioned-only economic buyer, that's
 * the un-engaged-buyer signal), but drop the noise the LLM sometimes grabs from
 * scheduling/email logistics: an "unknown" relationship with no substantive role
 * or a placeholder role like "unknown internal stakeholder". This is what keeps
 * "Unknown internal stakeholder" out of the pipeline-review brief.
 */
export function isMeaningfulContact(c: {
  relationship?: string | null;
  role?: string | null;
}): boolean {
  const rel = (c.relationship ?? "").toLowerCase().trim();
  const role = (c.role ?? "").toLowerCase().trim();
  if (rel && rel !== "unknown") return true;
  const junkRole =
    !role ||
    /unknown|mentioned|scheduling|shared .*email|internal stakeholder|copied|cc'?d/.test(
      role,
    );
  return !junkRole;
}
