"use client";

import Link from "next/link";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { AuthGate, UserBadge } from "@/components/AuthGate";
import { Card, SectionHeader } from "@/components/Card";
import { KpiTile } from "@/components/KpiTile";
import { TelemetryEmptyState } from "@/components/TelemetryEmptyState";
import { formatInteger, formatTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useTelemetry } from "@/lib/telemetry";
import { useDeviceLabels } from "@/lib/deviceLabels";

export default function DevicesPage() {
  const { t } = useI18n();
  return (
    <AuthGate title={t("devices.authTitle")}>
      {(session) => <DevicesView userId={session.user.id} sessionNode={<UserBadge session={session} />} />}
    </AuthGate>
  );
}

// ─── inline rename row ────────────────────────────────────────────────────────

function DeviceRow({
  deviceId,
  stats,
  label,
  onSave,
  saving,
}: {
  deviceId: string;
  stats: { count: number; lastSeen: string; avgSbp: number | null; avgDbp: number | null };
  label: string | undefined;
  onSave: (deviceId: string, name: string) => Promise<void>;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setDraft(label ?? "");
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 30);
  };

  const cancel = () => { setDraft(label ?? ""); setEditing(false); };

  const save = async () => {
    await onSave(deviceId, draft);
    setEditing(false);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") cancel();
  };

  return (
    <tr>
      {/* device id + label */}
      <td>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {editing ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                ref={inputRef}
                className="input"
                style={{ padding: "5px 9px", fontSize: 13, borderRadius: 10, width: 180 }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Device name…"
                autoFocus
              />
              <button className="btn btnTiny btnPrimary" type="button"
                onClick={save} disabled={saving}>
                {saving ? "…" : "Save"}
              </button>
              <button className="btn btnTiny" type="button" onClick={cancel}>
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: label ? 700 : 400 }}>
                {label ?? <span style={{ color: "var(--faint)", fontStyle: "italic" }}>Unnamed</span>}
              </span>
              <button className="btn btnTiny" type="button" onClick={startEdit}
                title="Rename device" style={{ opacity: 0.7, fontSize: 11 }}>
                ✎ Rename
              </button>
            </div>
          )}
          <span style={{ fontSize: 11, color: "var(--faint)", fontFamily: "Cascadia Code, Consolas, monospace" }}>
            {deviceId}
          </span>
        </div>
      </td>
      <td className="num">{stats.count}</td>
      <td className="nowrap">{formatTime(stats.lastSeen)}</td>
      <td className="num">{formatInteger(stats.avgSbp)}</td>
      <td className="num">{formatInteger(stats.avgDbp)}</td>
      <td>
        <Link href={`/history?device=${encodeURIComponent(deviceId)}`} className="badge">
          View trends
        </Link>
      </td>
    </tr>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

function DevicesView({ userId, sessionNode }: { userId: string; sessionNode: ReactNode }) {
  const { t } = useI18n();
  const { rows, status } = useTelemetry({ enabled: true, limit: 500 });
  const { labels, saving, saveLabel } = useDeviceLabels();

  const devices = useMemo(() => {
    const map = new Map<string, { count: number; lastSeen: string; avgSbp: number | null; avgDbp: number | null }>();
    for (const row of rows) {
      const key = row.device_id || "unknown";
      const cur = map.get(key) ?? { count: 0, lastSeen: row.created_at, avgSbp: null, avgDbp: null };
      const count = cur.count + 1;
      map.set(key, {
        count,
        lastSeen: row.created_at > cur.lastSeen ? row.created_at : cur.lastSeen,
        avgSbp: row.sbp_pred == null ? cur.avgSbp : ((cur.avgSbp ?? 0) * cur.count + row.sbp_pred) / count,
        avgDbp: row.dbp_pred == null ? cur.avgDbp : ((cur.avgDbp ?? 0) * cur.count + row.dbp_pred) / count,
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
        <div className="sectionHeader" style={{ marginBottom: 14 }}>
          <div>
            <div className="cardTitle">{t("devices.registry")}</div>
            <p className="muted">Click <strong>✎ Rename</strong> next to any device to give it a friendly name.</p>
          </div>
        </div>
        {devices.length === 0 ? (
          <TelemetryEmptyState />
        ) : (
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>{t("devices.windows")}</th>
                  <th>{t("devices.lastSeen")}</th>
                  <th>{t("devices.meanSbp")}</th>
                  <th>{t("devices.meanDbp")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {devices.map(([deviceId, stats]) => (
                  <DeviceRow
                    key={deviceId}
                    deviceId={deviceId}
                    stats={stats}
                    label={labels[deviceId]}
                    onSave={saveLabel}
                    saving={saving}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
