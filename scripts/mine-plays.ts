/**
 * The moves the reps actually made, in their own words.
 *
 *   npx tsx scripts/mine-plays.ts
 *   npx tsx scripts/mine-plays.ts --rep ebencomo@magaya.com --days 45
 *   npx tsx scripts/mine-plays.ts --days 60 --top 12
 *
 * lib/magaya-plays.ts is a hand-curated list, distilled by a human from a
 * handful of calls in April. This reads every captured call in a window and
 * pulls the specific things a seller did with a sentence, verbatim, with who
 * said it and what it was doing. Nothing here is summarised: a summary of a
 * move is a generic best practice with the move removed, and generic best
 * practice is exactly what nobody needs another list of.
 *
 * WHAT COUNTS. Six kinds, all of them things a seller DID rather than topics
 * they covered: asking for a named person, handing the customer language to
 * use internally, reframing a request instead of taking it at face value,
 * trading something for access, pre-empting an objection with evidence,
 * narrowing scope to protect a gate. The test applied to every candidate is
 * whether it survives being written as general advice. "Confirm next steps"
 * survives, so it is not a move. "Forget the WMS piece, if we only solve
 * customs filing by October does that get you approval" does not, so it is.
 *
 * EVIDENCE. Every quote is checked back against the transcript with
 * quoteAppearsIn from lib/prescription-scoring.ts, the same function the
 * ledger uses, so a model that invents its evidence produces nothing rather
 * than fiction. Recall diarizes into interleaved fragments, which is why the
 * check joins a single speaker's own consecutive lines and never crosses
 * speakers.
 *
 * OUTCOMES ARE CONTEXT, NOT CAUSE. A move that preceded an advance did not
 * necessarily cause it. This prints what was observably true afterwards so a
 * human can go and read the call, and it says "not checked" wherever we did
 * not look, which is never the same as a zero.
 *
 * READ ONLY. Writes nothing, ever. Touches no recap, ledger or capture path.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getAnthropicClient, getAnthropicModel } from "../lib/anthropic";
import type { Tristate } from "../lib/database.types";
import { prettyAccount, repName } from "../lib/display-names";
import { readNextMeeting, repEmailFor, type OutcomeCall } from "../lib/prescription-outcomes";
import { quoteAppearsIn, readTranscriptForCall } from "../lib/prescription-scoring";
import type { RolldogSnapshot } from "../lib/snapshot";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

/** Days after the call in which a booked meeting still counts as this call's. */
const NEXT_MEETING_DAYS = 7;
/** Days after the call in which a stage advance still counts as this call's. */
const ADVANCE_DAYS = 30;

/**
 * A transcript longer than this is truncated before the model sees it, and
 * the truncation is printed. A silently shortened transcript would report the
 * back half of a call as a call with no moves in it.
 */
const MAX_TRANSCRIPT_CHARS = 300_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// =====================================================================
// What a move is
// =====================================================================

const MOVE_KINDS = [
  "named_ask",
  "internal_language",
  "reframe",
  "trade_for_access",
  "preempt_with_evidence",
  "narrow_scope",
] as const;
type MoveKind = (typeof MOVE_KINDS)[number];

/** Grouped by what the move was doing, which is the only useful grouping. */
const KIND_LABEL: Record<MoveKind, string> = {
  named_ask: "ASKED FOR A NAMED PERSON",
  internal_language: "HANDED THE CUSTOMER LANGUAGE FOR THEIR OWN PEOPLE",
  reframe: "REFRAMED THE REQUEST INSTEAD OF TAKING IT AT FACE VALUE",
  trade_for_access: "TRADED SOMETHING FOR ACCESS",
  preempt_with_evidence: "PRE-EMPTED THE OBJECTION WITH EVIDENCE",
  narrow_scope: "NARROWED SCOPE TO PROTECT A GATE",
};

