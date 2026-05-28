import type { TelemetryWindow } from "./types";

export function telemetryToCsv(rows: TelemetryWindow[]) {
  const header = ["created_at", "device_id", "sbp_pred", "dbp_pred", "sbp_std", "dbp_std", "id"];
  const body = rows.map((row) =>
    [
      row.created_at,
      row.device_id,
      row.sbp_pred ?? "",
      row.dbp_pred ?? "",
      row.sbp_std ?? "",
      row.dbp_std ?? "",
      row.id
    ]
      .map((value) => `"${String(value).replaceAll('"', '""')}"`)
      .join(",")
  );
  return [header.join(","), ...body].join("\n");
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function parseFeatureRowsFromCsv(text: string) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((header) => header.trim());
  const rows = lines.slice(1).map(splitCsvLine);
  const featuresIndex = headers.findIndex((header) => header.toLowerCase() === "features");

  if (featuresIndex >= 0) {
    return rows.map((row) => JSON.parse(row[featuresIndex]) as number[]);
  }

  const featureColumns = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => /^f\d+$/i.test(header))
    .sort((a, b) => Number(a.header.slice(1)) - Number(b.header.slice(1)));

  if (featureColumns.length === 0) {
    throw new Error("CSV needs a features column or numeric f0,f1,... columns.");
  }

  return rows.map((row) => featureColumns.map(({ index }) => Number(row[index])));
}

function splitCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}
