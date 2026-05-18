"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AuthGate, UserBadge } from "@/components/AuthGate";
import { Card, SectionHeader } from "@/components/Card";
import { AlertBadge, KpiTile } from "@/components/KpiTile";
import { TelemetryTable } from "@/components/TelemetryTable";
import { TrendChart } from "@/components/TrendChart";
import { classifyBp, summarizeTelemetry } from "@/lib/bp";
import { formatInteger, formatShortTime } from "@/lib/format";
import { useTelemetry } from "@/lib/telemetry";
import type { DashboardMode } from "@/lib/types";

function toneForConnection(state: string): "good" | "warn" | "bad" | "neutral" {
  if (state === "ready") return "good";
  if (state === "loading" || state === "connecting" || state === "subscribing" || state === "closed") return "warn";
  if (state === "error") return "bad";
  return "neutral";
}

export default function LivePage() {
  return (
    <AuthGate title="Sign in for the live BP monitor">
      {(session) => <LiveMonitor sessionId={session.user.id} sessionNode={<UserBadge session={session} />} />}
    </AuthGate>
  );
}

function LiveMonitor({ sessionId, sessionNode }: { sessionId: string; sessionNode: ReactNode }) {
  const [mode, setMode] = useState<DashboardMode>("user");
  const [threshold, setThreshold] = useState(140);
  const { rows, status, telemetryStatus } = useTelemetry({ enabled: true, limit: 80, realtime: true, websocket: true });
  const visibleRows = mode === "user" ? rows.slice(0, 20) : rows;
  const summary = useMemo(() => summarizeTelemetry(rows, threshold), [rows, threshold]);
  const band = classifyBp(summary.latest?.sbp_pred, summary.latest?.dbp_pred);
  const liveTone = summary.count > 0 ? "good" : toneForConnection(telemetryStatus.websocket);
  const liveLabel = summary.count > 0 ? "Receiving windows" : telemetryStatus.message;

  return (
    <div className="pageStack">
      <SectionHeader eyebrow="Live monitor" title="Streaming BP windows">
        {sessionNode}
      </SectionHeader>

      <div className="hero">
        <div className="heroCopy">
          <div>
            <div className="eyebrow">Current inference</div>
            <div className="heroStat" role="status" aria-live="polite">
              {formatInteger(summary.latest?.sbp_pred)}
              <span style={{ opacity: 0.42 }}> / </span>
              {formatInteger(summary.latest?.dbp_pred)}
            </div>
            <p className="muted">
              Latest SBP/DBP estimate from the buffered 8-second telemetry pipeline. Treat values as prototype
              predictions and use repeated windows for trend demonstrations.
            </p>
          </div>
          <div className="heroStrip">
            <AlertBadge tone={band.tone}>{band.label}</AlertBadge>
            <AlertBadge tone={liveTone}>{liveLabel}</AlertBadge>
            <span className="badge">device {summary.latest?.device_id ?? "-"}</span>
            <span className="badge">time {formatShortTime(summary.latest?.created_at)}</span>
            <span className="badge">user {sessionId.slice(0, 8)}...</span>
          </div>
        </div>
        <div className="heroPanel">
          <KpiTile label="Windows loaded" value={summary.count} meta="Supabase history plus live socket inserts" />
          <KpiTile label="SBP alerts" value={summary.highCount} unit="windows" tone={summary.highCount ? "bad" : "good"} />
          <Card>
            <div className="fieldStack">
              <label htmlFor="threshold">SBP alert threshold</label>
              <input
                id="threshold"
                className="input"
                type="number"
                min={80}
                max={220}
                value={threshold}
                onChange={(event) => setThreshold(Number(event.target.value))}
              />
              <p className="muted">Used for dashboard highlighting only; it does not change model predictions.</p>
            </div>
          </Card>
        </div>
      </div>

      <div className="kpiGrid">
        <KpiTile label="Average SBP" value={formatInteger(summary.avgSbp)} unit="mmHg" />
        <KpiTile label="Average DBP" value={formatInteger(summary.avgDbp)} unit="mmHg" />
        <KpiTile label="Active devices" value={summary.deviceCount} meta={status || telemetryStatus.message || band.detail} tone={band.tone} />
      </div>

      <div className="threeCol">
        <KpiTile
          label="Database load"
          value={telemetryStatus.database}
          meta="Supabase telemetry_windows query"
          tone={toneForConnection(telemetryStatus.database)}
        />
        <KpiTile
          label="Realtime channel"
          value={telemetryStatus.realtime}
          meta="Supabase INSERT subscription"
          tone={toneForConnection(telemetryStatus.realtime)}
        />
        <KpiTile
          label="FastAPI socket"
          value={telemetryStatus.websocket}
          meta="ws/dashboard broadcast path"
          tone={toneForConnection(telemetryStatus.websocket)}
        />
      </div>

      <Card>
        <div className="sectionHeader">
          <div>
            <div className="cardTitle">Live trend</div>
            <p className="muted">Recent SBP/DBP estimates, newest windows appended as they arrive.</p>
          </div>
          <span className={`pill tone-${liveTone}`}><span className={`dot dot-${liveTone}`} /> {liveLabel}</span>
        </div>
        <TrendChart rows={rows.slice(0, 40)} threshold={threshold} />
      </Card>

      <Card className="callout">
        <div className="cardTitle">Live hardware checklist</div>
        <div className="threeCol">
          <div className="fieldStack">
            <label>1. FastAPI</label>
            <p className="muted">Run <code>uvicorn bp_api.main:app --host 0.0.0.0 --port 8000 --reload</code>.</p>
          </div>
          <div className="fieldStack">
            <label>2. ESP32 URL</label>
            <p className="muted">Use the laptop LAN IP, not <code>127.0.0.1</code>, with <code>/ws/esp32</code>.</p>
          </div>
          <div className="fieldStack">
            <label>3. First result</label>
            <p className="muted">Expect the first BP window after about 8 seconds of stable ECG/PPG samples.</p>
          </div>
        </div>
      </Card>

      <Card>
        <div className="sectionHeader">
          <div>
            <div className="cardTitle">Recent feed</div>
            <p className="muted">{mode === "user" ? "Curated latest 20 windows." : "Detailed latest 80 windows."}</p>
          </div>
          <span className="seg" aria-label="Dashboard mode">
            <button type="button" className={mode === "user" ? "active" : ""} onClick={() => setMode("user")}>
              User mode
            </button>
            <button type="button" className={mode === "detailed" ? "active" : ""} onClick={() => setMode("detailed")}>
              Detailed
            </button>
          </span>
        </div>
        <TelemetryTable rows={visibleRows} mode={mode} />
      </Card>
    </div>
  );
}
