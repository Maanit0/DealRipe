/**
 * Tests for lib/draft-lint.ts.
 *
 *   npx tsx scripts/test-draft-lint.ts
 *
 * Pure. No network, no database, no env.
 *
 * A lint needs BOTH halves proved and neither is sufficient alone:
 *
 *   It must fire on the drafts a human complained about. Those are below,
 *   verbatim, because "the rule looks right" is how the last three register
 *   bugs shipped.
 *   It must NOT fire on mail the reps chose to send. That half is
 *   scripts/lint-sent-mail.ts, which runs it over all 595 real outbound
 *   messages and currently reports 0.
 *
 * The direct-address cases matter as much as the violations. A lint that
 * cannot tell "sorry you were unable to join" from "your general manager was
 * not on today's call" would fire on a rep chasing a no-show, which is the
 * false positive that makes people turn a check off.
 */

import { applyDraftFixes, draftBlocking, draftErrors, lintDraft } from "../lib/draft-lint";

let failed = 0;
let ran = 0;

function check(name: string, ok: boolean, detail?: string): void {
  ran += 1;
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
}

function rules(body: string, recipientNames?: string[]): string[] {
  return [...new Set(lintDraft({ body, recipientNames }).map((f) => f.rule))].sort();
}

/**
 * The Cyber Freight Mundo draft, 2026-09-10, verbatim. Daniel Blitstein's
 * mailbox, never sent, caught by a human reading it. Five distinct defects in
 * one email and the lint must find all five.
 */
const CYBER_FREIGHT = `Hi Rohit, Bharat,

Good to speak with you both today. Rohit, what you said about Cyber Freight Mundo being 20 to 25 years old and not being able to share data across offices really framed the urgency well, and it's clear the timing is right to move.

Quick recap of what we covered:

- Your current system has been in place for two decades and cross-office visibility is not possible, which is the core driver for the change.
- Your general manager was not on today's call, and Rohit flagged he will be out of the country shortly, so timing on the next steps matters.
- We talked through Magaya's supply chain platform and how it handles multi-office operations, and I'll be getting you the Australia and Fiji compliance details alongside the product overview by tomorrow morning CT.

Next steps:

1. I'll send the product information and the Australia and Fiji compliance details to you by tomorrow morning CT.
2. Before we go into a full demo, we'll need a mutual NDA in place so we can get into the specifics. Once you've had a chance to review the materials, could we lock in a demo for the week of September 21st, with the NDA signed ahead of it?

Let me know if anything above looks off.`;

console.log("\nlintDraft: the draft a human caught\n");

{
  const found = rules(CYBER_FREIGHT, ["Rohit", "Bharat"]);
  for (const r of [
    "qualification_vocabulary", // "urgency", and "the core driver for the change"
    "deal_reasoning", // "so timing on the next steps matters"
    "absence_note", // "Your general manager was not on today's call"
    "third_person_recipient", // "Rohit flagged he will be..."
    "correction_invite", // "if anything above looks off"
  ]) {
    check(`catches ${r}`, found.includes(r), `found: ${found.join(", ") || "nothing"}`);
  }
  check("none of it is blocking", draftBlocking(lintDraft({ body: CYBER_FREIGHT })).length === 0);
}

console.log("\nlintDraft: mail that must pass untouched\n");

// Written in the shape the reps measurably use: a specific opener, owners on
// each line, a process question to close. Nothing here is our register.
const CLEAN = `Hi Rohit, Bharat,

Good to speak with you both today. You mentioned the current system has been in place for 20 to 25 years and that offices cannot see each other's data, which is what we would be replacing first.

Quick recap of what we covered:

- You run out of three offices and each one keeps its own records, so a shipment handled in two of them has to be reconciled by hand.
- I'll get you the Australia and Fiji compliance details alongside the product overview by tomorrow morning CT.
- Before a full demo we would need a mutual NDA in place so we can get into specifics.

Once you've had a chance to review the materials, could we book the demo for the week of September 21st?

Is there a formal approval process on your side we should plan around?`;

check("a clean draft produces nothing", rules(CLEAN, ["Rohit", "Bharat"]).length === 0, rules(CLEAN, ["Rohit", "Bharat"]).join(", "));

console.log("\nlintDraft: who was absent, and who is allowed to say it\n");

check(
  "third party absent is flagged",
  rules("Your general manager was not on today's call.").includes("absence_note"),
);
check(
  "a named third party absent is flagged",
  rules("Miguel was not able to join the call today.").includes("absence_note"),
);
check(
  "addressing them directly is fine",
  !rules("Sorry you were unable to join the call today.").includes("absence_note"),
);
// Both of these are real sentences from the reps' own sent mail. Flagging them
// would fire the lint on a rep chasing a customer who stood them up.
check(
  "our own attendance is fine (we)",
  !rules("We were on the Microsoft Teams meeting today and did not see you.").includes("absence_note"),
);
check(
  "our own attendance is fine (I)",
  !rules("I was on the call at 10 and waited fifteen minutes.").includes("absence_note"),
);

