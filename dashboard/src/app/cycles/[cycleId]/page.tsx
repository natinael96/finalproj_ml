"use client";

import Link from "next/link";
import { use, useMemo, useState } from "react";
import { AuthGate, UserBadge } from "@/components/AuthGate";
import { Card } from "@/components/Card";
import { SignalChart } from "@/components/SignalChart";
import { useDeviceLabels } from "@/lib/deviceLabels";
import { useCycleLabels } from "@/lib/cycleLabels";
import { useRawBatches } from "@/lib/rawBatches";
import { useTelemetry } from "@/lib/telemetry";
import type { MergedSignals } from "@/lib/rawBatches";

type ViewMode = "charts" | "table";

// ─── page shell ──────────────────────────────────────────────────────────────

export default function CyclePage({
  params,
  searchParams,
}: {
  params: Promise<{ cycleId: string }>;
  searchParams: Promise<{ device?: string }>;
}) {
  const { cycleId } = use(params);
  const { device = "" } = use(searchParams);

  return (
    <AuthGate title="Cycle Signals">
      {(session) => (
        <CycleView
          cycleId={cycleId}
          device={device}
          sessionNode={<UserBadge session={session} />}
        />
      )}
    </AuthGate>
  );
}

// ─── sample table ─────────────────────────────────────────────────────────────

const GMT3_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  fractionalSecondDigits: 1,
  hour12: false,
});

