/**
 * The company's own priors, computed from what actually happened here.
 *
 * THE LOOP HAS BEEN OPEN AT THE RETURN LEG. prescribed_actions holds 894 rows
 * saying what DealRipe told a rep to do, whether they did it, and what followed.
 * generate-briefing.ts and briefing-magaya.ts receive NONE of it. So nothing
 * DealRipe has learned changes what it says next time, and "learns your winning
 * sales motion" stays a claim.
 *
 * This is the read-down half of the contract: agents read priors, agents write
 * outcomes, THE BRAIN INITIATES NOTHING. It answers questions and never decides.
 *
 * EVERY CLAIM CARRIES ITS n AND ITS EVIDENCE. Without that this becomes the
 * hardcoded CALIBRATION constant in lib/forecast-room.ts, which asserts 90%
 * against a rep's 63% and was never computed from a Magaya outcome, and which
 * scripts/evidence-pack.ts now deliberately refuses to print.
 *
 * WHAT IT MEASURES, AND WHY THAT QUESTION.
 *
 * Not "which questions win deals": 9 won and 17 lost, five of the losses one
 * hygiene sweep, and that is unanswerable this year. The answerable question is
 * whether ASKING moved the gate. For each qualification gate we compare the
 * deals where the rep followed the prescription against the deals where they
 * did not, and report the difference.
 *
 * IT IS ALLOWED TO SAY THE PRESCRIPTION DID NOT HELP. Measured 2026-09-08, reps
 * follow roughly one prescribed question in eight, and gates advance far more
 * often than prescriptions are followed. If asking makes no difference the honest
 * output is that it makes no difference, and a brain that can only produce
 * encouraging findings is a marketing asset rather than a learning system.
 */

import { supabaseAdmin } from "./supabase";

/** Below this, a gate reports insufficient evidence rather than a rate. */
export const MIN_N = 12;
/** Below this in either arm, the comparison is not made at all. */
export const MIN_ARM = 5;

export type GatePrior = {
  gate: string;
  /** Prescriptions targeting this gate whose follow-through is known. */
  n: number;
  followed: number;
  /** Advance rate among prescriptions the rep FOLLOWED. Null if the arm is thin. */
  advancedWhenFollowed: number | null;
  /** Advance rate among prescriptions the rep did NOT follow. Null if thin. */
  advancedWhenNot: number | null;
  /** followed minus not-followed. Positive means asking appeared to help. */
  lift: number | null;
  /**
   * What this supports saying out loud. Deliberately conservative: at these
   * sample sizes most gates will be "insufficient".
   */
  verdict: "insufficient" | "no_measurable_effect" | "asking_helped" | "asking_did_not_help";
  /** Prescription ids behind the numbers, so any claim is auditable. */
  evidence: { followedIds: string[]; notFollowedIds: string[] };
  /**
   * THE SAME COMPARISON AGAINST A NON-TAUTOLOGICAL OUTCOME.
   *
   * advancedWhen* is scored from outcome_qualification_advanced, which is OUR
   * OWN EXTRACTOR reporting that a field became evidenced. "The rep asked about
   * the decision process" and "our extractor then found decision-process
   * evidence" are very nearly the same event: asking a question makes the answer
   * get said, which makes the extractor find it. The schema already warns about
   * this, calling that column LEARNING and never proof.
   *
   * outcome_next_meeting does not have that problem. Asking a qualification
   * question does not mechanically book a meeting, so a lift here is a claim
   * about the DEAL rather than about our own transcript. Where the two
   * disagree, believe this one.
   */
  meetingWhenFollowed: number | null;
  meetingWhenNot: number | null;
  meetingLift: number | null;
};

type Row = {
  id: string;
  framework_field_keys: string[] | null;
  followed: string;
  outcome_qualification_advanced: string;
  outcome_next_meeting: string;
  kind: string;
};

