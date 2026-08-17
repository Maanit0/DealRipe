/**
 * Read an environment variable, tolerating the paste error that keeps happening.
 *
 * Twice on 2026-08-17 a Vercel variable was saved with its own name inside the
 * value:
 *
 *   SF_LOGIN_URL = "SF_LOGIN_URL=https://magayacorporation.my.salesforce.com"
 *   DIGEST_TO    = "DIGEST_TO=mbuman@magaya.com,mnemmers@magaya.com,..."
 *
 * Neither failed loudly. Salesforce auth broke for every deal, which made every
 * meeting look unmatched, which mailed four newly onboarded reps an escalation
 * blaming their data for our config. And the weekly digest went out with
 * "DIGEST_TO=mbuman@magaya.com" as its first recipient, which is not a
 * deliverable address, so the CRO it is written for is the one person who may
 * not have received it.
 *
 * The paste is easy to make and impossible to see in the Vercel UI, where the
 * value is masked. So rather than rely on nobody making it again, strip the
 * prefix and say so in the logs. A variable whose value begins with its own
 * name followed by "=" never legitimately means that.
 */
export function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;

  const prefix = `${name}=`;
  if (!raw.startsWith(prefix)) return raw;

  const fixed = raw.slice(prefix.length);
  // Loud on purpose. The repair is safe, the configuration is still wrong, and
  // whoever set it should correct it rather than rely on this forever.
  console.error(
    `[env] ${name} was saved with its own name inside the value. Using "${fixed.slice(0, 24)}..." ` +
      `and continuing, but fix it in the environment settings: the value must not begin with "${prefix}".`,
  );
  return fixed;
}
