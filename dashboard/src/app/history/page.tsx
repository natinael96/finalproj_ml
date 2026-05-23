"use client";

import { Suspense, useMemo, useState, type ReactNode } from "react";
import { AuthGate, UserBadge } from "@/components/AuthGate";
import { Card, SectionHeader } from "@/components/Card";
import { DailyTrendChart } from "@/components/DailyTrendChart";
import { KpiTile } from "@/components/KpiTile";
import { TelemetryTable } from "@/components/TelemetryTable";
import { TrendChart } from "@/components/TrendChart";
import { summarizeTelemetry } from "@/lib/bp";
import { downloadCsv, telemetryToCsv } from "@/lib/csv";
import { formatInteger, formatNumber, pluralize } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useTelemetry } from "@/lib/telemetry";
import { useHistoryUrl } from "@/lib/useHistoryUrl";
import {
  computeDailyTrends,
  computeTrendStats,
  filterByDateRange,
  type DateRange
} from "@/lib/trends";
import type { DashboardMode } from "@/lib/types";

export default function HistoryPage() {
  const { t } = useI18n();
  return (
    <AuthGate title={t("history.authTitle")}>
      {(session) => (
        <Suspense fallback={<div className="pageStack"><SectionHeader eyebrow={t("history.eyebrow")} title={t("history.title")} /></div>}>
          <HistoryView sessionNode={<UserBadge session={session} />} />
        </Suspense>
      )}
    </AuthGate>
  );
}

function HistoryView({ sessionNode }: { sessionNode: ReactNode }) {
  const { t, messages: m } = useI18n();
  const { device, range, threshold, replaceParams } = useHistoryUrl();
  const [mode, setMode] = useState<DashboardMode>("user");
  const { rows, status, devices } = useTelemetry({ enabled: true, device, limit: 500 });
  const filteredRows = useMemo(() => filterByDateRange(rows, range), [rows, range]);
  const visibleRows = mode === "user" ? filteredRows.slice(0, 100) : filteredRows;
  const summary = useMemo(() => summarizeTelemetry(filteredRows, threshold), [filteredRows, threshold]);
  const trendStats = useMemo(() => computeTrendStats(filteredRows, threshold), [filteredRows, threshold]);
  const dailyTrends = useMemo(() => computeDailyTrends(filteredRows), [filteredRows]);

  const rangeLabels: Record<DateRange, string> = {
    "24h": t("history.range24h"),
    "7d": t("history.range7d"),
    "30d": t("history.range30d"),
    all: t("history.rangeAll")
  };

  return (
    <div className="pageStack">
      <SectionHeader eyebrow={t("history.eyebrow")} title={t("history.title")}>
        {sessionNode}
      </SectionHeader>

      <div className="fourCol">
        <KpiTile label={t("history.windowsInView")} value={trendStats.count} meta={status || pluralize(summary.deviceCount, "device")} />
        <KpiTile label={t("history.meanSbp")} value={formatInteger(trendStats.avgSbp)} unit={t("common.mmHg")} meta={`σ ${formatNumber(trendStats.stdSbp, 1)}`} />
        <KpiTile label={t("history.meanDbp")} value={formatInteger(trendStats.avgDbp)} unit={t("common.mmHg")} meta={`σ ${formatNumber(trendStats.stdDbp, 1)}`} />
        <KpiTile label={t("history.thresholdHits")} value={trendStats.highSbpCount} tone={trendStats.highSbpCount ? "bad" : "good"} />
      </div>

      <div className="fourCol">
        <KpiTile label={t("history.meanMap")} value={formatInteger(trendStats.avgMap)} unit={t("common.mmHg")} meta={t("history.mapMeta")} />
        <KpiTile label={t("history.pulsePressure")} value={formatInteger(trendStats.avgPulsePressure)} unit={t("common.mmHg")} meta={t("history.ppMeta")} />
        <KpiTile label={t("history.sbpRange")} value={`${formatInteger(trendStats.minSbp)}–${formatInteger(trendStats.maxSbp)}`} unit={t("common.mmHg")} />
        <KpiTile label={t("history.elevated")} value={trendStats.elevatedCount} tone={trendStats.elevatedCount ? "warn" : "good"} meta={t("history.elevatedMeta")} />
      </div>

      <Card>
        <div className="sectionHeader">
          <div>
            <div className="cardTitle">{t("history.filtersExport")}</div>
            <p className="muted">{t("history.filtersBody")}</p>
          </div>
          <div className="rowActions">
            <button
              className="btn"
              type="button"
              onClick={() => downloadCsv("telemetry_windows.csv", telemetryToCsv(visibleRows))}
              disabled={visibleRows.length === 0}
            >
              {t("common.exportCsv")}
            </button>
            <span className="seg" aria-label="Dashboard mode">
              <button type="button" className={mode === "user" ? "active" : ""} onClick={() => setMode("user")}>
                {t("common.userMode")}
              </button>
              <button type="button" className={mode === "detailed" ? "active" : ""} onClick={() => setMode("detailed")}>
                {t("common.detailedMode")}
              </button>
            </span>
          </div>
        </div>
        <div className="fourCol">
          <div className="fieldStack">
            <label htmlFor="device">{t("history.deviceFilter")}</label>
            <select
              id="device"
              value={device}
              onChange={(event) => replaceParams({ device: event.target.value })}
            >
              <option value="">{t("history.allDevices")}</option>
              {devices.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
          <div className="fieldStack">
            <label htmlFor="range">{t("history.dateRange")}</label>
            <select
              id="range"
              value={range}
              onChange={(event) => replaceParams({ range: event.target.value as DateRange })}
            >
              <option value="24h">{m.history.range24h}</option>
              <option value="7d">{m.history.range7d}</option>
              <option value="30d">{m.history.range30d}</option>
              <option value="all">{m.history.rangeAll}</option>
            </select>
          </div>
          <div className="fieldStack">
            <label htmlFor="threshold">{t("history.sbpThreshold")}</label>
            <input
              id="threshold"
              type="number"
              className="input"
              value={threshold}
              onChange={(event) => replaceParams({ threshold: Number(event.target.value) })}
            />
          </div>
          <div className="fieldStack">
            <label>{t("history.currentView")}</label>
            <span className="badge">
              {rangeLabels[range]} · {visibleRows.length} rows
            </span>
          </div>
        </div>
      </Card>

      <Card>
        <div className="cardTitle">{t("history.sessionTrend")}</div>
        <p className="muted">{t("history.sessionTrendBody")}</p>
        <TrendChart rows={visibleRows} threshold={threshold} />
      </Card>

      <Card>
        <div className="cardTitle">{t("history.dailyAverages")}</div>
        <p className="muted">{t("history.dailyBody")}</p>
        <DailyTrendChart points={dailyTrends} />
      </Card>

      <Card>
        <div className="cardTitle">{t("history.storedWindows")}</div>
        <TelemetryTable rows={visibleRows} mode={mode} />
      </Card>
    </div>
  );
}
