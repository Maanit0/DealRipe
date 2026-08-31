/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,

  experimental: {
    /**
     * SHIP THE COLLATERAL PDFs INTO THE SERVERLESS BUNDLE.
     *
     * `lib/followup-draft.ts` attaches Juan's datasheet with
     * `readFile(join(process.cwd(), "assets", "collateral", file))`. That path
     * is built at runtime, so Next's dependency tracer cannot see it, and a file
     * committed to git is NOT thereby present next to a deployed function. The
     * read threw ENOENT on Vercel, the attach is best-effort, and the warning
     * went to a log nobody reads.
     *
     * Measured 2026-08-31: all seven of Juan's drafts that day came back from
     * Graph with `hasAttachments: false`, including one whose body says "The
     * datasheet with all modules is attached". Locally the same code attaches
     * correctly, which is exactly why it looked finished.
     *
     * UNDER `experimental` ON PURPOSE. This key only moved to the top level in
     * Next 15; on 14.2.15 a top-level copy is accepted, ignored, and warns, so
     * the PDFs would still not ship and the config would look like a fix.
     *
     * Keys are page-path globs, and the App Router route shape is matched by
     * both forms below rather than guessed at once.
     */
    outputFileTracingIncludes: {
      "/api/**": ["./assets/collateral/**"],
      "/app/api/**": ["./assets/collateral/**"],
    },
  },
};
