"use client";

import { useT } from "@/lib/i18n";

export function TelemetryEmptyState() {
  const t = useT();
  const steps = [
    t("empty.step1"),
    t("empty.step2"),
    t("empty.step3"),
    t("empty.step4")
  ];

  return (
    <div className="emptyState emptyStateSteps">
      <strong>{t("empty.title")}</strong>
      <ol className="emptyStepsList">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
