/**
 * Two briefing blocks that carry structure, and the readers that accept either
 * shape.
 *
 * WHERE IT STANDS WAS A PARAGRAPH AND THE PARAGRAPH WAS THE PROBLEM.
 *
 * It is the densest block in the brief and the one most likely to hold the
 * thing that changes how the call opens. Rendered as six sentences of prose it
 * reads as a wall, so the rep skims it and the one line that mattered goes past
 * them. Nothing about the CONTENT was wrong. Every sentence in the Dunavant
 * draft was a separate fact about a separate thing: the NDA, the price, the
 * timeline, two uncaptured calls, who is on this call. They were joined only by
 * being true.
 *
 * So it returns labelled points now: same sentences, same words, one per line,
 * each with a two or three word label saying what the line is ABOUT. A rep
 * scanning for "what is the money" finds it without reading the timeline.
 *
 * THE NUMBERS HAD THE SAME DEFECT MORE SHARPLY. "$34,400 per month" answers
 * nothing on its own: is that what they pay CargoWise today, what we quoted, or
 * what they said they could spend? A number with no label is a number the rep
 * cannot say out loud, which makes the block worse than absent, because they
 * WILL say it.
 *
 * Both accept the old flat shape too. Briefings generated before this ship are
 * still in the database and still get rendered by the preview scripts, and a
 * reader that throws on them would make the old ones unreadable to prove a
 * point about the new ones.
 */

export type StandPoint = {
  /** Two or three words naming what this line is about. "The money", "Timeline". */
  label: string;
  point: string;
};

export type DealNumber = {
  /** What the figure IS. "Quoted monthly", "Their spend today", "Users". */
  label: string;
  /** The figure itself, a fragment. "$34,400 per month". */
  value: string;
  /** Where it came from and when, where we have it. Optional and often absent. */
  note?: string | null;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Split prose into sentences.
 *
 * Only ever applied to a LEGACY string, where the alternative is one unreadable
 * paragraph. It splits after a terminator followed by a capital, a quote or a
 * digit, which keeps "$34,400 monthly and $24,000 implementation" intact and
 * does not break on "Aug. 14" the way a bare period split would.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=["“$A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Where it stands, as labelled lines, from either shape. */
export function standPoints(v: unknown): StandPoint[] {
  if (Array.isArray(v)) {
    return v
      .map((x) =>
        typeof x === "string"
          ? { label: "", point: x.trim() }
          : { label: str((x as StandPoint)?.label), point: str((x as StandPoint)?.point) },
      )
      .filter((p) => p.point.length > 0);
  }
  return sentences(str(v)).map((point) => ({ label: "", point }));
}

/**
 * Where it stands as one string.
 *
 * For the plain-text email, logs and the linter. The linter matters most: it
 * scans this block for language describing our own database, and if an array
 * arrived where it expected a string it would read "" and pass everything.
 * That is this codebase's own failure mode, so the flattening lives here rather
 * than in each caller.
 */
export function standText(v: unknown): string {
  return standPoints(v)
    .map((p) => (p.label ? `${p.label}: ${p.point}` : p.point))
    .join(" ");
}

/** The numbers, labelled, from either shape. */
export function dealNumbers(v: unknown): DealNumber[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      if (typeof x === "string") {
        // A legacy fragment carries no label. Do not invent one: "34,400 per
        // month" with a guessed label of "Price" would be a claim about which
        // side of the table the number sits on, which is exactly what the rep
        // needs to know and exactly what we do not have.
        return { label: "", value: x.trim(), note: null };
      }
      const n = x as DealNumber;
      return { label: str(n?.label), value: str(n?.value), note: str(n?.note) || null };
    })
    .filter((n) => n.value.length > 0 || n.label.length > 0);
}
