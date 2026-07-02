"use client";

/**
 * Browser-side Supabase client. Used by the login form and any
 * Client Component that needs to invoke auth methods (signInWithOtp,
 * signOut, etc.). Session is managed in cookies by @supabase/ssr.
 */

import { createBrowserClient } from "@supabase/ssr";

export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