const SYSTEM = `You are reading the transcript of one recorded B2B sales call and pulling out the specific MOVES the seller made. A move is something the seller did with a sentence that another seller could carry to a different customer and it would still be a move. It is never a topic they covered.

THE TRANSCRIPT IS MACHINE DIARIZED AND FRAGMENTED. Lines are "Speaker: text", one spoken sentence is often split across several lines by the same speaker, and other people's short interjections ("mhm", "yeah", "okay") are interleaved in the middle of it. Read across a speaker's own consecutive fragments to understand what they said.

THE SIX KINDS. Nothing else is a move.

named_ask
  The seller names a specific person and asks for that person, by name, to be in the room or on the thread.
  IS: naming the person who owns the budget and asking for them on the next call.
  IS NOT: "who else should be involved in this?" That is a question about roles.

internal_language
  The seller hands the customer words, a number or a framing to carry to their own people.
  IS: telling the customer which specific line to use when they take this to their CFO.
  IS NOT: "let me know if you need anything for your internal discussion."

reframe
  The customer asks for something and the seller does not simply agree or refuse. They change what is being asked, and say why.
  IS: turning a request for a demo on Thursday into a demo on Tuesday built on the customer's own invoices.
  IS NOT: "happy to demo whenever works for you."

trade_for_access
  The seller gives something concrete in exchange for a person, a document, data, or time.
  IS: pricing walked through verbally now, the written proposal once there is a mutual NDA.
  IS NOT: "I'll send some information over."

preempt_with_evidence
  The seller raises the objection or the gap BEFORE the customer does, and attaches something checkable to it: a count, a document, a named limitation.
  IS: naming the two items on the customer's own thirty-item list that the product does not cover.
  IS NOT: "we're a great fit for what you're doing."

narrow_scope
  The seller cuts the scope down to protect a date, an approval or a decision.
  IS: dropping the warehouse piece and asking whether customs filing alone by October gets approval.
  IS NOT: "we can always phase the rollout."

THE TEST THAT REJECTS MOST CANDIDATES. Write the candidate as a piece of general advice. If nothing is lost, it is not a move. "Ask about budget", "build rapport", "confirm the next step", "understand their process" are all advice, and every quote that reduces to one of them must be rejected. A real move names something: a person, a document, a number, a date, a system, a constraint, a tradeoff.

RULES

1. VERBATIM OR NOTHING. The quote is copied from the transcript word for word. Never paraphrase, never fix the grammar, never assemble it from two different speakers, and never join two passages that are minutes apart. You may join one speaker's own consecutive fragments across somebody else's interjection, because those words really were said in sequence. A quote that is not in the transcript is discarded and the move is lost, so copy carefully.
2. SELLER SIDE ONLY. The seller is Magaya. Anything anyone on the customer's side said is not a move, however good it was. The invite roster below names who is on which side. A speaker who is on neither list counts as the seller only when the transcript makes plain that they work for Magaya, and otherwise does not count at all.
3. Give the speaker label exactly as it appears in the transcript.
4. The examples above are illustrations of the KIND. Never quote them. The quote must come from this transcript.
5. QUALITY OVER COUNT. Most calls contain between zero and three real moves. Returning an empty list is a correct and common answer. A weak move admitted here becomes advice given to five other reps, so when you are torn, leave it out.
6. "doing" is one line, at most fifteen words, saying what this specific move did in this specific moment. Not a restatement of the kind.

Return JSON only, no prose and no markdown fences:
{"moves": [{"kind": "named_ask" | "internal_language" | "reframe" | "trade_for_access" | "preempt_with_evidence" | "narrow_scope", "speaker": string, "quote": string, "doing": string}]}`;

type RawMove = { kind: MoveKind; speaker: string; quote: string; doing: string };

function parseMoves(raw: string): RawMove[] | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1)) as { moves?: unknown };
    if (!Array.isArray(o.moves)) return null;
    const kinds = new Set<string>(MOVE_KINDS);
    return o.moves
      .map((m) => m as Record<string, unknown>)
      .filter(
        (m) =>
          typeof m.kind === "string" &&
          kinds.has(m.kind) &&
          typeof m.quote === "string" &&
          m.quote.trim().length > 0,
      )
      .map((m) => ({
        kind: m.kind as MoveKind,
        speaker: typeof m.speaker === "string" ? m.speaker.trim() : "",
        quote: (m.quote as string).trim(),
        doing: typeof m.doing === "string" ? m.doing.trim() : "",
      }));
  } catch {
    return null;
  }
}

type MineResult =
  | { status: "mined"; moves: RawMove[] }
  /** The model failed or could not be parsed. Not a call with no moves in it. */
  | { status: "unavailable"; error: string };

async function mineCall(args: {
  transcript: string;
  account: string;
  rep: string;
  callDate: string;
  callType: string;
  roster: string;
}): Promise<MineResult> {
  let raw: string;
  try {
    const resp = await getAnthropicClient().messages.create({
      model: getAnthropicModel(),
      max_tokens: 2000,
      temperature: 0,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `CUSTOMER: ${args.account}`,
            `DEAL OWNER: ${args.rep}`,
            `CALL DATE: ${args.callDate}`,
            `CALL TYPE: ${args.callType}`,
            ``,
            args.roster,
            ``,
            `TRANSCRIPT:`,
            args.transcript,
            ``,
            `What specific moves did the seller make on this call? Quote word for word. Return JSON only, and return an empty list if there were none.`,
          ].join("\n"),
        },
      ],
    });
    const block = resp.content.find((b) => b.type === "text");
    raw = block && "text" in block ? block.text : "";
  } catch (err) {
    return { status: "unavailable", error: err instanceof Error ? err.message : String(err) };
  }
  const moves = parseMoves(raw);
  if (!moves) return { status: "unavailable", error: "model response could not be parsed as moves" };
  return { status: "mined", moves };
}

