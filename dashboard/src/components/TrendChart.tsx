"use client";

import type { TelemetryWindow } from "@/lib/types";
import { formatShortTime } from "@/lib/format";
import { useT } from "@/lib/i18n";

function buildPoints(values: number[], width: number, height: number, min: number, max: number, padX: number) {
  if (values.length === 0) return "";
  const span = Math.max(max - min, 1);
  const chartWidth = width - padX * 2;
  return values
    .map((value, index) => {
      const x = values.length === 1 ? padX + chartWidth / 2 : padX + (index / (values.length - 1)) * chartWidth;
      const y = height - ((value - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function TrendChart({ rows, threshold = 140 }: { rows: TelemetryWindow[]; threshold?: number }) {
  const t = useT();
  const ordered = [...rows].reverse().filter((row) => row.sbp_pred != null && row.dbp_pred != null);
  const sbp = ordered.map((row) => Number(row.sbp_pred));
  const dbp = ordered.map((row) => Number(row.dbp_pred));
  const width = 720;
  const height = 220;
  const padX = 48;
  const allValues = [...sbp, ...dbp, threshold];
  const min = Math.floor((Math.min(...allValues, 60) - 5) / 10) * 10;
  const max = Math.ceil((Math.max(...allValues, 160) + 5) / 10) * 10;
  const span = Math.max(max - min, 1);
  const thresholdY = height - ((threshold - min) / span) * height;
  const mid = Math.round((min + max) / 2);
  const startLabel = ordered[0]?.created_at ? formatShortTime(ordered[0].created_at) : "";
  const endLabel = ordered[ordered.length - 1]?.created_at
    ? formatShortTime(ordered[ordered.length - 1].created_at)
    : "";

  if (ordered.length < 2) {
    return (
      <div className="chartEmpty">
        <strong>{t("chart.needTwo")}</strong>
        <span>{t("chart.needTwoBody")}</span>
      </div>
    );
  }

  return (
    <div className="chartFrame" aria-label="SBP and DBP trend chart">
      <svg viewBox={`0 0 ${width} ${height + 24}`} role="img">
        <text x="0" y="12" className="axisLabel">{max} mmHg</text>
        <text x="0" y={(height / 2).toFixed(1)} className="axisLabel">{mid} mmHg</text>
        <text x="0" y={height - 4} className="axisLabel">{min} mmHg</text>
        <line x1={padX} y1={thresholdY} x2={width} y2={thresholdY} className="thresholdLine" />
        <polyline points={buildPoints(sbp, width, height, min, max, padX)} className="sbpLine" />
        <polyline points={buildPoints(dbp, width, height, min, max, padX)} className="dbpLine" />
        <text x={padX} y={height + 18} className="axisLabel">{startLabel}</text>
        <text x={width - 4} y={height + 18} className="axisLabel" textAnchor="end">{endLabel}</text>
      </svg>
      <div className="chartLegend">
        <span><i className="legendSbp" /> {t("chart.sbp")}</span>
        <span><i className="legendDbp" /> {t("chart.dbp")}</span>
        <span><i className="legendThreshold" /> {t("chart.threshold", { value: threshold })}</span>
        <span className="muted">{t("chart.windows", { count: ordered.length })}</span>
      </div>
    </div>
  );
}
