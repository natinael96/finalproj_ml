"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { useT } from "@/lib/i18n";
import { supabase, supabaseEnvMissing, supabaseStorageKey } from "@/lib/supabaseClient";
import { Card } from "./Card";

type AuthMode = "signIn" | "signUp";

function clearStoredSupabaseSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(supabaseStorageKey);
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith("sb-") && key.endsWith("-auth-token")) {
      window.localStorage.removeItem(key);
    }
  }
}

export function AuthGate({
  children,
  title
}: {
  children: (session: Session) => ReactNode;
  title?: string;
}) {
  const t = useT();
  const gateTitle = title ?? t("auth.signInTitle");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("signIn");
  const [showPassword, setShowPassword] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!supabase) return;
    let mounted = true;
    const client = supabase;

    client.auth
      .getSession()
      .then(({ data }) => {
        if (mounted) setSession(data.session);
      })
      .catch((error) => {
        if (!mounted) return;
        clearStoredSupabaseSession();
        setStatus(`Supabase auth is unreachable: ${error instanceof Error ? error.message : String(error)}`);
      });

    const { data: sub } = client.auth.onAuthStateChange((_event, currentSession) => {
      setSession(currentSession);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function signIn() {
    if (!supabase) return;
    if (!email.trim() || !password) {
      setStatus("Enter your email and password to sign in.");
      return;
    }
    try {
      setStatus("Signing in...");
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setStatus(error ? `Error: ${error.message}` : "");
    } catch (error) {
      setStatus(`Sign-in request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function resetLocalSession() {
    clearStoredSupabaseSession();
    setSession(null);
    setStatus("Cleared the saved Supabase session. Refresh the page, then sign in again.");
  }

  async function signUp() {
    if (!supabase) return;
    if (!email.trim() || !password || !confirmPassword) {
      setStatus("Enter an email, password, and password confirmation to create an account.");
      return;
    }
    if (password.length < 6) {
      setStatus("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setStatus("Passwords do not match.");
      return;
    }
    try {
      setStatus("Creating account...");
      const { error } = await supabase.auth.signUp({ email, password });
      setStatus(error ? `Error: ${error.message}` : "Check your email if confirmations are enabled.");
    } catch (error) {
      setStatus(`Sign-up request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authMode === "signIn") await signIn();
    else await signUp();
  }

  if (supabaseEnvMissing()) {
    return (
      <Card>
        <div className="cardTitle">{t("auth.missingEnv")}</div>
        <p className="muted">{t("auth.missingEnvBody")}</p>
      </Card>
    );
  }

  if (!session) {
    return (
      <Card className="authCard">
        <div>
          <div className="eyebrow">Telemetry access</div>
          <h1>{gateTitle}</h1>
          <p className="muted">
            Supabase RLS keeps windows scoped to the signed-in user. Use this account&apos;s user id when
            starting ESP32 or replay ingest.
          </p>
        </div>
        <div className="seg" aria-label="Authentication mode">
          <button
            type="button"
            className={authMode === "signIn" ? "active" : ""}
            onClick={() => {
              setAuthMode("signIn");
              setStatus("");
            }}
          >
            {t("auth.signIn")}
          </button>
          <button
            type="button"
            className={authMode === "signUp" ? "active" : ""}
            onClick={() => {
              setAuthMode("signUp");
              setStatus("");
            }}
          >
            {t("auth.signUp")}
          </button>
        </div>
        <form className="authForm" onSubmit={submitAuth}>
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t("auth.email")}
            className="input"
            type="email"
            autoComplete="email"
          />
          <div className="passwordField">
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("auth.password")}
              type={showPassword ? "text" : "password"}
              className="input"
              autoComplete={authMode === "signIn" ? "current-password" : "new-password"}
            />
            <button
              type="button"
              className="passwordToggle"
              onClick={() => setShowPassword((current) => !current)}
              aria-label={showPassword ? t("auth.hide") : t("auth.show")}
            >
              {showPassword ? t("auth.hide") : t("auth.show")}
            </button>
          </div>
          {authMode === "signUp" ? (
            <div className="passwordField">
              <input
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder={t("auth.confirmPassword")}
                type={showPassword ? "text" : "password"}
                className="input"
                autoComplete="new-password"
              />
              <button
                type="button"
                className="passwordToggle"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? "Hide password confirmation" : "Show password confirmation"}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          ) : null}
          <button className="btn btnPrimary" type="submit">
            {authMode === "signIn" ? t("auth.signIn") : t("auth.signUp")}
          </button>
        </form>
        {status ? (
          <div className="grid">
            <div className="muted">{status}</div>
            {status.toLowerCase().includes("supabase") || status.toLowerCase().includes("fetch") ? (
              <button type="button" className="btn" onClick={resetLocalSession}>
                Clear saved session
              </button>
            ) : null}
          </div>
        ) : null}
      </Card>
    );
  }

  return <>{children(session)}</>;
}

export function UserBadge({ session }: { session: Session }) {
  const t = useT();
  const [status, setStatus] = useState("");
  const userId = session.user.id;

  async function copyUserId() {
    try {
      await navigator.clipboard.writeText(userId);
      setStatus("Copied");
      setTimeout(() => setStatus(""), 1500);
    } catch {
      setStatus("Copy failed");
      setTimeout(() => setStatus(""), 1500);
    }
  }

  async function signOut() {
    await supabase?.auth.signOut();
  }

  return (
    <div className="userBadge">
      <span>
        user_id <strong className="num">{userId.slice(0, 8)}...</strong>
      </span>
      <button type="button" className="btn btnTiny" onClick={copyUserId}>
        {status || t("auth.copyUserId")}
      </button>
      <button type="button" className="btn btnTiny" onClick={signOut}>
        {t("auth.signOut")}
      </button>
    </div>
  );
}
