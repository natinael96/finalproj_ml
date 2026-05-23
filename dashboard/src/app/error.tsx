"use client";

import { Card, SectionHeader } from "@/components/Card";
import { useT } from "@/lib/i18n";

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  const t = useT();

  return (
    <div className="pageStack">
      <SectionHeader eyebrow={t("error.eyebrow")} title={t("error.title")} />
      <Card className="callout">
        <div className="cardTitle">{t("error.recovery")}</div>
        <p className="muted">{t("error.recoveryBody")}</p>
        <div className="rowActions">
          <button type="button" className="btn btnPrimary" onClick={reset}>
            {t("error.retry")}
          </button>
          <span className="badge tone-bad">{error.message || t("error.unknown")}</span>
        </div>
      </Card>
    </div>
  );
}
