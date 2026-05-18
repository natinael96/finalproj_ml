import { formatNumber, formatTime } from "@/lib/format";
import type { DashboardMode, TelemetryWindow } from "@/lib/types";

export function TelemetryTable({
  rows,
  mode = "user"
}: {
  rows: TelemetryWindow[];
  mode?: DashboardMode;
}) {
  if (rows.length === 0) {
    return (
      <div className="emptyState">
        <strong>No telemetry windows yet.</strong>
        <span>Start FastAPI and stream ESP32 or replay data with the signed-in user id.</span>
      </div>
    );
  }

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>time</th>
            <th>device</th>
            <th>SBP</th>
            <th>DBP</th>
            <th>σ SBP</th>
            <th>σ DBP</th>
            {mode === "detailed" ? <th>id</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="nowrap">{formatTime(row.created_at)}</td>
              <td>{row.device_id}</td>
              <td className="num">{formatNumber(row.sbp_pred)}</td>
              <td className="num">{formatNumber(row.dbp_pred)}</td>
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
