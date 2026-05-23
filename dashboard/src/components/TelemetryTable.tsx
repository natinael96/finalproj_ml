"use client";

import { formatNumber, formatTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { DashboardMode, TelemetryWindow } from "@/lib/types";
import { TelemetryEmptyState } from "./TelemetryEmptyState";

export function TelemetryTable({
  rows,
  mode = "user"
}: {
  rows: TelemetryWindow[];
  mode?: DashboardMode;
}) {
  const t = useT();

  if (rows.length === 0) {
    return <TelemetryEmptyState />;
  }

  function sourceLabel(row: TelemetryWindow) {
    if (row.synthetic == null) return t("common.unknown");
    return row.synthetic ? t("common.synthetic") : t("common.sensor");
  }

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>{t("table.time")}</th>
            <th>{t("table.device")}</th>
            <th>{t("table.sbp")}</th>
            <th>{t("table.dbp")}</th>
            <th>{t("table.source")}</th>
            <th>{t("table.sigmaSbp")}</th>
            <th>{t("table.sigmaDbp")}</th>
            {mode === "detailed" ? <th>{t("table.id")}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="nowrap">{formatTime(row.created_at)}</td>
              <td>{row.device_id}</td>
              <td className="num">{formatNumber(row.sbp_pred)}</td>
              <td className="num">{formatNumber(row.dbp_pred)}</td>
              <td>{sourceLabel(row)}</td>
              <td className="num">{formatNumber(row.sbp_std, 2)}</td>
              <td className="num">{formatNumber(row.dbp_std, 2)}</td>
              {mode === "detailed" ? <td className="num">{row.id}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
