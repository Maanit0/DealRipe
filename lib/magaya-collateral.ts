/**
 * The collateral Juan Lopez sends after a call, and which bundle goes with what.
 *
 * Built from the two emails he supplied on 2026-08-28 as worked examples, both
 * sent 2026-08-20, both to customers he had met that morning. He described the
 * split himself: he manages two solutions, "95% of the time it's the same data
 * sheet", and he is happy to handle the remainder by hand. So this exists to get
 * the common case right and to ABSTAIN on anything it cannot place, never to
 * guess between them.
 *
 * Guessing is the expensive failure. A rep who finds the wrong datasheet in
 * their draft has to notice it, remove it, and find the right one, which is
 * slower than an empty draft and teaches them to check every line of every
 * draft afterwards. An empty attachment list costs Juan the ten seconds he
 * spends today.
 *
 * THE LINKS GO IN THE BODY, THE DATASHEET GOES IN attachmentsToAdd. A YouTube
 * URL is text and can be written into the email; a PDF is a file we do not have
 * and cannot attach through Graph, so the draft names it and the rep attaches
 * it. That distinction is already how attachmentsToAdd works and this does not
 * change it.
 */

export type CollateralBundle = {
  key: string;
  /** How a rep would name it out loud. */
  label: string;
  /** What the call has to be about for this bundle to be right. */
  whenToSend: string;
  /** Written into the email body, in the order Juan writes them. */
  links: Array<{ title: string; url: string }>;
  /** Named in attachmentsToAdd for the rep to attach before sending. */
  attachments: string[];
  /**
   * The real files, in assets/collateral, attached to the draft.
   *
   * Recovered from Juan's own sent mail rather than asked for, so these are the
   * exact PDFs his customers already receive and not a copy that has drifted.
   * His own sending is what decided which bundle is which: Magaya Supply Chain
   * Data Sheet 23 times against Magaya Rates Solution Sheet once, which is the
   * 95/5 split he described.
   */
  files: string[];
  /**
   * What the customer sees the attachment called.
   *
   * The disk name is hyphenated because it came off a download; Juan sends
   * "Magaya Supply Chain Data Sheet.pdf" with spaces, and the rates one keeps
   * its "(1)". A customer receiving a differently named file than the rep has
   * always sent them is a small tell that something else wrote the email.
   * Keyed by the disk filename.
   */
  sendAs?: Record<string, string>;
};

export const COLLATERAL: ReadonlyArray<CollateralBundle> = [
  {
    key: "rate_management",
    label: "Rate management",
    whenToSend:
      "the customer's interest is RATE MANAGEMENT: quoting, client rate sheets, tariffs, buy and sell rates, margin on a quote, or producing rates in a particular format for their own customers",
    links: [{ title: "Rate management video tour", url: "https://www.youtube.com/watch?v=_WWi6Z5IoKU" }],
    attachments: ["Rate management datasheet"],
    files: ["Magaya-Rates-Solution-Sheet-02192024-1-.pdf"],
    sendAs: { "Magaya-Rates-Solution-Sheet-02192024-1-.pdf": "Magaya Rates Solution Sheet 02192024 (1).pdf" },
  },
  {
    key: "supply_chain_ops",
    label: "Supply chain and forwarding operations",
    whenToSend:
      "the customer's interest is FORWARDING AND SUPPLY CHAIN OPERATIONS: shipments, import or export workflow, customs and documentation, warehousing, tracking, or running the business end to end. This is the common case",
    links: [
      { title: "Supply Chain Tour", url: "https://www.youtube.com/watch?v=j_McdWaugso" },
      {
        title: "Export Operations",
        url: "https://www.youtube.com/watch?v=QqqUO-GEHKw&list=PLsPRY0qd--QdCnOJdyggs3MGvHZvDszSt",
      },
      {
        title: "Import Operations",
        url: "https://www.youtube.com/watch?v=FEY6Sl6g_Vo&list=PLsPRY0qd--QeBhs05epBgNkOkofaQ8NA5",
      },
    ],
    // JUST THE DATASHEET. "Product overview" was here and is not a document.
    // Four months of Juan's sent mail to 2026-08-31 carry the Supply Chain Data
    // Sheet 23 times, the Rates Solution Sheet once, and nothing named a product
    // overview at all; everything else he attaches is a per-customer proposal or
    // SOW. So the line asked him to attach a file that does not exist, forever,
    // on every supply chain draft. The datasheet IS the overview.
    attachments: ["Magaya datasheet"],
    files: ["Magaya-Supply-Chain-Data-Sheet.pdf"],
    sendAs: { "Magaya-Supply-Chain-Data-Sheet.pdf": "Magaya Supply Chain Data Sheet.pdf" },
  },
];

/**
 * The bundles, described for the model.
 *
 * Deliberately describes WHEN each applies rather than listing keywords. A
 * keyword rule on "rate" fires on "at any rate" and on a customer describing
 * their shipping rates while asking about warehousing, and Juan's two examples
 * are separated by what the customer wanted, not by a word.
 */
