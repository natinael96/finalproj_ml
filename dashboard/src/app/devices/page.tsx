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
import { useCycleLabels } from "@/lib/cycleLabels";
import { useCycleList } from "@/lib/rawBatches";
import type { TelemetryWindow } from "@/lib/types";

export default function DevicesPage() {
  const { t } = useI18n();
  return (
    <AuthGate title={t("devices.authTitle")}>
      {(session) => <DevicesView userId={session.user.id} sessionNode={<UserBadge session={session} />} />}
    </AuthGate>
  );
}

// ─── cycle row ────────────────────────────────────────────────────────────────

function CycleRow({
  cycleId,
  autoName,
  tsMs,
  batchCount,
  sbp,
  dbp,
  customLabel,
  onSave,
  saving,
}: {
  cycleId: string;
  autoName: string;
  tsMs: number;
  batchCount: number;
  sbp: number | null;
  dbp: number | null;
  customLabel: string | undefined;
  onSave: (id: string, label: string) => Promise<void>;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(customLabel ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => { setDraft(customLabel ?? ""); setEditing(true); setTimeout(() => inputRef.current?.select(), 20); };
  const cancel = () => setEditing(false);
  const save = async () => { await onSave(cycleId, draft); setEditing(false); };

  const displayName = customLabel || autoName;
  const d = new Date(tsMs);
  const timeStr = d.toLocaleString([], {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr auto auto auto",
      alignItems: "center",
      gap: "8px 16px",
      padding: "9px 14px",
      borderTop: "1px solid var(--border, rgba(0,0,0,0.07))",
      fontSize: 13,
    }}>
      {/* Name + rename */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {editing ? (
          <>
            <input
              ref={inputRef}
              className="input"
              style={{ padding: "4px 8px", fontSize: 12, borderRadius: 8, width: 160 }}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }}
              placeholder={autoName}
              autoFocus
            />
            <button className="btn btnTiny btnPrimary" type="button" disabled={saving}
              onClick={save}>{saving ? "…" : "Save"}</button>
            <button className="btn btnTiny" type="button" onClick={cancel}>✕</button>
          </>
        ) : (
          <>
            <span style={{ fontWeight: customLabel ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {displayName}
            </span>
            <button type="button" title="Rename cycle"
              style={{ background: "none", border: "none", cursor: "pointer", padding: "1px 3px", fontSize: 11, opacity: 0.45, color: "var(--ink)", flexShrink: 0 }}
              onClick={startEdit}>✎</button>
          </>
        )}
      </div>

      {/* Time */}
      <span style={{ color: "var(--muted)", whiteSpace: "nowrap", fontSize: 12 }}>{timeStr}</span>

      {/* SBP/DBP */}
      <span style={{ whiteSpace: "nowrap", textAlign: "right", minWidth: 80 }}>
        {sbp != null && dbp != null ? (
          <>
            <strong>{sbp.toFixed(0)}</strong>
            <span style={{ color: "var(--faint)", margin: "0 3px" }}>/</span>
            <span>{dbp.toFixed(0)}</span>
            <span style={{ color: "var(--faint)", marginLeft: 3, fontSize: 11 }}>mmHg</span>
          </>
        ) : (
          <span style={{ color: "var(--faint)" }}>—</span>
        )}
      </span>

      {/* Batch count badge */}
      <span style={{ color: "var(--faint)", fontSize: 11, whiteSpace: "nowrap" }}>
        {batchCount} batch{batchCount !== 1 ? "es" : ""}
      </span>
    </div>
  );
}

// ─── device card ──────────────────────────────────────────────────────────────

function DeviceCard({
  deviceId,
  stats,
  deviceLabel,
  telemetryRows,
  onRenameDevice,
  deviceSaving,
}: {
  deviceId: string;
  stats: { count: number; lastSeen: string; avgSbp: number | null; avgDbp: number | null };
  deviceLabel: string | undefined;
  telemetryRows: TelemetryWindow[];
  onRenameDevice: (id: string, name: string) => Promise<void>;
  deviceSaving: boolean;
}) {
  const [editingDevice, setEditingDevice] = useState(false);
  const [deviceDraft, setDeviceDraft] = useState(deviceLabel ?? "");
  const deviceInputRef = useRef<HTMLInputElement>(null);

  const { cycles, loading: cyclesLoading } = useCycleList(deviceId);
  const { customLabel, saveLabel: saveCycleLabel, saving: cycleSaving } = useCycleLabels();

  // Match each cycle to its closest telemetry prediction (within 3 min)
  const cyclesWithPred = useMemo(() => {
    const devRows = telemetryRows.filter((r) => r.device_id === deviceId);
    return cycles.map((c, i) => {
      const match = devRows.reduce<TelemetryWindow | null>((best, r) => {
        if (r.ts_ms_start == null) return best;
        const diff = Math.abs(r.ts_ms_start - c.ts_ms_start);
        if (diff > 180_000) return best;
        if (!best || diff < Math.abs((best.ts_ms_start ?? 0) - c.ts_ms_start)) return r;
        return best;
      }, null);
      return {
        ...c,
        autoName: `Cycle ${cycles.length - i}`,
        sbp: match?.sbp_pred ?? null,
        dbp: match?.dbp_pred ?? null,
      };
    });
  }, [cycles, telemetryRows, deviceId]);

  const startEditDevice = () => {
    setDeviceDraft(deviceLabel ?? "");
    setEditingDevice(true);
    setTimeout(() => deviceInputRef.current?.select(), 20);
  };
  const cancelDevice = () => setEditingDevice(false);
  const saveDevice = async () => { await onRenameDevice(deviceId, deviceDraft); setEditingDevice(false); };

  return (
    <Card>
      {/* Device header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 18px", gap: 12, flexWrap: "wrap",
        borderBottom: "1px solid var(--border, rgba(0,0,0,0.08))",
      }}>
        {/* Name + device_id */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          {editingDevice ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                ref={deviceInputRef}
                className="input"
                style={{ padding: "5px 10px", fontSize: 14, borderRadius: 10, width: 200 }}
                value={deviceDraft}
                onChange={(e) => setDeviceDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveDevice(); if (e.key === "Escape") cancelDevice(); }}
                placeholder="Device name…"
                autoFocus
              />
              <button className="btn btnTiny btnPrimary" type="button" disabled={deviceSaving}
                onClick={saveDevice}>{deviceSaving ? "…" : "Save"}</button>
              <button className="btn btnTiny" type="button" onClick={cancelDevice}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: deviceLabel ? 700 : 400, fontSize: 15 }}>
                {deviceLabel ?? <span style={{ color: "var(--faint)", fontStyle: "italic", fontWeight: 400 }}>Unnamed device</span>}
              </span>
              <button className="btn btnTiny" type="button" onClick={startEditDevice}
                style={{ fontSize: 11, opacity: 0.7 }}>✎ Rename</button>
            </div>
          )}
          <span style={{ fontSize: 11, color: "var(--faint)", fontFamily: "Cascadia Code, Consolas, monospace" }}>
            {deviceId}
          </span>
        </div>

        {/* Stats chips */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className="pill" style={{ fontSize: 12 }}>
            {stats.count} window{stats.count !== 1 ? "s" : ""}
          </span>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            Last: {formatTime(stats.lastSeen)}
          </span>
          {stats.avgSbp != null && (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              Avg&nbsp;<strong>{formatInteger(stats.avgSbp)}</strong>&nbsp;/&nbsp;{formatInteger(stats.avgDbp)}&nbsp;mmHg
            </span>
          )}
          <Link href={`/history?device=${encodeURIComponent(deviceId)}`} className="badge"
            style={{ fontSize: 11 }}>
            View trends →
          </Link>
        </div>
      </div>

      {/* Cycles section */}
      <div>
        {/* Column headers */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr auto auto auto",
          gap: "4px 16px",
          padding: "6px 14px",
          background: "rgba(0,0,0,0.03)",
          fontSize: 11, fontWeight: 600, color: "var(--muted)",
          textTransform: "uppercase", letterSpacing: "0.05em",
        }}>
          <span>Cycle</span>
          <span>Time</span>
          <span style={{ textAlign: "right", minWidth: 80 }}>SBP / DBP</span>
          <span>Batches</span>
        </div>

        {cyclesLoading && cycles.length === 0 ? (
          <div style={{ padding: "14px 18px", color: "var(--faint)", fontSize: 13 }}>
            Loading cycles…
          </div>
        ) : cycles.length === 0 ? (
          <div style={{ padding: "14px 18px", color: "var(--faint)", fontSize: 13 }}>
            No cycles recorded yet.
          </div>
        ) : (
          cyclesWithPred.map((c) => (
            <CycleRow
              key={c.cycle_id}
              cycleId={c.cycle_id}
              autoName={c.autoName}
              tsMs={c.ts_ms_start}
              batchCount={c.batch_count}
              sbp={c.sbp}
              dbp={c.dbp}
              customLabel={customLabel(c.cycle_id)}
              onSave={saveCycleLabel}
              saving={cycleSaving}
            />
          ))
        )}
      </div>
    </Card>
  );
}

// ─── page view ────────────────────────────────────────────────────────────────

function DevicesView({ userId, sessionNode }: { userId: string; sessionNode: ReactNode }) {
  const { t } = useI18n();
  const { rows, status } = useTelemetry({ enabled: true, limit: 500 });
  const { labels, saving: deviceSaving, saveLabel: saveDeviceLabel } = useDeviceLabels();

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

      {devices.length === 0 ? (
        <Card><TelemetryEmptyState /></Card>
      ) : (
        devices.map(([deviceId, stats]) => (
          <DeviceCard
            key={deviceId}
            deviceId={deviceId}
            stats={stats}
            deviceLabel={labels[deviceId]}
            telemetryRows={rows}
            onRenameDevice={saveDeviceLabel}
            deviceSaving={deviceSaving}
          />
        ))
      )}
    </div>
  );
}
