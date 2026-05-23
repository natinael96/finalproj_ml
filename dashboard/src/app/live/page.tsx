"use client";

import { useMemo, useState, type ReactNode } from "react";
import { AuthGate, UserBadge } from "@/components/AuthGate";
import { Card, SectionHeader } from "@/components/Card";
import { AlertBadge, KpiTile } from "@/components/KpiTile";
import { TelemetryTable } from "@/components/TelemetryTable";
import { TrendChart } from "@/components/TrendChart";
import { classifyBp, summarizeTelemetry } from "@/lib/bp";
import { formatInteger, formatShortTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { isWebSocketEnabled } from "@/lib/env";
import { useTelemetry } from "@/lib/telemetry";
import { computeTrendStats } from "@/lib/trends";
import type { DashboardMode } from "@/lib/types";

function toneForConnection(state: string): "good" | "warn" | "bad" | "neutral" {
  if (state === "ready") return "good";
  if (state === "loading" || state === "connecting" || state === "subscribing" || state === "closed") return "warn";
  if (state === "error") return "bad";
  return "neutral";
}

export default function LivePage() {
  const { t } = useI18n();
  return (
    <AuthGate title={t("live.authTitle")}>
      {(session) => <LiveMonitor sessionId={session.user.id} sessionNode={<UserBadge session={session} />} />}
    </AuthGate>
  );
}

function LiveMonitor({ sessionId, sessionNode }: { sessionId: string; sessionNode: ReactNode }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<DashboardMode>("user");
  const [threshold, setThreshold] = useState(140);
  const wsEnabled = isWebSocketEnabled();
  const { rows, status, telemetryStatus } = useTelemetry({
    enabled: true,
    limit: 80,
    realtime: true,
    websocket: wsEnabled
  });
  const visibleRows = mode === "user" ? rows.slice(0, 20) : rows;
  const summary = useMemo(() => summarizeTelemetry(rows, threshold), [rows, threshold]);
  const trendStats = useMemo(() => computeTrendStats(rows, threshold), [rows, threshold]);
  const band = classifyBp(summary.latest?.sbp_pred, summary.latest?.dbp_pred, {
    waiting: t("bp.waiting"),
    high: t("bp.high"),
    elevated: t("bp.elevated"),
    inRange: t("bp.inRange"),
    waitingDetail: t("bp.waitingDetail"),
    highDetail: t("bp.highDetail"),
    elevatedDetail: t("bp.elevatedDetail"),
    inRangeDetail: t("bp.inRangeDetail")
  });
  const liveTone = summary.count > 0 ? "good" : toneForConnection(wsEnabled ? telemetryStatus.websocket : telemetryStatus.realtime);
  const liveLabel = summary.count > 0 ? t("live.receiving") : telemetryStatus.message;

  return (
    <div className="pageStack">
      <SectionHeader eyebrow={t("live.eyebrow")} title={t("live.title")}>
        {sessionNode}
      </SectionHeader>

      <div className="hero">
        <div className="heroCopy">
          <div>
            <div className="eyebrow">{t("live.currentInference")}</div>
            <div className="heroStat" role="status" aria-live="polite">
              {formatInteger(summary.latest?.sbp_pred)}
              <span style={{ opacity: 0.42 }}> / </span>
              {formatInteger(summary.latest?.dbp_pred)}
            </div>
            <p className="muted">
              {t("live.heroBody", {
                map: formatInteger(summary.latestMap),
                pp: formatInteger(summary.latestPulsePressure)
              })}
            </p>
          </div>
          <div className="heroStrip">
            <AlertBadge tone={band.tone}>{band.label}</AlertBadge>
            <AlertBadge tone={liveTone}>{liveLabel}</AlertBadge>
            <AlertBadge tone={summary.latest?.synthetic ? "warn" : summary.latest?.synthetic === false ? "good" : "neutral"}>
              {summary.latest?.synthetic ? t("live.syntheticFallback") : summary.latest?.synthetic === false ? t("live.sensorData") : t("live.sourceUnknown")}
            </AlertBadge>
            <span className="badge">{t("common.device")} {summary.latest?.device_id ?? "-"}</span>
            <span className="badge">{t("common.time")} {formatShortTime(summary.latest?.created_at)}</span>
            <span className="badge">user {sessionId.slice(0, 8)}...</span>
          </div>
        </div>
        <div className="heroPanel">
          <KpiTile label={t("live.windowsLoaded")} value={summary.count} meta={t("live.windowsMeta")} />
          <KpiTile label={t("live.sbpAlerts")} value={summary.highCount} unit="windows" tone={summary.highCount ? "bad" : "good"} />
          <Card>
            <div className="fieldStack">
              <label htmlFor="threshold">{t("live.alertThreshold")}</label>
              <input
                id="threshold"
                className="input"
                type="number"
                min={80}
                max={220}
                value={threshold}
                onChange={(event) => setThreshold(Number(event.target.value))}
              />
              <p className="muted">{t("live.thresholdNote")}</p>
            </div>
          </Card>
        </div>
      </div>

      <div className="kpiGrid">
        <KpiTile label={t("live.avgSbp")} value={formatInteger(summary.avgSbp)} unit={t("common.mmHg")} />
        <KpiTile label={t("live.avgDbp")} value={formatInteger(summary.avgDbp)} unit={t("common.mmHg")} />
        <KpiTile label={t("live.sessionMap")} value={formatInteger(trendStats.avgMap)} unit={t("common.mmHg")} />
        <KpiTile
          label={t("live.activeDevices")}
          value={summary.deviceCount}
          meta={
            summary.syntheticCount
              ? t("live.syntheticWindows", { count: summary.syntheticCount })
              : status || telemetryStatus.message || band.detail
          }
          tone={summary.syntheticCount ? "warn" : band.tone}
        />
      </div>

      <div className="threeCol">
        <KpiTile label={t("live.dbLoad")} value={telemetryStatus.database} meta={t("live.dbMeta")} tone={toneForConnection(telemetryStatus.database)} />
        <KpiTile label={t("live.realtime")} value={telemetryStatus.realtime} meta={t("live.realtimeMeta")} tone={toneForConnection(telemetryStatus.realtime)} />
        <KpiTile
          label={t("live.fastApiSocket")}
          value={wsEnabled ? telemetryStatus.websocket : "disabled"}
          meta={wsEnabled ? t("live.socketMeta") : "Set NEXT_PUBLIC_BP_WEBSOCKET_ENABLED=true"}
          tone={wsEnabled ? toneForConnection(telemetryStatus.websocket) : "neutral"}
        />
      </div>

      <Card>
        <div className="sectionHeader">
          <div>
            <div className="cardTitle">{t("live.liveTrend")}</div>
            <p className="muted">{t("live.liveTrendBody")}</p>
          </div>
          <span className={`pill tone-${liveTone}`}><span className={`dot dot-${liveTone}`} /> {liveLabel}</span>
        </div>
        <TrendChart rows={rows.slice(0, 40)} threshold={threshold} />
      </Card>

      <Card className="callout">
        <div className="cardTitle">{t("live.hardwareChecklist")}</div>
        <div className="threeCol">
          <div className="fieldStack">
            <label>{t("live.hw1")}</label>
            <p className="muted">{t("live.hw1Body")}</p>
          </div>
          <div className="fieldStack">
            <label>{t("live.hw2")}</label>
            <p className="muted">{t("live.hw2Body")}</p>
          </div>
          <div className="fieldStack">
            <label>{t("live.hw3")}</label>
            <p className="muted">{t("live.hw3Body")}</p>
          </div>
        </div>
      </Card>

      <Card>
        <div className="sectionHeader">
          <div>
            <div className="cardTitle">{t("live.recentFeed")}</div>
            <p className="muted">{mode === "user" ? t("live.curated20") : t("live.detailed80")}</p>
          </div>
          <span className="seg" aria-label="Dashboard mode">
            <button type="button" className={mode === "user" ? "active" : ""} onClick={() => setMode("user")}>
              {t("common.userMode")}
            </button>
            <button type="button" className={mode === "detailed" ? "active" : ""} onClick={() => setMode("detailed")}>
              {t("common.detailedMode")}
            </button>
          </span>
        </div>
        <TelemetryTable rows={visibleRows} mode={mode} />
      </Card>
    </div>
  );
}