// =====================================================================
// Who said it
// =====================================================================

/** Every speaker label the transcript actually carries. */
function speakerLabels(transcript: string): Set<string> {
  const out = new Set<string>();
  for (const line of transcript.split("\n")) {
    const m = /^\s*([^:]{1,60}?):\s*/.exec(line);
    if (m) out.add(m[1].trim().toLowerCase());
  }
  return out;
}

/**
 * The attribution is the model's and only lightly checked: the label has to be
 * somebody who actually spoke on this call. It is NOT checked that the speaker
 * is the deal's own rep, because the seller side is routinely two or three
 * people (an SE, another AE, the BDR who booked it) and dropping those would
 * drop real moves.
 */
function speakerIsReal(labels: Set<string>, speaker: string): boolean {
  if (labels.size === 0) return true; // unlabelled transcript, nothing to check against
  const s = speaker.trim().toLowerCase();
  if (!s) return false;
  for (const l of labels) {
    if (l === s || l.includes(s) || s.includes(l)) return true;
  }
  return false;
}

/**
 * Which side of the table the speaker sat on.
 *
 * The first run mined two Seaboard Marine moves said by the customer's own
 * engineer and a Tqlglobal one said by the customer offering to bring their
 * colleague, all three printed under a Magaya rep's name. A move is a thing
 * the SELLER did, so a customer's sentence recorded as one becomes advice
 * handed to five other reps on the strength of the buyer having said it.
 *
 * Decided from the invite, where the domain is unambiguous, rather than from
 * the model. "unknown" is its own answer and stays visible in the output: the
 * seller side is often joined by somebody who was never on the invite, and
 * silently dropping them would lose real moves while silently keeping them
 * would repeat the bug.
 */
type Side = "seller" | "customer" | "unknown";

const SELLER_DOMAIN = "magaya.com";

type Participant = { name?: string | null; email?: string | null };

function participantsOf(raw: unknown): Participant[] {
  return Array.isArray(raw) ? (raw as Participant[]) : [];
}

/** Lowercase alphabetic name tokens, so "Soto, Jaime" and "Jaime Soto" match. */
function nameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/**
 * Does this transcript label name this participant.
 *
 * Two tokens shared is a match, and one is enough when either side only has
 * one to give. The email local part is checked too, because half the Magaya
 * invites carry an address where the name should be: "JHuseby@tql.com" is how
 * the roster spells the man the transcript calls "Joseph Huseby".
 */
function labelNamesParticipant(speaker: string, p: Participant): boolean {
  const s = nameTokens(speaker);
  if (s.length === 0) return false;
  const n = nameTokens(p.name ?? "");
  const shared = s.filter((t) => n.includes(t)).length;
  if (shared >= 2) return true;
  if (shared === 1 && (s.length === 1 || n.length === 1)) return true;

  const local = (p.email ?? "").split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
  if (local.length >= 4 && s.some((t) => t.length >= 4 && local.includes(t))) return true;
  return false;
}

/**
 * This call's invite decides first, and a wider directory catches the rest.
 *
 * The invite is the customer's copy as often as ours, so a Magaya person who
 * joined without being on it looks identical to a stranger. Checking the
 * speaker against every magaya.com attendee seen anywhere in the window fixes
 * that without weakening the customer test, which still runs first and still
 * wins: a name that is on THIS invite as the customer is the customer.
 */
function sideOfSpeaker(
  participants: Participant[],
  speaker: string,
  directory: Participant[],
): Side {
  let sawCustomer = false;
  for (const p of participants) {
    if (!labelNamesParticipant(speaker, p)) continue;
    const domain = (p.email ?? "").split("@")[1]?.toLowerCase() ?? "";
    if (domain === SELLER_DOMAIN) return "seller";
    if (domain) sawCustomer = true;
  }
  if (sawCustomer) return "customer";
  if (directory.some((p) => labelNamesParticipant(speaker, p))) return "seller";
  return "unknown";
}

/** Every magaya.com attendee seen on any call in the window, deduped by address. */
function sellerDirectory(all: ReadonlyArray<Participant[]>): Participant[] {
  const byEmail = new Map<string, Participant>();
  for (const list of all) {
    for (const p of list) {
      const email = (p.email ?? "").toLowerCase();
      if (email.endsWith(`@${SELLER_DOMAIN}`) && !byEmail.has(email)) byEmail.set(email, p);
    }
  }
  return [...byEmail.values()];
}

