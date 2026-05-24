"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ClinicalBanner } from "@/components/ClinicalBanner";
import { useTheme } from "@/components/Providers";
import { useI18n } from "@/lib/i18n";
import type { Locale } from "@/lib/preferences";

const navKeys = [
  { href: "/overview", key: "nav.overview" },
  { href: "/live", key: "nav.live" },
  { href: "/history", key: "nav.history" },
  { href: "/devices", key: "nav.devices" },
  { href: "/model", key: "nav.model" },
  { href: "/about", key: "nav.about" }
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { locale, setLocale, t } = useI18n();
  const { theme, setTheme } = useTheme();

  return (
    <div className="appShell">
      <aside className="sidebar">
        <Link href="/overview" className="brandBlock" aria-label={t("nav.overview")}>
          <span className="brandMark">BP</span>
          <span>
            <span className="brandTitle">{t("nav.brandTitle")}</span>
            <span className="brandSub">{t("nav.brandSub")}</span>
          </span>
        </Link>

        <div className="toolbar" role="toolbar" aria-label={t("common.language")}>
          <label className="toolbarField">
            <span className="toolbarLabel">{t("common.language")}</span>
            <select
              value={locale}
              onChange={(event) => setLocale(event.target.value as Locale)}
              aria-label={t("common.language")}
            >
              <option value="en">{t("common.langEn")}</option>
              <option value="am">{t("common.langAm")}</option>
            </select>
          </label>
          <label className="toolbarField">
            <span className="toolbarLabel">{t("common.theme")}</span>
            <select
              value={theme}
              onChange={(event) => setTheme(event.target.value as "light" | "dark")}
              aria-label={t("common.theme")}
            >
              <option value="light">{t("common.themeLight")}</option>
              <option value="dark">{t("common.themeDark")}</option>
            </select>
          </label>
        </div>

        <nav className="sideNav" aria-label="Dashboard navigation">
          {navKeys.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href || (pathname === "/" && item.href === "/overview") ? "active" : ""}
            >
              {t(item.key)}
            </Link>
          ))}
        </nav>
        <div className="sidebarNote">
          <span className="eyebrow">{t("nav.brandSub")}</span>
          <p>{t("nav.sidebarNote")}</p>
        </div>
      </aside>
      <main className="mainPanel">
        <ClinicalBanner />
        {children}
      </main>
    </div>
  );
}
