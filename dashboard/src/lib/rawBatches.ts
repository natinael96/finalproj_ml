"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

export type MergedSignals = {
  ecg: number[];
  ppg: number[];
  accel: number[];
  fs: number;
  durationS: number;
  batchCount: number;
  latestTs: string;
};

function safeArray(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number);
  return [];
}

function accelMag(ax: number[], ay: number[], az: number[]): number[] {
  const n = Math.min(ax.length, ay.length, az.length);
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = ax[i] ?? 0;
    const y = ay[i] ?? 0;
    const z = az[i] ?? 0;
    out[i] = Math.sqrt(x * x + y * y + z * z);
  }
  return out;
}

/** Fetch the list of distinct device_ids that have ever sent raw batches.
 *
 * Strategy: query the `devices` label table first (one row per device, no
 * scale issue), then fall back to scanning recent `esp32_raw_batches` for
 * any device that was never formally registered.
 */
export function useDeviceList() {
  const [devices, setDevices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    try {
      const seen = new Set<string>();

      // Primary: devices table — contains every registered device (one row each)
      const { data: labeled } = await supabase
        .from("devices")
        .select("device_id")
        .order("created_at", { ascending: false });
      if (labeled) {
        for (const row of labeled) {
          if (row.device_id) seen.add(row.device_id as string);
        }
      }

      // Fallback: scan recent raw batches for devices not yet in the label table
      const { data: batches } = await supabase
        .from("esp32_raw_batches")
        .select("device_id")
        .order("ts_ms_start", { ascending: false })
        .limit(2000);
      if (batches) {
        for (const row of batches) {
          if (row.device_id) seen.add(row.device_id as string);
        }
      }

      setDevices([...seen].sort());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { devices, loading, reload: load };
}

export type CycleSignals = {
  cycle_id: string;
  /** Human label, e.g. "Cycle 3 · 12:04:21" */
  label: string;
  ecg: number[];
  ppg: number[];
  accel: number[];
  fs: number;
};

/** Average element-wise across arrays (trims to shortest). */
export function averageSignals(arrays: number[][]): number[] {
  const valid = arrays.filter((a) => a.length > 0);
  if (valid.length === 0) return [];
  const len = Math.min(...valid.map((a) => a.length));
  return Array.from({ length: len }, (_, i) =>
    valid.reduce((s, a) => s + a[i], 0) / valid.length
  );
}

export type CycleInfo = {
  cycle_id: string;
  /** Unix-ms of the first batch in this cycle */
  ts_ms_start: number;
  /** Number of batches in this cycle */
  batch_count: number;
  /** Label shown in the UI, e.g. "Cycle 3 · 12:04:21" */
  label: string;
};

/** Fetch distinct cycle_ids for a given device, newest first. */
export function useCycleList(device: string) {
  const [cycles, setCycles] = useState<CycleInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!supabase || !device) { setCycles([]); return; }
    setLoading(true);
    try {
      const { data } = await supabase
        .from("esp32_raw_batches")
        .select("cycle_id,ts_ms_start")
        .eq("device_id", device)
        .order("ts_ms_start", { ascending: false })
        .limit(1000);
      if (!data) { setCycles([]); return; }

      // Aggregate per cycle_id
      const map = new Map<string, { tsMin: number; count: number }>();
      for (const row of data) {
        const cid = (row.cycle_id as string | null) ?? "unknown";
        const ts = (row.ts_ms_start as number) ?? 0;
        const existing = map.get(cid);
        if (!existing) {
          map.set(cid, { tsMin: ts, count: 1 });
        } else {
          if (ts < existing.tsMin) existing.tsMin = ts;
          existing.count++;
        }
      }

      // Sort newest first by tsMin, then label as "Cycle N"
      const sorted = [...map.entries()]
        .sort((a, b) => b[1].tsMin - a[1].tsMin)
        .map(([cycle_id, { tsMin, count }], idx, arr) => {
          const cycleNum = arr.length - idx; // oldest = Cycle 1
          const d = new Date(tsMin);
          const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          return {
            cycle_id,
            ts_ms_start: tsMin,
            batch_count: count,
            label: `Cycle ${cycleNum} · ${timeStr}`,
          } satisfies CycleInfo;
        });

      setCycles(sorted);
    } finally {
      setLoading(false);
    }
  }, [device]);

  useEffect(() => { load(); }, [load]);

  return { cycles, loading, reload: load };
}

