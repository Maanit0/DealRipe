/**
 * Which Salesforce objects will actually accept a write from DealRipe today?
 *
 * Account field updates are refused by a record-triggered flow,
 * Record_Triggered_ACCOUNT_Before_Save, whose decision on "Is Date of Software
 * Acquisition empty?" routes to Show Error Message. Task creation is unaffected
 * and has been logging calls since 2026-08-13. Contact and
 * OpportunityContactRole are the next things we want to write and nobody knows
 * whether they carry flows of their own.
 *
 * Permission metadata cannot answer this. The Tooling API reported that Account
 * rule Active=false while every PATCH was still bouncing off it, because the
 * logic had moved into a flow. The only trustworthy evidence is an attempted
 * write. Trust the write, not the metadata.
 *
 * The first version of this probe wrote each field back with the value it
 * already held, on the theory that Salesforce evaluates flows on any update.
 * It reported WRITES OK on all four objects, and minutes later a real write to
 * Account was refused by the very flow it was meant to detect. Salesforce does
 * not consider a same-value assignment a change, so ISCHANGED stayed false and
 * the flow never fired. A no-op write cannot answer this question.
 *
 * So each probe now writes a DIFFERENT value and restores the original
 * immediately. The record is changed for about a second and ends byte for byte
 * as it started. If the write is refused, nothing changed at all. Restoration
 * failures are reported loudly, because a probe that leaves customer data
 * altered is worse than no probe.
 *
 *   npx tsx scripts/salesforce-write-probe.ts --account 001RN00000mCyY1YAK
 *   npx tsx scripts/salesforce-write-probe.ts            (picks a linked account)
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSalesforceClient } from "../lib/salesforce";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const API = "v61.0";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type ProbeResult =
  | { kind: "accepted" }
  | { kind: "refused"; status: number; message: string; errorCode: string | null }
  | { kind: "could_not_try"; why: string };

async function main(): Promise<void> {
  const { token, instanceUrl } = await getSalesforceClient();
  const auth = { authorization: `Bearer ${token}` };
  const jsonAuth = { ...auth, "content-type": "application/json" };

  const q = async <T>(soql: string): Promise<T[] | null> => {
    const r = await fetch(`${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`, {
      headers: auth,
    });
    if (!r.ok) return null;
    return ((await r.json()) as { records?: T[] }).records ?? [];
  };

  const patch = async (sobject: string, id: string, body: Record<string, unknown>) =>
    fetch(`${instanceUrl}/services/data/${API}/sobjects/${sobject}/${id}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify(body),
    });

  /**
   * Write a genuinely different value, then put the original back.
   *
   * The probe value is deliberately recognisable so that if a restore ever
   * fails, whoever finds it in Salesforce knows immediately what it is and that
   * it is not customer data.
   */
  const probe = async (
    sobject: string,
    id: string,
    field: string,
    currentValue: unknown,
  ): Promise<ProbeResult> => {
    const probeValue =
      typeof currentValue === "string" && currentValue.length > 0
        ? `${currentValue.slice(0, 30)} (DealRipe write probe)`
        : "DealRipe write probe";

    const res = await patch(sobject, id, { [field]: probeValue });

    if (res.status === 204) {
      // Accepted, so the record now holds the probe value. Put the original
      // back before anything else happens.
      const restore = await patch(sobject, id, { [field]: currentValue ?? null });
      if (restore.status !== 204) {
        const why = (await restore.text().catch(() => "")).slice(0, 200);
        console.log(
          `  !! RESTORE FAILED on ${sobject} ${id}.${field}. It still holds the probe value.\n` +
            `     Set it back by hand. Salesforce said: ${why}`,
        );
      }
      return { kind: "accepted" };
    }
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 400);
    let errorCode: string | null = null;
    try {
      const parsed = JSON.parse(text) as Array<{ message?: string; errorCode?: string }>;
      if (Array.isArray(parsed) && parsed[0]) {
        message = parsed[0].message ?? message;
        errorCode = parsed[0].errorCode ?? null;
      }
    } catch {
      // Non-JSON body. Keep the raw text; an unparseable error is still an error.
    }
    return { kind: "refused", status: res.status, message, errorCode };
  };

  const say = (label: string, r: ProbeResult) => {
    if (r.kind === "accepted") {
      console.log(`  WRITES OK    ${label}`);
    } else if (r.kind === "could_not_try") {
      console.log(`  UNTESTED     ${label}  (${r.why})`);
      console.log(`               Untested is not blocked and not working. It is unknown.`);
    } else {
      console.log(`  REFUSED      ${label}  ${r.status}${r.errorCode ? ` ${r.errorCode}` : ""}`);
      console.log(`               ${r.message}`);
    }
  };

  // ---------------------------------------------------------------
  // Pick an account DealRipe is linked to, so the probe runs against
  // the same records a real write-back would touch.
  // ---------------------------------------------------------------
  let accountIds: string[] = [];
  const forced = arg("--account");
  if (forced) {
    accountIds = [forced];
  } else {
    const db = supabaseAdmin();
    const tenantId = await resolveTenantId("magaya");
    const res = await db
      .from("deals")
      .select("account, salesforce_account_id")
      .eq("tenant_id", tenantId)
      .not("salesforce_account_id", "is", null);
    accountIds = ((res.data ?? []) as Array<{ salesforce_account_id: string }>)
      .map((d) => d.salesforce_account_id)
      .filter(Boolean);
  }
  const accountId = accountIds[0] ?? null;
  if (!accountId) {
    console.log(`\nNo Salesforce-linked account to probe against.\n`);
    return;
  }

  console.log(`\n${"=".repeat(74)}`);
  console.log(`WRITE PROBE, against account ${accountId}`);
  console.log(`Writes a probe value and restores the original. Net change: none.`);
  console.log(`${"=".repeat(74)}\n`);

  // ---------------------------------------------------------------
  // Account: the known blocker. Confirm it is still blocking.
  // ---------------------------------------------------------------
  //
  // Pick an account the flow can actually fire on. Its decision is "Is Date of
  // Software Acquisition empty?", so an account that HAS that date never
  // reaches Show Error Message and a clean write there proves nothing. The
  // first attempt at this probe picked an arbitrary linked account, got WRITES
  // OK, and would have been read as the block being lifted.
  //
  const linked = accountIds.length > 0 ? accountIds : [accountId];
  const inList = linked.map((i) => `'${i}'`).join(",");
  const triggering = await q<{ Id: string; Name: string; Business_Issues__c: string | null }>(
    `SELECT Id, Name, Business_Issues__c FROM Account ` +
      `WHERE Id IN (${inList}) AND Date_of_Software_Acquisition__c = null LIMIT 1`,
  );
  const fallback = await q<{ Id: string; Name: string; Business_Issues__c: string | null }>(
    `SELECT Id, Name, Business_Issues__c FROM Account WHERE Id = '${accountId}'`,
  );

  if (triggering !== null && triggering.length > 0) {
    const a = triggering[0];
    console.log(`  (probing an account with NO Date of Software Acquisition, which is what the flow tests)`);
    say(`Account (${a.Name})`, await probe("Account", a.Id, "Business_Issues__c", a.Business_Issues__c));
  } else if (fallback !== null && fallback.length > 0) {
    const a = fallback[0];
    console.log(`  (no linked account has an empty Date of Software Acquisition, so this cannot trigger the flow)`);
    say(`Account (${a.Name}) INCONCLUSIVE`, await probe("Account", a.Id, "Business_Issues__c", a.Business_Issues__c));
  } else {
    say("Account", { kind: "could_not_try", why: "could not read any account" });
  }

  // ---------------------------------------------------------------
  // Contact: the next capability. 62 of 80 contacts on these accounts
  // have no Title, and a call names people and their jobs.
  // ---------------------------------------------------------------
  // Search every linked account, not just the first one. The first probe found
  // no contact and reported UNTESTED, which was true of that account and told
  // us nothing about whether Contact writes work.
  const cons = await q<{ Id: string; Name: string; Title: string | null }>(
    `SELECT Id, Name, Title FROM Contact WHERE AccountId IN (${inList}) LIMIT 1`,
  );
  if (cons === null) {
    say("Contact", { kind: "could_not_try", why: "could not read contacts" });
  } else if (cons.length === 0) {
    say("Contact", { kind: "could_not_try", why: "no contact on this account" });
  } else {
    say(`Contact (${cons[0].Name})`, await probe("Contact", cons[0].Id, "Title", cons[0].Title));
  }

  // ---------------------------------------------------------------
  // Task: already live. Probe it so a regression here is visible
  // rather than discovered when a recap goes missing.
  // ---------------------------------------------------------------
  const tasks = await q<{ Id: string; Subject: string | null }>(
    `SELECT Id, Subject FROM Task WHERE WhatId IN (${inList}) ORDER BY CreatedDate DESC LIMIT 1`,
  );
  if (tasks === null) {
    say("Task", { kind: "could_not_try", why: "could not read tasks" });
  } else if (tasks.length === 0) {
    say("Task", { kind: "could_not_try", why: "no task on this account yet" });
  } else {
    say(`Task ("${tasks[0].Subject ?? ""}")`, await probe("Task", tasks[0].Id, "Subject", tasks[0].Subject));
  }

  // ---------------------------------------------------------------
  // OpportunityContactRole: probed for completeness. All nine records
  // across these accounts have a blank Role, so writing roles would
  // invent a convention rather than continue one. Knowing whether we
  // COULD is still worth one call.
  // ---------------------------------------------------------------
  const ocr = await q<{ Id: string; Role: string | null }>(
    `SELECT Id, Role FROM OpportunityContactRole LIMIT 1`,
  );
  if (ocr === null) {
    say("OpportunityContactRole", { kind: "could_not_try", why: "could not read" });
  } else if (ocr.length === 0) {
    say("OpportunityContactRole", { kind: "could_not_try", why: "no records exist" });
  } else {
    say("OpportunityContactRole", await probe("OpportunityContactRole", ocr[0].Id, "Role", ocr[0].Role));
  }

  console.log(`\n${"=".repeat(74)}`);
  console.log(`REFUSED means a flow or validation rule stops us and someone at Magaya`);
  console.log(`must change it. WRITES OK means we can ship against that object today.`);
  console.log(`${"=".repeat(74)}\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  let cause: unknown = (e as { cause?: unknown })?.cause;
  while (cause) {
    const c = cause as { message?: string; code?: string; cause?: unknown };
    console.error(`  caused by: ${c.code ?? ""} ${c.message ?? String(cause)}`);
    cause = c.cause;
  }
  console.error("");
  process.exit(1);
});
