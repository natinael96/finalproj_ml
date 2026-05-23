"use client";

import { useState } from "react";
import { Card } from "./Card";
import { SignalChart } from "./SignalChart";
import { useRawBatches } from "@/lib/rawBatches";
import { formatShortTime } from "@/lib/format";

type TabId = "ecg" | "ppg" | "accel" | "all";

export function SignalViewer({ device }: { device?: string }) {
  const [tab, setTab] = useState<TabId>("all");
  const { signals, loading, error, reload } = useRawBatches({
    device,
    maxBatches: 200,
  });

  const hasAccel = (signals?.accel.length ?? 0) > 0;

  return (
    <Card>
      <div className="sectionHeader" style={{ marginBottom: 16 }}>
        <div>
          <div className="cardTitle">Signal Viewer</div>
          <p className="muted">
            {signals
              ? `${signals.batchCount} batch${signals.batchCount !== 1 ? "es" : ""} · ${signals.ecg.length.toLocaleString()} samples · ${signals.durationS.toFixed(1)} s · last updated ${formatShortTime(signals.latestTs)}`
              : "Raw ECG, PPG and accelerometer waveforms from esp32_raw_batches"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="seg" aria-label="Signal tab">
            {(["all", "ecg", "ppg", "accel"] as TabId[]).map((t) => (
              <button
                key={t}
                type="button"
                className={tab === t ? "active" : ""}
                onClick={() => setTab(t)}
              >
                {t === "all" ? "All" : t === "ecg" ? "ECG" : t === "ppg" ? "PPG IR" : "Accel"}
              </button>
            ))}
          </span>
          <button
            className="btn btnTiny"
            type="button"
            onClick={reload}
            disabled={loading}
          >
            {loading ? "Loading…" : "↺ Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <p style={{ color: "var(--bad)", marginBottom: 14, fontSize: 13 }}>
          ⚠ {error}
        </p>
      )}

      {loading && !signals && (
        <div className="chartEmpty">
          <strong>Loading signals…</strong>
          <span>Fetching raw batches from database</span>
        </div>
      )}

      {!loading && !signals && !error && (
        <div className="chartEmpty">
          <strong>No raw batches yet</strong>
          <span>
            Send data from the ESP32 — each POST saves one batch to{" "}
            <code>esp32_raw_batches</code>
          </span>
        </div>
      )}

      {signals && (
        <div style={{ display: "grid", gap: 24 }}>
          {(tab === "all" || tab === "ecg") && (
            <SignalChart
              values={signals.ecg}
              label="ECG"
              unit="ADC"
              color="var(--accent)"
              fs={signals.fs}
              height={190}
            />
          )}
          {(tab === "all" || tab === "ppg") && (
            <SignalChart
              values={signals.ppg}
              label="PPG (IR channel)"
              unit="raw"
              color="var(--accent2)"
              fs={signals.fs}
              height={165}
            />
          )}
          {(tab === "all" || tab === "accel") &&
            (hasAccel ? (
              <SignalChart
                values={signals.accel}
                label="Accelerometer Magnitude"
                unit="m/s²"
                color="var(--good)"
                fs={signals.fs}
                height={145}
              />
            ) : (
              tab === "accel" && (
                <div className="chartEmpty">
                  <strong>No accelerometer data</strong>
                  <span>ax / ay / az columns are empty in the stored batches</span>
                </div>
              )
            ))}
          <p className="muted" style={{ fontSize: 12 }}>
            Showing last {signals.batchCount} batches (≤ 200). ECG values are raw
            12-bit ADC counts (0–4095); saturation at 4095 means the electrode
            gain/placement needs adjustment. PPG IR reflects photocurrent from
            MAX30100.
          </p>
        </div>
      )}
    </Card>
  );
}
