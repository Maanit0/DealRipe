/**
 * Write to the Salesforce OPPORTUNITY, not just the Account.
 *
 * Everything DealRipe writes to Salesforce today lands on Account. The schema
 * survey on 2026-08-14 showed that is half the picture: Magaya maintains
 * opportunity fields their reps fill by hand, two of which DealRipe already
 * knows the answer to and has simply never written.
 *
 *   Intro_Call_Appointment_Outcome__c   13% filled, picklist
 *       Attended | No Call/ No Show (Intro Call) | AE declined/ Rescheduling
 *       We determine exactly this. transcript-sync already decides between
 *       captured, no_show and no_conversation from attendance on the call.
 *
 *   Agreement_on_Next_Steps__c          15% ticked, checkbox
 *       True when the call ended with a next step the customer agreed to,
 *       which is next_step_confirmed in the framework.
 *
 * This also breaks an assumption. The precedence rule is "Rolldog owns a deal
 * that has a Rolldog opportunity, so Salesforce is written only where Rolldog
 * has none". That assumed the two CRMs hold the same things. They do not:
 * Intro_Call_Appointment_Outcome has no Rolldog equivalent, so a deal with a
 * Rolldog opportunity currently gets nothing written to a Salesforce field only
 * Salesforce has. Precedence belongs at the FIELD level, not the deal level,
 * and these two fields are Salesforce-only by definition.
 *
 * Every write here fills a blank and never overwrites. A rep who set the intro
 * call outcome by hand knows something we do not.
 */

import { getSalesforceClient } from "./salesforce";
import { assertScopedAccountWrite, runWithAuthorizedAccounts } from "./salesforce-scope";
import { recordWrite } from "./crm-scope";

const API = "v61.0";

/** Our call outcomes, mapped to Magaya's picklist. */
const OUTCOME_TO_PICKLIST: Record<string, string> = {
  captured: "Attended",
  no_show: "No Call/ No Show (Intro Call)",
  // The bot joined, the meeting existed, and no conversation happened. From the
  // opportunity's point of view that is the same fact as a no-show.
  no_conversation: "No Call/ No Show (Intro Call)",
};

/**
 * "AE declined/ Rescheduling" is deliberately unmapped. It describes OUR side
 * pulling out, which is a rep's own account of what happened and not something
 * a transcript can establish. Guessing it would put words in a rep's mouth on
 * their own opportunity.
 */

export type OpportunityTarget =
  | { state: "found"; id: string; name: string; stage: string }
  | { state: "none" }
  | { state: "unknown"; why: string };

/**
 * The opportunity a call belongs to: the most recently created open one on the
 * account.
 *
 * "none" and "unknown" are separate on purpose. A query that failed is not an
 * account without opportunities, and treating it as one would mean silently
 * skipping every write during an outage.
 */
