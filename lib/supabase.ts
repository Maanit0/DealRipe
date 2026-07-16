import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// Lazy-initialized so the module loads even before env vars are set.
// Errors surface on first .from() / .rpc() call with a clear message.
let _client: SupabaseClient<Database> | null = null;
let _admin: SupabaseClient<Database> | null = null;

/**
 * Browser-safe Supabase client. Uses the anon key, all access enforced by RLS.
 * Safe to import in client and server components.
 */
export function supabaseClient(): SupabaseClient<Database> {
  if (!_client) {
    _client = createClient<Database>(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
      {
        // Never let Next's Data Cache serve stale Supabase reads (see the note
        // in supabaseAdmin). Harmless in the browser where fetch isn't patched.
        global: {
          fetch: (input: RequestInfo | URL, init?: RequestInit) =>
            fetch(input, { ...init, cache: "no-store" }),
        },
      },
    );
  }
  return _client;
}

/**
 * Server-only Supabase client. Uses the service role key, bypasses RLS.
 * Must NEVER be called from a client component or any code that ships to the
 * browser. The service role key is intentionally not NEXT_PUBLIC_ so it is
 * undefined in the browser bundle.
 */
export function supabaseAdmin(): SupabaseClient<Database> {
  if (typeof window !== "undefined") {
    throw new Error(
      "supabaseAdmin() must only be called from server-side code (route handlers, server actions, server components).",
    );
  }
  if (!_admin) {
    _admin = createClient<Database>(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      {
        auth: { persistSession: false, autoRefreshToken: false },
        // CRITICAL: Next.js App Router patches global fetch to cache responses
        // in its persistent Data Cache (which survives redeploys). supabase-js
        // uses fetch, so without this every query URL gets cached and stale
        // reads persist even after the DB changes. Force no-store so Supabase
        // reads are always live.
        global: {
          fetch: (input: RequestInfo | URL, init?: RequestInit) =>
            fetch(input, { ...init, cache: "no-store" }),
        },
      },
    );
  }
  return _admin;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var ${name}. See SETUP.md.`);
  }
  return v;
}
