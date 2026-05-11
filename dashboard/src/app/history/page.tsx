"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, supabaseEnvMissing } from "@/lib/supabaseClient";

type WindowRow = {
  id: string;
  created_at: string;
  device_id: string;
  sbp_pred: number | null;
  dbp_pred: number | null;
};

export default function HistoryPage() {
  const [rows, setRows] = useState<WindowRow[]>([]);
  const [device, setDevice] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [mode, setMode] = useState<"user" | "detailed">("user");

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    (async () => {
      setStatus("Loading...");
      const q = supabase
        .from("telemetry_windows")
        .select("id,created_at,device_id,sbp_pred,dbp_pred")
        .order("created_at", { ascending: false })
        .limit(500);
      const { data, error } = device ? await q.eq("device_id", device) : await q;
      if (cancelled) return;
      if (error) setStatus(`Error: ${error.message}`);
      else {
        setRows((data ?? []) as any);
        setStatus("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device]);

  const devices = useMemo(() => {
    const s = new Set(rows.map((r) => r.device_id).filter(Boolean));
    return Array.from(s).sort();
  }, [rows]);

  return (
    <div className="container">
      <div className="topbar" style={{ alignItems: "flex-end" }}>
        <div>
          <div className="brandTitle">History</div>
          <div className="brandSub">Last {mode === "user" ? "100" : "500"} windows</div>
        </div>
        <div className="nav">
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
          <Link href="/" className="badge">
            Live
          </Link>
        </div>
      </div>

      <div className="card">
        {supabaseEnvMissing() ? (
          <div style={{ color: "var(--muted)", lineHeight: 1.6 }}>
            Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in{" "}
            <code>dashboard/.env.local</code>, then restart <code>npm run dev</code>.
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ color: "var(--muted)" }}>Device filter</div>
          <select
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            className="input"
            style={{ width: 220 }}
          >
            <option value="">All</option>
            {devices.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          {status ? <div style={{ color: "var(--muted)" }}>{status}</div> : null}
        </div>

        <div className="tableWrap">
          <table>
            <thead>
              <tr style={{ textAlign: "left", opacity: 0.85 }}>
                <th>time</th>
                <th>device</th>
                <th>SBP</th>
                <th>DBP</th>
                {mode === "detailed" ? <th>id</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, mode === "user" ? 100 : 500).map((r) => (
                <tr key={r.id}>
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
                  {mode === "detailed" ? <td className="num">{r.id}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

