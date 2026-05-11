"use client";

import { useEffect, useState } from "react";
import { supabase, supabaseEnvMissing } from "@/lib/supabaseClient";
import Link from "next/link";

type WindowRow = {
  id: string;
  created_at: string;
  device_id: string;
  sbp_pred: number | null;
  dbp_pred: number | null;
  sbp_std: number | null;
  dbp_std: number | null;
};

function Card({ children }: { children: React.ReactNode }) {
  return <div className="card">{children}</div>;
}

export default function HomePage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [session, setSession] = useState<any>(null);
  const [rows, setRows] = useState<WindowRow[]>([]);
  const [status, setStatus] = useState<string>("");
  const latest = rows[0];
  const [mode, setMode] = useState<"user" | "detailed">("user");
  const userId: string | undefined = session?.user?.id;

  async function copyUserId() {
    if (!userId) return;
    try {
      await navigator.clipboard.writeText(userId);
      setStatus("Copied user_id to clipboard.");
      setTimeout(() => setStatus(""), 1500);
    } catch {
      setStatus("Copy failed (clipboard blocked).");
      setTimeout(() => setStatus(""), 1500);
    }
  }

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    if (!supabase) return;

    let cancelled = false;
    (async () => {
      setStatus("Loading recent telemetry...");
      const { data, error } = await supabase
        .from("telemetry_windows")
        .select("id,created_at,device_id,sbp_pred,dbp_pred,sbp_std,dbp_std")
        .order("created_at", { ascending: false })
        .limit(50);
      if (cancelled) return;
      if (error) setStatus(`Error: ${error.message}`);
      else {
        setRows((data ?? []) as any);
        setStatus("");
      }
    })();

    const channel = supabase
      .channel("telemetry_windows_live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "telemetry_windows" },
        (payload) => {
          const r = payload.new as any as WindowRow;
          setRows((prev) => [r, ...prev].slice(0, 50));
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase?.removeChannel(channel);
    };
  }, [session]);

  // Extra live channel: FastAPI -> Dashboard websocket (works even without Supabase Realtime)
  useEffect(() => {
    if (!session) return;
    const url = "ws://127.0.0.1:8000/ws/dashboard";
    const ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === "telemetry_window") {
          const r: WindowRow = {
            id: String(msg.ts_ms_start ?? Date.now()),
            created_at: new Date().toISOString(),
            device_id: String(msg.device_id ?? "device"),
            sbp_pred: typeof msg.sbp_pred === "number" ? msg.sbp_pred : null,
            dbp_pred: typeof msg.dbp_pred === "number" ? msg.dbp_pred : null,
            sbp_std: null,
            dbp_std: null
          };
          setRows((prev) => [r, ...prev].slice(0, 50));
        }
      } catch {
        // ignore
      }
    };
    ws.onopen = () => ws.send("hello");
    return () => ws.close();
  }, [session]);

  async function signIn() {
    setStatus("Signing in...");
    if (!supabase) return;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setStatus(error ? `Error: ${error.message}` : "");
  }

  async function signUp() {
    setStatus("Creating account...");
    if (!supabase) return;
    const { error } = await supabase.auth.signUp({ email, password });
    setStatus(
      error
        ? `Error: ${error.message}`
        : "Check your email (if confirmations are enabled)."
    );
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  return (
    <div className="container">
      <div className="topbar">
        <div>
          <div className="brandTitle">Clinical BP Monitor</div>
          <div className="brandSub">
            Live inference windows from <code>telemetry_windows</code>
          </div>
        </div>
        <div className="nav">
          {session ? (
            <span className="seg" aria-label="Dashboard mode">
              <button
                type="button"
                className={mode === "user" ? "active" : ""}
                onClick={() => setMode("user")}
              >
                User mode
              </button>
              <button
                type="button"
                className={mode === "detailed" ? "active" : ""}
                onClick={() => setMode("detailed")}
              >
                Detailed
              </button>
            </span>
          ) : null}
          <span className="pill">
            <span className="dot" />
            <span style={{ fontSize: 12, color: "var(--muted)" }}>Listening</span>
          </span>
          {session ? (
            <span className="badge" title="Use this in the replay script as --user-id">
              user_id: <span className="num" style={{ marginLeft: 6 }}>{userId?.slice(0, 8) ?? "—"}…</span>
              <button
                type="button"
                onClick={copyUserId}
                className="btn"
                style={{ padding: "6px 10px", marginLeft: 10 }}
              >
                Copy
              </button>
            </span>
          ) : null}
          <Link href="/history" className="badge">
            History
          </Link>
          {session ? (
            <button onClick={signOut} className="btn">
              Sign out
            </button>
          ) : null}
        </div>
      </div>

      {supabaseEnvMissing() ? (
        <Card>
          <div style={{ fontWeight: 760, marginBottom: 8 }}>Missing dashboard env vars</div>
          <div style={{ color: "var(--muted)", lineHeight: 1.6 }}>
            Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in{" "}
            <code>dashboard/.env.local</code> (copy from <code>.env.local.example</code>), then restart{" "}
            <code>npm run dev</code>.
          </div>
        </Card>
      ) : !session ? (
        <Card>
          <div style={{ fontWeight: 760, marginBottom: 10 }}>Sign in</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: 10 }}>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email"
              className="input"
            />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              type="password"
              className="input"
            />
            <button onClick={signIn} className="btn btnPrimary">
              Sign in
            </button>
            <button onClick={signUp} className="btn">
              Sign up
            </button>
          </div>
          {status ? <div style={{ marginTop: 10, color: "var(--muted)" }}>{status}</div> : null}
        </Card>
      ) : (
        <div className="grid">
          {status ? <div style={{ color: "var(--muted)" }}>{status}</div> : null}
          <div className="kpiGrid">
            <Card>
              <div className="kpiLabel">Latest window</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginTop: 10 }}>
                <div>
                  <div className="kpiValue num">
                    {latest?.sbp_pred == null ? "—" : latest.sbp_pred.toFixed(0)}
                    <span style={{ fontSize: 14, color: "var(--muted)", marginLeft: 8 }}>SBP</span>
                  </div>
                  <div className="kpiMeta">
                    σ {latest?.sbp_std == null ? "—" : latest.sbp_std.toFixed(2)}
                  </div>
                </div>
                <div style={{ width: 1, alignSelf: "stretch", background: "var(--line)" }} />
                <div>
                  <div className="kpiValue num">
                    {latest?.dbp_pred == null ? "—" : latest.dbp_pred.toFixed(0)}
                    <span style={{ fontSize: 14, color: "var(--muted)", marginLeft: 8 }}>DBP</span>
                  </div>
                  <div className="kpiMeta">
                    σ {latest?.dbp_std == null ? "—" : latest.dbp_std.toFixed(2)}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <span className="badge">
                  device: <span className="num" style={{ marginLeft: 6 }}>{latest?.device_id ?? "—"}</span>
                </span>
                <span className="badge">
                  time:{" "}
                  <span className="num" style={{ marginLeft: 6 }}>
                    {latest?.created_at ? new Date(latest.created_at).toLocaleTimeString() : "—"}
                  </span>
                </span>
                {mode === "detailed" ? (
                  <span className="badge">
                    row_id: <span className="num" style={{ marginLeft: 6 }}>{latest?.id ?? "—"}</span>
                  </span>
                ) : null}
              </div>
            </Card>
            <Card>
              <div className="kpiLabel">Guidance</div>
              <div style={{ marginTop: 10, color: "var(--muted)", lineHeight: 1.6 }}>
                Stream ESP32 chunks to <code>/ws/ingest</code>. Each insert becomes one telemetry window.
                Use the History view during your demo to show trends.
              </div>
            </Card>
            <Card>
              <div className="kpiLabel">Status</div>
              <div style={{ marginTop: 10, color: "var(--muted)", lineHeight: 1.6 }}>
                RLS is enabled. Ensure you’re signed in with the same user that writes rows (or use Service Role on the backend).
              </div>
            </Card>
          </div>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <div style={{ fontWeight: 760 }}>Live feed</div>
              <div className="brandSub">
                {mode === "user" ? "latest 20 (curated)" : "latest 50 (full)"}
              </div>
            </div>
            <div className="tableWrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr style={{ textAlign: "left", opacity: 0.85 }}>
                    <th>time</th>
                    <th>device</th>
                    <th>SBP</th>
                    <th>DBP</th>
                    <th>σ(SBP)</th>
                    <th>σ(DBP)</th>
                    {mode === "detailed" ? <th>id</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {(mode === "user" ? rows.slice(0, 20) : rows).map((r) => (
                    <tr
                      key={r.id}
                    >
                      <td style={{ whiteSpace: "nowrap" }}>
                        {new Date(r.created_at).toLocaleString()}
                      </td>
                      <td>{r.device_id}</td>
                      <td className="num">
                        {r.sbp_pred == null ? "-" : r.sbp_pred.toFixed(1)}
                      </td>
                      <td className="num">
                        {r.dbp_pred == null ? "-" : r.dbp_pred.toFixed(1)}
                      </td>
                      <td className="num">
                        {r.sbp_std == null ? "-" : r.sbp_std.toFixed(2)}
                      </td>
                      <td className="num">
                        {r.dbp_std == null ? "-" : r.dbp_std.toFixed(2)}
                      </td>
                      {mode === "detailed" ? <td className="num">{r.id}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

