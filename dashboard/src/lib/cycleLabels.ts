"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

/**
 * Reads and writes custom labels for cycle_ids from the `cycle_labels` table.
 *
 * Usage:
 *   const { customLabel, saveLabel, saving } = useCycleLabels();
 *   customLabel("abc-uuid")               // → "Morning session" | undefined
 *   await saveLabel("abc-uuid", "Post-exercise");
 *   await saveLabel("abc-uuid", "");       // clears the label
 */
export function useCycleLabels() {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [userId, setUserId] = useState<string | null>(null);
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
    const { data } = await supabase
      .from("cycle_labels")
      .select("cycle_id,label");
    if (data) {
      const m: Record<string, string> = {};
      for (const row of data) {
        if (row.cycle_id && row.label) m[row.cycle_id as string] = row.label as string;
      }
      setLabels(m);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Save (or clear) a custom label for a cycle.
   * Passing an empty string removes the label.
   */
  const saveLabel = useCallback(async (cycleId: string, label: string) => {
    if (!supabase || !userId) return;
    setSaving(true);
    try {
      const trimmed = label.trim();
      if (trimmed) {
        await supabase
          .from("cycle_labels")
          .upsert(
            { cycle_id: cycleId, user_id: userId, label: trimmed },
            { onConflict: "cycle_id,user_id" }
          );
        setLabels((prev) => ({ ...prev, [cycleId]: trimmed }));
      } else {
        await supabase
          .from("cycle_labels")
          .delete()
          .eq("cycle_id", cycleId)
          .eq("user_id", userId);
        setLabels((prev) => {
          const next = { ...prev };
          delete next[cycleId];
          return next;
        });
      }
    } finally {
      setSaving(false);
    }
  }, [userId]);

  /** Returns the custom label if set, otherwise undefined. */
  const customLabel = useCallback(
    (cycleId: string): string | undefined => labels[cycleId],
    [labels]
  );

  /**
   * Delete a cycle and all its raw signal data.
   * Removes rows from `esp32_raw_batches` (by cycle_id) and `cycle_labels`.
   */
  const deleteCycle = useCallback(async (cycleId: string) => {
    if (!supabase || !userId) return;
    setSaving(true);
    try {
      await Promise.all([
        supabase.from("esp32_raw_batches").delete().eq("cycle_id", cycleId),
        supabase.from("cycle_labels").delete().eq("cycle_id", cycleId).eq("user_id", userId),
      ]);
      setLabels((prev) => {
        const next = { ...prev };
        delete next[cycleId];
        return next;
      });
    } finally {
      setSaving(false);
    }
  }, [userId]);

  return { labels, saving, saveLabel, deleteCycle, customLabel, reload: load };
}
