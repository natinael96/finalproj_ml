"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "./Card";
import { SignalChart, SeriesData } from "./SignalChart";
import {
  useRawBatches, useDeviceList, useCycleList,
  useMultiCycleBatches, averageSignals,
} from "@/lib/rawBatches";
import { formatInteger, formatShortTime } from "@/lib/format";
import { useDeviceLabels } from "@/lib/deviceLabels";
import { useCycleLabels } from "@/lib/cycleLabels";
import { useTelemetry } from "@/lib/telemetry";
import type { TelemetryWindow } from "@/lib/types";

type TabId = "ecg" | "ppg" | "accel" | "all";
type AggMode = "overlay" | "average";

// Palette for overlay colours — cycles through these for each selected cycle
const PALETTE = [
  "var(--accent)",
  "var(--accent2)",
  "var(--good)",
  "var(--warn)",
  "oklch(60% 0.18 290)",
];

function predictionLabel(row: TelemetryWindow | null | undefined) {
  if (!row || row.sbp_pred == null || row.dbp_pred == null) return null;
  return `${formatInteger(row.sbp_pred)}/${formatInteger(row.dbp_pred)} mmHg`;
}

export function SignalViewer({ device: initialDevice }: { device?: string }) {
  const [tab, setTab] = useState<TabId>("all");
  const [selectedDevice, setSelectedDevice] = useState(initialDevice ?? "");
  const [selectedCycle, setSelectedCycle] = useState("");
  const [compareMode, setCompareMode] = useState(false);
  const [selectedCycles, setSelectedCycles] = useState<string[]>([]);
  const [aggMode, setAggMode] = useState<AggMode>("overlay");

  useEffect(() => {
    if (initialDevice && !selectedDevice) setSelectedDevice(initialDevice);
  }, [initialDevice]); // eslint-disable-line

  const { devices, loading: devicesLoading, reload: reloadDevices } = useDeviceList();
  const { displayName } = useDeviceLabels();
  const { customLabel } = useCycleLabels();
  const { cycles, loading: cyclesLoading, reload: reloadCycles } = useCycleList(selectedDevice);
  const { rows: telemetryRows } = useTelemetry({ enabled: true, limit: 500, realtime: true });
  const { signals, loading, error, reload } = useRawBatches({
    device: selectedDevice,
    cycleId: compareMode ? "" : selectedCycle,
    maxBatches: 200,
  });

  // Cycle label map for useMultiCycleBatches
  const cycleLabels = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of cycles) m[c.cycle_id] = c.label;
    return m;
  }, [cycles]);

  const latestPredictionByDevice = useMemo(() => {
    const map = new Map<string, TelemetryWindow>();
    for (const row of telemetryRows) {
      if (!row.device_id || row.sbp_pred == null || row.dbp_pred == null) continue;
      const current = map.get(row.device_id);
      const rowTime = new Date(row.created_at).getTime();
      const currentTime = current ? new Date(current.created_at).getTime() : Number.NEGATIVE_INFINITY;
      if (!current || rowTime > currentTime) map.set(row.device_id, row);
    }
    return map;
  }, [telemetryRows]);

  const latestPrediction = useMemo(() => {
    return telemetryRows.find((row) => row.sbp_pred != null && row.dbp_pred != null) ?? null;
  }, [telemetryRows]);

  const predictionByCycle = useMemo(() => {
    if (!selectedDevice) return new Map<string, TelemetryWindow>();
    const deviceRows = telemetryRows.filter((row) => row.device_id === selectedDevice);
    const map = new Map<string, TelemetryWindow>();
    for (const cycle of cycles) {
      const match = deviceRows.reduce<TelemetryWindow | null>((best, row) => {
        if (row.ts_ms_start == null || row.sbp_pred == null || row.dbp_pred == null) return best;
        const diff = Math.abs(row.ts_ms_start - cycle.ts_ms_start);
        if (diff > 180_000) return best;
        if (!best || diff < Math.abs((best.ts_ms_start ?? 0) - cycle.ts_ms_start)) return row;
        return best;
      }, null);
      if (match) map.set(cycle.cycle_id, match);
    }
    return map;
  }, [cycles, telemetryRows, selectedDevice]);

  const { results: multiResults, loading: multiLoading } = useMultiCycleBatches(
    selectedDevice,
    compareMode ? selectedCycles : [],
    cycleLabels
  );

  const hasAccel = compareMode
    ? multiResults.some(r => r.accel.length > 0)
    : (signals?.accel.length ?? 0) > 0;

  // ── helpers ──────────────────────────────────────────────────────────────
  const changeDevice = (d: string) => {
    setSelectedDevice(d); setSelectedCycle(""); setSelectedCycles([]); setCompareMode(false);
  };

  useEffect(() => {
    if (!selectedDevice && devices.length > 0)
      setSelectedDevice(initialDevice && devices.includes(initialDevice) ? initialDevice : devices[0]);
  }, [devices]); // eslint-disable-line

  useEffect(() => {
    if (cycles.length > 0 && !selectedCycle && !compareMode) setSelectedCycle(cycles[0].cycle_id);
  }, [cycles]); // eslint-disable-line

  const toggleCycleSelect = (cid: string) => {
    setSelectedCycles(prev =>
      prev.includes(cid) ? prev.filter(c => c !== cid) : prev.length < 5 ? [...prev, cid] : prev
    );
  };

  const enterCompare = () => {
    setCompareMode(true);
    // Pre-select the currently-viewed cycle plus the next one
    const cur = cycles.findIndex(c => c.cycle_id === selectedCycle);
    const picks = cycles.slice(Math.max(0, cur), Math.max(0, cur) + 2).map(c => c.cycle_id);
    setSelectedCycles(picks);
  };

  const exitCompare = () => { setCompareMode(false); setSelectedCycles([]); };

  const handleRefresh = () => { reload(); reloadDevices(); reloadCycles(); };

  // ── build series arrays for compare mode ────────────────────────────────
  const buildSeries = (field: "ecg" | "ppg" | "accel"): SeriesData[] =>
    multiResults.map((r, i) => ({
      values: r[field],
      color: PALETTE[i % PALETTE.length],
      label: r.label,
    }));

  const buildAverageSeries = (field: "ecg" | "ppg" | "accel", color: string): SeriesData[] => [{
    values: averageSignals(multiResults.map(r => r[field])),
    color,
    label: `Average (${multiResults.length} cycles)`,
  }];

  const seriesFor = (field: "ecg" | "ppg" | "accel", singleColor: string): SeriesData[] | undefined => {
    if (!compareMode || multiResults.length === 0) return undefined;
    return aggMode === "average" ? buildAverageSeries(field, singleColor) : buildSeries(field);
  };

  const isCompareReady = compareMode && multiResults.length >= 2 && !multiLoading;
  const showCharts = !compareMode ? !!signals : isCompareReady;
  const latestPredictionText = predictionLabel(latestPrediction);

  return (
    <Card>
      {/* ── title row ── */}
      <div className="sectionHeader" style={{ marginBottom: 14 }}>
        <div>
          <div className="cardTitle">Signal Viewer</div>
          <p className="muted">
            {compareMode
              ? `Comparing ${selectedCycles.length} cycle${selectedCycles.length !== 1 ? "s" : ""} · ${aggMode} view`
              : signals
              ? `${signals.batchCount} batch${signals.batchCount !== 1 ? "es" : ""} · ${signals.ecg.length.toLocaleString()} samples · ${signals.durationS.toFixed(1)} s · last ${formatShortTime(signals.latestTs)}`
              : "Raw ECG, PPG and accelerometer waveforms"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* signal tabs */}
          <span className="seg" aria-label="Signal tab">
            {(["all", "ecg", "ppg", "accel"] as TabId[]).map((t) => (
              <button key={t} type="button" className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {t === "all" ? "All" : t === "ecg" ? "ECG" : t === "ppg" ? "PPG IR" : "Accel"}
              </button>
            ))}
          </span>
          {/* compare / aggregate toggle */}
          {selectedDevice && cycles.length >= 2 && (
            compareMode ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="seg" aria-label="Aggregate mode">
                  <button type="button" className={aggMode === "overlay" ? "active" : ""}
                    onClick={() => setAggMode("overlay")}>Overlay</button>
                  <button type="button" className={aggMode === "average" ? "active" : ""}
                    onClick={() => setAggMode("average")}>Average</button>
                </span>
                <button className="btn btnTiny" type="button" onClick={exitCompare}>✕ Compare</button>
              </div>
            ) : (
              <button className="btn btnTiny" type="button" onClick={enterCompare}
                title="Select multiple cycles to overlay or average">
                ⊕ Compare
              </button>
            )
          )}
          <button className="btn btnTiny" type="button" onClick={handleRefresh} disabled={loading || multiLoading}>
            {(loading || multiLoading) ? "Loading…" : "↺ Refresh"}
          </button>
        </div>
      </div>

      {/* ── device filter ── */}
      <div className="deviceFilterBar" style={{ marginBottom: 10 }}>
        <span className="toolbarLabel" style={{ whiteSpace: "nowrap" }}>Device</span>
        {devicesLoading && devices.length === 0 ? (
          <span className="signalChartMeta">Loading…</span>
        ) : devices.length === 0 ? (
          <span className="signalChartMeta" style={{ color: "var(--faint)" }}>No devices found</span>
        ) : (
          <div className="devicePillRow">
            <button type="button" className={`devicePill${selectedDevice === "" ? " active" : ""}`}
              onClick={() => changeDevice("")} style={{ maxWidth: 280 }}>
              All
              {latestPredictionText && (
                <span style={{ opacity: 0.72, fontWeight: 600, flexShrink: 0 }}>{latestPredictionText}</span>
              )}
            </button>
            {devices.map((d) => {
              const predText = predictionLabel(latestPredictionByDevice.get(d));
              return (
                <button key={d} type="button"
                  className={`devicePill${selectedDevice === d ? " active" : ""}`}
                  onClick={() => changeDevice(d)} title={predText ? `${d} · ${predText}` : d}
                  style={{ maxWidth: 280 }}>
                  <span className="devicePillDot" />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{displayName(d)}</span>
                  {predText && <span style={{ opacity: 0.72, fontWeight: 600, flexShrink: 0 }}>{predText}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── cycle filter / compare selector ── */}
      {selectedDevice && (
        <div className="deviceFilterBar" style={{ marginBottom: 14 }}>
          <span className="toolbarLabel" style={{ whiteSpace: "nowrap" }}>
            {compareMode ? "Pick cycles" : "Cycle"}
          </span>
          {cyclesLoading && cycles.length === 0 ? (
            <span className="signalChartMeta">Loading cycles…</span>
          ) : cycles.length === 0 ? (
            <span className="signalChartMeta" style={{ color: "var(--faint)" }}>No cycles yet</span>
          ) : (
            <div className="devicePillRow" style={{ overflowX: "auto", flexWrap: "nowrap", paddingBottom: 2 }}>
              {!compareMode && (
                <button type="button" className={`devicePill${selectedCycle === "" ? " active" : ""}`}
                  onClick={() => setSelectedCycle("")}>Latest</button>
              )}
              {cycles.map((c, i) => {
                const isSelected = compareMode
                  ? selectedCycles.includes(c.cycle_id)
                  : selectedCycle === c.cycle_id;
                const cycleColor = compareMode && isSelected
                  ? PALETTE[selectedCycles.indexOf(c.cycle_id) % PALETTE.length]
                  : undefined;
                const displayCycleName = customLabel(c.cycle_id) ?? `Cycle ${cycles.length - i}`;
                const predText = predictionLabel(predictionByCycle.get(c.cycle_id));
                return (
                  <button key={c.cycle_id} type="button"
                    className={`devicePill cyclePill${isSelected ? " active" : ""}`}
                    style={cycleColor ? { background: cycleColor, borderColor: cycleColor, color: "white", maxWidth: 280 } : { maxWidth: 280 }}
                    onClick={() => compareMode ? toggleCycleSelect(c.cycle_id) : setSelectedCycle(c.cycle_id)}
                    title={`${c.batch_count} batches${predText ? ` · ${predText}` : ""} · ${c.cycle_id}`}>
                    {compareMode && isSelected && (
                      <span style={{ fontWeight: 900, marginRight: 2 }}>
                        {selectedCycles.indexOf(c.cycle_id) + 1}
                      </span>
                    )}
                    <span className="devicePillDot" style={{
                      background: cycleColor ?? (isSelected ? "var(--paper)" : "var(--accent2)")
                    }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{displayCycleName}</span>
                    {predText && <span style={{ opacity: 0.72, fontWeight: 600, flexShrink: 0 }}>{predText}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {compareMode && (
            <span className="signalChartMeta" style={{ marginLeft: "auto", whiteSpace: "nowrap", fontSize: 11 }}>
              {selectedCycles.length}/5 selected
            </span>
          )}
        </div>
      )}

      {/* compare hint */}
      {compareMode && selectedCycles.length < 2 && (
        <div className="chartEmpty" style={{ minHeight: 80 }}>
          <strong>Select at least 2 cycles above to compare</strong>
          <span>Up to 5 cycles can be selected simultaneously</span>
        </div>
      )}

      {/* ── error ── */}
      {error && <p style={{ color: "var(--bad)", marginBottom: 14, fontSize: 13 }}>⚠ {error}</p>}

      {/* ── loading ── */}
      {(loading || multiLoading) && !showCharts && (
        <div className="chartEmpty">
          <strong>Loading signals…</strong>
          <span>Fetching signal data…</span>
        </div>
      )}

      {/* ── single-cycle empty state ── */}
      {!compareMode && !loading && !signals && !error && (
        <div className="chartEmpty">
          <strong>No data{selectedDevice ? ` for "${displayName(selectedDevice)}"` : ""}{selectedCycle ? " in this cycle" : ""}</strong>
          <span>
            {selectedCycle ? "Select a different cycle above." :
              selectedDevice ? "Try a different device or send data from the ESP32." :
                "Connect an ESP32 and start streaming to see signals here."}
          </span>
        </div>
      )}

      {/* ── charts ── */}
      {showCharts && (
        <div style={{ display: "grid", gap: 24 }}>
          {(tab === "all" || tab === "ecg") && (
            <SignalChart
              values={compareMode ? [] : (signals?.ecg ?? [])}
              series={seriesFor("ecg", "var(--accent)")}
              label="ECG" unit="ADC" color="var(--accent)"
              fs={compareMode ? (multiResults[0]?.fs ?? 20) : (signals?.fs ?? 20)}
              height={190} />
          )}
          {(tab === "all" || tab === "ppg") && (
            <SignalChart
              values={compareMode ? [] : (signals?.ppg ?? [])}
              series={seriesFor("ppg", "var(--accent2)")}
              label="PPG (IR channel)" unit="raw" color="var(--accent2)"
              fs={compareMode ? (multiResults[0]?.fs ?? 20) : (signals?.fs ?? 20)}
              height={165} />
          )}
          {(tab === "all" || tab === "accel") && (
            hasAccel ? (
              <SignalChart
                values={compareMode ? [] : (signals?.accel ?? [])}
                series={seriesFor("accel", "var(--good)")}
                label="Accelerometer Magnitude" unit="m/s²" color="var(--good)"
                fs={compareMode ? (multiResults[0]?.fs ?? 20) : (signals?.fs ?? 20)}
                height={145} />
            ) : tab === "accel" ? (
              <div className="chartEmpty">
                <strong>No accelerometer data</strong>
                <span>No accelerometer data available for this recording.</span>
              </div>
            ) : null
          )}

          <p className="muted" style={{ fontSize: 12 }}>
            {compareMode && isCompareReady
              ? `${aggMode === "overlay" ? "Overlaying" : "Averaging"} ${multiResults.length} cycle${multiResults.length !== 1 ? "s" : ""} · signals trimmed to ${Math.min(...multiResults.map(r => r.ecg.length)).toLocaleString()} samples (shortest cycle). `
              : selectedCycle
              ? `Showing full cycle · ${signals?.batchCount} batches · ${signals?.ecg.length.toLocaleString()} samples. `
              : `Showing last ${signals?.batchCount} batches (≤ 200). `}
            ECG is raw 12-bit ADC (0–4095). PPG IR = MAX30100 photocurrent.
          </p>
        </div>
      )}
    </Card>
  );
}