export async function findOpenOpportunity(accountId: string): Promise<OpportunityTarget> {
  const { token, instanceUrl } = await getSalesforceClient();
  const soql =
    `SELECT Id, Name, StageName FROM Opportunity ` +
    `WHERE AccountId = '${accountId.replace(/[^a-zA-Z0-9]/g, "")}' AND IsClosed = false ` +
    `ORDER BY CreatedDate DESC LIMIT 1`;
  const r = await fetch(`${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    return { state: "unknown", why: `${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}` };
  }
  const rows = ((await r.json()) as { records?: Array<{ Id: string; Name: string; StageName: string }> }).records ?? [];
  if (rows.length === 0) return { state: "none" };
  return { state: "found", id: rows[0].Id, name: rows[0].Name, stage: rows[0].StageName };
}

export type OpportunityWriteResult = {
  written: string[];
  skipped: Array<{ field: string; reason: string }>;
  opportunityId: string | null;
};

/**
 * Fill the two opportunity fields we can answer, on the account's open
 * opportunity.
 *
 * `isFirstCall` gates the intro call outcome. The field is named for the INTRO
 * call, so stamping it after the fourth meeting would overwrite the meaning of
 * a field a rep uses to remember how the relationship started.
 */
export async function writeOpportunityFromCall(args: {
  tenantSlug: string;
  accountId: string;
  /** calls.outcome for this meeting. */
  callOutcome: string | null;
  /** True when this is the earliest captured call on the deal. */
  isFirstCall: boolean;
  /** field_extractions status for next_step_confirmed: "Yes" | "No" | "Unknown". */
  nextStepConfirmed: string | null;
  apply: boolean;
}): Promise<OpportunityWriteResult> {
  const res: OpportunityWriteResult = { written: [], skipped: [], opportunityId: null };

  const opp = await findOpenOpportunity(args.accountId);
  if (opp.state === "unknown") {
    res.skipped.push({ field: "*", reason: `could not read opportunities: ${opp.why}` });
    return res;
  }
  if (opp.state === "none") {
    res.skipped.push({ field: "*", reason: "no open opportunity on this account" });
    return res;
  }
  res.opportunityId = opp.id;

  const { token, instanceUrl } = await getSalesforceClient();
  const auth = { authorization: `Bearer ${token}` };

  // Read current values first: every write here fills a blank, never replaces.
  const cur = await fetch(
    `${instanceUrl}/services/data/${API}/query?q=` +
      encodeURIComponent(
        `SELECT Id, Intro_Call_Appointment_Outcome__c, Agreement_on_Next_Steps__c FROM Opportunity WHERE Id = '${opp.id}'`,
      ),
    { headers: auth },
  );
  if (!cur.ok) {
    res.skipped.push({ field: "*", reason: `could not read current values (${cur.status}), so nothing was written` });
    return res;
  }
  const row = ((await cur.json()) as {
    records?: Array<{ Intro_Call_Appointment_Outcome__c: string | null; Agreement_on_Next_Steps__c: boolean }>;
  }).records?.[0];
  if (!row) {
    res.skipped.push({ field: "*", reason: "opportunity disappeared between the two reads" });
    return res;
  }

  const body: Record<string, unknown> = {};
  const labels: string[] = [];

  // ---- Intro call outcome ----
  const mapped = OUTCOME_TO_PICKLIST[String(args.callOutcome ?? "")];
  if (!mapped) {
    res.skipped.push({
      field: "Intro Call Outcome",
      reason: `outcome "${args.callOutcome ?? "none"}" does not map to one of their values`,
    });
  } else if (!args.isFirstCall) {
    res.skipped.push({ field: "Intro Call Outcome", reason: "not the first call on this deal" });
  } else if (row.Intro_Call_Appointment_Outcome__c) {
    res.skipped.push({
      field: "Intro Call Outcome",
      reason: `already "${row.Intro_Call_Appointment_Outcome__c}"; a rep's own answer is not ours to change`,
    });
  } else {
    body.Intro_Call_Appointment_Outcome__c = mapped;
    labels.push(`Intro Call Outcome: ${mapped}`);
  }

  // ---- Agreement on next steps ----
  // Only ever ticked. False and never-set are the same value on a checkbox, so
  // writing false would claim the call agreed nothing when we may simply not
  // have established it.
  if (args.nextStepConfirmed !== "Yes") {
    res.skipped.push({
      field: "Agreement on Next Steps",
      reason: `next step is "${args.nextStepConfirmed ?? "unknown"}"; a checkbox is only ever ticked`,
    });
  } else if (row.Agreement_on_Next_Steps__c === true) {
    res.skipped.push({ field: "Agreement on Next Steps", reason: "already ticked" });
  } else {
    body.Agreement_on_Next_Steps__c = true;
    labels.push("Agreement on Next Steps: checked");
  }

  if (Object.keys(body).length === 0) return res;
  if (!args.apply) {
    res.written.push(...labels.map((l) => `would write ${l}`));
    return res;
  }

  try {
    await runWithAuthorizedAccounts([args.accountId], async () =>
      recordWrite(
        labels.map((l) => ({ label: "Opportunity", value: l, mode: "fill_blank" })),
        async () => {
          assertScopedAccountWrite(args.tenantSlug, args.accountId, ["opportunity"]);
          const r = await fetch(`${instanceUrl}/services/data/${API}/sobjects/Opportunity/${opp.id}`, {
            method: "PATCH",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (r.status !== 204) {
            throw new Error(`PATCH Opportunity ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
          }
          return true;
        },
      ),
    );
    res.written.push(...labels);
  } catch (err) {
    res.skipped.push({ field: "*", reason: err instanceof Error ? err.message : String(err) });
  }
  return res;
}
