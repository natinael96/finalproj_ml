export function formatNumber(value: number | null | undefined, digits = 1) {
  return value == null || Number.isNaN(value) ? "-" : value.toFixed(digits);
}

export function formatInteger(value: number | null | undefined) {
  return value == null || Number.isNaN(value) ? "-" : value.toFixed(0);
}

export function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

export function formatShortTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleTimeString();
}

export function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
