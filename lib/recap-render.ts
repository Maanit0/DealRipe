/**
 * Rendering the recap as a document a person would write.
 *
 * This exists because of a specific failure. docs/recap-target-eduardo.md sets
 * the acceptance test as putting our recap beside the one Eduardo produced from
 * the same transcript, and says plainly: "If ours is shorter, safer, or more
 * structured than his, it has failed."
 *
 * The first version passed on content and failed on exactly that. Every fact
 * had its quote hanging underneath it on its own indented line, which reads as
 * a data export. His reads as a readout. Same facts, and only one of them is
 * something a rep pastes into a Salesforce Note and shares with a solution
 * engineer, which is what he actually does with it.
 *
 * So quotes go inline, in the sentence, the way a person quotes someone. The
 * structured form is still there underneath in the Narrative type for anything
 * that wants to compute over it; this is the reading view.
 *
 * Plain text rather than HTML on purpose: this feeds a Salesforce Note, the
 * plain-text arm of the recap email, and the preview, and all three want the
 * same words.
 */

import type { DemoStrategy, Narrative, PassResult, QuotedFact } from "./recap-passes";
import { applyMagayaTerms } from "./magaya-terms";

/** "Debra said X ("quote")." with the attribution only when we have it. */
function sentenceWithQuote(f: QuotedFact): string {
  const quote = f.quote.trim().replace(/\s+/g, " ");
  const who = f.speaker ? `${f.speaker}: ` : "";
  // The statement already reads as a sentence. The quote earns its place after
  // it, not on a line of its own.
  const stop = /[.!?]$/.test(f.statement) ? "" : ".";
  return `${f.statement}${stop} ${who}"${quote}"`;
}

function para(lines: string[]): string {
  return lines.filter((l) => l.trim().length > 0).join("\n");
}

/**
 * A pass that did not produce anything still says something.
 *
 * Never an empty heading. "Absent" and "unavailable" are different facts and a
 * reader who cannot tell them apart cannot know whether to re-run.
 */
export function renderPassGap(label: string, r: PassResult<unknown>): string | null {
  if (r.status === "present") return null;
  return r.status === "absent"
    ? `${label}\nNothing to report. ${r.reason}`
    : `${label}\nNot generated. ${r.reason} This is not a statement about the call.`;
}

export function renderNarrativeProse(n: Narrative): string {
  const out: string[] = [];

  if (n.executiveSummary) {
    out.push("EXECUTIVE SUMMARY");
    out.push(n.executiveSummary);
    out.push("");
  }

  if (n.currentEnvironment.length > 0) {
    out.push("CURRENT ENVIRONMENT");
    // Written as a sentence, not a record.
    //
    // The first version emitted "125 users. Total users across all platforms,
    // warehousing, freight forwarding, and customs (Debra Kristopson)": number
    // first, label second, attribution in brackets on every line. Correct
    // content in the shape of a data export, which is the specific failure
    // docs/recap-target-eduardo.md warns about. The statement already reads as
    // a sentence and usually contains the figure, so lead with it and let the
    // number stand behind it only when it adds something.
    out.push(
      para(
        n.currentEnvironment.map((f) => {
          const figure = `${f.value} ${f.unit}`.trim();
          const said = f.speaker ? `${f.speaker} said ` : "";
          const body = /[.!?]$/.test(f.statement) ? f.statement : `${f.statement}.`;
          // Lowercasing the first word after "said" reads correctly for a
          // determiner and mangles a proper noun: "Debra Kristopson said
          // dunavant has 125 users". Only fold the small set of openers where
          // the capital is grammatical rather than part of a name.
          const foldable = /^(the|they|their|this|these|those|it|its|a|an|we|our|there)\b/i;
          // Avoid "125 users. 125 users across all platforms."
          const restate = f.statement.toLowerCase().includes(f.value.toLowerCase())
            ? ""
            : ` (${figure})`;
          const opened = said && foldable.test(body) ? body.charAt(0).toLowerCase() + body.slice(1) : body;
          return `- ${said}${opened}${restate}`;
        }),
      ),
    );
    out.push("");
  }

  if (n.environmentNotes.length > 0) {
    out.push("HOW THEY WORK TODAY");
    out.push(para(n.environmentNotes.map((f) => `- ${f.statement}`)));
    out.push("");
  }

  if (n.painPoints.length > 0) {
    out.push("PAIN POINTS AND DECISION DRIVERS");
    out.push("In the order they weighted them.");
    out.push("");
    out.push(para(n.painPoints.map((f, i) => `${i + 1}. ${sentenceWithQuote(f)}`)));
    out.push("");
  }

  if (n.operationalDetail) {
    out.push("THE DETAIL THAT MATTERS");
    out.push(n.operationalDetail);
    out.push("");
  }

  if (n.requirementsByArea.length > 0) {
    out.push("REQUIREMENTS BY AREA");
    for (const r of n.requirementsByArea) {
      out.push(`${r.area}`);
      out.push(para(r.requirements.map((q) => `  - ${q}`)));
      out.push("");
    }
  }

  if (n.buyingProcess.length > 0) {
    out.push("BUYING PROCESS");
    out.push(para(n.buyingProcess.map((f) => `- ${sentenceWithQuote(f)}`)));
    out.push("");
  }

  if (n.timeline.length > 0) {
    out.push("TIMELINE AND URGENCY");
    out.push(para(n.timeline.map((f) => `- ${sentenceWithQuote(f)}`)));
    out.push("");
  }

  const { customerOwes, weOwe } = n.nextSteps;
  if (customerOwes.length > 0 || weOwe.length > 0) {
    out.push("AGREED NEXT STEPS");
    if (customerOwes.length > 0) {
      out.push("They owe us:");
      out.push(para(customerOwes.map((f) => `  - ${f.statement}`)));
    }
    if (weOwe.length > 0) {
      out.push("We owe them:");
      out.push(para(weOwe.map((f) => `  - ${f.statement}`)));
    }
    out.push("");
  }

  return out.join("\n").trimEnd();
}