/** The roster the model is given, so it can obey the seller-side rule. */
function rosterFor(participants: Participant[]): string {
  const label = (p: Participant) => (p.name ?? p.email ?? "").trim();
  const seller = participants
    .filter((p) => (p.email ?? "").toLowerCase().endsWith(`@${SELLER_DOMAIN}`))
    .map(label)
    .filter(Boolean);
  const customer = participants
    .filter((p) => !(p.email ?? "").toLowerCase().endsWith(`@${SELLER_DOMAIN}`))
    .map(label)
    .filter(Boolean);
  return [
    `WHO WAS ON THE INVITE:`,
    `  seller side (Magaya): ${seller.length > 0 ? seller.join(", ") : "nobody listed"}`,
    `  customer side: ${customer.length > 0 ? customer.join(", ") : "nobody listed"}`,
    `  The invite is not a complete list of who spoke. Somebody absent from it is the seller only if the transcript makes that plain.`,
  ].join("\n");
}

/**
 * The model's "doing" line, with dashes removed.
 *
 * Mark reads an em dash as machine-written, which is why lib/briefing-lint.ts
 * rejects one in a briefing. These lines are the raw material for exactly that
 * copy, so they are cleaned where they are produced rather than downstream.
 */
function cleanDoing(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();
}

// =====================================================================
// What was observably true afterwards
// =====================================================================

type Observed = { value: Tristate; detail: string };

/**
 * Outcomes with no conversation in them, so a row on the calendar carrying one
 * is not a next meeting. Same set lib/prescription-outcomes.ts filters by;
 * stated here only because it is private there, and readNextMeeting below
 * remains the authority on whether a later meeting exists at all.
 */
const NO_CONTENT = new Set([
  "no_conversation",
  "no_show",
  "rescheduled",
  "placeholder",
  "capture_failed",
  "duplicate",
]);

/**
 * Is there a next meeting on this deal within a week of the call.
 *
 * readNextMeeting decides the hard part, which is whether we are entitled to
 * say "no" at all: it refuses to unless the rep's calendar has actually been
 * read since the call. An unconnected or stale calendar comes back unknown and
 * stays unknown here, because "the rep booked nothing" and "we were looking at
 * a calendar older than the call" are the two things this codebase keeps
 * confusing. Only once production has said yes does this ask the narrower
 * question of whether that meeting is inside the window.
 */
async function nextMeetingWithinWeek(call: OutcomeCall): Promise<Observed> {
  const production = await readNextMeeting(call);
  if (production.value !== "yes") {
    return { value: production.value, detail: production.reason };
  }

  const until = new Date(Date.parse(call.at) + NEXT_MEETING_DAYS * 86_400_000).toISOString();
  const res = await supabaseAdmin()
    .from("calls")
    .select("scheduled_start, call_date, outcome, title")
    .eq("tenant_id", call.tenantId)
    .eq("deal_id", call.dealId)
    .gt("scheduled_start", call.at)
    .lte("scheduled_start", until)
    .order("scheduled_start", { ascending: true })
    .limit(10);
  if (res.error) {
    return { value: "unknown", detail: `calls lookup failed: ${res.error.message}` };
  }
  const real = (res.data ?? []).filter((c) => !(c.outcome && NO_CONTENT.has(c.outcome)));
  if (real.length === 0) {
    return {
      value: "no",
      detail: `a later meeting exists but not inside ${NEXT_MEETING_DAYS} days (${production.reason})`,
    };
  }
  const next = real[0];
  return {
    value: "yes",
    detail: `${(next.scheduled_start ?? next.call_date ?? "").slice(0, 10)}${
      next.title ? ` "${next.title}"` : ""
    }`,
  };
}

type SnapshotRow = { snapshot_date: string; signals: unknown };

/**
 * The Rolldog reading a stored snapshot carries, or null.
 *
 * lib/snapshot.ts writes the rolldog block only when the read succeeded
 * (buildSignals sets `rolldog: rolldog?.snapshot ?? null`, and snapshot is
 * null on every status but "read"), so a block that is present is a reading
 * that happened, on new rows and on the legacy rows written before
 * rolldogRead existed alike. Absent means we did not get a reading, which is
 * unknown and never "the stage did not move".
 */
function rolldogOf(signals: unknown): RolldogSnapshot | null {
  const s = (signals ?? {}) as { rolldog?: RolldogSnapshot | null };
  return s.rolldog ?? null;
}

function stageOf(snap: RolldogSnapshot): string | null {
  return snap.stageKey ?? snap.stageName ?? null;
}

