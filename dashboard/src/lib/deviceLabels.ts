"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

export type DeviceLabelMap = Record<string, string>;

/**
 * Reads and writes custom labels for device_ids from the `devices` table.
 *
 * Usage:
 *   const { displayName, saveLabel, saving } = useDeviceLabels();
 *   displayName("esp32-001")  // → "Living Room ESP32" (or "esp32-001" if not named)
 *   await saveLabel("esp32-001", "Living Room ESP32");
 */
export function useDeviceLabels() {
  const [labels, setLabels] = useState<DeviceLabelMap>({});
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Resolve current user once
  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      setUserId(data.session?.user.id ?? null);
    });
    const { data: sub } = supabase?.auth.onAuthStateChange((_e, s) => {
      setUserId(s?.user.id ?? null);
    }) ?? { data: null };
    return () => { sub?.subscription.unsubscribe(); };
  }, []);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    try {
      const { data } = await supabase
        .from("devices")
        .select("device_id,label");
      if (data) {
        const m: DeviceLabelMap = {};
        for (const row of data) {
          if (row.label) m[row.device_id as string] = row.label as string;
        }
        setLabels(m);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Save (or clear) a custom label for a device.
   * Passing an empty string removes the label.
   */
  const saveLabel = useCallback(async (deviceId: string, label: string) => {
    if (!supabase || !userId) return;
    setSaving(true);
    try {
      const trimmed = label.trim();
      await supabase
        .from("devices")
        .upsert(
          { user_id: userId, device_id: deviceId, label: trimmed || null },
          { onConflict: "user_id,device_id" }
        );
      setLabels((prev) => {
        const next = { ...prev };
        if (trimmed) next[deviceId] = trimmed;
        else delete next[deviceId];
        return next;
      });
    } finally {
      setSaving(false);
    }
  }, [userId]);

  /** Returns the custom label if set, otherwise the raw device_id. */
  const displayName = useCallback(
    (deviceId: string) => labels[deviceId] || deviceId,
    [labels]
  );

  /**
   * Delete a device and all its associated data.
   * Removes rows from `devices`, `esp32_raw_batches`, and `telemetry_windows`.
   */
  const deleteDevice = useCallback(async (deviceId: string) => {
    if (!supabase || !userId) return;
    setSaving(true);
    try {
      await Promise.all([
        supabase.from("devices").delete().eq("user_id", userId).eq("device_id", deviceId),
        supabase.from("esp32_raw_batches").delete().eq("device_id", deviceId),
        supabase.from("telemetry_windows").delete().eq("device_id", deviceId),
      ]);
      setLabels((prev) => {
        const next = { ...prev };
        delete next[deviceId];
        return next;
      });
    } finally {
      setSaving(false);
    }
  }, [userId]);

  return { labels, loading, saving, saveLabel, deleteDevice, displayName, reload: load };
}