/**
 * The long form, for the Salesforce Note.
 *
 * Eduardo pastes our recap into a Note by hand and shares that Note with the
 * solution engineer to prep the demo, so the Note is the real consumer and
 * length is a feature there. His words: "it seems long but I like to have it
 * because it helps me."
 *
 * The email is a different artifact with a different reader, a rep on a phone
 * an hour after a call. Same generation, two renderings: see renderRecapEmailBody.
 */
export function renderRecapNote(args: {
  account: string;
  callTitle?: string | null;
  callAt?: string | null;
  stageKey: string;
  narrative: PassResult<Narrative>;
  demoStrategy: PassResult<DemoStrategy>;
  captured: ReadonlyArray<{ label: string; answer: string }>;
  stillOpen: ReadonlyArray<{ label: string; question: string; stageKey: string | null }>;
  history: string | null;
}): string {
  const out: string[] = [];
  out.push(`Call recap: ${args.account}`);
  if (args.callTitle) out.push(args.callTitle);
  if (args.callAt) out.push(args.callAt);
  out.push("");

  out.push(
    args.narrative.status === "present"
      ? renderNarrativeProse(args.narrative.value)
      : (renderPassGap("NARRATIVE", args.narrative) ?? ""),
  );
  out.push("");

  // The audit, after the narrative and never before it. He asked for it to stay
  // and asked for it not to colour the readout's language.
  out.push(`QUALIFICATION, AGAINST ${args.stageKey}`);
  out.push("");
  out.push(`Confirmed on this call (${args.captured.length}):`);
  out.push(
    args.captured.length === 0
      ? "  Nothing new was confirmed against the framework on this call."
      : args.captured.map((c) => `  - ${c.label}: ${c.answer}`).join("\n"),
  );
  out.push("");
  out.push(`Still open (${args.stillOpen.length}):`);
  out.push(
    args.stillOpen.length === 0
      ? "  Nothing open at this stage."
      : args.stillOpen.map((o) => `  - [${o.stageKey ?? "?"}] ${o.label}. ${o.question}`).join("\n"),
  );
  out.push("");

  if (args.history) {
    out.push("PRIOR CALLS ON THIS DEAL");
    out.push(args.history);
    out.push("");
  }

  out.push(
    args.demoStrategy.status === "present"
      ? renderDemoStrategyProse(args.demoStrategy.value)
      : (renderPassGap("RECOMMENDED DEMO STRATEGY", args.demoStrategy) ?? ""),
  );

  return out.join("\n").trimEnd();
}

