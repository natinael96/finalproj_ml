"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AuthGate, UserBadge } from "@/components/AuthGate";
import { Card, SectionHeader } from "@/components/Card";
import { KpiTile } from "@/components/KpiTile";
import { TelemetryTable } from "@/components/TelemetryTable";
import { TrendChart } from "@/components/TrendChart";
import { summarizeTelemetry } from "@/lib/bp";
import { downloadCsv, telemetryToCsv } from "@/lib/csv";
import { formatInteger, pluralize } from "@/lib/format";
import { useTelemetry } from "@/lib/telemetry";
import type { DashboardMode } from "@/lib/types";

export default function HistoryPage() {
  return (
    <AuthGate title="Sign in to review historical windows">
      {(session) => <HistoryView sessionNode={<UserBadge session={session} />} />}
    </AuthGate>
  );
}

function HistoryView({ sessionNode }: { sessionNode: ReactNode }) {
  const [device, setDevice] = useState("");
  const [mode, setMode] = useState<DashboardMode>("user");
  const [threshold, setThreshold] = useState(140);
  const { rows, status, devices } = useTelemetry({ enabled: true, device, limit: 500 });
  const visibleRows = mode === "user" ? rows.slice(0, 100) : rows;
  const summary = useMemo(() => summarizeTelemetry(rows, threshold), [rows, threshold]);

  return (
    <div className="pageStack">
      <SectionHeader eyebrow="Historical analytics" title="Telemetry history">
        {sessionNode}
      </SectionHeader>

      <div className="fourCol">
        <KpiTile label="Loaded windows" value={summary.count} meta={status || pluralize(summary.deviceCount, "device")} />
        <KpiTile label="Mean SBP" value={formatInteger(summary.avgSbp)} unit="mmHg" />
        <KpiTile label="Mean DBP" value={formatInteger(summary.avgDbp)} unit="mmHg" />
        <KpiTile label="SBP threshold hits" value={summary.highCount} tone={summary.highCount ? "bad" : "good"} />
      </div>

      <Card>
        <div className="sectionHeader">
          <div>
            <div className="cardTitle">Filters and export</div>
            <p className="muted">Use this page during the demo to show that predictions are stored and auditable.</p>
          </div>
          <div className="rowActions">
            <button
              className="btn"
              type="button"
              onClick={() => downloadCsv("telemetry_windows.csv", telemetryToCsv(visibleRows))}
              disabled={visibleRows.length === 0}
            >
              Export CSV
            </button>
            <span className="seg" aria-label="Dashboard mode">
              <button type="button" className={mode === "user" ? "active" : ""} onClick={() => setMode("user")}>
                User mode
              </button>
              <button type="button" className={mode === "detailed" ? "active" : ""} onClick={() => setMode("detailed")}>
                Detailed
              </button>
            </span>
          </div>
        </div>
        <div className="threeCol">
          <div className="fieldStack">
            <label htmlFor="device">Device filter</label>
            <select id="device" value={device} onChange={(event) => setDevice(event.target.value)}>
              <option value="">All devices</option>
              {devices.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
          <div className="fieldStack">
            <label htmlFor="threshold">SBP threshold</label>
            <input
              id="threshold"
              type="number"
              className="input"
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
            />
          </div>
          <div className="fieldStack">
            <label>Current view</label>
            <span className="badge">{mode === "user" ? "Last 100 windows" : "Last 500 windows"}</span>
          </div>
        </div>
      </Card>

      <Card>
        <div className="cardTitle">Trend analytics</div>
        <TrendChart rows={visibleRows} threshold={threshold} />
      </Card>

      <Card>
        <div className="cardTitle">Stored telemetry windows</div>
        <TelemetryTable rows={visibleRows} mode={mode} />
      </Card>
    </div>
  );
}

