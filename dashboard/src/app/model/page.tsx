"use client";

import { useEffect, useState } from "react";
import { Card, SectionHeader } from "@/components/Card";
import { KpiTile } from "@/components/KpiTile";
import { BP_API_URL, apiHeaders } from "@/lib/env";
import { formatNumber } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { ApiHealth } from "@/lib/types";

type ModelMetrics = {
  mae_sbp?: number;
  mae_dbp?: number;
  rmse_sbp?: number;
  rmse_dbp?: number;
  within_5mmhg_sbp?: number;
  within_5mmhg_dbp?: number;
  n_test?: number;
  n_features?: number;
  live_schema_compatible?: boolean;
  window_s?: number;
  feature_mode?: string;
};

export default function ModelPage() {
  const { t, messages: m } = useI18n();
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [metrics, setMetrics] = useState<ModelMetrics | null>(null);
  const [status, setStatus] = useState(t("model.loadingMeta"));

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [healthRes, metricsRes] = await Promise.all([
          fetch(`${BP_API_URL}/health`, { headers: apiHeaders() }),
          fetch("/metrics.json")
        ]);
        if (cancelled) return;

        if (healthRes.ok) {
          setHealth((await healthRes.json()) as ApiHealth);
        }
        if (metricsRes.ok) {
          setMetrics((await metricsRes.json()) as ModelMetrics);
        }
        setStatus(healthRes.ok ? t("model.liveHealth") : t("model.offlineMetrics"));
      } catch {
        if (!cancelled) setStatus(t("model.apiUnreachable"));
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const featureCount = health?.feature_count ?? health?.n_features ?? metrics?.n_features ?? "-";
  const schemaOk = health?.live_schema_compatible ?? metrics?.live_schema_compatible;
  const ahaTones: Array<"good" | "warn" | "bad"> = ["good", "warn", "warn", "bad"];

  return (
    <div className="pageStack">
      <SectionHeader eyebrow={t("model.eyebrow")} title={t("model.title")}>
        <span className="badge">{status}</span>
      </SectionHeader>

      <div className="fourCol">
        <KpiTile label={t("model.sbpMae")} value={formatNumber(metrics?.mae_sbp, 2)} unit={t("common.mmHg")} meta={`RMSE ${formatNumber(metrics?.rmse_sbp, 2)}`} />
        <KpiTile label={t("model.dbpMae")} value={formatNumber(metrics?.mae_dbp, 2)} unit={t("common.mmHg")} meta={`RMSE ${formatNumber(metrics?.rmse_dbp, 2)}`} />
        <KpiTile
          label={t("model.features")}
          value={String(featureCount)}
          meta={schemaOk ? t("model.schemaOk") : t("model.schemaPending")}
          tone={schemaOk ? "good" : "warn"}
        />
        <KpiTile
          label={t("model.testWindows")}
          value={metrics?.n_test ?? "-"}
          meta={t("model.within5", {
            sbp: formatNumber((metrics?.within_5mmhg_sbp ?? 0) * 100, 0),
            dbp: formatNumber((metrics?.within_5mmhg_dbp ?? 0) * 100, 0)
          })}
        />
      </div>

      <div className="threeCol">
        <KpiTile
          label={t("model.modelLoaded")}
          value={health?.model_loaded ? t("model.yes") : health ? t("model.no") : t("lab.unknown")}
          tone={health?.model_loaded ? "good" : "neutral"}
        />
        <KpiTile
          label={t("model.supabase")}
          value={health?.supabase_configured ? t("model.configured") : health ? t("model.missing") : t("lab.unknown")}
          tone={health?.supabase_configured ? "good" : "warn"}
        />
        <KpiTile label={t("model.windowSize")} value={metrics?.window_s ?? 8} unit={t("common.sec")} meta={metrics?.feature_mode ?? "esp32_single_ppg"} />
      </div>

      <div className="twoCol">
        <Card>
          <div className="cardTitle">{t("model.physiology")}</div>
          <p className="muted">{t("model.physiologyBody")}</p>
        </Card>
        <Card className="callout">
          <div className="cardTitle">{t("model.uncertainty")}</div>
          <p className="muted">{t("model.uncertaintyBody")}</p>
        </Card>
      </div>

      <Card>
        <div className="cardTitle">{t("model.ahaTitle")}</div>
        <div className="threeCol">
          {m.model.ahaBands.map(([label, rule], index) => (
            <div className={`stageCard tone-${ahaTones[index]}`} key={label}>
              <span className="timelineDot" />
              <strong>{label}</strong>
              <p className="muted">{rule}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="cardTitle">{t("model.featureFamilies")}</div>
        <div className="threeCol">
          {m.model.featuresList.map((feature) => (
            <div className="stageCard" key={feature}>
              <span className="timelineDot" />
              <p className="muted">{feature}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="cardTitle">{t("model.limitations")}</div>
        <div className="timeline">
          {m.model.limitationItems.map((item) => (
            <div className="timelineItem" key={item}>
              <span className="timelineDot" />
              <p className="muted">{item}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
