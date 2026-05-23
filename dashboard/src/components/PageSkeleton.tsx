"use client";

import { useT } from "@/lib/i18n";

export function PageSkeleton({ variant = "page" }: { variant?: "page" | "kpi" | "chart" | "table" }) {
  const t = useT();

  if (variant === "kpi") {
    return (
      <div className="skeletonCard" aria-hidden>
        <div className="skeletonLine short" />
        <div className="skeletonLine tall" />
        <div className="skeletonLine medium" />
        <span className="srOnly">{t("skeleton.kpi")}</span>
      </div>
    );
  }

  if (variant === "chart") {
    return (
      <div className="skeletonChart" aria-hidden>
        <div className="skeletonLine medium" />
        <div className="skeletonChartArea" />
        <span className="srOnly">{t("skeleton.chart")}</span>
      </div>
    );
  }

  if (variant === "table") {
    return (
      <div className="skeletonTable" aria-hidden>
        {Array.from({ length: 5 }).map((_, index) => (
          <div className="skeletonTableRow" key={index}>
            <div className="skeletonLine medium" />
            <div className="skeletonLine short" />
          </div>
        ))}
        <span className="srOnly">{t("skeleton.table")}</span>
      </div>
    );
  }

  return (
    <div className="pageStack skeletonPage" aria-hidden>
      <div className="skeletonLine short" />
      <div className="skeletonLine tall" />
      <div className="fourCol">
        <div className="skeletonCard" />
        <div className="skeletonCard" />
        <div className="skeletonCard" />
        <div className="skeletonCard" />
      </div>
      <div className="skeletonChartArea" />
    </div>
  );
}