/** SQL0 < SQL1 < ... Null when the stage carries no number to order by. */
function rankOf(stage: string | null): number | null {
  if (!stage) return null;
  const m = stage.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

type StageContext = {
  /** Rolldog's stage on the day of the call, or null if we could not read one. */
  at: string | null;
  advanced: Observed;
};

/**
 * Where the deal stood when the call happened, and whether it advanced after.
 *
 * Source is deal_signal_snapshots, four-hourly, holding Rolldog's own stage
 * verbatim. Deliberately not DealRipe's inferred stage, which moves when an
 * extraction confirms a field and would make this measure our own extraction
 * rather than the customer's CRM. A Salesforce-only deal has no Rolldog
 * opportunity and so reports unknown here, permanently and correctly.
 */
async function stageContext(args: {
  tenantId: string;
  dealId: string;
  at: string;
}): Promise<StageContext> {
  const day = args.at.slice(0, 10);
  const from = new Date(Date.parse(args.at) - 30 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(args.at) + ADVANCE_DAYS * 86_400_000).toISOString().slice(0, 10);

  const res = await supabaseAdmin()
    .from("deal_signal_snapshots")
    .select("snapshot_date, signals")
    .eq("tenant_id", args.tenantId)
    .eq("deal_id", args.dealId)
    .gte("snapshot_date", from)
    .lte("snapshot_date", to)
    .order("snapshot_date", { ascending: true });
  if (res.error) {
    return {
      at: null,
      advanced: { value: "unknown", detail: `snapshot lookup failed: ${res.error.message}` },
    };
  }
  const rows = (res.data ?? []) as SnapshotRow[];

  // The reading nearest before the call, and the last reading in the window
  // after it. Strictly after the call's own day on the later side: the row for
  // the call's day is upserted through the day and may hold a value read
  // before the call started.
  let before: { row: SnapshotRow; snap: RolldogSnapshot } | null = null;
  let after: { row: SnapshotRow; snap: RolldogSnapshot } | null = null;
  for (const row of rows) {
    const snap = rolldogOf(row.signals);
    if (!snap) continue;
    if (row.snapshot_date < day) before = { row, snap };
    else if (row.snapshot_date > day) after = { row, snap };
  }

  const stageAt = before ? stageOf(before.snap) : null;

  if (!before || !after) {
    const which =
      !before && !after
        ? "no snapshot around this call carries a Rolldog reading"
        : !before
          ? "no snapshot before this call carries a Rolldog reading"
          : `no snapshot in the ${ADVANCE_DAYS} days after this call carries a Rolldog reading yet`;
    return { at: stageAt, advanced: { value: "unknown", detail: which } };
  }

  const fromStage = stageOf(before.snap);
  const toStage = stageOf(after.snap);
  const fromRank = rankOf(fromStage);
  const toRank = rankOf(toStage);
  if (fromRank === null || toRank === null) {
    return {
      at: stageAt,
      advanced: { value: "unknown", detail: "a Rolldog reading carries no stage to order" },
    };
  }
  if (toRank > fromRank) {
    return {
      at: stageAt,
      advanced: { value: "yes", detail: `${fromStage} to ${toStage} by ${after.row.snapshot_date}` },
    };
  }
  if (toRank < fromRank) {
    return {
      at: stageAt,
      advanced: {
        value: "no",
        detail: `slipped back, ${fromStage} to ${toStage} by ${after.row.snapshot_date}`,
      },
    };
  }
  return {
    at: stageAt,
    advanced: {
      value: "no",
      detail: `still ${toStage} on ${after.row.snapshot_date}`,
    },
  };
}

// =====================================================================
// The run
// =====================================================================

type DealRow = { id: string; account: string; external_id: string | null; rep_email: string | null };
type CallRow = {
  id: string;
  deal_id: string;
  scheduled_start: string | null;
  call_date: string | null;
  title: string | null;
  outcome: string | null;
  participants: unknown;
  meeting_type: string | null;
  call_subtype: string | null;
};

type Move = RawMove & {
  /** Which side of the table the speaker sat on, from the invite. */
  side: Side;
  /** The deal's owner, who is often not the person who said this. */
  rep: string;
  account: string;
  stage: string | null;
  callDate: string;
  callTitle: string | null;
  nextMeeting: Observed;
  advanced: Observed;
};

/** Same label prescription-report reads by, so the two group calls alike. */
function callType(c: CallRow): string {
  if (c.meeting_type === "existing_customer") return "existing_customer";
  return c.call_subtype ?? c.meeting_type ?? "unclassified";
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length === 0) line = w;
    else if (line.length + 1 + w.length <= width) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

function mark(o: Observed): string {
  return o.value === "yes" ? "yes" : o.value === "no" ? "no" : "not checked";
}

/**
 * Printed next to a speaker the invite does not place on either side. Kept
 * visible rather than dropped: the seller side is often joined by somebody who
 * was never invited, and this is the reader's cue to check before repeating it.
 */
function sideNote(side: Side): string {
  return side === "unknown" ? "  (not on the invite, side not confirmed)" : "";
}

async function main(): Promise<void> {
  const repArg = (arg("--rep") ?? "").trim().toLowerCase();
  const days = Number(arg("--days") ?? 30);
  const top = Number(arg("--top") ?? 10);
  const maxCalls = arg("--max-calls") ? Number(arg("--max-calls")) : null;
  if (!Number.isFinite(days) || days <= 0) {
    console.log("Usage: [--rep <email>] [--days N] [--top N] [--max-calls N]");
    process.exit(1);
  }

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const now = new Date().toISOString();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rep_email")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(`deals read failed: ${dealsRes.error.message}`);
  let deals = (dealsRes.data ?? []) as DealRow[];
  if (repArg) {
    deals = deals.filter(
      (d) => repEmailFor({ repEmail: d.rep_email, dealExternalId: d.external_id }) === repArg,
    );
    if (deals.length === 0) {
      console.log(`No deals for ${repArg}.`);
      return;
    }
  }
  const dealById = new Map(deals.map((d) => [d.id, d]));

  // Deliberately NOT narrowed to the selected rep's deals: the seller-side
  // directory below is built from every invite in the window, and a rep who is
  // absent from their own customer's invite is usually present on somebody
  // else's. Mining is narrowed straight after.
  const callsRes = await db
    .from("calls")
    .select(
      "id, deal_id, scheduled_start, call_date, title, outcome, participants, meeting_type, call_subtype",
    )
    .eq("tenant_id", tenantId)
    .or(`scheduled_start.gte.${since},call_date.gte.${since}`)
    .order("scheduled_start", { ascending: false });
  if (callsRes.error) throw new Error(`calls read failed: ${callsRes.error.message}`);

  const inWindow = ((callsRes.data ?? []) as CallRow[])
    .map((c) => ({ call: c, at: c.scheduled_start ?? c.call_date }))
    .filter((c): c is { call: CallRow; at: string } => Boolean(c.at))
    .filter((c) => c.at >= since && c.at <= now)
    .sort((a, b) => b.at.localeCompare(a.at));

  const directory = sellerDirectory(inWindow.map((c) => participantsOf(c.call.participants)));
  const calls = inWindow.filter((c) => dealById.has(c.call.deal_id));

  const scope = repArg ? repName(repArg) : "all reps";
  console.log(`\nMOVES MINED  ${scope}  last ${days} days\n`);
  console.log(`  calls in window          ${calls.length}`);
  if (calls.length === 0) {
    console.log("");
    return;
  }

  const selected = maxCalls && maxCalls > 0 ? calls.slice(0, maxCalls) : calls;
  if (selected.length < calls.length) {
    console.log(
      `  read                     ${selected.length} (--max-calls ${maxCalls}, so ${calls.length - selected.length} newest-first calls were not read)`,
    );
  }

  const moves: Move[] = [];
  const skipped = { not_yet: 0, no_content: 0, unavailable: 0 };
  let withTranscript = 0;
  let modelFailures = 0;
  let quotesDiscarded = 0;
  let speakersDiscarded = 0;
  let customerSideDiscarded = 0;
  let truncated = 0;

  for (const { call, at } of selected) {
    const deal = dealById.get(call.deal_id);
    const account = prettyAccount({
      account: deal?.account ?? call.deal_id,
      externalId: deal?.external_id ?? null,
    });
    const rep = repName(
      repEmailFor({
        repEmail: deal?.rep_email ?? null,
        dealExternalId: deal?.external_id ?? null,
      }),
    );

    const read = await readTranscriptForCall({ callId: call.id, outcome: call.outcome });
    if (read.status !== "present") {
      skipped[read.status] += 1;
      continue;
    }
    withTranscript += 1;

    let body = read.body;
    if (body.length > MAX_TRANSCRIPT_CHARS) {
      body = body.slice(0, MAX_TRANSCRIPT_CHARS);
      truncated += 1;
      console.log(
        `  note: ${account} ${at.slice(0, 10)} transcript truncated to ${MAX_TRANSCRIPT_CHARS} chars, moves after that point were not looked for`,
      );
    }

    const roster = participantsOf(call.participants);
    const mined = await mineCall({
      transcript: body,
      account,
      rep,
      callDate: at.slice(0, 10),
      callType: callType(call),
      roster: rosterFor(roster),
    });
    if (mined.status === "unavailable") {
      // A failed read is not a call without moves in it. Say so and move on.
      modelFailures += 1;
      console.log(`  note: ${account} ${at.slice(0, 10)} not mined: ${mined.error}`);
      continue;
    }
    if (mined.moves.length === 0) continue;

    const labels = speakerLabels(read.body);
    const kept: Array<RawMove & { side: Side }> = [];
    for (const m of mined.moves) {
      if (!quoteAppearsIn(read.body, m.quote)) {
        quotesDiscarded += 1;
        continue;
      }
      if (!speakerIsReal(labels, m.speaker)) {
        speakersDiscarded += 1;
        continue;
      }
      const side = sideOfSpeaker(roster, m.speaker, directory);
      if (side === "customer") {
        // The buyer said it. Whatever it was, it was not a seller's move.
        customerSideDiscarded += 1;
        continue;
      }
      kept.push({ ...m, doing: cleanDoing(m.doing), side });
    }
    if (kept.length === 0) continue;

    // Outcomes once per call, not once per move.
    const outcomeCall: OutcomeCall = {
      tenantId,
      callId: call.id,
      dealId: call.deal_id,
      at,
      participants: call.participants,
      repEmail: deal?.rep_email ?? null,
      dealExternalId: deal?.external_id ?? null,
    };
    const [nextMeeting, stage] = await Promise.all([
      nextMeetingWithinWeek(outcomeCall),
      stageContext({ tenantId, dealId: call.deal_id, at }),
    ]);

    for (const m of kept) {
      moves.push({
        ...m,
        rep,
        account,
        stage: stage.at,
        callDate: at.slice(0, 10),
        callTitle: call.title,
        nextMeeting,
        advanced: stage.advanced,
      });
    }
  }

  console.log(`  with a stored transcript ${withTranscript}`);
  const skippedTotal = skipped.not_yet + skipped.no_content + skipped.unavailable;
  if (skippedTotal > 0) {
    console.log(
      `  not read                 ${skippedTotal} (${skipped.no_content} had no conversation, ` +
        `${skipped.not_yet} have no transcript yet, ${skipped.unavailable} could not be read)`,
    );
  }
  console.log(`  moves kept               ${moves.length}`);
  if (
    quotesDiscarded > 0 ||
    speakersDiscarded > 0 ||
    customerSideDiscarded > 0 ||
    modelFailures > 0 ||
    truncated > 0
  ) {
    const bits: string[] = [];
    if (quotesDiscarded > 0) bits.push(`${quotesDiscarded} quote(s) not found in the transcript`);
    if (speakersDiscarded > 0) bits.push(`${speakersDiscarded} attributed to nobody on the call`);
    if (customerSideDiscarded > 0) {
      bits.push(`${customerSideDiscarded} said by the customer, not the seller`);
    }
    if (modelFailures > 0) bits.push(`${modelFailures} call(s) the model could not read`);
    if (truncated > 0) bits.push(`${truncated} transcript(s) truncated`);
    console.log(`  discarded                ${bits.join(", ")}`);
  }

  if (moves.length === 0) {
    console.log(
      `\n  Nothing survived. On a small window that usually means the calls held no move that ` +
        `beats a generic best practice, which is a finding about the calls, not a failure of the run.\n`,
    );
    return;
  }

  // =====================================================================
  // Grouped by what the move was doing
  // =====================================================================

  const byKind = new Map<MoveKind, Move[]>();
  for (const m of moves) byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m]);
  const ordered = [...byKind.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [kind, list] of ordered) {
    console.log(`\n${"=".repeat(78)}`);
    console.log(`${KIND_LABEL[kind]}   (${list.length})`);
    console.log(`${"=".repeat(78)}`);
    for (const m of list.sort((a, b) => b.callDate.localeCompare(a.callDate))) {
      console.log(
        `\n  ${m.account}  |  ${m.stage ?? "stage not checked"}  |  ${m.callDate}  |  deal owner ${m.rep}`,
      );
      console.log(`  ${m.speaker}${sideNote(m.side)}:`);
      console.log(wrap(`"${m.quote}"`, 74, "    "));
      if (m.doing) console.log(wrap(m.doing, 74, "    ") + "");
      console.log(
        `    next meeting inside ${NEXT_MEETING_DAYS}d: ${mark(m.nextMeeting)}   ` +
          `stage advanced inside ${ADVANCE_DAYS}d: ${mark(m.advanced)}`,
      );
      if (m.nextMeeting.value === "unknown" || m.advanced.value === "unknown") {
        if (m.nextMeeting.value === "unknown") {
          console.log(wrap(`next meeting not checked: ${m.nextMeeting.detail}`, 74, "      "));
        }
        if (m.advanced.value === "unknown") {
          console.log(wrap(`stage not checked: ${m.advanced.detail}`, 74, "      "));
        }
      } else {
        console.log(`      ${m.nextMeeting.detail}; ${m.advanced.detail}`);
      }
    }
  }

  // =====================================================================
  // --top: the moves that preceded an advance
  // =====================================================================

  const advanced = moves
    .filter((m) => m.advanced.value === "yes")
    .sort(
      (a, b) =>
        Number(b.nextMeeting.value === "yes") - Number(a.nextMeeting.value === "yes") ||
        b.callDate.localeCompare(a.callDate),
    );

  if (top > 0) {
    console.log(`\n${"=".repeat(78)}`);
    console.log(`MOVES THAT PRECEDED AN ADVANCE   (${advanced.length})`);
    console.log(`${"=".repeat(78)}`);
    if (advanced.length === 0) {
      const unknown = moves.filter((m) => m.advanced.value === "unknown").length;
      console.log(
        `\n  None. ${unknown} of ${moves.length} move(s) sit on a deal whose stage we could not read,\n` +
          `  usually because it has no Rolldog opportunity or the window has no snapshot yet.\n` +
          `  That is missing data, not a deal that failed to move.`,
      );
    }
    // How many CALLS this is, not how many moves. The first run printed four
    // moves here and all four were one call, which reads as four data points
    // until you notice the account and the date are the same on every line.
    const calls = new Set(advanced.map((m) => `${m.account} ${m.callDate}`));
    if (advanced.length > 0) {
      console.log(
        `\n  ${advanced.length} move(s) across ${calls.size} call(s). ` +
          `Several moves off one call are one call, not several pieces of evidence.`,
      );
    }
    for (const m of advanced.slice(0, top)) {
      console.log(
        `\n  ${m.account}  |  ${m.callDate}  |  ${KIND_LABEL[m.kind].toLowerCase()}`,
      );
      console.log(`  ${m.speaker}${sideNote(m.side)}:`);
      console.log(wrap(`"${m.quote}"`, 74, "    "));
      console.log(`    ${m.advanced.detail}`);
      console.log(`    next meeting inside ${NEXT_MEETING_DAYS}d: ${mark(m.nextMeeting)}`);
    }
    if (advanced.length > top) {
      console.log(`\n  ${advanced.length - top} more not printed (raise --top).`);
    }
  }

  // --write turns this run into the playbook the briefing reads.
  //
  // A GENERATED TYPESCRIPT FILE, not a table and not JSON on disk. Three
  // reasons, in order. A human reviews the diff before any of these quotes
  // reaches a briefing a rep reads aloud to a customer, which is the same bar
  // lib/magaya-plays.ts is held to and the reason "no briefing beats a wrong
  // one" survives contact with mined data. A statically imported module is
  // traced by Next; a path built at runtime is invisible to it, which this repo
  // has already paid for once. And it needs no migration.
  if (process.argv.includes("--write")) {
    await writePlaybook(tenantId, moves);
  }

  console.log(
    `\n  A move printed above happened BEFORE the advance. It did not necessarily cause it:\n` +
      `  nothing here holds a stage constant, and one call is one of several. Read the quote,\n` +
      `  not the ratio. "not checked" is missing data and never a zero.\n` +
      `  Attribution is the model's, verified only in that the speaker really spoke on the call.\n`,
  );
}

