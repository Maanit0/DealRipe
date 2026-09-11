/**
 * Rules the follow-up draft must obey before it lands in a rep's outbox.
 *
 * THE DRAFT WAS THE ONLY GENERATED ARTIFACT WITH NO DETERMINISTIC CHECK. The
 * briefing has had lintBriefing since it existed, the recap and the demo
 * strategy got lintRecap and lintGeneralRecap on 2026-09-08, and this one has
 * had nothing but a very long prompt. That asymmetry is why the same defect
 * kept arriving: a prose rule competes with two hundred other prose rules and
 * loses quietly, and nothing downstream can tell that it lost.
 *
 * Three instances of one class, all found by a human reading a draft rather
 * than by anything in the code:
 *
 *   2026-09-09  "Steven sent the NDA to the CFO's email" -> rule 9b, the rep
 *               written in the third person in their own email.
 *   2026-09-09  "The CFO holds signing authority for contracts and NDAs" ->
 *               rule 9d, our qualification note read back to the person who
 *               already knows it.
 *   2026-09-10  "Rohit flagged he will be out of the country shortly, so
 *               timing on the next steps matters" -> both at once, plus
 *               "framed the urgency well" and "the core driver for the
 *               change", which is analyst vocabulary said out loud to a buyer.
 *
 * Only the first of those had enforcement (fixThirdPersonSender). It is the
 * only one that has not recurred.
 *
 * TIERS, the same three the recap uses and for the same reason:
 *
 *   fix         Deterministic and lossless. Applied, never reported upward.
 *   regenerate  Worth one more attempt, then ship and flag. Register problems:
 *               the email is not WRONG, it sounds like a CRM. Suppressing a
 *               draft over a noun would hand the rep a blank page after a real
 *               call, and a rep with no draft writes nothing at all.
 *   suppress    Do not create the draft. Anything that asserts what we cannot
 *               stand behind, or that would embarrass the rep on sight.
 *
 * EVERY PATTERN HERE IS GROUNDED. A lint rule is a flag, so CLAUDE.md's rule
 * applies to it: check the fire rate across the whole book before shipping it.
 * These were measured against the 595 real outbound messages the six reps
 * actually sent (deal_messages.body_trimmed, machine senders and calendar
 * responses excluded). The whole set fires on ONE of them, 0.2%, and that one
 * is a rep who wrote "no budget allocated yet" to a customer, which is the
 * same mistake rather than a false positive. Near-zero on mail humans chose to
 * send is the only evidence these catch DealRipe's register and not sales
 * email; scripts/lint-sent-mail.ts re-runs the check and must stay there.
 *
 * Three rules were DELETED outright because that check fired them on the reps'
 * own mail. They are listed below rather than quietly dropped, since the
 * tempting move is to keep a rule that feels right.
 */

import { normalizeDashes } from "./recap-lint";

export type DraftFinding = {
  tier: "fix" | "regenerate" | "suppress";
  rule: string;
  detail: string;
};

/**
 * Sales-qualification vocabulary, spoken aloud to a buyer.
 *
 * The recap bans these from its narrative and the draft never did, which is
 * how "really framed the urgency well" and "the core driver for the change"
 * reached a customer-facing email. They are not wrong; they are the register
 * of a deal review, and a buyer reading their own conversation described in
 * pipeline vocabulary learns that a system wrote it.
 *
 * DELIBERATELY NOT ON THIS LIST. Each was removed because the reps THEMSELVES
 * write it to customers, which settles the question: if it appears in mail a
 * human chose to send, it is their vocabulary and not our register problem.
 * scripts/lint-sent-mail.ts is what caught these, and it caught them by firing
 * on the control group, which is the whole reason to have one.
 *   "discovery call"  8 of 595 sent messages. Mostly no-show and reschedule
 *                     notes: "we were online and ready for our scheduled
 *                     discovery call". It is what they call the meeting.
 *   "stakeholder"     2 of 595. Theirs, not ours.
 *   "next steps"      Eduardo, Alexandra and Daniel all write a "Next steps:"
 *                     heading. The reps' own shape.
 *   "timeline", "use case"   Ordinary business English.
 *   "pipeline"        Ambiguous in freight. Nothing needs it.
 */
