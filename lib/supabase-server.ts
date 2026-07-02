/**
 * Server-side Supabase client backed by the request's cookies.
 *
 * Use this from Server Components, Server Actions, and Route Handlers
 * when the read/write should be scoped to the AUTHENTICATED USER (so RLS
 * actually enforces). Do NOT use this for cron / system writes — those
 * use supabaseAdmin() from lib/supabase.ts (service role, bypasses RLS).
 *
 * The session lives in cookies managed by @supabase/ssr; the middleware
 * refreshes them on each request, so by the time this client is built
 * the cookies are fresh.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export function createSupabaseServerClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Component context: cookies are read-only here.
            // The middleware handles session refresh, so this is fine.
          }
        },
      },
    },
  );
}
