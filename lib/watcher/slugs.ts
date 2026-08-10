/**
 * Tenants with a watcher dataset (the proactive rebuild IA). Kept in its own
 * tiny file so client components (AppShell) can branch on it without pulling
 * the full datasets into the bundle.
 */
export const WATCHER_SLUGS = new Set(["second-nature", "ledgerline", "keelson"]);

/** Watcher tenants with NO DB backing: nav shows only the watcher pages
 *  (Today, Forecast), since /pipeline, /meetings etc. need a DB tenant. */
export const WATCHER_ONLY_SLUGS = new Set(["ledgerline"]);
