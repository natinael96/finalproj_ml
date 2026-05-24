"""
Query Supabase directly with requests (no supabase package needed).
Auto-loads from .env.local (project root) or from environment variable.
Run:
    python query_observations.py
"""
import os, re, statistics
from pathlib import Path
from datetime import datetime, timezone
import requests

# ── load .env.local files (project root + dashboard/) ─────────
def _load_dotenv(path):
    try:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            v = v.strip().strip('"').strip("'")
            if k.strip() and v and k.strip() not in os.environ:
                os.environ[k.strip()] = v
    except FileNotFoundError:
        pass

_load_dotenv(Path(__file__).parent / ".env.local")
_load_dotenv(Path(__file__).parent / "dashboard" / ".env.local")

SUPABASE_URL = (os.environ.get("SUPABASE_URL") or
                os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or
                "https://uaboqplbyzuvagreoohy.supabase.co")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

if not KEY:
    print("\nERROR: SUPABASE_SERVICE_ROLE_KEY not found.")
    print("  Add it to .env.local in the project root, or:")
    print("  Git Bash:  export SUPABASE_SERVICE_ROLE_KEY=eyJ...")
    raise SystemExit(1)

print(f"  Loaded key from env  (prefix: {KEY[:20]}…)")
print(f"  Supabase URL         : {SUPABASE_URL}")

HEADERS = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
    "Prefer": "count=exact",
}

def q(table, select="*", order=None, limit=2000, filters=None):
    params = {"select": select, "limit": limit}
    if order:
        params["order"] = order
    if filters:
        params.update(filters)
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=HEADERS, params=params)
    r.raise_for_status()
    return r.json()

SEP = "=" * 65

print(f"\n{SEP}")
print("  LIVE DATABASE OBSERVATIONS")
print(SEP)

# ── RAW BATCHES ────────────────────────────────────────────────
batches = q("esp32_raw_batches",
            select="device_id,ts_ms_start,fs_hz,window_s,sample_count,cycle_id,created_at",
            order="ts_ms_start.asc")

devices     = sorted(set(b["device_id"] for b in batches if b.get("device_id")))
cycle_ids   = sorted(set(b["cycle_id"]  for b in batches if b.get("cycle_id")))
fs_vals     = [b["fs_hz"]        for b in batches if b.get("fs_hz")]
sc_vals     = [b["sample_count"] for b in batches if b.get("sample_count")]
ts_vals     = [b["ts_ms_start"]  for b in batches if b.get("ts_ms_start")]

print(f"\n{'─'*65}")
print("  6.4 — ESP32 Signal Acquisition")
print(f"{'─'*65}")
print(f"  Total raw batches stored         : {len(batches)}")
print(f"  Distinct devices                 : {devices}")
print(f"  Distinct prediction cycles       : {len(cycle_ids)}")

if fs_vals:
    print(f"  Reported fs_hz (all batches)     : {sorted(set(fs_vals))}")
if sc_vals:
    mode_sc = max(set(sc_vals), key=sc_vals.count)
    print(f"  Samples/batch (mode)             : {mode_sc}  (target: 20)")
    print(f"  Samples/batch min/max            : {min(sc_vals)} / {max(sc_vals)}")

if ts_vals:
    t0 = datetime.fromtimestamp(min(ts_vals)/1000, tz=timezone.utc)
    t1 = datetime.fromtimestamp(max(ts_vals)/1000, tz=timezone.utc)
    span_min = (max(ts_vals) - min(ts_vals)) / 60000
    print(f"  First batch (UTC)                : {t0.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  Last  batch (UTC)                : {t1.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  Total acquisition span           : {span_min:.1f} min")

# Per-device inter-batch timing
for dev in devices:
    dev_b = sorted([b for b in batches if b["device_id"] == dev and b.get("ts_ms_start")],
                   key=lambda x: x["ts_ms_start"])
    if len(dev_b) > 1:
        gaps = [dev_b[i+1]["ts_ms_start"] - dev_b[i]["ts_ms_start"]
                for i in range(len(dev_b)-1)]
        mean_g = statistics.mean(gaps)
        std_g  = statistics.stdev(gaps) if len(gaps) > 1 else 0
        cv     = std_g / mean_g * 100 if mean_g else 0
        print(f"\n  Device: {dev}")
        print(f"    Batches                        : {len(dev_b)}")
        print(f"    Inter-batch interval mean      : {mean_g:.0f} ms  (ideal: 1000 ms)")
        print(f"    Inter-batch interval std       : {std_g:.0f} ms")
        print(f"    Timing jitter (CV)             : {cv:.1f} %")
        late = sum(1 for g in gaps if g > 1500)
        print(f"    Late batches (>1.5 s gap)      : {late} ({late/len(gaps)*100:.1f}%)")