console.log("\nlintDraft: rule 9c, a name on the To line\n");

check(
  "writing about a recipient is flagged",
  rules("Rohit flagged he will be out of the country shortly.", ["Rohit"]).includes("third_person_recipient"),
);
check(
  "the greeting is not a violation",
  !rules("Hi Rohit,\n\nThanks for the time today.", ["Rohit"]).includes("third_person_recipient"),
);
check(
  "direct address is not a violation",
  !rules("Hi Bharat,\n\nRohit, could you send the user counts when you get a chance?", ["Rohit", "Bharat"])
    .includes("third_person_recipient"),
);
// Rule 9a explicitly permits this: a colleague of the customer who was on the
// call but is not on the To line may be named.
check(
  "a colleague NOT on the To line may be named",
  !rules("Once Gustavo has forwarded one of the draft airway bills to the carrier, we can pick it up.", ["Rohit"])
    .includes("third_person_recipient"),
);

console.log("\nlintDraft: vocabulary the reps use vs vocabulary we invented\n");

check("urgency is ours", rules("That really framed the urgency well.").includes("qualification_vocabulary"));
check("the driver sense is ours", rules("which is the core driver for the change").includes("qualification_vocabulary"));
// Measured: 8 of 595 sent messages say "discovery call", 2 say "stakeholder".
check("discovery call is theirs", rules("We were ready for our scheduled discovery call.").length === 0);
check("stakeholder is theirs", rules("I'll loop in the other stakeholders on your side.").length === 0);
// A freight company has drivers. Banning the bare word would fire on the
// customer's own business.
check("a literal driver is fine", rules("Your drivers can scan the barcode at pickup.").length === 0);
check("Next steps: is the reps' own heading", rules("Next steps:\n\n1. I'll send the quote.").length === 0);

console.log("\nlintDraft: a gate's status is not a recap line\n");

// The OPUS draft, 2026-09-11. The whole bullet is true and reads like an
// ordinary recap line, which is what makes it the hardest case: "no hard
// timeline yet" is the timeline gate reporting itself as unanswered, sent to
// the person whose answer is missing.
check(
  "no hard timeline yet is flagged",
  rules("No hard timeline yet, but the demo is tentatively set for September 26th at 2:00 PM PT.")
    .includes("gate_status_reported"),
);
check(
  "budget remains unconfirmed is flagged",
  rules("The budget remains not confirmed on your side.").includes("gate_status_reported"),
);
check(
  "still need to confirm authority is flagged",
  rules("We still need to confirm who has authority to sign.").includes("gate_status_reported"),
);
// The ASK is the correct form of the same fact and must pass cleanly.
check(
  "asking for the date instead is clean",
  rules("Is there a date you are working back from on your side?").length === 0,
);
check(
  "a real scheduling condition is clean",
  rules("The demo is set for September 26th at 2:00 PM PT, once the NDA is signed.").length === 0,
);

console.log("\nlintDraft: asking the customer to audit the email\n");

check("looks off is flagged", rules("Let me know if anything above looks off.").includes("correction_invite"));
check("anything I missed is flagged", rules("Let me know if there's anything I missed.").includes("correction_invite"));
check("correct me is flagged", rules("Correct me if that's not right.").includes("correction_invite"));
// The single hit in 595 sent messages, and it is a rep apologising for a
// spelling rather than asking for a recap to be audited.
check(
  "a name spelling is not an audit request",
  !rules("Yeo (please excuse and correct if I got his name wrong) will make the final call.")
    .includes("correction_invite"),
);
// What the reps close on instead, from the same corpus. None may fire.
check(
  "a forward commitment closes clean",
  rules("Let me know if you have any additional feedback as you are reviewing and I will check back in regarding the filer code.").length === 0,
);
check(
  "a process question closes clean",
  rules("Is there a formal approval process on your side we should plan around before Norwood signs?").length === 0,
);

console.log("\nlintDraft: tiers\n");

{
  const f = lintDraft({ body: "The quote is ready [INSERT DATE] for review." });
  check("a placeholder suppresses", draftBlocking(f).length === 1, JSON.stringify(f));
}
{
  const f = lintDraft({ body: "We covered a lot, the demo is next.", subject: "Follow up, Acme" });
  check("a clean body has no errors", draftErrors(f).length === 0);
}
{
  const f = lintDraft({ body: "We covered a lot — the demo is next." });
  check("a dash is fix tier only", draftErrors(f).length === 0 && f.some((x) => x.rule === "dashes"));
  const fixed = applyDraftFixes({ body: "We covered a lot — the demo is next.", subject: "A — B" });
  check("applyDraftFixes removes it", !/[—–]/.test(fixed.body) && !/[—–]/.test(fixed.subject), fixed.body);
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${ran - failed}/${ran}\n`);
process.exit(failed === 0 ? 0 : 1);