const QUALIFICATION_WORDS = [
  "urgency",
  "compelling event",
  "decision criteria",
  "decision maker",
  "economic buyer",
  "budget holder",
  "pain point",
  "qualification",
  "buying process",
  "buying group",
  "champion",
  "meddic",
  "bant",
  "sql1",
  "sql2",
  "sql3",
  "sql4",
  "sql5",
];

/**
 * "driver" in the qualification sense, which is the one that leaked.
 *
 * Not the bare word: a freight company has drivers, and banning it outright
 * would fire on the customer's own business. Only the analyst construction,
 * where a driver is a reason a deal is happening rather than a person in a
 * truck.
 */
const DRIVER_SENSE = /\b(the |a |their |your |our )?(core|key|main|primary|business|decision|biggest) driver\b|\bdriver (for|of|behind) the (change|decision|project|move|search|evaluation)\b/i;

/**
 * A conclusion about the DEAL, addressed to the buyer.
 *
 * "so timing on the next steps matters" is a sentence from a pipeline review.
 * It tells the customer that their own situation has consequences for our
 * sequencing, which is true, ours to act on, and none of their business.
 */
const DEAL_REASONING = [
  /\bso (the )?timing\b[^.!?]{0,40}\bmatters\b/i,
  /\btiming (is|feels|seems) right\b/i,
  /\bwindow (is|are) (closing|narrow)\b/i,
  /\bwhile (the |this )?(momentum|window)\b/i,
  /\bbefore (the )?(quarter|fiscal|budget cycle) (end|close)/i,
];

/**
 * Reporting the STATE OF A QUALIFICATION GATE to the customer.
 *
 * This is the purest form of the defect and the hardest to see, because the
 * sentence is true and reads like a normal recap line. "No hard timeline yet,
 * but the demo is tentatively set for September 26th" went out in a draft to a
 * customer. "No hard timeline yet" is not something that happened on the call.
 * It is the timeline gate reporting itself as unanswered, which is a field in
 * our own extraction, rendered as prose, addressed to the person whose answer
 * is missing.
 *
 * The customer does not need to be told what we failed to learn. If the
 * timeline matters, ASK for it. A recap line describes what was said; this
 * describes what was not, which is a gap audit.
 *
 * Distinct from DEAL_REASONING above: that one states a conclusion, this one
 * states a gate's status. Both are deal-review sentences and they arrive by
 * different routes, so they are detected and named separately.
 */
