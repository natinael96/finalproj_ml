# Project progress — cuff-less BP estimation MVP

This document summarizes what was implemented in this repository, how the pieces connect, and what to run next.

## Goals (from your pipeline spec)

- **Sensors → preprocessing → feature engineering → (optional) feature selection → model → predictions (SBP, DBP) → API + dashboard**
- **MVP model**: multi-output **Random Forest** on a compact feature set (top‑k selection supported).

---

## ML pipeline — detailed architecture

This section describes **what happens in code**, stage by stage, from raw data to deployed prediction.

### High-level flow

```text
[Raw data]
    │
    ├─ PhysioNet pulse-transit-time-ppg (CSV/WFDB)
    └─ Optional: CSV with JSON signal columns (dataset.py)
    │
    ▼
[Windowing / labeling]  ← bp_pipeline/physionet_ptt_ppg.py (and dataset.py for CSV)
    │
    ▼  per window: (ecg_segment, ppg_segment, accel_segment*, sbp, dbp, fs)
    │
[Preprocessing + feature extraction]  ← bp_pipeline/features.py (+ preprocess.py)
    │
    ▼  one row: X[i] ∈ ℝ^F  (F = len(DEFAULT_FEATURES) before selection)
    │
[Imputation]  ← bp_pipeline/train.py  (_nan_impute: column medians)
    │
[Feature selection]  ← bp_pipeline/train.py  (RF on SBP only → importances → top-k)
    │
[Model]  ← sklearn MultiOutputRegressor(RandomForestRegressor)
    │
    ▼  y_hat = [SBP, DBP]
[Artifacts]  ← artifacts/model.joblib, feature_schema.json, metrics.json
    │
    ├─ bp_api/main.py     POST /predict
    └─ bp_dashboard/app.py  (plot + optional API calls)
```

\*Accel is a **3-column** array; for these public datasets it is often **zeros**, so motion-based features are uninformative unless you supply real accelerometer data.

---

### Stage 1 — Data ingestion and supervised labels

**Entry point:** `python -m bp_pipeline.train` with either `--physionet-ptt-dir` or `--data` (CSV).

#### PhysioNet pulse-transit-time-ppg (CSV)

- **Read:** `bp_pipeline/physionet_ptt_ppg.py` reads record CSVs from `CSV/` and looks up per-record BP and subject metadata in `CSV/subjects_info.csv`.\n+- **Labels (MVP):** single SBP/DBP label per record is computed as the mean of start/end values.\n+- **Features (MVP):** RR/HR from `peaks`, cross-correlation lag between distal/proximal PPG channels as a PTT proxy, plus motion RMS from IMU channels when present.

#### CSV path (`bp_pipeline/dataset.py`)

- Each row provides JSON-encoded `ecg`, `ppg`, accel axes, `sbp`, `dbp`, optional `fs_ecg` / `fs_ppg`.
- One call to `extract_features_from_signals` per row.

**Output of Stage 1:** a stream of **labeled windows** `(ecg, ppg, accel_xyz, sbp, dbp, fs)`.

---

### Stage 2 — Signal preprocessing (inside feature extraction)

**Function:** `extract_features_from_signals` in `bp_pipeline/features.py` (called once per window from `train.py`).

| Step | Implementation | Notes |
|------|------------------|--------|
| Bandpass ECG | `bandpass(ecg, 0.5–40 Hz, fs_ecg)` | `bp_pipeline/preprocess.py` — 4th-order Butterworth, **zero-phase** `filtfilt`. |
| Bandpass PPG | `bandpass(ppg, 0.5–8 Hz, fs_ppg)` | PPG energy is lower frequency than raw ECG band. |
| Motion mask | `motion_mask(accel)` — keep samples with magnitude **below** 80th percentile | Simplified artifact rejection; not NLMS. |
| Apply mask to PPG | `apply_motion_mask(ppg_f, m)` | ECG is **not** masked in this MVP. |
| R-peaks | `neurokit2.ecg_process` → `ECG_R_Peaks` | Robust default; needs ~≥1 s of ECG. |
| PPG peaks | `find_peaks` with HR-based `distance` + `prominence` | MVP systolic peak picker. |

---

### Stage 3 — Feature engineering (fixed schema)

**Schema:** `DEFAULT_FEATURES` in `bp_pipeline/features.py` (12 names).

