/**
 * One agent per deal, drawn literally. Scale is the argument, so show the
 * population rather than describe it.
 *
 * Confidence is carried by background alpha rather than by `opacity`, because
 * `opacity` on the element also fades the ring, and the ring is the whole point
 * of the marked dots: it says the agent found something specific worth naming.
 * Not a red/amber/green status grid.
 */

const MARKED = new Set([7, 13, 24, 31, 46, 52, 68, 77, 81, 94]);
const FOCUS = 46;

// Deterministic spread so the render is stable across server and client.
function alphaFor(i: number, floor: number, span: number) {
  const n = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
  return Number((floor + n * span).toFixed(2));
}

export function SwarmGrid({ count = 100 }: { count?: number }) {
  return (
    <div className="grid grid-cols-10 gap-1.5 w-full max-w-[320px]">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="dr-dot relative aspect-square"
          style={{ transitionDelay: `${i * 6}ms` }}
        >
          <div
            className="absolute inset-0 rounded-[4px]"
            style={{ backgroundColor: `rgba(34,197,94,${alphaFor(i, 0.22, 0.78)})` }}
          />
          {MARKED.has(i) && (
            <div
              aria-hidden
              className={
                i === FOCUS
                  ? "absolute -inset-1 rounded-md border-[2.5px] border-warn"
                  : "absolute -inset-[3px] rounded-md border-2 border-ink/50"
              }
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** The same population at architecture-diagram scale, with one pulled out. */
export function MiniGrid({ count = 196, hot = 59 }: { count?: number; hot?: number }) {
  return (
    <div className="grid grid-cols-[repeat(14,1fr)] gap-[3px] w-[224px] shrink-0">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={
            i === hot
              ? "dr-dot aspect-square rounded-[3px] bg-accent ring-[2.5px] ring-ink"
              : "dr-dot aspect-square rounded-[2.5px]"
          }
          style={{
            transitionDelay: `${i * 3}ms`,
            ...(i === hot
              ? null
              : { backgroundColor: `rgba(34,197,94,${alphaFor(i, 0.3, 0.5)})` }),
          }}
        />
      ))}
    </div>
  );
}
