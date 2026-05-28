"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { hasSupabaseEnv } from "./env";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const supabaseStorageKey = "bp-dashboard-auth";

const globalForSupabase = globalThis as typeof globalThis & {
  __bpDashboardSupabase?: SupabaseClient | null;
};

function createSupabaseClient(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      storageKey: supabaseStorageKey,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true
    }
  });
}

export const supabase =
  globalForSupabase.__bpDashboardSupabase !== undefined
    ? globalForSupabase.__bpDashboardSupabase
    : createSupabaseClient();

if (process.env.NODE_ENV !== "production") {
  globalForSupabase.__bpDashboardSupabase = supabase;
}

export function supabaseEnvMissing() {
  return !hasSupabaseEnv();
}