| Feature | Meaning in this codebase |
|---------|---------------------------|
| `ptt_mean_s`, `ptt_std_s` | From `ptt_series_seconds`: for each R-peak time, take **first PPG peak strictly after** it; PTT = Δt in seconds; plausible range **0.03–0.6 s**; then mean/std. |
| `pwv_proxy` | `1 / ptt_mean` if PTT mean > 0 | **Not** true \(PWV = L/PTT\) without arterial path length \(L\). |
| `rr_mean_s`, `rr_std_s` | RR intervals in seconds from consecutive R-peak indices. |
| `hrv_rmssd_s` | RMSSD on RR: \(\sqrt{\mathrm{mean}((\Delta RR)^2)}\). |
| `ppg_mean`, `ppg_std`, `ppg_skew`, `ppg_kurtosis` | On **motion-masked** PPG; skew/kurtosis from standardized moments. |
| `acc_rms`, `acc_jerk_rms` | RMS of accel samples in mask; jerk = `diff(accel)` then RMS. Often NaN/low signal if accel is all zeros. |

**Output of Stage 3:** one vector `X[i] ∈ ℝ^{12}` aligned with `DEFAULT_FEATURES.names` (order matters).

---

### Stage 4 — Training-time cleaning

**File:** `bp_pipeline/train.py`

- **`_nan_impute`:** For each feature column, replace NaN/Inf with the **training-set column median** (computed on the stacked matrix before the train/test split in the current code — i.e. on all extracted windows first). Medians are stored in `model.joblib` as `medians_full_schema` for traceability (API currently expects pre-cleaned features).

---

### Stage 5 — Feature selection (top‑k)

**File:** `bp_pipeline/train.py` — `select_top_k_features`

1. Fit a **RandomForestRegressor** to predict **SBP only** (`y[:, 0]`) using the **full** 12-D feature matrix.
2. Read `feature_importances_`.
3. Keep indices of the **top k** (default `--top-k 20`, capped by number of features).
4. **`slice_schema`** reduces `X` to only those columns.

**Why SBP-only for ranking:** quick proxy; you could rank by combined SBP+DBP importance or use permutation importance for a stricter approach.

---

### Stage 6 — Model and objective

**Estimator:** `sklearn.multioutput.MultiOutputRegressor(RandomForestRegressor)`

- **Two outputs:** index 0 = SBP, index 1 = DBP (internally two forests with same hyperparameters in this wrapper).
- **Hyperparameters (MVP):** `n_estimators=200`, `max_depth=10`, `min_samples_split=5`, `random_state` from CLI, `n_jobs=-1`.

**Split:** `train_test_split` default **80/20** (`--test-size`), **shuffle** — **not** patient-grouped (important caveat for Dataset 2).

**Metrics:** MAE and RMSE **separately** for SBP and DBP on the held-out split.

---

### Stage 7 — Artifacts (what “production” loads)

| File | Contents |
|------|-----------|
| `artifacts/model.joblib` | Dict: `model` (fitted), `schema` (selected feature names), `full_schema`, `medians_full_schema`. |
| `artifacts/feature_schema.json` | Same selected names (for humans/tools). |
| `artifacts/metrics.json` | MAE/RMSE, counts. |

---

### Stage 8 — Inference path

**FastAPI:** `bp_api/main.py`

- Loads bundle once (`lru_cache`).
- Validates `len(features)` matches saved schema.
- Rejects non-finite values.
- `model.predict([x])` → `[sbp, dbp]`.

**Important:** The API expects the **already-selected** feature vector (post top‑k order as in `schema.names`). Training does not currently export a “full 12-D → slice” helper in the API layer.

---

### Stage 9 — Dashboard (monitoring / demo)

**Dash:** `bp_dashboard/app.py`

- **Actual mode:** plot columns `sbp`, `dbp` (optional `t`).
- **Predict mode:** POST each row’s features to `/predict` and plot `sbp_pred`, `dbp_pred`.
- **Alert:** counts rows with `SBP > threshold` (default 140).

---

### Limitations (explicit)

1. **Patient leakage** possible on Dataset 2 with random `train_test_split`.
2. **PWV** is a proxy without distance \(L\).
3. **NLMS** adaptive filtering not implemented — motion handling is percentile masking.
4. **PCG / FSR** from Dataset 1 are loaded/parsed only as needed for alignment; PCG is not yet in the feature vector.
5. **API vs training feature contract:** client must send the **selected** feature order matching `feature_schema.json`.

---

## What exists in the repo

### 1) Core ML pipeline (`bp_pipeline/`)

