import { config } from "dotenv";
config({ path: ".env.local" });

import {
  __setPilotOpportunityIdsForTesting,
  flushAuditWrites,
} from "../lib/crm-scope";
import {
  RolldogApiError,
  getDealRoom,
  writeSituation,
} from "../lib/rolldog";

const OPP = "80949";

function printError(label: string, err: unknown): void {
  if (err instanceof RolldogApiError) {
    console.error(
      `${label}: RolldogApiError status=${err.status} endpoint=${err.endpoint}`,
    );
    console.error("  body:", JSON.stringify(err.body, null, 2));
  } else if (err instanceof Error) {
    console.error(`${label}: ${err.name}: ${err.message}`);
  } else {
    console.error(`${label}:`, err);
  }
}

async function logSituation(label: string): Promise<void> {
  const room = await getDealRoom(OPP);
  console.log(
    `${label} situation:`,
    JSON.stringify(room.situation, null, 2),
  );
}

async function main(): Promise<void> {
  __setPilotOpportunityIdsForTesting([OPP]); // authorize sandbox opp for this run only

  await logSituation("BEFORE");

  // WRITE A — text fields. These should work cleanly (notes / why-looking /
  // why-looking-now were all returned as plain strings on the sandbox read).
  try {
    await writeSituation(OPP, {
      whyLooking: "replacing a manual quoting process",
      whyLookingNow: "fiscal year ends in Q3, budget expires",
      notes: "situation smoke test",
    });
    console.log("WRITE A (text fields): OK");
  } catch (err) {
    printError("WRITE A (text fields)", err);
  }

  // WRITE B — existing-systems as a STRING. The sandbox GET returned this
  // field as an array (e.g. []), so passing a string is the uncertain case.
  // Isolated in its own try/catch so a failure here does not mask Write A.
  try {
    await writeSituation(OPP, {
      existingSystems: "Salesforce and spreadsheets",
    });
    console.log("WRITE B (existing-systems as string): OK");
  } catch (err) {
    printError("WRITE B (existing-systems as string)", err);
  }

  await flushAuditWrites(); // ensure the audit rows land before exit

  await logSituation("AFTER");
}

main().catch(console.error);
