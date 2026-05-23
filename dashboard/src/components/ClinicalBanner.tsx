"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { PREF_DISCLAIMER_DISMISSED, readDisclaimerDismissed } from "@/lib/preferences";

export function ClinicalBanner() {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(!readDisclaimerDismissed());
  }, []);

  function dismiss() {
    window.localStorage.setItem(PREF_DISCLAIMER_DISMISSED, "1");
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="clinicalBanner" role="note">
      <div className="clinicalBannerCopy">
        <strong>{t("disclaimer.title")}</strong>
        <span>{t("disclaimer.body")}</span>
      </div>
      <button type="button" className="btn clinicalBannerDismiss" onClick={dismiss}>
        {t("common.dismiss")}
      </button>
    </div>
  );
}
