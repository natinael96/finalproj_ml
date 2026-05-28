export type Theme = "light" | "dark";
export type Locale = "en" | "am";

export const PREF_THEME = "bp-dashboard-theme";
export const PREF_LOCALE = "bp-dashboard-locale";
export const PREF_DISCLAIMER_DISMISSED = "bp-dashboard-disclaimer-dismissed";

export function readTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(PREF_THEME);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function readLocale(): Locale {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(PREF_LOCALE);
  return stored === "am" ? "am" : "en";
}

export function readDisclaimerDismissed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(PREF_DISCLAIMER_DISMISSED) === "1";
}
