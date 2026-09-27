/**
 * supabase.ts — Supabase client factory.
 *
 * Two clients:
 *  - browserClient()      Uses the publishable (anon) key. Safe to use in browser/client components.
 *  - serviceRoleClient()  Uses the secret service-role key. Server-side ONLY (API routes, Server Actions).
 *                         NEVER expose this key to the browser.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL');
}
if (!SUPABASE_ANON_KEY) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_ANON_KEY');
}

/**
 * Public (anon) client — safe in Client Components and browser code.
 * Respects Row Level Security policies.
 */
export function browserClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/**
 * Service-role client — bypasses RLS. Use ONLY in:
 *   - API Route Handlers (src/app/api/*)
 *   - Server Actions
 *   - Server Components that perform privileged writes
 *
 * NEVER import this in Client Components.
 */
export function serviceRoleClient(): SupabaseClient {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing env: SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      // Disable auto session refresh — not needed for server-side service role usage
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
