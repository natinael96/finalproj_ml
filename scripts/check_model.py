#!/usr/bin/env python3
"""
Model health-check script.
Loads artifacts_live/ and runs a battery of sanity checks on the saved model.

Run:  python scripts/check_model.py
"""
import json, sys, time
from pathlib import Path


#abeselom was here
import joblib
import numpy as np
import sys

ROOT       = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
from bp_pipeline.inference import load_artifact_bundle, apply_bp_constraints
ARTIFACTS  = ROOT / "artifacts_live"
MODEL_PATH = ARTIFACTS / "model.joblib"
SCHEMA_PATH= ARTIFACTS / "feature_schema.json"
METRICS_PATH = ARTIFACTS / "metrics.json"

SEP = "=" * 62

def banner(title):
    print(f"\n{SEP}")
    print(f"  {title}")
    print(SEP)

def ok(msg):  print(f"  [OK]  {msg}")
def warn(msg):print(f"  [!!]  {msg}")
def info(msg):print(f"        {msg}")

# ── 1. File presence ──────────────────────────────────────────────────────────
banner("1 · Artifact files")
for p in (MODEL_PATH, SCHEMA_PATH, METRICS_PATH):
    size_kb = p.stat().st_size / 1024 if p.exists() else 0
    if p.exists():
        ok(f"{p.name:30s}  {size_kb:8.1f} KB")
    else:
        warn(f"{p.name:30s}  NOT FOUND"); sys.exit(1)

# ── 2. Feature schema ─────────────────────────────────────────────────────────
banner("2 · Feature schema")
schema = json.loads(SCHEMA_PATH.read_text())
names  = schema.get("names", [])
ok(f"{len(names)} features")
for i, n in enumerate(names):
    info(f"  {i+1:2d}. {n}")

# ── 3. Saved metrics ──────────────────────────────────────────────────────────
banner("3 · Saved training metrics")
metrics = json.loads(METRICS_PATH.read_text())
targets = {
    "mae_sbp": ("<= 15 mmHg",  15.0),
    "mae_dbp": ("<= 10 mmHg",  10.0),
    "rmse_sbp":("acceptable",  None),
    "rmse_dbp":("acceptable",  None),
    "within_5mmhg_sbp": (">= 35 %", 0.35),
    "within_5mmhg_dbp": (">= 40 %", 0.40),
}
for key, (label, threshold) in targets.items():
    val = metrics.get(key)
    if val is None: info(f"{key:30s}: N/A"); continue
    display = f"{val:.4f}" if isinstance(val, float) else str(val)
    if threshold is None:
        ok(f"{key:30s}: {display}  [{label}]")
    elif ("mae" in key or "rmse" in key) and val <= threshold:
        ok(f"{key:30s}: {display}  [{label}]")
    elif "within" in key and val >= threshold:
        ok(f"{key:30s}: {display}  [{label}]")
    else:
        warn(f"{key:30s}: {display}  [{label}] — BELOW TARGET")

info(f"\n  n_train={metrics.get('n_train_fit')}  "
     f"n_test={metrics.get('n_test')}  "
     f"split={metrics.get('split_method')}  "
     f"model={metrics.get('model_kind')}")
info(f"  feature_mode={metrics.get('feature_mode')}  "
     f"live_compatible={metrics.get('live_schema_compatible')}")

# ── 4. Load model ─────────────────────────────────────────────────────────────
banner("4 · Model loading")

# Inspect raw dict first
t0 = time.perf_counter()
raw = joblib.load(MODEL_PATH)
raw_ms = (time.perf_counter() - t0) * 1000
ok(f"Raw joblib load in {raw_ms:.1f} ms  —  type: {type(raw).__name__}")
if isinstance(raw, dict):
    for k, v in raw.items():
        info(f"  raw['{k}']:  {type(v).__name__}")

# Now load via the proper inference wrapper
t0 = time.perf_counter()
bundle = load_artifact_bundle(MODEL_PATH)
wrap_ms = (time.perf_counter() - t0) * 1000
ok(f"ArtifactBundle wrapped in {wrap_ms:.1f} ms")

for attr in ("model","schema_names","med_map","calibrator","imputer","feat_idx"):
    val = getattr(bundle, attr, None)
    present = val is not None
    status = "OK" if present else "  "
    label = type(val).__name__ if present else "None"
    extra = f" ({len(val)})" if present and hasattr(val, "__len__") and not isinstance(val, str) else ""
    info(f"  [{status}] bundle.{attr:20s}: {label}{extra}")

n_features_bundle = len(bundle.schema_names or [])
if n_features_bundle != len(names):
    warn(f"Schema mismatch: bundle has {n_features_bundle} features, "
         f"feature_schema.json has {len(names)}")
else:
    ok(f"Schema sizes match ({n_features_bundle} features)")

# Confirm underlying estimator
et = bundle.model
ok(f"Estimator: {type(et).__name__}  "
   f"n_estimators={getattr(et,'n_estimators','?')}  "
   f"n_outputs={getattr(et,'n_outputs_','?')}")

# ── 5. Inference speed & output range ─────────────────────────────────────────
banner("5 · Inference smoke-tests")

# Build test vectors for rest, walk, run
import math

