"use client";

import { useEffect, useState } from "react";
import { Card } from "./Card";
import { SignalChart } from "./SignalChart";
import { useRawBatches, useDeviceList, useCycleList } from "@/lib/rawBatches";
import { formatShortTime } from "@/lib/format";

type TabId = "ecg" | "ppg" | "accel" | "all";

export function SignalViewer({ device: initialDevice }: { device?: string }) {
  const [tab, setTab] = useState<TabId>("all");
  const [selectedDevice, setSelectedDevice] = useState(initialDevice ?? "");
  const [selectedCycle, setSelectedCycle] = useState(""); // "" = latest / all cycles

  // Keep selection in sync with parent hint on first load
  useEffect(() => {
    if (initialDevice && !selectedDevice) setSelectedDevice(initialDevice);
  }, [initialDevice]); // eslint-disable-line react-hooks/exhaustive-deps

  const { devices, loading: devicesLoading, reload: reloadDevices } = useDeviceList();
  const { cycles, loading: cyclesLoading, reload: reloadCycles } = useCycleList(selectedDevice);
  const { signals, loading, error, reload } = useRawBatches({
    device: selectedDevice,
    cycleId: selectedCycle,
    maxBatches: 200,
  });

  const hasAccel = (signals?.accel.length ?? 0) > 0;

  // Auto-select first device if none chosen
  useEffect(() => {
    if (!selectedDevice && devices.length > 0) {
      setSelectedDevice(
        initialDevice && devices.includes(initialDevice) ? initialDevice : devices[0]
      );
    }
  }, [devices]); // eslint-disable-line react-hooks/exhaustive-deps

  // When device changes, reset cycle selection
  const changeDevice = (d: string) => {
    setSelectedDevice(d);
    setSelectedCycle("");
  };

  // When cycles load, auto-select the latest one (index 0)
  useEffect(() => {
    if (cycles.length > 0 && !selectedCycle) {
      setSelectedCycle(cycles[0].cycle_id);
    }
  }, [cycles]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => { reload(); reloadDevices(); reloadCycles(); };

  return (
    <Card>
      {/* ── title row ── */}
      <div className="sectionHeader" style={{ marginBottom: 14 }}>
        <div>
          <div className="cardTitle">Signal Viewer</div>
          <p className="muted">
            {signals
              ? `${signals.batchCount} batch${signals.batchCount !== 1 ? "es" : ""} · ${signals.ecg.length.toLocaleString()} samples · ${signals.durationS.toFixed(1)} s · last updated ${formatShortTime(signals.latestTs)}`
              : "Raw ECG, PPG and accelerometer waveforms from esp32_raw_batches"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="seg" aria-label="Signal tab">
            {(["all", "ecg", "ppg", "accel"] as TabId[]).map((t) => (
              <button key={t} type="button"
                className={tab === t ? "active" : ""}
                onClick={() => setTab(t)}>
                {t === "all" ? "All" : t === "ecg" ? "ECG" : t === "ppg" ? "PPG IR" : "Accel"}
              </button>
            ))}
          </span>
          <button className="btn btnTiny" type="button"
            onClick={handleRefresh} disabled={loading}>
            {loading ? "Loading…" : "↺ Refresh"}
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
            <button type="button"
              className={`devicePill${selectedDevice === "" ? " active" : ""}`}
              onClick={() => changeDevice("")}>
              All
            </button>
            {devices.map((d) => (
              <button key={d} type="button"
                className={`devicePill${selectedDevice === d ? " active" : ""}`}
                onClick={() => changeDevice(d)} title={d}>
                <span className="devicePillDot" />
                {d}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── cycle filter (only when a specific device is selected) ── */}
      {selectedDevice && (
        <div className="deviceFilterBar" style={{ marginBottom: 14 }}>
          <span className="toolbarLabel" style={{ whiteSpace: "nowrap" }}>Cycle</span>

          {cyclesLoading && cycles.length === 0 ? (
            <span className="signalChartMeta">Loading cycles…</span>
          ) : cycles.length === 0 ? (
            <span className="signalChartMeta" style={{ color: "var(--faint)" }}>
              No cycles yet for this device
            </span>
          ) : (
            <div className="devicePillRow" style={{ overflowX: "auto", flexWrap: "nowrap", paddingBottom: 2 }}>
              {/* "Latest" = no cycle filter — shows last maxBatches across all cycles */}
              <button type="button"
                className={`devicePill${selectedCycle === "" ? " active" : ""}`}
                onClick={() => setSelectedCycle("")}>
                Latest
              </button>
              {cycles.map((c) => (
                <button key={c.cycle_id} type="button"
                  className={`devicePill cyclePill${selectedCycle === c.cycle_id ? " active" : ""}`}
                  onClick={() => setSelectedCycle(c.cycle_id)}
                  title={`cycle_id: ${c.cycle_id}\n${c.batch_count} batches`}>
                  <span className="devicePillDot" style={{
                    background: selectedCycle === c.cycle_id ? "var(--paper)" : "var(--accent2)"
                  }} />
                  {c.label}
                </button>
              ))}
            </div>
          )}

          {selectedCycle && (
            <span className="signalChartMeta" style={{ marginLeft: "auto", whiteSpace: "nowrap", fontSize: 11 }}>
              {cycles.find(c => c.cycle_id === selectedCycle)?.batch_count ?? "?"} batches
            </span>
          )}
        </div>
      )}

      {/* ── error ── */}
      {error && (
        <p style={{ color: "var(--bad)", marginBottom: 14, fontSize: 13 }}>⚠ {error}</p>
      )}

      {/* ── loading skeleton ── */}
      {loading && !signals && (
        <div className="chartEmpty">
          <strong>Loading signals…</strong>
          <span>Fetching raw batches from database</span>
        </div>
      )}

      {/* ── empty state ── */}
      {!loading && !signals && !error && (
        <div className="chartEmpty">
          <strong>
            No data
            {selectedDevice ? ` for "${selectedDevice}"` : ""}
            {selectedCycle ? " in this cycle" : ""}
          </strong>
          <span>
            {selectedCycle
              ? "Select a different cycle above."
              : selectedDevice
              ? "Try selecting a different device, or send data from the ESP32."
              : <>Send data from the ESP32 — each POST saves one batch to <code>esp32_raw_batches</code></>}
          </span>
        </div>
      )}

      {/* ── charts ── */}
      {signals && (
        <div style={{ display: "grid", gap: 24 }}>
          {(tab === "all" || tab === "ecg") && (
            <SignalChart
              values={signals.ecg} label="ECG" unit="ADC"
              color="var(--accent)" fs={signals.fs} height={190} />
          )}
          {(tab === "all" || tab === "ppg") && (
            <SignalChart
              values={signals.ppg} label="PPG (IR channel)" unit="raw"
              color="var(--accent2)" fs={signals.fs} height={165} />
          )}
          {(tab === "all" || tab === "accel") && (
            hasAccel ? (
              <SignalChart
                values={signals.accel} label="Accelerometer Magnitude" unit="m/s²"
                color="var(--good)" fs={signals.fs} height={145} />
            ) : tab === "accel" ? (
              <div className="chartEmpty">
                <strong>No accelerometer data</strong>
                <span>ax / ay / az columns are empty in the stored batches</span>
              </div>
            ) : null
          )}
          <p className="muted" style={{ fontSize: 12 }}>
            {selectedCycle
              ? `Showing full cycle · ${signals.batchCount} batch${signals.batchCount !== 1 ? "es" : ""} · ${signals.ecg.length.toLocaleString()} samples. `
              : `Showing last ${signals.batchCount} batches (≤ 200)${selectedDevice ? ` for "${selectedDevice}"` : " across all devices"}. `}
            ECG values are raw 12-bit ADC counts (0–4095). PPG IR reflects photocurrent from MAX30100.
          </p>
        </div>
      )}
    </Card>
  );
}
