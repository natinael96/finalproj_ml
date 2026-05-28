"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { am } from "./am";
import { en, type Messages } from "./en";
import { PREF_LOCALE, readLocale, type Locale } from "@/lib/preferences";

const catalogs: Record<Locale, Messages> = { en, am };

type I18nContextValue = {
  locale: Locale;
  messages: Messages;
  setLocale: (locale: Locale) => void;
  t: (path: string, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function interpolate(template: string, vars?: Record<string, string | number>) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? `{${key}}`));
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    setLocaleState(readLocale());
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    window.localStorage.setItem(PREF_LOCALE, next);
    document.documentElement.lang = next === "am" ? "am" : "en";
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "am" ? "am" : "en";
  }, [locale]);

  const messages = catalogs[locale];

  const t = useCallback(
    (path: string, vars?: Record<string, string | number>) => {
      const value = getByPath(messages as unknown as Record<string, unknown>, path);
      if (typeof value === "string") return interpolate(value, vars);
      return path;
    },
    [messages]
  );

  const value = useMemo(() => ({ locale, messages, setLocale, t }), [locale, messages, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within LocaleProvider");
  return ctx;
}

export function useT() {
  return useI18n().t;
}

export { en, am, type Messages };
