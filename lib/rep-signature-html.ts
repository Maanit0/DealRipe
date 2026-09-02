/**
 * A rep's real email signature, images and all.
 *
 * Juan Lopez, 2026-09-02: the plain three lines DealRipe appends are his name,
 * title and number, and they are not his signature. His is a Tahoma block over
 * the Magaya "#1 Freight Management Platform" banner and four social icons, and
 * every email he sends carries it. A draft without it is one he rewrites before
 * sending, which is most of why his adoption is 1 of 6.
 *
 * NOT HOSTED, INLINE. lib/followup-draft.ts's own note says an <img> needs a URL
 * we would have to host and a broken image on outgoing customer mail is worse
 * than none. That was the right call and this does not change it: the images
 * ride with the message as inline attachments, recovered from Juan's own sent
 * mail, so nothing is fetched at read time and nothing can 404.
 *
 * The cid values are rewritten to ids we control. Outlook's own are per message
 * (image001.png@01DD3AD8.09D11FF0) and would point at a message that is not
 * this one.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type SignatureAsset = { filename: string; contentId: string; contentType: string };

export type RepSignature = {
  /** Folder under assets/signatures. */
  dir: string;
  /** Inline images the HTML refers to by cid. */
  assets: SignatureAsset[];
};

const REP_SIGNATURE_HTML: Record<string, RepSignature> = {
  "jlopez@magaya.com": {
    dir: "jlopez",
    assets: [
      { filename: "image001.png", contentId: "dealripe-image001.png", contentType: "image/png" },
      { filename: "image002.jpg", contentId: "dealripe-image002.jpg", contentType: "image/jpeg" },
      { filename: "image003.jpg", contentId: "dealripe-image003.jpg", contentType: "image/jpeg" },
      { filename: "image004.jpg", contentId: "dealripe-image004.jpg", contentType: "image/jpeg" },
      { filename: "image005.jpg", contentId: "dealripe-image005.jpg", contentType: "image/jpeg" },
    ],
  },
};

export function hasHtmlSignature(mailbox: string): boolean {
  return Boolean(REP_SIGNATURE_HTML[mailbox.toLowerCase()]);
}

export function signatureFor(mailbox: string): RepSignature | null {
  return REP_SIGNATURE_HTML[mailbox.toLowerCase()] ?? null;
}

/** The rep's signature markup, or null if we do not hold one for them. */
export async function signatureHtml(mailbox: string): Promise<string | null> {
  const sig = signatureFor(mailbox);
  if (!sig) return null;
  try {
    return await readFile(join(process.cwd(), "assets", "signatures", sig.dir, "signature.html"), "utf8");
  } catch {
    // Missing markup means no signature, never a half rendered one.
    return null;
  }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/**
 * A plain-text draft body as minimal HTML.
 *
 * Paragraphs and nothing else. followup-draft defaults to plain text because
 * "HTML markup makes them read like templates", and that reasoning is about
 * styling, not about the tag needed to end a line. Blank-line separated blocks
 * become paragraphs so the shape the rep reads is the shape they wrote.
 */
export function bodyTextToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map(
      (para) =>
        `<p style="margin:0 0 12px;font-family:Calibri,sans-serif;font-size:11pt">${para
          .split("\n")
          .map((line) => line.replace(/[&<>]/g, (c) => ESC[c]))
          .join("<br>")}</p>`,
    )
    .join("\n");
}