# Batches per cycle
cyc_counts = {}
for b in batches:
    c = b.get("cycle_id") or "none"
    cyc_counts[c] = cyc_counts.get(c, 0) + 1
if cyc_counts:
    vals = list(cyc_counts.values())
    print(f"\n  Batches per cycle — mean         : {statistics.mean(vals):.1f}  (target: 100 for 2000-sample window)")
    print(f"  Batches per cycle — min / max    : {min(vals)} / {max(vals)}")
    complete = sum(1 for v in vals if v >= 90)
    print(f"  Complete cycles (≥90 batches)    : {complete} / {len(vals)}")

# ── TELEMETRY WINDOWS ─────────────────────────────────────────
rows = q("telemetry_windows",
         select="device_id,ts_ms_start,sbp_pred,dbp_pred,sbp_std,dbp_std,synthetic,created_at",
         order="ts_ms_start.asc")

sbps     = [r["sbp_pred"] for r in rows if r.get("sbp_pred") is not None]
dbps     = [r["dbp_pred"] for r in rows if r.get("dbp_pred") is not None]
sbp_stds = [r["sbp_std"]  for r in rows if r.get("sbp_std")  is not None]
dbp_stds = [r["dbp_std"]  for r in rows if r.get("dbp_std")  is not None]
synth    = sum(1 for r in rows if r.get("synthetic"))

print(f"\n{'─'*65}")
print("  6.5 — BP Estimation vs Cuff Reference")
print(f"{'─'*65}")
print(f"  Total prediction windows         : {len(rows)}")
print(f"    → Real (sensor)                : {len(rows) - synth}")
print(f"    → Synthetic                    : {synth}")

if sbps:
    print(f"\n  SBP predictions (mmHg):")
    print(f"    Mean ± SD                      : {statistics.mean(sbps):.1f} ± {statistics.stdev(sbps) if len(sbps)>1 else 0:.1f}")
    print(f"    Median                         : {statistics.median(sbps):.1f}")
    print(f"    Range (min–max)                : {min(sbps):.1f} – {max(sbps):.1f}")

if dbps:
    print(f"\n  DBP predictions (mmHg):")
    print(f"    Mean ± SD                      : {statistics.mean(dbps):.1f} ± {statistics.stdev(dbps) if len(dbps)>1 else 0:.1f}")
    print(f"    Median                         : {statistics.median(dbps):.1f}")
    print(f"    Range (min–max)                : {min(dbps):.1f} – {max(dbps):.1f}")

if sbps and dbps:
    pps = [s - d for s, d in zip(sbps, dbps)]
    maps = [(s + 2*d)/3 for s, d in zip(sbps, dbps)]
    print(f"\n  Pulse Pressure (SBP−DBP):")
    print(f"    Mean ± SD                      : {statistics.mean(pps):.1f} ± {statistics.stdev(pps) if len(pps)>1 else 0:.1f} mmHg")
    print(f"  MAP estimate ((SBP+2×DBP)/3):")
    print(f"    Mean ± SD                      : {statistics.mean(maps):.1f} ± {statistics.stdev(maps) if len(maps)>1 else 0:.1f} mmHg")

if sbp_stds:
    print(f"\n  Model uncertainty SBP std        : {statistics.mean(sbp_stds):.2f} ± {statistics.stdev(sbp_stds) if len(sbp_stds)>1 else 0:.2f} mmHg")
if dbp_stds:
    print(f"  Model uncertainty DBP std        : {statistics.mean(dbp_stds):.2f} ± {statistics.stdev(dbp_stds) if len(dbp_stds)>1 else 0:.2f} mmHg")

def classify(s, d):
    if   s < 120 and d < 80:  return "Normal"
    elif s < 130 and d < 80:  return "Elevated"
    elif s < 140 or  d < 90:  return "HTN Stage 1"
    else:                      return "HTN Stage 2+"