/**
 * Store the mined moves, so the briefing can read them.
 *
 * INTO THE DATABASE, not into the repository. An earlier version of this wrote
 * a generated TypeScript module so a reviewer could read the diff, which walked
 * straight into the one rule that forbids it: Magaya is under NDA and call
 * content is never committed. Supabase already holds the transcripts these come
 * from.
 *
 * Everything lands with approved=false. Nothing reaches a briefing until a
 * person sets it, which is the review step the file was supposed to provide.
 */
async function writePlaybook(tenantId: string, moves: Move[]): Promise<void> {
  const db = supabaseAdmin();
  const rows = moves.map((m) => ({
    tenant_id: tenantId,
    kind: m.kind,
    quote: m.quote.replace(/\s+/g, " ").trim(),
    doing: m.doing,
    speaker: m.speaker,
    rep: m.rep,
    account: m.account,
    stage: m.stage,
    call_date: m.callDate,
    preceded_advance: m.advanced.value === "yes",
    next_meeting_in_a_week: m.nextMeeting.value === "yes",
    last_seen_at: new Date().toISOString(),
  }));
  // Re-mining an overlapping window re-sees the same sentence. onConflict on the
  // quote hash updates what may have changed since (a stage that has now moved)
  // and deliberately does NOT touch `approved`: re-running the miner must never
  // silently re-approve, nor un-approve something a person has already read.
  const { error, count } = await db
    .from("mined_plays")
    .upsert(rows, { onConflict: "tenant_id,quote_hash", ignoreDuplicates: false, count: "exact" });
  if (error) {
    console.error(`\n  COULD NOT STORE: ${error.message}`);
    console.error(`  Has supabase/add-mined-plays.sql been run?`);
    return;
  }
  const { count: approved } = await db
    .from("mined_plays")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("approved", true);
  console.log(
    `\n  STORED ${count ?? rows.length} move(s) in mined_plays, all with approved=false.\n` +
      `  ${approved ?? 0} move(s) in the table are approved and readable by a briefing.\n` +
      `  Nothing here reaches a rep until someone reads it and sets approved.`,
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