/**
 * The Note for a call that is NOT a new-business conversation.
 *
 * WHY THIS EXISTS
 *
 * renderRecapNote is qualification-only, so a renewal, a support call or an
 * existing-customer conversation produced a readout for the rep and nothing at
 * all for the CRM. Three of Magaya's 84 captured calls are in that hole (Best
 * on 2026-07-16, CBX Global on 07-20 and 07-22), and they are not misfiled: all
 * three carry Account.Type = Customer, so `existing_customer` is the correct
 * classification and the missing artifact is the actual gap.
 *
 * It matters more than the count suggests. An expansion conversation with a
 * paying customer is exactly the record a solution engineer wants before the
 * next call, and Eduardo pastes recaps into Notes by hand precisely for that.
 *
 * WHAT IT DELIBERATELY OMITS
 *
 * The qualification audit, all of it. docs/recap-target-eduardo.md routes the
 * audit and only the audit; running it here would tell a customer who has paid
 * for years that their budget and decision process are open, which is the
 * renewal-QBR failure the call-type work exists to stop. The narrative runs for
 * every call type, so what is left is the readout, which is the part a reader
 * of a Note wants anyway.
 *
 * `fallback` is the older shallow shape and is used ONLY when the narrative
 * pass produced nothing, so a failed pass degrades to a thinner Note rather
 * than to no Note. A pass that failed says so; it never renders as an empty
 * section, which would read as "nothing was discussed".
 */
export function renderGeneralRecapNote(args: {
  account: string;
  callTitle?: string | null;
  callAt?: string | null;
  /** How the call was classified, stated plainly so a reader knows why there
   *  is no qualification section rather than assuming one went missing. */
  meetingType: string;
  narrative: PassResult<Narrative>;
  fallback?: { summary: string; takeaways: string[]; nextSteps: string[] } | null;
  history: string | null;
}): string {
  const out: string[] = [];
  out.push(`Call recap: ${args.account}`);
  if (args.callTitle) out.push(args.callTitle);
  if (args.callAt) out.push(args.callAt);
  out.push("");
  out.push(
    `Classified as ${args.meetingType.replace(/_/g, " ")}, so this is the readout without a ` +
      `qualification audit. A new-business audit on this call would list gates the account settled long ago.`,
  );
  out.push("");

  if (args.narrative.status === "present") {
    out.push(renderNarrativeProse(args.narrative.value));
  } else if (args.fallback) {
    // The narrative failed and the shallow pass did not. Say which, so a thin
    // Note is legible as a degraded one rather than as a thin conversation.
    out.push(renderPassGap("NARRATIVE", args.narrative) ?? "");
    out.push("");
    out.push("WHAT THE CALL COVERED");
    out.push(args.fallback.summary);
    if (args.fallback.takeaways.length > 0) {
      out.push("");
      out.push("TAKEAWAYS");
      out.push(args.fallback.takeaways.map((t) => `  - ${t}`).join("\n"));
    }
    if (args.fallback.nextSteps.length > 0) {
      out.push("");
      out.push("NEXT STEPS");
      out.push(args.fallback.nextSteps.map((t) => `  - ${t}`).join("\n"));
    }
  } else {
    out.push(renderPassGap("NARRATIVE", args.narrative) ?? "");
  }

  if (args.history) {
    out.push("");
    out.push("PRIOR CALLS ON THIS DEAL");
    out.push(args.history);
  }

  return out.join("\n").trimEnd();
}

/**
 * The short form, for the email a rep opens on a phone.
 *
 * Four things only: what this account is, what hurts, what we still owe them,
 * and what could go wrong. Everything else is in the Note. A recap nobody
 * finishes reading is worse than a shorter one that gets acted on, and the rep
 * already has the long version where they will actually use it.
 */
