"use client";

import { formatTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { DashboardMode, TelemetryWindow } from "@/lib/types";
import { TelemetryEmptyState } from "./TelemetryEmptyState";
import { useDeviceLabels } from "@/lib/deviceLabels";


/** Detect cycle boundaries: gap > 60 s between consecutive windows = new cycle. */
function assignCycles(rows: TelemetryWindow[]): number[] {
  const reversed = [...rows].reverse(); // oldest first
  const nums = new Array(rows.length).fill(1);
  let cycle = 1;
  let prevMs: number | null = null;
  for (let i = 0; i < reversed.length; i++) {
    const ms = reversed[i].ts_ms_start ?? new Date(reversed[i].created_at).getTime();
    if (prevMs !== null && ms - prevMs > 60_000) cycle++;
    nums[reversed.length - 1 - i] = cycle; // map back to newest-first index
    prevMs = ms;
  }
  return nums;
}

// ─── component ───────────────────────────────────────────────────────────────

export function TelemetryTable({
  rows,
  mode = "user",
}: {
  rows: TelemetryWindow[];
  mode?: DashboardMode;
}) {
  const t = useT();
  const { labels, displayName } = useDeviceLabels();
  if (rows.length === 0) return <TelemetryEmptyState />;

  const cycleNums   = assignCycles(rows);
  const maxCycle    = Math.max(...cycleNums);
  const displayed   = mode === "user" ? rows.slice(0, 20) : rows;

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Cycle</th>
            <th>{t("table.time")}</th>
            <th>{t("table.device")}</th>
            <th style={{ textAlign: "center" }}>SBP / DBP</th>
            {mode === "detailed" && (
              <>
                <th>{t("table.sigmaSbp")}</th>
                <th>{t("table.sigmaDbp")}</th>
                <th>{t("table.source")}</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {displayed.map((row, i) => {
            const sbp    = row.sbp_pred;
            const dbp    = row.dbp_pred;
            const cycleN = cycleNums[i];
            const deviceId = row.device_id ?? "";
            const deviceName = displayName(deviceId);
            const hasCustomDeviceName = Boolean(deviceId && labels[deviceId]);
            // Label cycles newest = "Latest", older ones counted backwards
            const cycleLabel = maxCycle - cycleN + 1 === 1 ? "Latest" : `C ${maxCycle - cycleN + 1}`;

            return (
              <tr key={row.id}>
                <td style={{ color: "var(--faint)", fontSize: 11 }}>{rows.length - i}</td>

                <td>
                  <span className="pill" style={{ fontSize: 11 }}>{cycleLabel}</span>
                </td>

                <td className="nowrap" style={{ fontSize: 13 }}>{formatTime(row.created_at)}</td>

                <td style={{ color: "var(--muted)", fontSize: 13 }}
                  title={deviceId || undefined}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ color: "var(--ink)", fontWeight: hasCustomDeviceName ? 650 : 500 }}>
                      {deviceName || "-"}
                    </span>
                    {hasCustomDeviceName && (
                      <span style={{ color: "var(--faint)", fontSize: 11, fontFamily: "Cascadia Code, Consolas, monospace" }}>
                        {deviceId}
                      </span>
                    )}
                  </div>
                </td>

                <td style={{ textAlign: "center" }}>
                  {sbp != null && dbp != null ? (
                    <span className="bpCell">
                      <strong>{sbp.toFixed(0)}</strong>
                      <span style={{ color: "var(--faint)", margin: "0 2px" }}>/</span>
                      {dbp.toFixed(0)}
                    </span>
                  ) : <span style={{ color: "var(--faint)" }}>—</span>}
                </td>

                {mode === "detailed" && (
                  <>
                    <td className="num" style={{ color: "var(--faint)", fontSize: 12 }}>
                      {row.sbp_std != null ? `±${row.sbp_std.toFixed(1)}` : "—"}
                    </td>
                    <td className="num" style={{ color: "var(--faint)", fontSize: 12 }}>
                      {row.dbp_std != null ? `±${row.dbp_std.toFixed(1)}` : "—"}
                    </td>
                    <td style={{ fontSize: 12, color: "var(--muted)" }}>
                      {row.synthetic ? t("common.synthetic") : t("common.sensor")}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