export function collateralPromptBlock(): string {
  const bundles = COLLATERAL.map(
    (b) =>
      `- "${b.key}" (${b.label}): send when ${b.whenToSend}.\n  Links: ${b.links
        .map((l) => `${l.title} ${l.url}`)
        .join(" | ")}\n  Attach: ${b.attachments.join(", ")}`,
  ).join("\n");

  return `COLLATERAL THE REP SENDS AFTER A CALL

${bundles}

RULES FOR COLLATERAL, and the default is to send none:
- Include a bundle ONLY if the rep committed on this call to send materials, a video, a datasheet or an overview, OR the customer asked for something to review. If neither happened, send nothing: an unrequested datasheet is the marketing email these drafts exist to avoid.
- Pick ONE bundle. If the call genuinely covered both, pick the one the customer spent the most time on and say nothing about the other.
- If you cannot tell which one fits, INCLUDE NO LINKS AND NO ATTACHMENTS. The rep attaches the right one in ten seconds; the wrong one costs them longer than an empty draft and teaches them to check every draft afterwards.
- Write the links into the body EXACTLY as given, each on its own line with its title, the way the rep already writes them. Never invent a URL, never shorten one, never describe a video that has no link here.
- Name the attachments in attachmentsToAdd. DealRipe attaches the bundle's own datasheet to the draft before the rep opens it, so referring to it in the body in the present tense is correct and true. Never promise a file that is not in this list.
- THE MNDA, and the rule is about TENSE rather than silence. Juan Lopez writes "I've sent the MNDA via AdobeSign so we may continue the process"; Eduardo Bencomo writes "I'll send over a mutual NDA shortly". Both are honest because each matches what actually happened.
  Use the PAST tense only where the transcript or the thread shows it has already gone out. Where the rep merely committed to send it, write it as their own commitment with their own timeframe. Never state that an NDA has been sent on the strength of it being a next step, because the customer will go looking for it.
  DealRipe does not create the signature envelope; AdobeSign does. Where the rep committed to send the DOCUMENT for legal review rather than for signature, name it in attachmentsToAdd so the rep attaches it.`;
}


/**
 * Files made for ONE customer. Never our stock collateral, whatever else the
 * name contains.
 *
 * Eduardo's 2026-08-27 draft named "Magaya Supply Chain Demo Deck - Dunavant
 * 2026-08-27.pptx, Magaya API Guide.pdf". The old matcher tested the joined
 * string for "supply chain" and would have attached the generic Supply Chain
 * Data Sheet to a draft asking for a deck built for Dunavant. It never fired
 * only because the attachment itself was broken.
 */
const CUSTOMER_SPECIFIC =
  /\b(deck|proposal|quote|quotation|nda|mnda|agreement|estimate|sow|statement of work|contract|invoice|order form|pricing|recording|webinar|guide)\b/i;

/** The stock collateral, named as the thing it is. */
const DATASHEET = /\b(data ?sheet|product overview|solution sheet)\b/i;
const RATES = /\brates? (management|solution|sheet|datasheet|data sheet)\b|\brate management\b/i;


/**
 * Classify a file that ACTUALLY WENT OUT, for storage rather than for attaching.
 *
 * The outbound draft path asks "which stock bundle did the model mean"; this
 * asks the opposite question about a file already sent: is this a stock file we
 * already hold, or an artifact built for one customer that exists nowhere else?
 * Losing the first costs nothing. Losing the second loses the artifact.
 *
 * THE NDA IS THE SUBTLETY AND IT IS WHY agreementState IS A PARAMETER. It sits
 * in CUSTOMER_SPECIFIC because the draft path must not auto-attach stock
 * collateral when the rep asked for the NDA. But for STORAGE the template is
 * stock and the EXECUTED copy is a customer artifact: same filename, different
 * lifecycle stage. Classification is (name pattern) x (agreement state), never
 * name alone.
 *
 * Rules are ordered and the first match wins. It ABSTAINS rather than guessing,
 * and an abstained OUTBOUND file is still treated as worth keeping, because
 * losing something unique costs more than keeping a spare brochure.
 */
export function classifyAttachmentForStorage(args: {
  filename: string;
  direction?: "inbound" | "outbound" | null;
  /** deal_messages.agreement_state on the carrying message, if any. */
  agreementState?: string | null;
}): { class: "static" | "customized" | "unclassified"; basis: string } {
  const name = (args.filename ?? "").trim();
  if (!name) return { class: "unclassified", basis: "no filename" };

  // Stock named as the thing it is. "Supply chain" in a filename is a topic;
  // "data sheet" is the document.
  if ((DATASHEET.test(name) || RATES.test(name)) && !CUSTOMER_SPECIFIC.test(name)) {
    return { class: "static", basis: "datasheet_pattern" };
  }

  if (CUSTOMER_SPECIFIC.test(name)) {
    const isNda = /\b(nda|mnda|non-?disclosure)\b/i.test(name);
    // An NDA that has not come back executed is the blank template going out.
    if (isNda && args.agreementState !== "executed") {
      return { class: "static", basis: "nda_template" };
    }
    return { class: "customized", basis: isNda ? "nda_executed" : "customer_specific_pattern" };
  }

  return { class: "unclassified", basis: "abstained" };
}

/**
 * The bundle whose named attachments the model asked for, or null.
 *
 * PER ITEM, not on the joined string. A draft naming both a customer proposal
 * and the datasheet should still get the datasheet, and testing the whole
 * haystack at once cannot express that. It also stops one customer-specific
 * filename poisoning a legitimate request beside it.
 *
 * Abstains unless an item names the collateral as such. "Supply chain" in a
 * filename is a topic; "data sheet" is the document.
 */
export function bundleForNamedAttachments(named: ReadonlyArray<string>): CollateralBundle | null {
  const items = named.map((n) => (n ?? "").trim()).filter(Boolean);
  if (items.length === 0) return null;

  let wantsRates = false;
  let wantsSheet = false;
  for (const item of items) {
    if (CUSTOMER_SPECIFIC.test(item)) continue;
    if (RATES.test(item)) wantsRates = true;
    else if (DATASHEET.test(item)) wantsSheet = true;
  }
  // Rate first: "rate management datasheet" satisfies both and the rates sheet
  // is the more specific answer.
  if (wantsRates) return COLLATERAL.find((b) => b.key === "rate_management") ?? null;
  if (wantsSheet) return COLLATERAL.find((b) => b.key === "supply_chain_ops") ?? null;
  return null;
}