| Component | File | What it does |
|-----------|------|----------------|
| Preprocessing | `bp_pipeline/preprocess.py` | Bandpass (`butter` + `filtfilt`), accel magnitude, motion mask (80th percentile), PPG peak detection (`scipy.signal.find_peaks`). |
| Features | `bp_pipeline/features.py` | R-peaks via **NeuroKit2** `ecg_process`, PTT from R→next PPG peak, PWV proxy as `1/mean(PTT)`, RR stats, RMSSD, PPG stats, accel RMS/jerk. |
| CSV loader | `bp_pipeline/dataset.py` | Optional path: JSON-in-CSV rows → `extract_features_from_signals`. |
| Kaggle / datasets | `bp_pipeline/kaggle_noninvasivebp.py` | **Dataset 1** (subject JSON @ 1 kHz): parse `data_*`, detect BP instants from **inverted FSR + negative slope**, window ECG/PPG, labels from `data_BP`. **Dataset 2** (`Part_*.mat` @ 125 Hz): HDF5 cell loader, sliding windows, **SBP/DBP = max/min ABP** in window. |
| Training | `bp_pipeline/train.py` | Builds `X,y`, median NaN impute, RF importance → **top‑k features**, `MultiOutputRegressor(RandomForest)`, MAE/RMSE, saves `artifacts/model.joblib`, `feature_schema.json`, `metrics.json`. |

### 2) Serving (`bp_api/`)

- **`bp_api/main.py`**: FastAPI `GET /health`, `POST /predict` (loads `artifacts/model.joblib`, optional `BP_MODEL_PATH`).

### 3) Dashboard (`bp_dashboard/`)

- **`bp_dashboard/app.py`**: Dash app — plot SBP/DBP over time, SBP threshold alert, optional **predict mode** calling the API with CSV `features` or `f0,f1,...`.

### 4) Scripts (`scripts/`)

| Script | Purpose |
|--------|---------|
| (none) | Dataset download helpers removed; dataset-specific loader is `bp_pipeline/physionet_ptt_ppg.py`. |

### 5) Dependencies

- **`requirements.txt`**: numpy, scipy, sklearn, neurokit2, pandas, h5py, fastapi, uvicorn, dash, plotly, requests, etc.

---

## Datasets
### PhysioNet `pulse-transit-time-ppg/1.1.0`

- Records in WFDB and CSV format; this project currently uses the **CSV** path.
- Labels are taken from `subjects_info.csv` (BP start/end), aggregated to a single label per record (MVP).

---

## How to run (cheat sheet)

### Environment

```bash
pip install -r requirements.txt
```

When running **scripts** (not `python -m ...`) from repo root, use:

```bash
PYTHONPATH=. python scripts/<script>.py ...
```

### Train
```bash
PYTHONPATH=. python -m bp_pipeline.train --physionet-ptt-dir path/to/pulse-transit-time-ppg/1.1.0 --out artifacts --top-k 20 --verbose
```

### API

```bash
uvicorn bp_api.main:app --reload
```

### Dashboard

```bash
python -m bp_dashboard.app
```

(Requires `dash` installed — same `pip install -r requirements.txt`.)

---

## Example training metrics (from your run)

You reported something like:

- `train=(230, 12)`, `test=(58, 12)` → 230 train windows, 58 test, **12 features** after selection / full schema slice.
- `mae_sbp ≈ 9.9`, `mae_dbp ≈ 4.2` mmHg; RMSE slightly higher (penalizes large errors).

Interpretation: **DBP** near your **MAE < 5 mmHg** target; **SBP** still above it on that split/size — typical for small samples / hard SBP.

---

## Known quirks / lessons

1. **`ModuleNotFoundError: bp_pipeline`**: run with `PYTHONPATH=.` or `python -m ...` from repo root.

---

## Suggested next steps (not done yet)

- **NLMS** motion artifact removal for real accel + PPG.
- **Richer features** (PCG, FSR shape around deflation, ABP morphology if available).
- **Separate models** or weighted loss if SBP remains harder than DBP.

---

## File map (quick navigation)

```
bp_pipeline/
  preprocess.py      # filtering, motion mask, PPG peaks
  features.py        # PTT, HRV, PPG stats, feature vector
  kaggle_noninvasivebp.py  # Dataset 1 JSON + Dataset 2 .mat windowing
  train.py           # train + metrics + artifacts
  dataset.py         # CSV → features
bp_api/main.py       # FastAPI predict
bp_dashboard/app.py  # Dash UI
scripts/             # download, inspect, debug
artifacts/           # produced by training (gitignored if you add .gitignore)
```

*Last updated to reflect the state of the codebase at the time of writing.*
