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
- An MNDA is NOT in this list and is not yours to promise. The rep sends it through AdobeSign by hand, and saying it has been sent when it has not is a false statement to a customer.`;
}


/** The bundle whose named attachments the model asked for, or null. */
export function bundleForNamedAttachments(named: ReadonlyArray<string>): CollateralBundle | null {
  const hay = named.join(" ").toLowerCase();
  if (!hay.trim()) return null;
  // Rate first: "rate management datasheet" contains "datasheet" and would match
  // the supply chain bundle on the looser word.
  if (/\brate/.test(hay)) return COLLATERAL.find((b) => b.key === "rate_management") ?? null;
  if (/data ?sheet|datasheet|overview|supply chain/.test(hay)) {
    return COLLATERAL.find((b) => b.key === "supply_chain_ops") ?? null;
  }
  return null;
}
