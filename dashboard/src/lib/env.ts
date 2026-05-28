export const BP_API_URL =
  process.env.NEXT_PUBLIC_BP_API_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:8000";

export const BP_DASHBOARD_WS_URL =
  process.env.NEXT_PUBLIC_BP_DASHBOARD_WS_URL ?? "ws://127.0.0.1:8000/ws/dashboard";

export const BP_API_KEY = process.env.NEXT_PUBLIC_BP_API_KEY ?? "";

export function apiHeaders(extra?: HeadersInit): HeadersInit {
  return BP_API_KEY ? { ...extra, "x-api-key": BP_API_KEY } : extra ?? {};
}

export function dashboardWebSocketUrl() {
  if (!BP_API_KEY) return BP_DASHBOARD_WS_URL;
  const url = new URL(BP_DASHBOARD_WS_URL);
  url.searchParams.set("api_key", BP_API_KEY);
  return url.toString();
}

export function hasSupabaseEnv() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

/** Set NEXT_PUBLIC_BP_WEBSOCKET_ENABLED=true to connect to FastAPI /ws/dashboard. */
export function isWebSocketEnabled() {
  const raw = process.env.NEXT_PUBLIC_BP_WEBSOCKET_ENABLED?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
