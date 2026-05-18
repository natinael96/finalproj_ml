"use client";

import { useMemo } from "react";
import type { ReactNode } from "react";
import { AuthGate, UserBadge } from "@/components/AuthGate";
import { Card, SectionHeader } from "@/components/Card";
import { KpiTile } from "@/components/KpiTile";
import { formatInteger, formatTime } from "@/lib/format";
import { useTelemetry } from "@/lib/telemetry";

export default function DevicesPage() {
  return (
    <AuthGate title="Sign in to inspect devices and sessions">
      {(session) => <DevicesView userId={session.user.id} sessionNode={<UserBadge session={session} />} />}
    </AuthGate>
  );
}

function DevicesView({ userId, sessionNode }: { userId: string; sessionNode: ReactNode }) {
  const { rows, status } = useTelemetry({ enabled: true, limit: 500 });
  const devices = useMemo(() => {
    const map = new Map<string, { count: number; lastSeen: string; avgSbp: number | null; avgDbp: number | null }>();
    for (const row of rows) {
      const key = row.device_id || "unknown";
      const current = map.get(key) ?? { count: 0, lastSeen: row.created_at, avgSbp: null, avgDbp: null };
      const count = current.count + 1;
      map.set(key, {
        count,
        lastSeen: row.created_at > current.lastSeen ? row.created_at : current.lastSeen,
        avgSbp: row.sbp_pred == null ? current.avgSbp : ((current.avgSbp ?? 0) * current.count + row.sbp_pred) / count,
        avgDbp: row.dbp_pred == null ? current.avgDbp : ((current.avgDbp ?? 0) * current.count + row.dbp_pred) / count
      });
    }
    return Array.from(map.entries()).sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen));
  }, [rows]);

  return (
    <div className="pageStack">
      <SectionHeader eyebrow="Operations" title="Devices and sessions">
        {sessionNode}
      </SectionHeader>

      <div className="threeCol">
        <KpiTile label="Known devices" value={devices.length} meta={status || "From telemetry_windows"} />
        <KpiTile label="Total windows" value={rows.length} />
        <KpiTile label="Current user" value={userId.slice(0, 8)} meta="Use this id in ingest query params" />
      </div>

      <Card className="callout">
        <div className="cardTitle">Live setup command pattern</div>
        <p className="muted">
          For replay or ESP32 ingestion, the backend needs the same <code>user_id</code> as the dashboard user so
          Supabase RLS can show rows here.
        </p>
        <pre className="preBlock">
{`ws://<PC_LAN_IP>:8000/ws/esp32?device_id=esp32-01&fs_hz=100&window_s=8&user_id=${userId}`}
        </pre>
      </Card>

      <Card>
        <div className="cardTitle">Device registry from telemetry</div>
        {devices.length === 0 ? (
          <div className="emptyState">
            <strong>No devices observed.</strong>
            <span>Stream at least one telemetry window to populate this operational view.</span>
          </div>
        ) : (
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>device</th>
                  <th>windows</th>
                  <th>last seen</th>
                  <th>mean SBP</th>
                  <th>mean DBP</th>
                </tr>
              </thead>
              <tbody>
                {devices.map(([device, stats]) => (
                  <tr key={device}>
                    <td>{device}</td>
                    <td className="num">{stats.count}</td>
                    <td className="nowrap">{formatTime(stats.lastSeen)}</td>
                    <td className="num">{formatInteger(stats.avgSbp)}</td>
                    <td className="num">{formatInteger(stats.avgDbp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