const GATE_STATUS = [
  /\bno (?:hard |firm |set |fixed |confirmed |specific )?(?:timeline|time frame|timeframe|budget|close date|decision|approval|next step)s?\b[^.!?]{0,20}\b(?:yet|so far|as of yet|at this (?:point|stage))\b/i,
  /\b(?:timeline|timing|budget|decision process|approval process|signing path|authority)\b[^.!?]{0,24}\b(?:is|are|remains|remain)\b[^.!?]{0,12}\b(?:unclear|unknown|undefined|tbd|to be determined|not confirmed|still open|outstanding)\b/i,
  /\bstill (?:need|needs|waiting) to (?:confirm|establish|nail down|pin down)\b[^.!?]{0,24}\b(?:budget|timeline|authority|decision)\b/i,
  /\b(?:we|i) (?:have|haven't|have not) (?:not )?(?:yet )?(?:confirmed|established|captured|nailed down)\b[^.!?]{0,24}\b(?:budget|timeline|decision|authority)\b/i,
];

/**
 * Telling the customer who was NOT in the room.
 *
 * "Your general manager was not on today's call" is a roster note we keep for
 * ourselves. They know who came.
 *
 * ONLY A THIRD PARTY. The subject is captured so the two legitimate cases
 * survive, and both were found by running this over the reps' own sent mail
 * rather than by thinking about it:
 *   "you"      addressing them directly. "Sorry you were unable to join" is a
 *              normal thing a person writes.
 *   "we", "I"  the SELLER's attendance, which is the entire content of a
 *              no-show note. Two of the 595 sent messages are exactly that:
 *              "We were on the Microsoft Teams meeting today" and "We were
 *              online and ready for our scheduled discovery call". Flagging
 *              those would have made the lint fire on a rep chasing a customer
 *              who stood them up.
 * Anything else, a named third party or "your <role>", is the deal-review
 * version and the one that reached a customer.
 */
// Case-sensitive ON PURPOSE: the `[A-Z][a-z]+` branch is how a person's name
// is told from an ordinary noun, so an /i flag would match every word. The
// pronoun and "your" branches therefore have to spell out both cases, and
// forgetting that is why the first version missed "Your general manager was
// not on today's call" at the start of a bullet.
const ABSENCE = /\b([Yy]ou|[Ww]e|I|[Yy]our\s+[a-z]+(?:\s+[a-z]+)?|[A-Z][a-z]+)\s+(?:was|were|wasn't|weren't)\s+(?:not\s+)?(?:able to\s+)?(?:un)?(?:on|join|attend|present|available)[a-z]*\b[^.!?]{0,40}\b(call|meeting|session|today)\b/;
const ABSENCE_ALLOWED_SUBJECTS = new Set(["you", "we", "i"]);

/**
 * Asking the customer to audit the email.
 *
 * MEASURED, and this is the reason the rule exists rather than a preference:
 * across 595 real messages the six reps sent, a correction-invite appears
 * ONCE, and that one is about the spelling of a person's name. The shape does
 * not exist in this team's mail. It was in our prompt twice, as "a line
 * inviting correction", and worse, rule 10b quoted the exact sentence "Let me
 * know if anything looks off from the recap below" as an example of a
 * DIFFERENT bug. Rule 5b warns that examples teach wording rather than shape;
 * the model lifted the phrase straight out of its own ban and shipped it.
 *
 * What the reps close a recap email on instead, from the same corpus: a
 * process question ("Is there a formal approval process on your side we should
 * plan around before Norwood signs?"), a restatement of what the customer
 * owes ("Olga, you are sending a sample IE cancellation document"), or a
 * forward commitment ("Let me know if you have any additional feedback as you
 * are reviewing and I will check back in regarding the filer code").
 */
const CORRECTION_INVITE = [
  /\b(look|looks|sound|sounds|seem|seems)\s+(off|wrong|incorrect|inaccurate)\b/i,
  /\banything\s+(?:above|below|here|there)?\s*(?:is\s+)?(?:off|wrong|incorrect|inaccurate|amiss)\b/i,
  /\banything\s+(?:i\s+)?(?:missed|left out|overlooked|got wrong|mischaracter)/i,
  /\b(?:correct me|set me straight)\b/i,
  // "if I got his name wrong" is the single hit in 595 sent messages and it is
  // a rep apologising for a spelling, not asking the customer to audit a
  // recap. Excluded by name rather than by lowering the rule, so the rule
  // still catches "if I got any of that wrong".
  /\bif (?:i|we) (?:missed|misunderstood|got (?!.{0,12}\bname\b).{0,12}wrong)\b/i,
];

/** An unfilled template token. Never acceptable in something a rep may send. */
const PLACEHOLDER = /\[(?:insert|name|company|customer|todo|tbd|xxx)[^\]]*\]|\{\{[^}]+\}\}|\bTBD\b|\bXXX\b/i;

/**
 * Strip the parts of a body that are legitimately allowed to carry a name:
 * the greeting line, and the appended signature block.
 *
 * Without this, "Hi Rohit," is a third-person reference to Rohit and every
 * draft fails. The signature is appended by appendRepSignature AFTER this lint
 * runs, so it is normally absent, but the helper is exported and callers may
 * pass a finished body.
 */