def make_vec(hr, ptt, activity_idx):
    """Minimal feature vector matching feature_schema.json order."""
    rr  = 60.0 / hr
    inv = 1.0 / ptt
    vals = {
        "rr_mean_s":    rr,
        "gyro_rms":     0.02  + 0.27*activity_idx,
        "ppg_std":      8200  + 1200*activity_idx,
        "acc_jerk_rms": 0.07  + 1.10*activity_idx,
        "acc_rms":      10.70 + 0.80*activity_idx,
        "gyro_jerk_rms":0.042 + 0.37*activity_idx,
        "rr_std_s":     0.042 - 0.010*activity_idx,
        "inv_ptt_x_hr": inv * hr,
        "ptt_std_s":    0.013 + 0.002*activity_idx,
        "hrv_rmssd_s":  0.044 - 0.011*activity_idx,
        "ppg_kurtosis": 5.8   - 0.6*activity_idx,
        "ppg_mean":     62500 - 800*activity_idx,
        "pwv_proxy":    inv * 0.80,
        "ptt_mean_s":   ptt,
        "inv_ptt":      inv,
        "inv_ptt2":     inv**2,
        "log_ptt":      math.log(ptt),
        "ppg_skew":     -1.9  + 0.4*activity_idx,
    }
    return np.array([vals[n] for n in names], dtype=float)

test_cases = [
    ("rest",  67,  0.252, 0),
    ("walk",  89,  0.200, 1),
    ("run",  151,  0.154, 2),
    ("edge: very fast HR", 185, 0.120, 2),
    ("edge: very slow HR",  45, 0.320, 0),
]

rng = np.random.default_rng(42)
all_ok = True
for label, hr, ptt, idx in test_cases:
    vec = make_vec(hr, ptt, idx)
    t0 = time.perf_counter()
    try:
        sbp, dbp = bundle.predict(vec)          # returns (float, float)
        elapsed_ms = (time.perf_counter() - t0) * 1000
        pp = sbp - dbp
        ok_range = (70 <= sbp <= 220) and (40 <= dbp <= 130) and (pp >= 10)
        status = "OK" if ok_range else "!!"
        print(f"  [{status}] {label:28s}  "
              f"HR={hr:3d}  PTT={ptt*1000:.0f}ms  →  "
              f"SBP={sbp:6.1f}  DBP={dbp:5.1f}  PP={pp:5.1f}  "
              f"({elapsed_ms:.1f} ms)")
        if not ok_range:
            all_ok = False
            warn(f"       Output out of physiological range!")
    except Exception as e:
        warn(f"{label}: prediction failed — {e}")
        all_ok = False

# ── 6. Batch throughput ───────────────────────────────────────────────────────
banner("6 · Batch throughput")
N = 500
X_batch = rng.normal(0, 1, (N, len(names)))
# Fill with plausible values
X_batch[:, names.index("rr_mean_s")]  = rng.uniform(0.35, 1.2, N)
X_batch[:, names.index("ptt_mean_s")] = rng.uniform(0.10, 0.40, N)
X_batch[:, names.index("inv_ptt")]    = 1.0 / X_batch[:, names.index("ptt_mean_s")]
X_batch[:, names.index("inv_ptt2")]   = X_batch[:, names.index("inv_ptt")] ** 2
X_batch[:, names.index("log_ptt")]    = np.log(X_batch[:, names.index("ptt_mean_s")])

t0 = time.perf_counter()
preds = bundle.predict_batch(X_batch)
batch_ms = (time.perf_counter() - t0) * 1000
per_pred = batch_ms / N
ok(f"{N} predictions in {batch_ms:.1f} ms  →  {per_pred:.2f} ms/pred")
if per_pred < 5.0:
    ok("Throughput sufficient for real-time use (< 5 ms/pred)")
else:
    warn(f"Prediction latency {per_pred:.1f} ms may be too slow")

# ── 7. NaN/Inf robustness ─────────────────────────────────────────────────────
banner("7 · NaN / Inf robustness")
vec_nan = make_vec(70, 0.230, 0).reshape(1, -1)
vec_nan[0, 0] = float("nan")
vec_nan[0, 3] = float("inf")
try:
    sbp, dbp = bundle.predict(vec_nan.ravel())
    if np.isfinite(sbp) and np.isfinite(dbp):
        ok(f"NaN/Inf imputed gracefully  →  SBP={sbp:.1f}  DBP={dbp:.1f}")
    else:
        warn(f"Output contains NaN/Inf: {sbp}, {dbp}")
except Exception as e:
    warn(f"Crashed on NaN input: {e}")

# ── Summary ───────────────────────────────────────────────────────────────────
banner("Summary")
print(f"  Model   : {metrics.get('model_kind')}")
print(f"  Features: {n_features_bundle}")
print(f"  MAE SBP : {metrics.get('mae_sbp', '?'):.2f} mmHg")
print(f"  MAE DBP : {metrics.get('mae_dbp', '?'):.2f} mmHg")
print(f"  RMSE SBP: {metrics.get('rmse_sbp', '?'):.2f} mmHg")
print(f"  RMSE DBP: {metrics.get('rmse_dbp', '?'):.2f} mmHg")
print(f"  ±5 mmHg SBP: {metrics.get('within_5mmhg_sbp',0)*100:.1f}%")
print(f"  ±5 mmHg DBP: {metrics.get('within_5mmhg_dbp',0)*100:.1f}%")
print(f"  Train N : {metrics.get('n_train_fit')}   Test N: {metrics.get('n_test')}")
print(SEP)
