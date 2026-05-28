import type { TelemetryWindow } from "./types";

export type DateRange = "24h" | "7d" | "30d" | "all";

export type DailyTrendPoint = {
  date: string;
  label: string;
  count: number;
  avgSbp: number;
  avgDbp: number;
  avgMap: number;
  avgPulsePressure: number;
};

export type TrendStats = {
  count: number;
  avgSbp: number | null;
  avgDbp: number | null;
  avgMap: number | null;
  avgPulsePressure: number | null;
  minSbp: number | null;
  maxSbp: number | null;
  minDbp: number | null;
  maxDbp: number | null;
  stdSbp: number | null;
  stdDbp: number | null;
  highSbpCount: number;
  elevatedCount: number;
};

export function meanArterialPressure(sbp: number, dbp: number) {
  return dbp + (sbp - dbp) / 3;
}

export function pulsePressure(sbp: number, dbp: number) {
  return sbp - dbp;
}

export function validRows(rows: TelemetryWindow[]) {
  return rows.filter((row) => row.sbp_pred != null && row.dbp_pred != null);
}

export function filterByDateRange(rows: TelemetryWindow[], range: DateRange) {
  if (range === "all") return rows;
  const hours = range === "24h" ? 24 : range === "7d" ? 24 * 7 : 24 * 30;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return rows.filter((row) => {
    const ts = new Date(row.created_at).getTime();
    return !Number.isNaN(ts) && ts >= cutoff;
  });
}

function std(values: number[]) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function computeTrendStats(rows: TelemetryWindow[], sbpThreshold = 140): TrendStats {
  const valid = validRows(rows);
  if (valid.length === 0) {
    return {
      count: 0,
      avgSbp: null,
      avgDbp: null,
      avgMap: null,
      avgPulsePressure: null,
      minSbp: null,
      maxSbp: null,
      minDbp: null,
      maxDbp: null,
      stdSbp: null,
      stdDbp: null,
      highSbpCount: 0,
      elevatedCount: 0
    };
  }

  const sbpValues = valid.map((row) => Number(row.sbp_pred));
  const dbpValues = valid.map((row) => Number(row.dbp_pred));
  const mapValues = valid.map((row) => meanArterialPressure(Number(row.sbp_pred), Number(row.dbp_pred)));
  const ppValues = valid.map((row) => pulsePressure(Number(row.sbp_pred), Number(row.dbp_pred)));

  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    count: valid.length,
    avgSbp: avg(sbpValues),
    avgDbp: avg(dbpValues),
    avgMap: avg(mapValues),
    avgPulsePressure: avg(ppValues),
    minSbp: Math.min(...sbpValues),
    maxSbp: Math.max(...sbpValues),
    minDbp: Math.min(...dbpValues),
    maxDbp: Math.max(...dbpValues),
    stdSbp: std(sbpValues),
    stdDbp: std(dbpValues),
    highSbpCount: valid.filter((row) => Number(row.sbp_pred) >= sbpThreshold).length,
    elevatedCount: valid.filter(
      (row) => Number(row.sbp_pred) >= 130 || Number(row.dbp_pred) >= 80
    ).length
  };
}

export function computeDailyTrends(rows: TelemetryWindow[]): DailyTrendPoint[] {
  const valid = validRows(rows);
  const buckets = new Map<string, { sbp: number[]; dbp: number[] }>();

  for (const row of valid) {
    const date = new Date(row.created_at);
    if (Number.isNaN(date.getTime())) continue;
    const key = date.toISOString().slice(0, 10);
    const bucket = buckets.get(key) ?? { sbp: [], dbp: [] };
    bucket.sbp.push(Number(row.sbp_pred));
    bucket.dbp.push(Number(row.dbp_pred));
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => {
      const avgSbp = bucket.sbp.reduce((sum, value) => sum + value, 0) / bucket.sbp.length;
      const avgDbp = bucket.dbp.reduce((sum, value) => sum + value, 0) / bucket.dbp.length;
      const parsed = new Date(`${date}T12:00:00`);
      return {
        date,
        label: parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        count: bucket.sbp.length,
        avgSbp,
        avgDbp,
        avgMap: meanArterialPressure(avgSbp, avgDbp),
        avgPulsePressure: pulsePressure(avgSbp, avgDbp)
      };
    });
}
