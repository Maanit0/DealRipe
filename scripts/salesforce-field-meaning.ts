/**
 * What does a Salesforce field actually mean, judged from the values in it?
 *
 * Written for Date_of_Software_Acquisition__c, which is the field the
 * Record_Triggered_ACCOUNT_Before_Save flow demands and therefore the field
 * that decides whether any Account write lands at all. Its name is ambiguous:
 * it could be when the customer expects to BUY, or when they bought the system
 * they are currently running. Those are opposite facts and a call gives
 * different sentences for each, so the extraction question cannot be written
 * until we know which one Magaya means.
 *
 * The values answer it. Dates clustered in the future or the recent past,
 * shortly before Desired Go-Live, mean expected purchase. Dates years before
 * the account was created mean the incumbent system.
 *
 * READ ONLY.
 *
 *   npx tsx scripts/salesforce-field-meaning.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSalesforceClient } from "../lib/salesforce";

const API = "v61.0";

function days(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return Math.round((x - y) / 86_400_000);
}

async function main(): Promise<void> {
  const { token, instanceUrl } = await getSalesforceClient();
  const soql =
    `SELECT Id, Name, CreatedDate, Date_of_Software_Acquisition__c, Desired_Go_Live_Date__c, ` +
    `Customer_Since__c, Accounting_System_Used__c, Any_Other_Software__c ` +
    `FROM Account WHERE Date_of_Software_Acquisition__c != null ` +
    `ORDER BY CreatedDate DESC LIMIT 100`;
  const r = await fetch(`${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    console.log(`\nCould not read (${r.status}): ${(await r.text().catch(() => "")).slice(0, 300)}\n`);
    process.exit(1);
  }
  const rows = ((await r.json()) as {
    records?: Array<{
      Name: string;
      CreatedDate: string;
      Date_of_Software_Acquisition__c: string | null;
      Desired_Go_Live_Date__c: string | null;
      Customer_Since__c: string | null;
      Accounting_System_Used__c: string | null;
      Any_Other_Software__c: string | null;
    }>;
  }).records ?? [];

  if (rows.length === 0) {
    console.log(`\nNo account has this field set, so its meaning cannot be read from data.\n`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n${rows.length} account(s) with Date of Software Acquisition set. Today is ${today}.\n`);
  console.log(`  acquisition   go-live      vs go-live   vs created   account`);

  let future = 0;
  let beforeGoLive = 0;
  let longBeforeCreated = 0;
  let withGoLive = 0;

  for (const a of rows.slice(0, 40)) {
    const acq = a.Date_of_Software_Acquisition__c;
    const gl = a.Desired_Go_Live_Date__c;
    const vsGoLive = days(acq, gl);
    const vsCreated = days(acq, a.CreatedDate.slice(0, 10));
    if (acq && acq > today) future++;
    if (vsGoLive !== null) {
      withGoLive++;
      if (vsGoLive < 0) beforeGoLive++;
    }
    if (vsCreated !== null && vsCreated < -365) longBeforeCreated++;
    console.log(
      `  ${(acq ?? "-").padEnd(13)} ${(gl ?? "-").padEnd(12)} ` +
        `${(vsGoLive === null ? "-" : `${vsGoLive > 0 ? "+" : ""}${vsGoLive}d`).padEnd(12)} ` +
        `${(vsCreated === null ? "-" : `${vsCreated > 0 ? "+" : ""}${vsCreated}d`).padEnd(12)} ` +
        `${a.Name.slice(0, 34)}`,
    );
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(`  ${future} of ${rows.length} are in the FUTURE`);
  console.log(`  ${beforeGoLive} of ${withGoLive} with a go-live date fall BEFORE it`);
  console.log(`  ${longBeforeCreated} of ${rows.length} are more than a year BEFORE the account existed`);
  console.log(`${"=".repeat(78)}`);
  console.log(`
  Mostly future, and mostly before go-live: this is when the customer expects to
  BUY. The extraction should ask when they intend to make a purchase decision.

  Mostly years before the account was created: this is when they bought the
  system they run today. The extraction should ask how long they have had their
  current software.

  Neither pattern clear: do not guess. Ask Eduardo. This field gates every
  Account write, and a wrong value in it is worse than a blocked one.
`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
