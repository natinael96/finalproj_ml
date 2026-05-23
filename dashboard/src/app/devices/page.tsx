"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { AuthGate, UserBadge } from "@/components/AuthGate";
import { Card, SectionHeader } from "@/components/Card";
import { KpiTile } from "@/components/KpiTile";
import { TelemetryEmptyState } from "@/components/TelemetryEmptyState";
import { formatInteger, formatTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useTelemetry } from "@/lib/telemetry";

export default function DevicesPage() {
  const { t } = useI18n();
  return (
    <AuthGate title={t("devices.authTitle")}>
      {(session) => <DevicesView userId={session.user.id} sessionNode={<UserBadge session={session} />} />}
    </AuthGate>
  );
}

function DevicesView({ userId, sessionNode }: { userId: string; sessionNode: ReactNode }) {
  const { t } = useI18n();
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
      <SectionHeader eyebrow={t("devices.eyebrow")} title={t("devices.title")}>
        {sessionNode}
      </SectionHeader>

      <div className="threeCol">
        <KpiTile label={t("devices.knownDevices")} value={devices.length} meta={status || t("devices.fromTelemetry")} />
        <KpiTile label={t("devices.totalWindows")} value={rows.length} />
        <KpiTile label={t("devices.currentUser")} value={userId.slice(0, 8)} meta={t("devices.userMeta")} />
      </div>

      <Card className="callout">
        <div className="cardTitle">{t("devices.setupPattern")}</div>
        <p className="muted">{t("devices.setupBody")}</p>
        <pre className="preBlock">
{`ws://<PC_LAN_IP>:8000/ws/esp32?device_id=esp32-01&fs_hz=100&window_s=8&user_id=${userId}`}
        </pre>
      </Card>

      <Card>
        <div className="cardTitle">{t("devices.registry")}</div>
        {devices.length === 0 ? (
          <TelemetryEmptyState />
        ) : (
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>{t("table.device")}</th>
                  <th>{t("devices.windows")}</th>
                  <th>{t("devices.lastSeen")}</th>
                  <th>{t("devices.meanSbp")}</th>
                  <th>{t("devices.meanDbp")}</th>
                  <th>{t("history.sessionTrend")}</th>
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
                    <td>
                      <Link href={`/history?device=${encodeURIComponent(device)}`} className="badge">
                        {t("devices.viewTrends")}
                      </Link>
                    </td>
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
