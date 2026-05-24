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
  deviceId,
  autoName,
  tsMs,
  batchCount,
  sbp,
  dbp,
  customLabel,
  onSave,
  onDelete,
  saving,
}: {
  cycleId: string;
  deviceId: string;
  autoName: string;
  tsMs: number;
  batchCount: number;
  sbp: number | null;
  dbp: number | null;
  customLabel: string | undefined;
  onSave: (id: string, label: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(customLabel ?? "");
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => { setDraft(customLabel ?? ""); setEditing(true); setTimeout(() => inputRef.current?.select(), 20); };
  const cancel = () => setEditing(false);
  const save = async () => { await onSave(cycleId, draft); setEditing(false); };
  const handleDelete = async () => {
    if (!window.confirm(`Delete cycle "${customLabel || autoName}" and all its signal data? This cannot be undone.`)) return;
    setDeleting(true);
    await onDelete(cycleId);
    setDeleting(false);
  };

  const displayName = customLabel || autoName;
  const d = new Date(tsMs);
  const timeStr = d.toLocaleString([], {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr auto auto auto auto auto",
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

      {/* View signals */}
      <Link
        href={`/cycles/${encodeURIComponent(cycleId)}?device=${encodeURIComponent(deviceId)}`}
        className="badge"
        style={{ fontSize: 11, whiteSpace: "nowrap" }}>
        View signals →
      </Link>

      {/* Delete */}
      <button
        type="button"
        title="Delete cycle"
        disabled={deleting}
        onClick={handleDelete}
        style={{
          background: "none", border: "none", cursor: "pointer",
          padding: "2px 4px", fontSize: 13, opacity: 0.4,
          color: "var(--danger, #e53e3e)", flexShrink: 0,
          transition: "opacity 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.4")}
      >
        {deleting ? "…" : "🗑"}
      </button>
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
  onDeleteDevice,
  deviceSaving,
}: {
  deviceId: string;
  stats: { count: number; lastSeen: string; avgSbp: number | null; avgDbp: number | null };
  deviceLabel: string | undefined;
  telemetryRows: TelemetryWindow[];
  onRenameDevice: (id: string, name: string) => Promise<void>;
  onDeleteDevice: (id: string) => Promise<void>;
  deviceSaving: boolean;
}) {
  const [editingDevice, setEditingDevice] = useState(false);
  const [deviceDraft, setDeviceDraft] = useState(deviceLabel ?? "");
  const [cyclesOpen, setCyclesOpen] = useState(true);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletingDevice, setDeletingDevice] = useState(false);
  const deviceInputRef = useRef<HTMLInputElement>(null);
  const deleteConfirmRef = useRef<HTMLInputElement>(null);

  const { cycles, loading: cyclesLoading, reload: reloadCycles } = useCycleList(deviceId);
  const { customLabel, saveLabel: saveCycleLabel, deleteCycle, saving: cycleSaving } = useCycleLabels();

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

  const requiredText = deviceLabel || deviceId;
  const deleteConfirmMatch = deleteConfirmText.trim() === requiredText;

  const openDeleteConfirm = () => {
    setDeleteConfirmText("");
    setConfirmingDelete(true);
    setTimeout(() => deleteConfirmRef.current?.focus(), 30);
  };
  const cancelDeleteConfirm = () => { setConfirmingDelete(false); setDeleteConfirmText(""); };
  const handleDeleteDevice = async () => {
    if (!deleteConfirmMatch) return;
    setDeletingDevice(true);
    await onDeleteDevice(deviceId);
    setDeletingDevice(false);
    setConfirmingDelete(false);
  };

  const handleDeleteCycle = async (cycleId: string) => {
    await deleteCycle(cycleId);
    reloadCycles();
  };

  return (
    <Card>
      {/* Device header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 18px", gap: 12, flexWrap: "wrap",
        borderBottom: cyclesOpen ? "1px solid var(--border, rgba(0,0,0,0.08))" : undefined,
      }}>
        {/* Name + device_id */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
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

          {/* Delete device — guarded by name confirmation */}
          {!confirmingDelete ? (
            <button
              type="button"
              title="Delete device"
              onClick={openDeleteConfirm}
              style={{
                background: "none", border: "1px solid var(--danger, #e53e3e)",
                borderRadius: 6, cursor: "pointer", padding: "3px 8px",
                fontSize: 11, color: "var(--danger, #e53e3e)",
                opacity: 0.55, transition: "opacity 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.55")}
            >
              🗑 Delete device
            </button>
          ) : null}

          {/* Collapse toggle */}
          <button
            type="button"
            title={cyclesOpen ? "Collapse cycles" : "Expand cycles"}
            onClick={() => setCyclesOpen((v) => !v)}
            style={{
              background: "none", border: "none", cursor: "pointer",
              padding: "3px 6px", fontSize: 14, opacity: 0.6,
              transition: "opacity 0.15s, transform 0.2s",
              transform: cyclesOpen ? "rotate(0deg)" : "rotate(-90deg)",
              display: "flex", alignItems: "center",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
          >
            ▾
          </button>
        </div>
      </div>

      {/* Delete confirmation strip */}
      {confirmingDelete && (
        <div style={{
          padding: "12px 18px",
          background: "rgba(229,62,62,0.06)",
          borderTop: "1px solid rgba(229,62,62,0.25)",
          borderBottom: cyclesOpen ? "1px solid var(--border, rgba(0,0,0,0.08))" : undefined,
          display: "flex", flexDirection: "column", gap: 8,
        }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--danger, #c53030)", fontWeight: 600 }}>
            ⚠ This will permanently delete the device and ALL its cycles and signal data.
          </p>
          <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>
            Type <strong>{requiredText}</strong> to confirm:
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              ref={deleteConfirmRef}
              className="input"
              style={{ padding: "5px 10px", fontSize: 13, borderRadius: 8, width: 220,
                border: deleteConfirmText && !deleteConfirmMatch
                  ? "1.5px solid var(--danger, #e53e3e)"
                  : undefined,
              }}
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && deleteConfirmMatch) handleDeleteDevice(); if (e.key === "Escape") cancelDeleteConfirm(); }}
              placeholder={requiredText}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={!deleteConfirmMatch || deletingDevice}
              onClick={handleDeleteDevice}
              style={{
                background: deleteConfirmMatch ? "var(--danger, #e53e3e)" : "rgba(229,62,62,0.25)",
                color: "#fff", border: "none", borderRadius: 8,
                padding: "5px 14px", fontSize: 13, cursor: deleteConfirmMatch ? "pointer" : "not-allowed",
                fontWeight: 600, transition: "background 0.15s",
              }}
            >
              {deletingDevice ? "Deleting…" : "Delete"}
            </button>
            <button
              type="button"
              onClick={cancelDeleteConfirm}
              className="btn btnTiny"
              style={{ fontSize: 12 }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Cycles section — collapsible */}
      {cyclesOpen && (
        <div>
          {/* Column headers */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr auto auto auto auto auto",
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
            <span></span>
            <span></span>
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
                deviceId={deviceId}
                autoName={c.autoName}
                tsMs={c.ts_ms_start}
                batchCount={c.batch_count}
                sbp={c.sbp}
                dbp={c.dbp}
                customLabel={customLabel(c.cycle_id)}
                onSave={saveCycleLabel}
                onDelete={handleDeleteCycle}
                saving={cycleSaving}
              />
            ))
          )}
        </div>
      )}
    </Card>
  );
}

// ─── page view ────────────────────────────────────────────────────────────────

function DevicesView({ userId, sessionNode }: { userId: string; sessionNode: ReactNode }) {
  const { t } = useI18n();
  const { rows, status } = useTelemetry({ enabled: true, limit: 500 });
  const { labels, saving: deviceSaving, saveLabel: saveDeviceLabel, deleteDevice } = useDeviceLabels();

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

      <div className="twoCol">
        <KpiTile label={t("devices.knownDevices")} value={devices.length} meta={status || t("devices.fromTelemetry")} />
        <KpiTile label={t("devices.totalWindows")} value={rows.length} />
      </div>

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
            onDeleteDevice={deleteDevice}
            deviceSaving={deviceSaving}
          />
        ))
      )}
    </div>
  );
}