/**
 * Fetch raw signal data for multiple cycle_ids in one query and return each
 * cycle's merged ECG/PPG/accel arrays ready for overlay or averaging.
 */
export function useMultiCycleBatches(
  device: string,
  cycleIds: string[],
  cycleLabels: Record<string, string> = {}
) {
  const [results, setResults] = useState<CycleSignals[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = cycleIds.slice().sort().join(",");

  const load = useCallback(async () => {
    if (!supabase || !device || cycleIds.length === 0) {
      setResults([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Single query with .in() — much cheaper than N parallel requests
      const { data, error: err } = await supabase
        .from("esp32_raw_batches")
        .select("cycle_id,ts_ms_start,fs_hz,ecg,ppg,ax,ay,az")
        .eq("device_id", device)
        .in("cycle_id", cycleIds)
        .order("ts_ms_start", { ascending: true })
        .limit(cycleIds.length * 300);

      if (err) throw new Error(err.message);
      if (!data || data.length === 0) { setResults([]); return; }

      // Group rows by cycle_id
      const groups = new Map<string, typeof data>();
      for (const row of data) {
        const cid = row.cycle_id as string;
        if (!groups.has(cid)) groups.set(cid, []);
        groups.get(cid)!.push(row);
      }

      // Merge each group into one CycleSignals, preserving the requested order
      const merged: CycleSignals[] = cycleIds.map((cid) => {
        const rows = groups.get(cid) ?? [];
        const sorted = rows.sort(
          (a, b) => (a.ts_ms_start as number) - (b.ts_ms_start as number)
        );
        const ecg: number[] = [], ppg: number[] = [];
        const axArr: number[] = [], ayArr: number[] = [], azArr: number[] = [];
        let fs = 20;
        for (const row of sorted) {
          ecg.push(...safeArray(row.ecg));
          ppg.push(...safeArray(row.ppg));
          axArr.push(...safeArray(row.ax));
          ayArr.push(...safeArray(row.ay));
          azArr.push(...safeArray(row.az));
          if (row.fs_hz) fs = row.fs_hz as number;
        }
        return {
          cycle_id: cid,
          label: cycleLabels[cid] ?? cid.slice(0, 8),
          ecg,
          ppg,
          accel: accelMag(axArr, ayArr, azArr),
          fs,
        };
      });

      setResults(merged);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [device, key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  return { results, loading, error, reload: load };
}

export function useRawBatches(options?: { device?: string; cycleId?: string; maxBatches?: number }) {
  const { device = "", cycleId = "", maxBatches = 200 } = options ?? {};
  const [signals, setSignals] = useState<MergedSignals | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) {
      setError("Supabase not configured");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let query = supabase
        .from("esp32_raw_batches")
        .select("id,device_id,cycle_id,ts_ms_start,fs_hz,sample_count,ecg,ppg,ax,ay,az,created_at")
        .order("ts_ms_start", { ascending: false })
        .limit(maxBatches);
      if (device) query = query.eq("device_id", device);
      if (cycleId) query = query.eq("cycle_id", cycleId);
      const { data, error: err } = await query;
      if (err) throw new Error(err.message);
      if (!data || data.length === 0) {
        setSignals(null);
        return;
      }

      const sorted = [...data].sort(
        (a, b) => (a.ts_ms_start as number) - (b.ts_ms_start as number)
      );

      const ecg: number[] = [];
      const ppg: number[] = [];
      const axAll: number[] = [];
      const ayAll: number[] = [];
      const azAll: number[] = [];
      let fs = (sorted[0].fs_hz as number) ?? 10;

      for (const row of sorted) {
        ecg.push(...safeArray(row.ecg));
        ppg.push(...safeArray(row.ppg));
        axAll.push(...safeArray(row.ax));
        ayAll.push(...safeArray(row.ay));
        azAll.push(...safeArray(row.az));
        if (row.fs_hz) fs = row.fs_hz as number;
      }

      setSignals({
        ecg,
        ppg,
        accel: accelMag(axAll, ayAll, azAll),
        fs,
        durationS: ecg.length / Math.max(fs, 1),
        batchCount: sorted.length,
        latestTs: sorted[sorted.length - 1].created_at as string,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [device, cycleId, maxBatches]);

  useEffect(() => {
    load();
  }, [load]);

  return { signals, loading, error, reload: load };
}
