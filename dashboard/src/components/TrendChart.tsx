import type { TelemetryWindow } from "@/lib/types";

function buildPoints(values: number[], width: number, height: number, min: number, max: number) {
  if (values.length === 0) return "";
  const span = Math.max(max - min, 1);
  return values
    .map((value, index) => {
      const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
      const y = height - ((value - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function TrendChart({ rows, threshold = 140 }: { rows: TelemetryWindow[]; threshold?: number }) {
  const ordered = [...rows].reverse().filter((row) => row.sbp_pred != null && row.dbp_pred != null);
  const sbp = ordered.map((row) => Number(row.sbp_pred));
  const dbp = ordered.map((row) => Number(row.dbp_pred));
  const width = 720;
  const height = 220;
  const allValues = [...sbp, ...dbp, threshold];
  const min = Math.floor((Math.min(...allValues, 60) - 5) / 10) * 10;
  const max = Math.ceil((Math.max(...allValues, 160) + 5) / 10) * 10;
  const span = Math.max(max - min, 1);
  const thresholdY = height - ((threshold - min) / span) * height;
  const mid = Math.round((min + max) / 2);

  if (ordered.length < 2) {
    return (
      <div className="chartEmpty">
        <strong>Trend needs at least two windows.</strong>
        <span>Predictions arrive once each buffered window is processed.</span>
      </div>
    );
  }

  return (
    <div className="chartFrame" aria-label="SBP and DBP trend chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        <text x="0" y="12" className="axisLabel">{max} mmHg</text>
        <text x="0" y={(height / 2).toFixed(1)} className="axisLabel">{mid} mmHg</text>
        <text x="0" y={height - 4} className="axisLabel">{min} mmHg</text>
        <line x1="0" y1={thresholdY} x2={width} y2={thresholdY} className="thresholdLine" />
        <polyline points={buildPoints(sbp, width, height, min, max)} className="sbpLine" />
        <polyline points={buildPoints(dbp, width, height, min, max)} className="dbpLine" />
      </svg>
      <div className="chartLegend">
        <span><i className="legendSbp" /> SBP</span>
        <span><i className="legendDbp" /> DBP</span>
        <span><i className="legendThreshold" /> SBP threshold {threshold}</span>
      </div>
    </div>
  );
}
