"use client";

import { Card, SectionHeader } from "@/components/Card";
import { useI18n } from "@/lib/i18n";

export default function AboutPage() {
  const { t } = useI18n();

  return (
    <div className="pageStack">
      <SectionHeader eyebrow={t("about.eyebrow")} title={t("about.title")} />

      <div className="hero">
        <div className="heroCopy">
          <div>
            <div className="eyebrow">{t("about.opening")}</div>
            <div className="heroHeadline">{t("about.headline")}</div>
            <p className="muted">{t("about.body")}</p>
          </div>
        </div>
        <Card className="callout">
          <div className="cardTitle">{t("about.purpose")}</div>
          <p className="muted">{t("about.purposeBody")}</p>
        </Card>
      </div>

      <div className="threeCol">
        <Card>
          <div className="cardTitle">{t("about.showFirst")}</div>
          <p className="muted">{t("about.showFirstBody")}</p>
        </Card>
        <Card>
          <div className="cardTitle">{t("about.showSecond")}</div>
          <p className="muted">{t("about.showSecondBody")}</p>
        </Card>
        <Card>
          <div className="cardTitle">{t("about.showThird")}</div>
          <p className="muted">{t("about.showThirdBody")}</p>
        </Card>
      </div>

      <Card className="callout">
        <div className="cardTitle">{t("about.note")}</div>
        <p className="muted">{t("about.noteBody")}</p>
      </Card>
    </div>
  );
}
