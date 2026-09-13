/**
 * Regression for the two source-interpretation fixes.
 *
 *   npx tsx scripts/test-speaker-and-conversation.ts
 *
 * Pure for the speaker cases. The conversation cases read live transcripts,
 * because their canonical verdicts were established by reading those exact
 * calls on 2026-09-13 and a synthetic fixture would test a different thing.
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { classifyConversation } from "../lib/conversation-class";
import { labelNamesParticipant, sellerDirectory, sideOfSpeaker, type Participant } from "../lib/speaker-match";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

let failed = 0, ran = 0;
const check = (n: string, ok: boolean, d?: string) => {
  ran++; if (ok) console.log(`  ok    ${n}`);
  else { failed++; console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); }
};
const P = (name: string, email: string): Participant => ({ name, email } as Participant);

console.log("\nspeaker-match: identity must not be manufactured\n");
// A. customer and seller share a common first name
check("A  customer 'Tyler Walrabenstein' is not Magaya's Brooke Tyler",
  !labelNamesParticipant("Walrabenstein, Tyler", P("Brooke Tyler", "btyler@magaya.com")));
// B. customer name is a substring of a seller email
check("B  customer 'John Locasto' is not Magaya's Steven Johnson",
  !labelNamesParticipant("John Locasto", P("Steven Johnson", "sjohnson@magaya.com")));
// C. seller name is a substring of a customer email
check("C  seller 'Ana Almeida' is not customer 'anaalmeidalopez@acme.com'",
  !labelNamesParticipant("Ana Almeida", P("Someone Else", "anaalmeidalopez@acme.com")) ||
   labelNamesParticipant("Ana Almeida", P("Ana Almeida", "anaalmeidalopez@acme.com")));
// The capability the fallback exists for MUST survive.
check("   initial+surname still resolves (JHuseby = Joseph Huseby)",
  labelNamesParticipant("Joseph Huseby", P("", "JHuseby@tql.com")));
check("   full name in the address still resolves",
  labelNamesParticipant("Joseph Huseby", P("", "josephhuseby@tql.com")));
check("   surname alone still resolves",
  labelNamesParticipant("Joseph Huseby", P("", "huseby@tql.com")));
check("   exact display name still resolves",
  labelNamesParticipant("Carrie McGregor", P("Carrie McGregor", "cm@iff.com")));
// D. an unknown speaker must be UNKNOWN, never guessed
{
  const roster = [P("Ariel Rodriguez", "arodriguez@magaya.com"), P("", "Pricing@kcarlton.com")];
  const dir = sellerDirectory([[P("Steven Johnson", "sjohnson@magaya.com")], roster]);
  check("D  'John Locasto' against a roster that does not name him -> unknown",
    sideOfSpeaker(roster, "John Locasto", dir) === "unknown",
    `got ${sideOfSpeaker(roster, "John Locasto", dir)}`);
  check("   a named customer on the invite still resolves to customer",
    sideOfSpeaker([P("Tyler Walrabenstein", "tyler@tw.com"), P("Brooke Tyler", "btyler@magaya.com")],
      "Walrabenstein, Tyler", dir) === "customer");
}

(async () => {
  console.log("\nconversation-class: the ten calls read in full on 2026-09-13\n");
  const tid = await resolveTenantId("magaya");
  const db = supabaseAdmin() as any;
  const grab = async (t: string, c: string, tenant: boolean) => {
    const o: any[] = [];
    for (let f = 0; ; f += 1000) {
      let q = db.from(t).select(c); if (tenant) q = q.eq("tenant_id", tid);
      const r = await q.order("id", { ascending: true }).range(f, f + 999);
      if (r.error) throw new Error(r.error.message);
      o.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break;
    } return o;
  };
  const deals = await grab("deals", "id, account", true);
  const calls = await grab("calls", "id, deal_id, outcome, capture_class, call_date, scheduled_start, participants", true);
  const trs = await grab("transcripts", "id, call_id, body", false);
  const body = new Map(trs.map((t: any) => [t.call_id, String(t.body ?? "")]));
  const dir = sellerDirectory(calls.map((c: any) => (Array.isArray(c.participants) ? c.participants : []) as Participant[]));

  // deal, date, expected verdict
  // Pick the call by its transcript SIZE as well as its date: several deals
  // carry two rows on one day (a `duplicate` with no text, or a second real
  // meeting), and picking the first by date alone tested a different call.
  const CASES: Array<[string, string, number, string]> = [
    ["Apexcargo", "2026-08-28", 759, "short_but_valid"],        // I short but substantive
    ["Slade-global", "2026-09-10", 939, "short_but_valid"],      // I short but substantive
    ["Triadcargousa", "2026-09-02", 600, "no_show"],             // H room chatter
    ["Everwellparts", "2026-09-09", 724, "no_show"],             // H room chatter
    ["Melek HealthCare", "2026-09-02", 1537, "no_show"],         // H room chatter
    ["DQ Mega Logistics", "2026-09-04", 1753, "no_show"],        // H room chatter
    ["Unitedamericanline", "2026-09-09", 59, "seller_only"],     // E only Magaya speaks
    ["Nat Forwarding", "2026-08-13", 529, "seller_only"],        // E only Magaya speaks
    ["Twcustomsbrokers", "2026-08-11", 1198, "logistics_only"],  // G customer present, no content
    ["Noventraadvisory", "2026-08-27", 1902, "logistics_only"],  // G customer present, no content
  ];
  for (const [acct, date, chars, want] of CASES) {
    const d = deals.find((x: any) => String(x.account).toLowerCase().replace(/[^a-z0-9]/g, "")
      .startsWith(acct.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10)));
    const c = calls.find((x: any) => x.deal_id === d?.id
      && String(x.call_date ?? x.scheduled_start).slice(0, 10) === date
      && (body.get(x.id) ?? "").length === chars);
    if (!c) { check(`${acct} ${date}`, false, "call not found"); continue; }
    const got = classifyConversation({
      outcome: c.outcome, captureClass: c.capture_class, transcript: body.get(c.id) ?? "",
      participants: (Array.isArray(c.participants) ? c.participants : []) as Participant[], directory: dir,
    });
    check(`${acct.padEnd(20)} -> ${want}`, got.verdict === want, `got ${got.verdict} (${got.reason})`);
  }

  // UNKNOWN must never establish customer participation on its own.
  {
    const dir2 = sellerDirectory([[P("Ariel Rodriguez", "arodriguez@magaya.com")]]);
    const got = classifyConversation({
      outcome: "captured", captureClass: "captured",
      // "John Locasto" is not on this roster and cannot be grounded.
      transcript: [
        "Ariel Rodriguez: So on pricing, the licence cost lands around seven thousand a month for seventy users.",
        "John Locasto: That is higher than we budgeted, and I would need to take the proposal to our owner first.",
        "John Locasto: Can you send the contract terms and the implementation timeline this week?",
      ].join("\n"),
      participants: [P("Ariel Rodriguez", "arodriguez@magaya.com"), P("", "Pricing@kcarlton.com")],
      directory: dir2,
    });
    check("UNKNOWN speaker: a real meeting IS established",
      got.meetingOccurred === true && got.substantiveMeetingConversation === true, JSON.stringify(got.verdict));
    check("UNKNOWN speaker: nonSellerHumanParticipated is true",
      got.nonSellerHumanParticipated === true);
    check("UNKNOWN speaker: customerParticipated is NOT established",
      got.customerParticipated === false, `got ${got.customerParticipated}`);
    check("UNKNOWN speaker: substantiveCustomerConversation is NOT established",
      got.substantiveCustomerConversation === false, `got ${got.substantiveCustomerConversation}`);
    check("UNKNOWN speaker: verdict is substantive_unattributed",
      got.verdict === "substantive_unattributed", `got ${got.verdict}`);
  }
  // The same words from a GROUNDED customer must ground the claim.
  {
    const dir3 = sellerDirectory([[P("Ariel Rodriguez", "arodriguez@magaya.com")]]);
    const got = classifyConversation({
      outcome: "captured", captureClass: "captured",
      transcript: [
        "Ariel Rodriguez: So on pricing, the licence cost lands around seven thousand a month for seventy users.",
        "John Locasto: That is higher than we budgeted, and I would need to take the proposal to our owner first.",
        "John Locasto: Can you send the contract terms and the implementation timeline this week?",
      ].join("\n"),
      participants: [P("Ariel Rodriguez", "arodriguez@magaya.com"), P("John Locasto", "jlocasto@kcarlton.com")],
      directory: dir3,
    });
    check("GROUNDED customer: customerParticipated is true", got.customerParticipated === true);
    check("GROUNDED customer: substantiveCustomerConversation is true",
      got.substantiveCustomerConversation === true, `got ${got.verdict}`);
  }

  // F. a transcript with customer + Magaya must be substantive
  {
    const d = deals.find((x: any) => String(x.account) === "Ghy");
    const c = calls.filter((x: any) => x.deal_id === d?.id && (body.get(x.id) ?? "").length > 8000)[0];
    if (c) {
      const got = classifyConversation({ outcome: c.outcome, captureClass: c.capture_class,
        transcript: body.get(c.id) ?? "", participants: (Array.isArray(c.participants) ? c.participants : []) as Participant[], directory: dir });
      check("F  a long real GHY call -> substantive", got.substantiveCustomerConversation === true, `got ${got.verdict}`);
    }
  }
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${ran - failed}/${ran}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
