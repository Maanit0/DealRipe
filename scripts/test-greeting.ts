/**
 * Tests for who DealRipe greets by name, and who it writes to.
 *
 *   npx tsx scripts/test-greeting.ts
 *
 * Pure. No network, no database.
 *
 * Every case below is a real address off a real Magaya invite. Measured
 * 2026-09-11: 11 of 214 captured calls would have opened a draft naming a
 * shared mailbox as a person.
 */
import { isNeverDeliverable, isRoleMailboxAddress } from "../lib/attendees";
import { firstNameFor } from "../lib/followup-draft";

let failed = 0, ran = 0;
const check = (n: string, ok: boolean, d?: string) => {
  ran++; if (ok) console.log(`  ok    ${n}`);
  else { failed++; console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); }
};

console.log("\nfirstNameFor: a shared mailbox has no first name\n");
for (const [email, name] of [
  ["pricing@kcarlton.com", "Pricing"],
  ["docs@yeschb.com", null],
  ["info@alnoran.org", null],
  ["info@triadcargousa.com", null],
  ["dispatch@shippingsolutions4u.com", null],
  ["noreply@sender.zohocalendar.in", null],
  // The worst case: a clean two-word name where one word is a department.
  ["it@binexline.com", "Binex IT"],
] as Array<[string, string | null]>) {
  const got = firstNameFor(name, email, null);
  check(`${email} is not greeted`, got === "", `got "${got}"`);
}

console.log("\nfirstNameFor: real people are unaffected\n");
check('junjo@binexline.com stays "Jun"', firstNameFor("Jun Jo", "junjo@binexline.com", null) === "Jun");
check('n.roe@kcarlton.com is still greeted', firstNameFor("Nick Roe", "n.roe@kcarlton.com", null) === "Nick");
check('simarjeet@apexcargo.space is still greeted',
  firstNameFor("Simarjeet Singh", "simarjeet@apexcargo.space", null) === "Simarjeet");
// The 2026-09-02 Great Way case, which must not regress.
check('gong@great-way.com does not become "Gong"',
  firstNameFor("gong@great-way.com", "gong@great-way.com", "Peter Gong: yeah that works for us") === "Peter");

console.log("\nisNeverDeliverable: undeliverable, not merely shared\n");
check("noreply is undeliverable", isNeverDeliverable("noreply@sender.zohocalendar.in"));
check("no-reply is undeliverable", isNeverDeliverable("no-reply@x.com"));
check("donotreply is undeliverable", isNeverDeliverable("do.not.reply@x.com"));
// These are read by humans and are often the ONLY address on the call, so
// treating them as undeliverable would delete the draft rather than clean it.
check("docs@ IS deliverable", !isNeverDeliverable("docs@yeschb.com"));
check("info@ IS deliverable", !isNeverDeliverable("info@alnoran.org"));
check("dispatch@ IS deliverable", !isNeverDeliverable("dispatch@shippingsolutions4u.com"));
check("pricing@ IS deliverable", !isNeverDeliverable("pricing@kcarlton.com"));

console.log("\nisRoleMailboxAddress: shared, from the address\n");
check("it@ is a role mailbox", isRoleMailboxAddress("it@binexline.com", "Binex IT"));
check("a person is not", !isRoleMailboxAddress("junjo@binexline.com", "Jun Jo"));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${ran - failed}/${ran}\n`);
process.exit(failed === 0 ? 0 : 1);
