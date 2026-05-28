import type { TelemetryWindow } from "./types";

export type BpBand = {
  label: string;
  tone: "good" | "warn" | "bad" | "neutral";
  detail: string;
};

export function classifyBp(
  sbp?: number | null,
  dbp?: number | null,
  labels?: {
    waiting: string;
    high: string;
    elevated: string;
    inRange: string;
    highDetail: string;
    elevatedDetail: string;
    inRangeDetail: string;
    waitingDetail: string;
  }
): BpBand {
  const L = labels ?? {
    waiting: "Waiting",
    high: "High",
    elevated: "Elevated",
    inRange: "In range",
    highDetail: "Above common hypertension threshold",
    elevatedDetail: "Watch trend and repeat windows",
    inRangeDetail: "Current estimate is below alert threshold",
    waitingDetail: "No prediction window yet"
  };
  if (sbp == null || dbp == null) {
    return { label: L.waiting, tone: "neutral", detail: L.waitingDetail };
  }
  if (sbp >= 140 || dbp >= 90) {
    return { label: L.high, tone: "bad", detail: L.highDetail };
  }
  if (sbp >= 130 || dbp >= 80) {
    return { label: L.elevated, tone: "warn", detail: L.elevatedDetail };
  }
  return { label: L.inRange, tone: "good", detail: L.inRangeDetail };
}

export function summarizeTelemetry(rows: TelemetryWindow[], sbpThreshold = 140) {
  const valid = rows.filter((row) => row.sbp_pred != null && row.dbp_pred != null);
  const latest = rows[0];
  const highCount = valid.filter((row) => Number(row.sbp_pred) >= sbpThreshold).length;
  const syntheticCount = rows.filter((row) => row.synthetic).length;
  const avgSbp =
    valid.length === 0 ? null : valid.reduce((sum, row) => sum + Number(row.sbp_pred), 0) / valid.length;
  const avgDbp =
    valid.length === 0 ? null : valid.reduce((sum, row) => sum + Number(row.dbp_pred), 0) / valid.length;
  const devices = new Set(rows.map((row) => row.device_id).filter(Boolean));
  const latestSbp = latest?.sbp_pred != null ? Number(latest.sbp_pred) : null;
  const latestDbp = latest?.dbp_pred != null ? Number(latest.dbp_pred) : null;
  const latestMap =
    latestSbp != null && latestDbp != null ? latestDbp + (latestSbp - latestDbp) / 3 : null;
  const latestPulsePressure = latestSbp != null && latestDbp != null ? latestSbp - latestDbp : null;

  return {
    latest,
    count: rows.length,
    validCount: valid.length,
    highCount,
    syntheticCount,
    avgSbp,
    avgDbp,
    latestMap,
    latestPulsePressure,
    deviceCount: devices.size
  };
}
