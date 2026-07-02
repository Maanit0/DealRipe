import { config } from "dotenv";
config({ path: ".env.local" });

import {
  __setPilotOpportunityIdsForTesting,
  flushAuditWrites,
} from "../lib/crm-scope";
import { getDealRoom, writeBudget } from "../lib/rolldog";

async function main() {
  __setPilotOpportunityIdsForTesting(["80949"]); // authorize sandbox opp for this run only

  console.log("BEFORE:", JSON.stringify(await getDealRoom("80949"), null, 2));

  await writeBudget("80949", { lowRange: 50000, highRange: 200000, notes: "smoke test" });

  console.log("AFTER:", JSON.stringify(await getDealRoom("80949"), null, 2));

  await flushAuditWrites(); // ensure the audit row lands before exit
}
main().catch(console.error);
