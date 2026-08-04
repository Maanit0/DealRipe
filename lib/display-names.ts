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
  "auto:flyfreight.com": "Fly Freight",
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
  Flyfreight: "Fly Freight",
};

const REP_NAMES: Record<string, string> = {
  "jlopez@magaya.com": "Juan",
  "ebencomo@magaya.com": "Eduardo",
  // Net-new AE team, live August 10 2026. Without these the fallback derives
  // the name from the email local part and renders "Asuntrup", "Sjohnson".
  "asuntrup@magaya.com": "Alexandra",
  "sjohnson@magaya.com": "Steven",
  "arodriguez@magaya.com": "Ariel",
  "dblitstein@magaya.com": "Daniel",
  "mnemmers@magaya.com": "Mitch",
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
  if (email && REP_NAMES[email]) return REP_NAMES[email];
  // Unknown senders (e.g. demo-tenant reps like casey@secondnature.example):
  // derive a clean first name from the email local part instead of the
  // anonymous "the rep", so per-rep views group and label correctly.
  const local = email?.split("@")[0]?.trim();
  if (local && /^[a-z][a-z.\-_]*$/i.test(local)) {
    const first = local.split(/[._\-]/)[0];
    return first.charAt(0).toUpperCase() + first.slice(1);
  }
  return "the rep";
}

/** Full rep email routing display, when we want the address, not the name. */
export function repEmail(email: string | null | undefined): string | null {
  return email ?? null;
}