async function pageAll(tenantId: string): Promise<Row[]> {
  const db = supabaseAdmin();
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const res = await db
      .from("prescribed_actions")
      .select("id, framework_field_keys, followed, outcome_qualification_advanced, outcome_next_meeting, kind")
      .eq("tenant_id", tenantId)
      .order("id", { ascending: true })
      .range(from, from + 999);
    // A failed page is not an empty one. Silently short priors would be worse
    // than none: they would look computed.
    if (res.error) throw new Error(`prescribed_actions read failed: ${res.error.message}`);
    const rows = (res.data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/**
 * Per-gate priors across the tenant.
 *
 * Only prescriptions whose follow-through is KNOWN are counted. 'unknown' is
 * excluded rather than folded into 'no': a commitment is often secured after the
 * call in writing, and scoring an unobserved follow-through as a failure records
 * reps who did the work as reps who did nothing.
 */
export async function computeGatePriors(tenantId: string): Promise<GatePrior[]> {
  const rows = await pageAll(tenantId);

  type Bucket = {
    followedAdv: string[]; followedNot: string[]; notAdv: string[]; notNot: string[];
    fMeet: number; fMeetN: number; nMeet: number; nMeetN: number;
  };
  const byGate = new Map<string, Bucket>();

  for (const r of rows) {
    if (!Array.isArray(r.framework_field_keys) || r.framework_field_keys.length === 0) continue;
    if (r.followed !== "yes" && r.followed !== "no") continue;
    // An unknown outcome cannot be scored either way.
    if (r.outcome_qualification_advanced !== "yes" && r.outcome_qualification_advanced !== "no") continue;

    for (const gate of r.framework_field_keys) {
      const b = byGate.get(gate) ?? {
        followedAdv: [], followedNot: [], notAdv: [], notNot: [],
        fMeet: 0, fMeetN: 0, nMeet: 0, nMeetN: 0,
      };
      const advanced = r.outcome_qualification_advanced === "yes";
      if (r.followed === "yes") (advanced ? b.followedAdv : b.followedNot).push(r.id);
      else (advanced ? b.notAdv : b.notNot).push(r.id);
      // The independent outcome, counted separately because 'unknown' is common
      // on it and must not be scored as a failure to book.
      if (r.outcome_next_meeting === "yes" || r.outcome_next_meeting === "no") {
        const booked = r.outcome_next_meeting === "yes" ? 1 : 0;
        if (r.followed === "yes") { b.fMeet += booked; b.fMeetN += 1; }
        else { b.nMeet += booked; b.nMeetN += 1; }
      }
      byGate.set(gate, b);
    }
  }

  const out: GatePrior[] = [];
  for (const [gate, b] of byGate) {
    const followedN = b.followedAdv.length + b.followedNot.length;
    const notN = b.notAdv.length + b.notNot.length;
    const n = followedN + notN;

    const advFollowed = followedN >= MIN_ARM ? b.followedAdv.length / followedN : null;
    const advNot = notN >= MIN_ARM ? b.notAdv.length / notN : null;
    const lift = advFollowed !== null && advNot !== null ? advFollowed - advNot : null;

    const meetLift =
      b.fMeetN >= MIN_ARM && b.nMeetN >= MIN_ARM ? b.fMeet / b.fMeetN - b.nMeet / b.nMeetN : null;

    // THE VERDICT USES THE INDEPENDENT OUTCOME, NOT OUR OWN EXTRACTOR.
    //
    // Measured 2026-09-08 and it inverted the answer. Scored against
    // outcome_qualification_advanced, key_decision_maker_identified showed +44
    // and decision_process_mapped +28, while why_looking showed -4. Scored
    // against whether a next meeting actually got booked, those become +6 and
    // +10, and why_looking becomes +33.
    //
    // The first set was largely tautological: the rep asks about the decision
    // process, so the decision process gets discussed, so our extractor finds
    // decision-process evidence. That is a fact about our transcript, not about
    // the deal. The independent outcome cannot be produced by the asking alone.
    //
    // The extractor lift is still carried on the object, because a large gap
    // between the two is itself the signal that a gate's apparent effect is an
    // artifact of measuring ourselves.
    //
    // Thresholds are deliberately blunt. A 10-point difference on n=20 is noise,
    // and dressing it as a finding is how a brain starts asserting things it
    // cannot support.
    let verdict: GatePrior["verdict"] = "insufficient";
    if (n >= MIN_N && meetLift !== null) {
      if (meetLift >= 0.15) verdict = "asking_helped";
      else if (meetLift <= -0.15) verdict = "asking_did_not_help";
      else verdict = "no_measurable_effect";
    }

    out.push({
      gate,
      n,
      followed: followedN,
      advancedWhenFollowed: advFollowed,
      advancedWhenNot: advNot,
      lift,
      verdict,
      evidence: {
        followedIds: [...b.followedAdv, ...b.followedNot].slice(0, 20),
        notFollowedIds: [...b.notAdv, ...b.notNot].slice(0, 20),
      },
      meetingWhenFollowed: b.fMeetN >= MIN_ARM ? b.fMeet / b.fMeetN : null,
      meetingWhenNot: b.nMeetN >= MIN_ARM ? b.nMeet / b.nMeetN : null,
      meetingLift: meetLift,
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

/**
 * The prior for one gate, as a sentence a briefing can carry, or null.
 *
 * NULL IS THE COMMON CASE AND THAT IS CORRECT. A briefing that says "we have no
 * evidence about this question" on every gate is noise; one that says something
 * only where the evidence supports it is worth reading. The caller must treat
 * null as "say nothing", never as "no effect".
 */
export function priorLine(p: GatePrior): string | null {
  if (p.verdict === "insufficient") return null;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  // Every sentence is about the INDEPENDENT outcome. Our extractor agreeing is
  // not evidence, because asking the question is what makes it agree.
  if (p.verdict === "asking_helped") {
    return `Worth asking: a next meeting was booked after ${pct(p.meetingWhenFollowed ?? 0)} of the calls where a rep raised this, against ${pct(p.meetingWhenNot ?? 0)} where they did not (n=${p.n}).`;
  }
  if (p.verdict === "asking_did_not_help") {
    return `Raising this did not help here: a next meeting followed ${pct(p.meetingWhenFollowed ?? 0)} of the time when it was asked against ${pct(p.meetingWhenNot ?? 0)} when it was not (n=${p.n}).`;
  }
  return `No measurable difference to what happened next, whether this was asked or not (n=${p.n}).`;
}
