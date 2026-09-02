/**
 * Put one obviously-fake draft in a rep's own mailbox so they can look at it.
 *
 * Juan Lopez asked for his real signature and the datasheet attached. Both now
 * exist in code and neither has rendered in Outlook, which is the only place
 * that can answer "does it look right". This writes a draft addressed to the
 * rep themselves, carrying exactly what a real follow-up would carry.
 *
 * IT USES THE PRODUCTION PATHS. The attachment goes through
 * bundleForNamedAttachments and the same attachFileToDraft, the signature
 * through signatureHtml and the same inline-image attach. A test that
 * reimplements what it checks proves nothing about what ships.
 *
 * WHAT IT DOES NOT PROVE. This reads assets from local disk. It shows the
 * markup and the images render, not that Vercel bundled them. Only a real
 * post-call draft answers that.
 *
 * ADDRESSED TO THE REP, ALWAYS. Refuses any recipient that is not the mailbox
 * itself, because a test draft sitting in a rep's Outlook one click from a
 * customer is not a test, it is an incident waiting for a busy morning.
 *
 * Dry run by default, --apply WRITES the draft. Nothing is ever sent.
 *
 *   npx tsx scripts/test-signature-draft.ts --rep jlopez@magaya.com
 *   npx tsx scripts/test-signature-draft.ts --rep jlopez@magaya.com --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { attachFileToDraft, createDraft, updateDraftBody } from "../lib/graph-mail";
import { COLLATERAL, bundleForNamedAttachments } from "../lib/magaya-collateral";
import { bodyTextToHtml, signatureFor, signatureHtml } from "../lib/rep-signature-html";

const GRAPH_TENANT = "magaya.com";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

(async () => {
  const rep = (arg("--rep") ?? "").trim().toLowerCase();
  const apply = process.argv.includes("--apply");
  if (!rep.endsWith("@magaya.com")) {
    console.error("--rep must be a magaya.com mailbox");
    process.exit(1);
  }

  const bundle = bundleForNamedAttachments(["Magaya datasheet"]);
  const sigHtml = await signatureHtml(rep);
  const sig = signatureFor(rep);

  console.log(`rep            ${rep}`);
  console.log(`bundle matched ${bundle ? bundle.key : "NONE"}`);
  console.log(`pdf            ${bundle?.files.join(", ") ?? "-"}`);
  console.log(`signature      ${sigHtml ? `${sigHtml.length} chars, ${sig?.assets.length ?? 0} inline images` : "none held for this rep"}`);
  if (!apply) {
    console.log("\ndry run. --apply writes the draft to the rep's own mailbox. Nothing is ever sent.");
    return;
  }

  const body =
    "This is a test draft from DealRipe, addressed to you and not to anyone else.\n\n" +
    "Two things to check: the datasheet is attached, and the signature below is yours, banner and icons included.\n\n" +
    "Nothing here goes to a customer. Delete it once you have had a look.";

  const created = await createDraft({
    tenantIdOrDomain: GRAPH_TENANT,
    mailbox: rep,
    to: [{ email: rep }],
    subject: "[TEST] DealRipe signature and attachment check",
    body,
  });
  const draftId = (created as { id?: string }).id;
  if (!draftId) {
    console.error("draft created but no id returned, cannot attach");
    process.exit(1);
  }
  console.log(`\ndraft created`);

  if (bundle) {
    for (const f of bundle.files) {
      const bytes = await readFile(join(process.cwd(), "assets", "collateral", f));
      const shown = bundle.sendAs?.[f] ?? f;
      await attachFileToDraft({ tenantIdOrDomain: GRAPH_TENANT, mailbox: rep, draftId, filename: shown, contentType: "application/pdf", bytes });
      console.log(`  attached "${shown}" (${Math.round(bytes.length / 1024)}KB)`);
    }
  }
  if (sigHtml && sig) {
    for (const a of sig.assets) {
      const bytes = await readFile(join(process.cwd(), "assets", "signatures", sig.dir, a.filename));
      await attachFileToDraft({
        tenantIdOrDomain: GRAPH_TENANT, mailbox: rep, draftId, filename: a.filename,
        contentType: a.contentType, bytes, contentId: a.contentId, isInline: true,
      });
    }
    await updateDraftBody({ tenantIdOrDomain: GRAPH_TENANT, mailbox: rep, draftId, html: `${bodyTextToHtml(body)}\n${sigHtml}` });
    console.log(`  signature applied with ${sig.assets.length} inline images`);
  }
  console.log(`\nDone. It is in ${rep}'s Drafts, addressed to them, unsent.`);
  void COLLATERAL;
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
