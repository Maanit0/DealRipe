const DEMO = "https://calendly.com/maanitsharma21/dealripe-demo-with-maanit";

const BODY =
  "M150 76 C188 108 234 143 234 191 C234 236 197 268 150 268 C103 268 66 236 66 191 C66 143 112 108 150 76 Z";
const LEAF = "M153 86 C153 86 176 38 224 34 C228 82 187 102 153 94 Z";

/**
 * The mark, inline rather than an <img> so it inherits colour and never
 * flashes. `body` swaps for dark surfaces; the leaf is held constant because it
 * is the part people recognise.
 */
export function LogoMark({
  size = 20,
  body = "#0F172A",
}: {
  size?: number;
  body?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 300 300"
      role="img"
      aria-label="DealRipe"
    >
      <path d={BODY} fill={body} />
      <path d={LEAF} fill="#22C55E" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="mx-auto max-w-[1080px] px-6 pt-9">
      <div className="flex items-center justify-between">
        <a
          href="/"
          className="flex items-center gap-2.5 text-[19px] font-bold tracking-tight text-ink"
        >
          <LogoMark size={26} />
          DealRipe
        </a>
        <nav className="flex items-center gap-6">
          <a
            href={DEMO}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-xl2 bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-white transition hover:bg-ink/90"
          >
            See it Live
          </a>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-[1080px] flex-wrap items-center justify-between gap-4 px-6 py-8 text-[11px] text-muted">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5 font-semibold text-ink">
            <LogoMark size={13} />
            DealRipe
          </span>
          <span>·</span>
          <span>Built by Maanit Sharma.</span>
          <a href="mailto:maanit@dealripe.com" className="transition hover:text-ink">
            maanit@dealripe.com
          </a>
          <span>·</span>
          <a
            href="https://www.linkedin.com/in/maanit-sharma-a80a8a1b2"
            className="transition hover:text-ink"
          >
            LinkedIn
          </a>
        </div>
        <span>© 2026</span>
      </div>
    </footer>
  );
}

export function CtaButton({
  children = "See it Live",
  variant = "ink",
}: {
  children?: React.ReactNode;
  variant?: "ink" | "accent";
}) {
  return (
    <a
      href={DEMO}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-2 rounded-xl2 px-6 py-3.5 text-[15px] font-semibold text-white transition ${
        variant === "accent" ? "bg-accent hover:bg-accent/90" : "bg-ink hover:bg-ink/90"
      }`}
    >
      {children}
      <span aria-hidden>&rarr;</span>
    </a>
  );
}