function bodyWithoutGreetingOrSignature(body: string): string {
  const lines = body.split("\n");
  let start = 0;
  // The greeting is the first non-empty line when it looks like one.
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    if (/^(hi|hello|hey|dear|good (morning|afternoon|evening)|buenas|hola|estimad)/i.test(lines[i].trim())) {
      start = i + 1;
    }
    break;
  }
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^(thanks|thank you|best|best regards|regards|kind regards|cheers|sincerely|saludos|un saludo)[,!.]?$/i.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * Every rule, over a draft body.
 *
 * `recipientNames` are the first names of the people this email is ADDRESSED
 * to, which is what separates rule 9c from rule 9a. A colleague of the
 * customer who was on the call but is not on the To line may legitimately be
 * named in the third person ("once Gustavo has forwarded one of the draft
 * airway bills"); a person reading the email may not, because to them the
 * third person reads as being talked about.
 */
export function lintDraft(args: {
  body: string;
  subject?: string;
  recipientNames?: ReadonlyArray<string>;
}): DraftFinding[] {
  const out: DraftFinding[] = [];
  const { body } = args;
  const prose = bodyWithoutGreetingOrSignature(body);
  const lower = prose.toLowerCase();

  if (/[—–]/.test(body) || /[—–]/.test(args.subject ?? "")) {
    out.push({ tier: "fix", rule: "dashes", detail: "em or en dash present" });
  }

  const ph = PLACEHOLDER.exec(body) ?? PLACEHOLDER.exec(args.subject ?? "");
  if (ph) {
    out.push({ tier: "suppress", rule: "placeholder", detail: `unfilled token ${ph[0]}` });
  }

  for (const w of QUALIFICATION_WORDS) {
    if (lower.includes(w)) {
      out.push({
        tier: "regenerate",
        rule: "qualification_vocabulary",
        detail: `"${w}" is deal-review vocabulary, not something a rep says to a buyer`,
      });
    }
  }

  const driver = DRIVER_SENSE.exec(prose);
  if (driver) {
    out.push({
      tier: "regenerate",
      rule: "qualification_vocabulary",
      detail: `"${driver[0].trim()}" describes the deal, not their business. Say the reason itself.`,
    });
  }

  for (const re of DEAL_REASONING) {
    const m = re.exec(prose);
    if (m) {
      out.push({
        tier: "regenerate",
        rule: "deal_reasoning",
        detail: `"${m[0].trim()}" is a conclusion about our sequencing, addressed to the buyer`,
      });
      break;
    }
  }

  for (const re of GATE_STATUS) {
    const m = re.exec(prose);
    if (m) {
      out.push({
        tier: "regenerate",
        rule: "gate_status_reported",
        detail:
          `"${m[0].trim()}" reports what we failed to learn. That is a gap audit, not a recap. ` +
          `If it matters, ask for it instead.`,
      });
      break;
    }
  }

  const absence = ABSENCE.exec(prose);
  // Addressing the person directly is fine, and so is our own attendance;
  // reporting on a third party is not.
  if (absence && !ABSENCE_ALLOWED_SUBJECTS.has(absence[1].toLowerCase())) {
    out.push({
      tier: "regenerate",
      rule: "absence_note",
      detail: `"${absence[0].trim().slice(0, 70)}" tells the customer who was not in their own meeting`,
    });
  }

  for (const re of CORRECTION_INVITE) {
    const m = re.exec(prose);
    if (m) {
      out.push({
        tier: "regenerate",
        rule: "correction_invite",
        detail: `"${m[0].trim()}" asks the customer to audit the email. 1 of 595 sent rep messages does this.`,
      });
      break;
    }
  }

  // Rule 9c, enforced. A name on the To line, used in the body.
  for (const raw of args.recipientNames ?? []) {
    const name = raw.trim();
    if (name.length < 3) continue;
    // EVERY occurrence, not the first.
    //
    // The first version used a single exec and the Cyber Freight draft slipped
    // straight through it: "Rohit, what you said about..." is direct address
    // and legal, so the check skipped it and never looked at "Rohit flagged he
    // will be out of the country" four lines later. One legal use of a name
    // was granting an amnesty to every illegal one in the same email, which is
    // this codebase's own failure mode arriving from the inside.
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    const offender = [...prose.matchAll(re)].find((m) => {
      // "Thanks Rohit" and "Rohit, could you" are direct address, not third
      // person. The tell is punctuation immediately after the name.
      const after = prose.slice(m.index + name.length, m.index + name.length + 40);
      return !/^\s*[,:!?]/.test(after);
    });
    if (!offender) continue;
    out.push({
      tier: "regenerate",
      rule: "third_person_recipient",
      detail:
        `"${prose.slice(offender.index, offender.index + 46).trim()}" names someone on the To line. ` +
        `To them that reads as being talked about. Use "you".`,
    });
  }

  return out;
}

/** The findings a caller must act on. `fix` is applied, never reported. */
export function draftErrors(findings: ReadonlyArray<DraftFinding>): DraftFinding[] {
  return findings.filter((f) => f.tier !== "fix");
}

export function draftBlocking(findings: ReadonlyArray<DraftFinding>): DraftFinding[] {
  return findings.filter((f) => f.tier === "suppress");
}

/** Apply every `fix`-tier rule. Lossless by construction. */
export function applyDraftFixes(args: { body: string; subject: string }): { body: string; subject: string } {
  return { body: normalizeDashes(args.body), subject: normalizeDashes(args.subject) };
}

export function describeDraftFindings(findings: ReadonlyArray<DraftFinding>): string {
  return findings.map((f) => `${f.rule}: ${f.detail}`).join("; ");
}
