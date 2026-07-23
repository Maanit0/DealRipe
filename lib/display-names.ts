/**
 * One place for human-readable account and rep names, so we stop hardcoding
 * domain -> name maps in every view. Prefer Rolldog's own account-name when we
 * have it; fall back to a small map for auto-created (domain-keyed) deals; else
 * the stored account string.
 */

// Auto-created deals are keyed by "auto:<domain>"; give those clean names until
// Rolldog's account-name is available. (Rolldog-linked deals use accountName.)
const ACCOUNT_BY_KEY: Record<string, string> = {
  "auto:corelogistics.net": "Core Logistics",
  "auto:cbxglobal.com": "CBX Global",
  "auto:fmgloballogistics.com": "FM Global Logistics",
  "auto:acecustomsinc.com": "Ace Customs",
  "auto:seaboardmarine.com": "Seaboard Marine",
  "auto:airamericas.com": "Air Americas",
  "auto:successchb.com": "Success CHB",
  "auto:cargocleared.com": "Cargo Cleared",
  "auto:cargoservicesgroup.com": "Cargo Services Group",
  "auto:mastercargoinc.com": "Master Cargo",
  "dutyfreeamericas": "Duty Free Americas",
};

// Single-word stored account values (from earlier syncs) to pretty names.
const ACCOUNT_PRETTY: Record<string, string> = {
  Airamericas: "Air Americas",
  Corelogistics: "Core Logistics",
  Cargocleared: "Cargo Cleared",
  Successchb: "Success CHB",
  Cbxglobal: "CBX Global",
  Fmgloballogistics: "FM Global Logistics",
  Mastercargoinc: "Master Cargo",
  Acecustomsinc: "Ace Customs",
  Cargoservicesgroup: "Cargo Services Group",
  Seaboardmarine: "Seaboard Marine",
};

const REP_NAMES: Record<string, string> = {
  "jlopez@magaya.com": "Juan",
  "ebencomo@magaya.com": "Eduardo",
};

export function prettyAccount(opts: {
  externalId?: string | null;
  account: string;
  rolldogAccountName?: string | null;
}): string {
  if (opts.rolldogAccountName && opts.rolldogAccountName.trim()) return opts.rolldogAccountName.trim();
  if (opts.externalId && ACCOUNT_BY_KEY[opts.externalId]) return ACCOUNT_BY_KEY[opts.externalId];
  return ACCOUNT_PRETTY[opts.account] ?? opts.account;
}

/** First name of the rep, for the sales-leader voice ("Ask Juan to..."). */
export function repName(email: string | null | undefined): string {
  return (email && REP_NAMES[email]) || "the rep";
}

/** Full rep email routing display, when we want the address, not the name. */
export function repEmail(email: string | null | undefined): string | null {
  return email ?? null;
}