function renderRecapEmailBodyInner(args: {
  narrative: PassResult<Narrative>;
  demoStrategy: PassResult<DemoStrategy>;
  noteUrl?: string | null;
}): string {
  const out: string[] = [];

  if (args.narrative.status !== "present") {
    out.push(renderPassGap("READOUT", args.narrative) ?? "");
  } else {
    const n = args.narrative.value;
    if (n.executiveSummary) out.push(n.executiveSummary);
    if (n.painPoints.length > 0) {
      out.push("");
      out.push("What hurts, in their order:");
      // Statement only. The quotes are the Note's job; here they would double
      // the length of the one section a rep reads on a phone.
      out.push(n.painPoints.slice(0, 4).map((p, i) => `${i + 1}. ${p.statement}`).join("\n"));
    }
    if (n.nextSteps.weOwe.length > 0) {
      out.push("");
      out.push("What we owe them:");
      out.push(n.nextSteps.weOwe.map((f) => `  - ${f.statement}`).join("\n"));
    }
    if (n.nextSteps.customerOwes.length > 0) {
      out.push("");
      out.push("What they owe us:");
      out.push(n.nextSteps.customerOwes.map((f) => `  - ${f.statement}`).join("\n"));
    }
  }

  if (args.demoStrategy.status === "present" && args.demoStrategy.value.risks.length > 0) {
    out.push("");
    out.push("Risks:");
    out.push(args.demoStrategy.value.risks.slice(0, 4).map((r) => `  - ${r}`).join("\n"));
  }

  if (args.demoStrategy.status === "present" && args.demoStrategy.value.validateInternally.length > 0) {
    // Promoted into the short form deliberately. On Dunavant this is the item
    // that decides whether the demo lands, and it is the one thing a rep has to
    // act on before the session rather than during it.
    out.push("");
    out.push("Resolve internally before the demo:");
    out.push(args.demoStrategy.value.validateInternally.slice(0, 3).map((v) => `  - ${v}`).join("\n"));
  }

  out.push("");
  out.push(
    args.noteUrl
      ? `Full readout, requirements by area and the demo plan: ${args.noteUrl}`
      : "The full readout, requirements by area and demo plan are on the deal.",
  );
  return out.join("\n").trimEnd();
}

export function renderDemoStrategyProse(d: DemoStrategy): string {
  const out: string[] = [];
  out.push("RECOMMENDED DEMO STRATEGY");
  if (d.buildsOnRepPlan) {
    out.push("Starts from the split the rep proposed on the call and extends it where the call left gaps.");
  }
  out.push("");

  // The customer's goals come FIRST, before anything about our product.
  //
  // That order is the motion, not a layout preference. Eduardo's Aqua Gulf deck
  // opens on slide 4 with the customer's strategic goals and only then reaches
  // Magaya's company overview, and six of its seven lines are this section
  // verbatim. A reader building that deck should find this at the top.
  if (d.strategicGoals.length > 0) {
    out.push("STRATEGIC GOALS, IN THEIR TERMS");
    out.push(para(d.strategicGoals.map((g) => `- ${g}`)));
    out.push("");
  }

  // Deliberately separate, and deliberately labelled as not drivers. An
  // interest sitting in the goals list is how a demo gets built around
  // something nobody will pay for.
  if (d.interests.length > 0) {
    out.push("INTERESTS, NOT YET DRIVERS");
    out.push("Raised with no pain behind them. Worth showing, not worth building the session around.");
    out.push(para(d.interests.map((g) => `- ${g}`)));
    out.push("");
  }

  for (const [i, s] of d.sessions.entries()) {
    out.push(`Session ${i + 1}: ${s.name}${s.minutes ? ` (${s.minutes} minutes)` : ""}`);
    out.push(para(s.cover.map((c) => `  - ${c}`)));
    if (s.why) {
      out.push(`  Why here: ${s.why}`);
    }
    out.push("");
  }

  // Deliberately its own heading and deliberately never blank. An empty list
  // here asserts that we looked and found nothing, which is a different claim
  // from a section that was never written.
  out.push("VALIDATE INTERNALLY BEFORE THESE SESSIONS");
  out.push(
    d.validateInternally.length === 0
      ? "Nothing on this call needed internal validation. Every capability the customer asked about was answered without hedging."
      : para(d.validateInternally.map((v) => `- ${v}`)),
  );
  out.push("");

  if (d.risks.length > 0) {
    out.push("RISKS");
    out.push(para(d.risks.map((r) => `- ${r}`)));
    out.push("");
  }

  if (d.strengths.length > 0) {
    out.push("WHAT IS GOING FOR THIS DEAL");
    out.push(para(d.strengths.map((s) => `- ${s}`)));
    out.push("");
  }

  if (d.recommendation) {
    out.push("RECOMMENDATION");
    out.push(d.recommendation);
    out.push("");
  }

  if (d.positioning) {
    out.push("POSITIONING");
    out.push(d.positioning);
  }

  return out.join("\n").trimEnd();
}

/**
 * The recap as the rep reads it, with Magaya's own spelling of its own product
 * applied last. See lib/magaya-terms.ts: one wrong proper noun does not get
 * corrected by the reader, it discards the whole document.
 */
export function renderRecapEmailBody(args: Parameters<typeof renderRecapEmailBodyInner>[0]): string {
  return applyMagayaTerms(renderRecapEmailBodyInner(args));
}
