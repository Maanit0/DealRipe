/**
 * What DealRipe drafted, next to what the rep actually sent.
 *
 * Adoption is 3% (1 of 33 decided, 2026-09-02), and the overlap column in
 * draft-adoption is computed against bodyPreview so it cannot say WHERE a draft
 * and a rep's own email diverge. This pulls both full bodies for every case
 * where the rep wrote their own, so the difference can be read rather than
 * inferred from a percentage.
 *
 * Read-only. Imports lib/draft-adoption.ts for the verdict rather than
 * restating it, so this cannot disagree with the adoption report.
 *
 * Bodies are printed, never stored: Magaya is under NDA and these are customer
 * emails. Pipe to a file only if you are going to delete it.
 *
 *   npx tsx scripts/draft-vs-sent.ts --days 21
 *   npx tsx scripts/draft-vs-sent.ts --rep asuntrup@magaya.com --limit 3
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readAdoptionForWindow } from "../lib/draft-adoption";
import { getMessageBody } from "../lib/graph-mail";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const GRAPH_TENANT = "magaya.com";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const strip = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");

/** Everything above the first quoted-reply marker: what they actually wrote. */
function topOfThread(body: string): string {
  const cut = body.search(/\n\s*(From:|On .+ wrote:|-{5,}\s*Original Message)/);
  return (cut > 0 ? body.slice(0, cut) : body).trim();
}

(async () => {
  const days = Number(arg("--days") ?? 21);
  const onlyRep = arg("--rep")?.toLowerCase();
  const limit = Number(arg("--limit") ?? 8);

  const tenantId = await resolveTenantId("magaya");
  const read = await readAdoptionForWindow({ tenantId, days, kinds: ["followup_draft"] });
  const rows = read.rows;

  const pairs = rows.filter(
    (r) =>
      (r.verdict === "sent_own" || r.verdict === "sent_edited") &&
      r.matchedMessageId &&
      r.ourText &&
      (!onlyRep || r.mailbox.toLowerCase() === onlyRep),
  );
  console.log(`${rows.length} drafts in ${days} days, ${pairs.length} with a rep-written counterpart\n`);

  for (const r of pairs.slice(0, limit)) {
    let theirs = "";
    try {
      theirs = String(
        (await getMessageBody({
          tenantIdOrDomain: GRAPH_TENANT,
          mailbox: r.mailbox,
          messageId: r.matchedMessageId!,
        })) ?? "",
      );
    } catch (e) {
      theirs = `(body unavailable: ${e instanceof Error ? e.message : String(e)})`;
    }
    console.log("=".repeat(78));
    console.log(`${r.account}  ${r.mailbox.split("@")[0]}  ${r.draftedAt.slice(0, 10)}  overlap ${Math.round((r.overlap ?? 0) * 100)}%`);
    console.log("-".repeat(78));
    console.log("DEALRIPE DRAFTED:\n");
    console.log(strip(r.ourText!).slice(0, 1400));
    console.log("\n" + "-".repeat(78));
    console.log("REP ACTUALLY SENT:\n");
    console.log(topOfThread(strip(theirs)).slice(0, 1400));
    console.log();
  }
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
