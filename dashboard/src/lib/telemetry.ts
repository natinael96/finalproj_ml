"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { dashboardWebSocketUrl } from "./env";
import { supabase } from "./supabaseClient";
import type { TelemetryWindow } from "./types";

export type TelemetryStatus = {
  database: "idle" | "loading" | "ready" | "error" | "disabled";
  realtime: "idle" | "subscribing" | "ready" | "error" | "disabled";
  websocket: "idle" | "connecting" | "ready" | "error" | "closed" | "disabled";
  message: string;
};

export function useTelemetry(options?: {
  enabled?: boolean;
  device?: string;
  limit?: number;
  realtime?: boolean;
  websocket?: boolean;
}) {
  const { enabled = true, device = "", limit = 100, realtime = false, websocket = false } = options ?? {};
  const subscriptionIdRef = useRef(Math.random().toString(36).slice(2));
  const [rows, setRows] = useState<TelemetryWindow[]>([]);
  const [status, setStatus] = useState("");
  const [telemetryStatus, setTelemetryStatus] = useState<TelemetryStatus>({
    database: enabled ? "idle" : "disabled",
    realtime: realtime ? "idle" : "disabled",
    websocket: websocket ? "idle" : "disabled",
    message: enabled ? "Ready to load telemetry." : "Telemetry is disabled."
  });

  useEffect(() => {
    if (!enabled) {
      setTelemetryStatus((current) => ({ ...current, database: "disabled", message: "Telemetry is disabled." }));
      return;
    }
    if (!supabase) {
      setTelemetryStatus((current) => ({ ...current, database: "disabled", message: "Supabase is not configured." }));
      return;
    }
    const client = supabase;
    let cancelled = false;

    async function loadTelemetry() {
      try {
        setStatus("Loading telemetry...");
        setTelemetryStatus((current) => ({ ...current, database: "loading", message: "Loading stored telemetry..." }));
        const query = client
          .from("telemetry_windows")
          .select("id,created_at,ts_ms_start,device_id,sbp_pred,dbp_pred,sbp_std,dbp_std,synthetic")
          .order("created_at", { ascending: false })
          .limit(limit);
        const { data, error } = device ? await query.eq("device_id", device) : await query;
        if (cancelled) return;
        if (error) {
          const message = `Database error: ${error.message}`;
          setStatus(message);
          setTelemetryStatus((current) => ({ ...current, database: "error", message }));
        } else {
          setRows((data ?? []) as TelemetryWindow[]);
          setStatus("");
          setTelemetryStatus((current) => ({
            ...current,
            database: "ready",
            message: data?.length ? "Stored telemetry loaded." : "Connected. Waiting for first telemetry window."
          }));
        }
      } catch (error) {
        if (cancelled) return;
        const message = `Database request failed: ${error instanceof Error ? error.message : String(error)}`;
        setStatus(message);
        setTelemetryStatus((current) => ({ ...current, database: "error", message }));
      }
    }

    loadTelemetry();
    return () => {
      cancelled = true;
    };
  }, [device, enabled, limit]);

  useEffect(() => {
    if (!enabled || !realtime) {
      setTelemetryStatus((current) => ({ ...current, realtime: "disabled" }));
      return;
    }
    if (!supabase) {
      setTelemetryStatus((current) => ({ ...current, realtime: "disabled" }));
      return;
    }
    const client = supabase;
    setTelemetryStatus((current) => ({ ...current, realtime: "subscribing" }));
    const channel = client
      .channel(`telemetry_windows_live_${subscriptionIdRef.current}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "telemetry_windows" },
        (payload) => {
          const row = payload.new as TelemetryWindow;
          if (device && row.device_id !== device) return;
          setTelemetryStatus((current) => ({
            ...current,
            realtime: "ready",
            message: "Received a Supabase realtime telemetry window."
          }));
          setRows((prev) => [row, ...prev].slice(0, limit));
        }
      )
      .subscribe((state) => {
        if (state === "SUBSCRIBED") {
          setTelemetryStatus((current) => ({ ...current, realtime: "ready" }));
        } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          setTelemetryStatus((current) => ({
            ...current,
            realtime: "error",
            message: "Supabase realtime subscription is unavailable."
          }));
        }
      });

    return () => {
      client.removeChannel(channel);
    };
  }, [device, enabled, limit, realtime]);

  useEffect(() => {
    if (!enabled || !websocket) {
      setTelemetryStatus((current) => ({ ...current, websocket: "disabled" }));
      return;
    }

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let attempt = 0;

    function connect() {
      if (cancelled) return;
      setTelemetryStatus((current) => ({
        ...current,
        websocket: "connecting",
        message: attempt > 0 ? `Reconnecting dashboard WebSocket (attempt ${attempt + 1})...` : "Connecting dashboard WebSocket..."
      }));
      ws = new WebSocket(dashboardWebSocketUrl());

      ws.onopen = () => {
        attempt = 0;
        setStatus("Dashboard socket connected.");
        setTelemetryStatus((current) => ({
          ...current,
          websocket: "ready",
          message: "Connected. Waiting for first telemetry window."
        }));
        ws?.send("hello");
      };

      ws.onerror = () => {
        const message = "Dashboard WebSocket unavailable. Supabase history can still load.";
        setStatus(message);
        setTelemetryStatus((current) => ({ ...current, websocket: "error", message }));
      };

      ws.onclose = () => {
        if (cancelled) return;
        setStatus((current) => (current.includes("socket") ? "" : current));
        setTelemetryStatus((current) => ({ ...current, websocket: "closed", message: "WebSocket closed — retrying..." }));
        attempt += 1;
        const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 15000);
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message?.type !== "telemetry_window") return;
          const row: TelemetryWindow = {
            id: String(message.ts_ms_start ?? Date.now()),
            created_at: new Date().toISOString(),
            device_id: String(message.device_id ?? "device"),
            sbp_pred: typeof message.sbp_pred === "number" ? message.sbp_pred : null,
            dbp_pred: typeof message.dbp_pred === "number" ? message.dbp_pred : null,
            sbp_std: typeof message.sbp_std === "number" ? message.sbp_std : null,
            dbp_std: typeof message.dbp_std === "number" ? message.dbp_std : null,
            synthetic: Boolean(message.synthetic)
          };
          if (device && row.device_id !== device) return;
          setTelemetryStatus((current) => ({
            ...current,
            websocket: "ready",
            message: "Received a FastAPI dashboard WebSocket window."
          }));
          setRows((prev) => [row, ...prev].slice(0, limit));
        } catch {
          // Ignore non-telemetry messages from development probes.
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [device, enabled, limit, websocket]);

  const devices = useMemo(() => {
    const set = new Set(rows.map((row) => row.device_id).filter(Boolean));
    return Array.from(set).sort();
  }, [rows]);

  return { rows, setRows, status, setStatus, telemetryStatus, devices };
}