function SampleTable({ signals, fs, startMs }: { signals: MergedSignals; fs: number; startMs?: number }) {
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 100;

  const rows = useMemo(() => {
    const n = signals.ecg.length;
    const msPerSample = 1000 / fs;
    return Array.from({ length: n }, (_, i) => {
      const offsetMs = i * msPerSample;
      const tLabel = startMs != null
        ? GMT3_FMT.format(new Date(startMs + offsetMs))
        : `+${offsetMs.toFixed(1)} ms`;
      return {
        i,
        tLabel,
        ecg: signals.ecg[i]?.toFixed(2) ?? "—",
        ppg: signals.ppg[i]?.toFixed(2) ?? "—",
        accel: signals.accel[i]?.toFixed(4) ?? "—",
      };
    });
  }, [signals, fs, startMs]);

  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      {/* Pagination */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 0 12px", fontSize: 13, color: "var(--muted)",
      }}>
        <span>{rows.length} samples · page {page + 1} / {totalPages}</span>
        <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
          <button className="btn btnTiny" type="button"
            disabled={page === 0} onClick={() => setPage(0)}>«</button>
          <button className="btn btnTiny" type="button"
            disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹</button>
          <button className="btn btnTiny" type="button"
            disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>›</button>
          <button className="btn btnTiny" type="button"
            disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>»</button>
        </div>
      </div>

      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "right" }}>#</th>
              <th style={{ textAlign: "right" }}>Time (GMT+3)</th>
              <th style={{ textAlign: "right" }}>ECG (ADC)</th>
              <th style={{ textAlign: "right" }}>PPG IR (ADC)</th>
              <th style={{ textAlign: "right" }}>Accel |a| (m/s²)</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => (
              <tr key={r.i}>
                <td className="num" style={{ color: "var(--faint)", fontSize: 11 }}>{r.i}</td>
                <td className="num" style={{ color: "var(--muted)", fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 12 }}>{r.tLabel}</td>
                <td className="num">{r.ecg}</td>
                <td className="num">{r.ppg}</td>
                <td className="num">{r.accel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── view ─────────────────────────────────────────────────────────────────────

function CycleView({
  cycleId,
  device,
  sessionNode,
}: {
  cycleId: string;
  device: string;
  sessionNode: React.ReactNode;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("charts");

  const { displayName: deviceDisplayName } = useDeviceLabels();
  const { customLabel } = useCycleLabels();
  const { rows: telemetry } = useTelemetry({ enabled: true, limit: 500 });

  const { signals, loading, error } = useRawBatches({
    device,
    cycleId,
    maxBatches: 200,
  });

  // Match this cycle to its closest prediction
  const pred = useMemo(() => {
    if (!signals?.latestTs) return null;
    const cycleTs = new Date(signals.latestTs).getTime() - (signals.durationS ?? 0) * 1000;
    const devRows = telemetry.filter((r) => r.device_id === device);
    return devRows.reduce<typeof telemetry[0] | null>((best, r) => {
      if (r.ts_ms_start == null) return best;
      const diff = Math.abs(r.ts_ms_start - cycleTs);
      if (diff > 180_000) return best;
      if (!best || diff < Math.abs((best.ts_ms_start ?? 0) - cycleTs)) return r;
      return best;
    }, null);
  }, [telemetry, signals, device]);

  const deviceName = device ? deviceDisplayName(device) : "Unknown device";
  const cycleName = customLabel(cycleId) ?? "Cycle";
  const fs = signals?.fs ?? 20;
  const hasData = !loading && !error && signals && signals.ecg.length > 0;

  // Start timestamp for GMT+3 axis labels (epoch-ms of sample 0)
  const cycleStartMs = useMemo(() => {
    if (!signals?.latestTs) return undefined;
    return new Date(signals.latestTs).getTime() - signals.durationS * 1000;
  }, [signals]);

  return (
    <div className="pageStack">
      {/* ── header ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Link href="/devices" className="btn btnTiny" style={{ fontSize: 12 }}>
              ← Devices
            </Link>
            <span style={{ color: "var(--faint)", fontSize: 13 }}>{deviceName}</span>
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{cycleName}</h1>
          <span style={{ fontSize: 12, color: "var(--faint)", fontFamily: "Cascadia Code, Consolas, monospace" }}>
            {cycleId}
          </span>
        </div>
        {sessionNode}
      </div>

      {/* ── meta strip + view toggle ── */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        {signals && (
          <>
            <span className="pill" style={{ fontSize: 12 }}>
              {signals.batchCount} batch{signals.batchCount !== 1 ? "es" : ""}
            </span>
            <span className="pill" style={{ fontSize: 12 }}>{signals.durationS.toFixed(1)} s</span>
            <span className="pill" style={{ fontSize: 12 }}>{fs} Hz</span>
            {signals.ecg.length > 0 && (
              <span className="pill" style={{ fontSize: 12 }}>{signals.ecg.length} samples</span>
            )}
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              {signals.latestTs
                ? new Date(signals.latestTs).toLocaleString([], {
                    month: "short", day: "numeric",
                    hour: "2-digit", minute: "2-digit", second: "2-digit",
                  })
                : ""}
            </span>
          </>
        )}
        {pred && (
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            BP&nbsp;
            <strong style={{ color: "var(--accent)" }}>{pred.sbp_pred?.toFixed(0)}</strong>
            <span style={{ color: "var(--faint)", margin: "0 4px" }}>/</span>
            <span>{pred.dbp_pred?.toFixed(0)}</span>
            <span style={{ color: "var(--faint)", marginLeft: 4, fontWeight: 400, fontSize: 12 }}>mmHg</span>
          </span>
        )}

        {/* View mode toggle — pushed to the right */}
        {hasData && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <button
              className={`btn btnTiny${viewMode === "charts" ? " btnPrimary" : ""}`}
              type="button"
              onClick={() => setViewMode("charts")}>
              ▦ Charts
            </button>
            <button
              className={`btn btnTiny${viewMode === "table" ? " btnPrimary" : ""}`}
              type="button"
              onClick={() => setViewMode("table")}>
              ☰ Table
            </button>
          </div>
        )}
      </div>

      {/* ── loading / error ── */}
      {loading && (
        <Card>
          <p className="muted" style={{ padding: "20px 0", textAlign: "center" }}>Loading signals…</p>
        </Card>
      )}
      {error && (
        <Card>
          <p style={{ color: "var(--danger, red)", padding: "12px 0" }}>{error}</p>
        </Card>
      )}

      {/* ── charts view ── */}
      {hasData && viewMode === "charts" && (
        <>
          <Card>
            <div className="cardTitle" style={{ marginBottom: 8 }}>ECG</div>
            <SignalChart label="ECG" values={signals.ecg} fs={fs} unit="ADC" color="var(--accent)" startMs={cycleStartMs} />
          </Card>
          <Card>
            <div className="cardTitle" style={{ marginBottom: 8 }}>PPG (IR)</div>
            <SignalChart label="PPG" values={signals.ppg} fs={fs} unit="ADC" color="var(--accent2)" startMs={cycleStartMs} />
          </Card>
          <Card>
            <div className="cardTitle" style={{ marginBottom: 8 }}>Accelerometer</div>
            <SignalChart label="Accel" values={signals.accel} fs={fs} unit="m/s²" color="var(--good)" startMs={cycleStartMs} />
          </Card>
        </>
      )}

      {/* ── table view ── */}
      {hasData && viewMode === "table" && (
        <Card>
          <div className="cardTitle" style={{ marginBottom: 4 }}>Raw Samples</div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
            Time is relative to the start of the cycle. Showing {signals.ecg.length} samples at {fs} Hz.
          </p>
          <SampleTable signals={signals} fs={fs} startMs={cycleStartMs} />
        </Card>
      )}

      {/* ── empty state ── */}
      {!loading && !error && (!signals || signals.ecg.length === 0) && (
        <Card>
          <p className="muted" style={{ padding: "20px 0", textAlign: "center" }}>
            No signal data found for this cycle.
          </p>
        </Card>
      )}
    </div>
  );
}
