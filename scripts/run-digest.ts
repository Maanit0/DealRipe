/**
 * Fire the weekly digest by hand, through the real cron route.
 *
 * Why this exists rather than a curl one-liner: .env.local is a dotenv file,
 * not a shell script, so `source .env.local` breaks the moment a value contains
 * a space. DIGEST_TO does ("a@x.com, b@x.com"), which makes zsh try to run the
 * second address as a command. Every other script in here loads env through
 * dotenv for the same reason; this one just does the same and posts.
 *
 * It calls the DEPLOYED route rather than rebuilding the digest locally. That
 * is deliberate twice over. The route is the thing that actually runs on the
 * schedule, so nothing here can drift from it, and it reads PRODUCTION env, so
 * the recipients it echoes back are proof of what Vercel is configured with
 * rather than what your laptop is.
 *
 * Preview first with scripts/preview-digest.ts, which renders byte-for-byte
 * what this will send. This one sends; it does not show you anything new.
 *
 * Safe by default: prints the target and stops unless you pass --send.
 *
 *   npx tsx scripts/run-digest.ts            # show where it would go
 *   npx tsx scripts/run-digest.ts --send     # actually send and log it
 */

import { config } from "dotenv";
config({ path: ".env.local" });

function required(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`\n${name} is not set in .env.local.\n`);
    process.exit(1);
  }
  return v;
}

function addrs(v: string | undefined): string[] {
  return (v ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const url = required("DEALRIPE_APP_URL").replace(/\/+$/, "");
  const secret = required("CRON_SECRET");
  const send = process.argv.includes("--send");

  const endpoint = `${url}/api/cron/digest`;

  console.log(`\nEndpoint  ${endpoint}`);
  console.log(`Local DIGEST_TO   ${addrs(process.env.DIGEST_TO).join(", ") || "(not set)"}`);
  console.log(`Local DIGEST_BCC  ${addrs(process.env.DIGEST_BCC).join(", ") || "(none)"}`);
  console.log(`\nNote: the send uses PRODUCTION env on Vercel, not the two lines above.`);
  console.log(`The response echoes the real recipients, which is the only reliable check.`);

  if (!send) {
    console.log(`\nDry run. Re-run with --send to actually send.\n`);
    return;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!res.ok) {
    console.error(`\nHTTP ${res.status}`);
    console.error(typeof body === "string" ? body : JSON.stringify(body, null, 2));
    console.error("");
    process.exit(1);
  }

  console.log(`\nHTTP ${res.status}`);
  console.log(JSON.stringify(body, null, 2));
  console.log(`\nVerify with: npx tsx scripts/digest-log.ts --weeks 1\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
