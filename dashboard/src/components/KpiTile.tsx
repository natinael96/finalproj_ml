import type { ReactNode } from "react";
import { Card } from "./Card";

export function KpiTile({
  label,
  value,
  unit,
  meta,
  tone = "neutral"
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  meta?: ReactNode;
  tone?: "good" | "warn" | "bad" | "neutral";
}) {
  return (
    <Card className={`kpiTile tone-${tone}`}>
      <div className="kpiLabel">{label}</div>
      <div className="kpiValue">
        {value}
        {unit ? <span>{unit}</span> : null}
      </div>
      {meta ? <div className="kpiMeta">{meta}</div> : null}
    </Card>
  );
}

export function AlertBadge({
  tone,
  children
}: {
  tone: "good" | "warn" | "bad" | "neutral";
  children: ReactNode;
}) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}
