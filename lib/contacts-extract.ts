/**
 * Contact extraction from call transcripts.
 *
 * Turns a transcript into the customer-side people named on the call, each with
 * a role and a relationship (champion / economic buyer / influencer / user), so
 * the deal's Contacts card populates itself instead of staying empty. Best
 * effort by design: the LLM call and the upsert both fail soft so they can
 * never affect the ingest pipeline.
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { supabaseAdmin } from "./supabase";

export type ContactRelationship =
  | "champion"
  | "influencer"
  | "economic_buyer"
  | "user"
  | "unknown";

export type ExtractedContact = {
  name: string;
  role: string;
  relationship: ContactRelationship;
  /** True if the person actually participated in the call; false if they were
   *  only mentioned/referenced (a named stakeholder who wasn't present). Drives
   *  "last contacted": present -> the call date, mentioned-only -> never. */
  onCall: boolean;
  evidence: string;
};

const RELATIONSHIPS = new Set<ContactRelationship>([
  "champion",
  "influencer",
  "economic_buyer",
  "user",
  "unknown",
]);

/**
 * Extract the named, customer-side individuals from a transcript. Excludes the
 * seller's own reps and non-person groups ("the board", "operations team").
 * Returns [] on any failure or if the API key is unset.
 */
export async function extractContactsFromTranscript(args: {
  transcript: string;
  account: string;
}): Promise<ExtractedContact[]> {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  if (args.transcript.trim().length < 50) return [];

  const system = `You extract the customer-side people named in a B2B sales call transcript for the prospect account "${args.account}".

Return ONLY a JSON array, nothing else. Each element:
{ "name": string, "role": string, "relationship": "champion"|"economic_buyer"|"influencer"|"user"|"unknown", "onCall": boolean, "evidence": string }

Rules:
- Include only NAMED INDIVIDUALS on the customer/buyer side. Exclude the seller/vendor representatives.
- Do NOT include groups or teams (e.g. "the board", "operations team", "partners", "leadership"). Only specific named people.
- role: their title or function if stated; otherwise a short description, or "" if none.
- relationship: champion = the main advocate/driver on the call; economic_buyer = controls budget or gives final sign-off; influencer = weighs in on the decision; user = hands-on end user; unknown = unclear.
- onCall: true if this person actually spoke or participated in THIS call; false if they were only mentioned or referenced but were not present.
- evidence: one short verbatim quote from the transcript that supports the person and their role.
- If there are no named individuals, return [].`;

  try {
    const resp = await getAnthropicClient().messages.create({
      model: getAnthropicModel(),
      max_tokens: 1500,
      temperature: 0.1,
      system,
      messages: [{ role: "user", content: `Transcript:\n\n${args.transcript}` }],
    });
    const text = resp.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    return normalize(parseJsonArray(text));
  } catch (err) {
    console.error(
      `[contacts-extract] extraction failed for ${args.account}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

function parseJsonArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function normalize(raw: unknown[]): ExtractedContact[] {
  const out: ExtractedContact[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) continue;
    const relationship = RELATIONSHIPS.has(r.relationship as ContactRelationship)
      ? (r.relationship as ContactRelationship)
      : "unknown";
    out.push({
      name,
      role: typeof r.role === "string" ? r.role.trim() : "",
      relationship,
      onCall: r.onCall === true,
      evidence: typeof r.evidence === "string" ? r.evidence.trim() : "",
    });
  }
  return out;
}

/**
 * Add any newly-named contacts to a deal, deduped case-insensitively by name so
 * re-running a call never creates duplicates. Returns counts. Best-effort:
 * throws only on a hard DB error (callers wrap it).
 */
export async function upsertDealContacts(args: {
  tenantId: string;
  dealId: string;
  contacts: ExtractedContact[];
  /** Date of the call these contacts came from (ISO). Stamped as
   *  last_contacted_at on people who were ON the call; mentioned-only people
   *  stay null ("never contacted"), which is a useful un-engaged-buyer signal. */
  callDate?: string | null;
}): Promise<{ inserted: number; skipped: number }> {
  if (args.contacts.length === 0) return { inserted: 0, skipped: 0 };
  const db = supabaseAdmin();

  const existing = await db
    .from("contacts")
    .select("name")
    .eq("tenant_id", args.tenantId)
    .eq("deal_id", args.dealId);
  const have = new Set(
    (existing.data ?? []).map((c) => c.name.trim().toLowerCase()),
  );

  const rows: Array<{
    tenant_id: string;
    deal_id: string;
    external_id: string;
    name: string;
    role: string | null;
    relationship: ContactRelationship;
    last_contacted_at: string | null;
  }> = [];
  let skipped = 0;
  for (const c of args.contacts) {
    const key = c.name.toLowerCase();
    if (have.has(key)) {
      skipped += 1;
      continue;
    }
    have.add(key);
    rows.push({
      tenant_id: args.tenantId,
      deal_id: args.dealId,
      external_id: `call:${key}`,
      name: c.name,
      role: c.role || null,
      relationship: c.relationship,
      // Present on the call -> contacted on the call date. Only mentioned ->
      // never contacted (accurate, and flags un-engaged decision-makers).
      last_contacted_at: c.onCall && args.callDate ? args.callDate : null,
    });
  }

  if (rows.length === 0) return { inserted: 0, skipped };
  const ins = await db.from("contacts").insert(rows);
  if (ins.error) throw new Error(`contacts insert failed: ${ins.error.message}`);
  return { inserted: rows.length, skipped };
}
