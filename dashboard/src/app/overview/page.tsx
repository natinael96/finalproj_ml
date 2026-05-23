"use client";

import Link from "next/link";
import { Card, SectionHeader } from "@/components/Card";
import { KpiTile } from "@/components/KpiTile";
import { useI18n } from "@/lib/i18n";

export default function OverviewPage() {
  const { messages: m, t } = useI18n();

  return (
    <div className="pageStack">
      <SectionHeader eyebrow={t("overview.eyebrow")} title={t("overview.title")} />
      <div className="hero">
        <div className="heroCopy">
          <div>
            <div className="eyebrow">{t("overview.heroEyebrow")}</div>
            <div className="heroHeadline">{t("overview.heroHeadline")}</div>
            <p className="muted">{t("overview.heroBody")}</p>
          </div>
          <div className="heroStrip">
            <Link href="/live" className="badge">{t("overview.openLive")}</Link>
            <Link href="/history" className="badge">{t("overview.viewHistory")}</Link>
            <Link href="/lab" className="badge">{t("overview.testLab")}</Link>
            <Link href="/model" className="badge">{t("overview.explainModel")}</Link>
          </div>
        </div>
        <div className="heroPanel">
          <KpiTile label={t("overview.predictionTarget")} value="SBP / DBP" meta={t("overview.predictionMeta")} />
          <KpiTile label={t("overview.windowCadence")} value="8" unit={t("common.sec")} meta={t("overview.windowMeta")} />
          <KpiTile label={t("overview.primarySource")} value="ECG + PPG" meta={t("overview.primaryMeta")} />
        </div>
      </div>

      <div className="twoCol">
        <Card>
          <div className="cardTitle">{t("overview.demoChecklist")}</div>
          <div className="timeline">
            {m.overview.demoSteps.map((item) => (
              <div className="timelineItem" key={item}>
                <span className="timelineDot" />
                <p className="muted">{item}</p>
              </div>
            ))}
          </div>
        </Card>
        <Card className="callout">
          <div className="cardTitle">{t("overview.presentationMap")}</div>
          <p className="muted">{t("overview.presentationBody")}</p>
        </Card>
      </div>

      <Card className="callout">
        <div className="cardTitle">{t("overview.limitation")}</div>
        <p className="muted">{t("overview.limitationBody")}</p>
      </Card>

      <Card>
        <div className="cardTitle">{t("overview.pipeline")}</div>
        <div className="fiveStageGrid">
          {m.overview.stages.map(([title, text]) => (
            <div className="stageCard" key={title}>
              <div className="eyebrow">{title}</div>
              <p className="muted">{text}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
