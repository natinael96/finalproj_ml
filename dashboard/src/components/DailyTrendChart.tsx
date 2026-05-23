"use client";

import type { DailyTrendPoint } from "@/lib/trends";
import { useT } from "@/lib/i18n";

function buildPoints(values: number[], width: number, height: number, min: number, max: number) {
  if (values.length === 0) return "";
  const span = Math.max(max - min, 1);
  return values
    .map((value, index) => {
      const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
      const y = height - ((value - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function DailyTrendChart({ points }: { points: DailyTrendPoint[] }) {
  const t = useT();
  const width = 720;
  const height = 200;
  const sbp = points.map((point) => point.avgSbp);
  const dbp = points.map((point) => point.avgDbp);
  const allValues = [...sbp, ...dbp];
  const min = Math.floor((Math.min(...allValues, 60) - 5) / 10) * 10;
  const max = Math.ceil((Math.max(...allValues, 160) + 5) / 10) * 10;

  if (points.length === 0) {
    return (
      <div className="chartEmpty">
        <strong>{t("chart.dailyEmpty")}</strong>
        <span>{t("chart.dailyEmptyBody")}</span>
      </div>
    );
  }

  if (points.length === 1) {
    const point = points[0];
    return (
      <div className="dailySingle">
        <div className="dailySingleStat">
          <span className="eyebrow">{point.label}</span>
          <strong className="num">
            {point.avgSbp.toFixed(0)} / {point.avgDbp.toFixed(0)}
          </strong>
          <span className="muted">
            {t("chart.windowsCount", { count: point.count })} · MAP {point.avgMap.toFixed(0)} mmHg
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="chartFrame" aria-label="Daily average SBP and DBP trend">
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        <text x="0" y="12" className="axisLabel">{max} mmHg</text>
        <text x="0" y={height - 4} className="axisLabel">{min} mmHg</text>
        <polyline points={buildPoints(sbp, width, height, min, max)} className="sbpLine" />
        <polyline points={buildPoints(dbp, width, height, min, max)} className="dbpLine" />
        {points.map((point, index) => {
          const x = (index / (points.length - 1)) * width;
          return (
            <text key={point.date} x={x} y={height + 16} className="axisLabel" textAnchor="middle">
              {point.label}
            </text>
          );
        })}
      </svg>
      <div className="chartLegend">
        <span><i className="legendSbp" /> {t("chart.dailyAvgSbp")}</span>
        <span><i className="legendDbp" /> {t("chart.dailyAvgDbp")}</span>
      </div>
    </div>
  );
}