if sbps and dbps:
    cls = [classify(s, d) for s, d in zip(sbps, dbps)]
    print(f"\n  AHA Classification of predictions:")
    for cat in ["Normal", "Elevated", "HTN Stage 1", "HTN Stage 2+"]:
        n = cls.count(cat); pct = n/len(cls)*100 if cls else 0
        bar = "█" * int(pct/5)
        print(f"    {cat:<18}: {n:>3}  ({pct:4.1f}%)  {bar}")

# Session-level temporal drift
sorted_rows = sorted([r for r in rows if r.get("sbp_pred") and r.get("ts_ms_start")],
                     key=lambda x: x["ts_ms_start"])
if len(sorted_rows) > 2:
    sbp_seq = [r["sbp_pred"] for r in sorted_rows]
    dbp_seq = [r["dbp_pred"] for r in sorted_rows]
    diffs_s = [abs(sbp_seq[i+1]-sbp_seq[i]) for i in range(len(sbp_seq)-1)]
    diffs_d = [abs(dbp_seq[i+1]-dbp_seq[i]) for i in range(len(dbp_seq)-1)]
    print(f"\n  Window-to-window consistency:")
    print(f"    SBP Δ mean / max             : {statistics.mean(diffs_s):.1f} / {max(diffs_s):.1f} mmHg")
    print(f"    DBP Δ mean / max             : {statistics.mean(diffs_d):.1f} / {max(diffs_d):.1f} mmHg")

# ── DASHBOARD / SYSTEM PERFORMANCE ────────────────────────────
print(f"\n{'─'*65}")
print("  6.6 — Real-Time Dashboard Performance")
print(f"{'─'*65}")
print(f"  Total telemetry rows available   : {len(rows)}")
print(f"  Total raw signal batches         : {len(batches)}")
if devices:
    print(f"  Devices registered               : {len(devices)}")
if cycle_ids:
    print(f"  Named cycles (UUIDs)             : {len(cycle_ids)}")

# Ingest-to-DB latency (created_at vs ts_ms_start)
latencies = []
for r in rows:
    if r.get("ts_ms_start") and r.get("created_at"):
        try:
            ct = datetime.fromisoformat(r["created_at"].replace("Z","+00:00")).timestamp()*1000
            lat = (ct - r["ts_ms_start"]) / 1000
            if 0 < lat < 600:
                latencies.append(lat)
        except Exception:
            pass

if latencies:
    print(f"\n  End-to-end latency (sensor ts → DB write):")
    print(f"    Mean                           : {statistics.mean(latencies):.1f} s")
    print(f"    Median                         : {statistics.median(latencies):.1f} s")
    print(f"    Std dev                        : {statistics.stdev(latencies) if len(latencies)>1 else 0:.1f} s")
    print(f"    Min / Max                      : {min(latencies):.1f} / {max(latencies):.1f} s")
    p95 = sorted(latencies)[int(len(latencies)*0.95)]
    print(f"    95th percentile                : {p95:.1f} s")

# ── FULL PREDICTION LOG ────────────────────────────────────────
print(f"\n{'─'*65}")
print("  Full Prediction Log")
print(f"{'─'*65}")
print(f"{'#':>3}  {'Device':<14}  {'SBP':>6}  {'DBP':>6}  {'PP':>6}  {'MAP':>6}  Time (UTC+3)")
print(f"{'─'*3}  {'─'*14}  {'─'*6}  {'─'*6}  {'─'*6}  {'─'*6}  {'─'*16}")
for i, r in enumerate(sorted_rows, 1):
    sbp = r.get("sbp_pred"); dbp = r.get("dbp_pred")
    ts  = r.get("ts_ms_start")
    t   = (datetime.fromtimestamp(ts/1000, tz=timezone.utc)
           .astimezone(None)
           .strftime("%H:%M:%S")) if ts else "—"
    dev = (r.get("device_id") or "—")[:13]
    if sbp and dbp:
        pp  = sbp - dbp
        m   = (sbp + 2*dbp)/3
        print(f"{i:>3}  {dev:<14}  {sbp:>6.1f}  {dbp:>6.1f}  {pp:>6.1f}  {m:>6.1f}  {t}")
    else:
        print(f"{i:>3}  {dev:<14}  {'—':>6}  {'—':>6}  {'—':>6}  {'—':>6}  {t}")

print(f"\n{SEP}")
print("  Done — paste this output back to the assistant")
print(f"{SEP}\n")
