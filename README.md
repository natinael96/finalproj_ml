# finalproj_ml — BP Prediction MVP

End-to-end MVP for predicting **SBP/DBP** from **ECG + PPG + accelerometer**.

## What’s included

- Signal preprocessing:
  - Bandpass filter (ECG/PPG)
  - Simple motion artifact masking using accelerometer magnitude percentile
  - ECG R-peak detection via `neurokit2`
- Feature engineering:
  - Pulse Transit Time (PTT)
  - Basic HRV/RR features
  - Basic PPG statistics
  - Accelerometer RMS / jerk
- Training:
  - Multi-output RandomForestRegressor for `[SBP, DBP]`
  - Feature-importance based top-k selection
  - Saves `model.joblib` + `feature_schema.json`
- Serving:
  - FastAPI `/predict` that accepts a feature vector and returns SBP/DBP

## Setup

```bash
python -m venv .venv
```

```bash
pip install -r requirements.txt
```

## Data expectation (training)

This MVP expects a CSV dataset with one row per window/segment:

- `ecg`: ECG samples serialized (JSON list) OR precomputed features (see below)
- `ppg`: PPG samples serialized (JSON list)
- `accel_x`, `accel_y`, `accel_z`: accel samples serialized (JSON list)
- `sbp`, `dbp`: labels
- optional: `fs_ecg` (default 250), `fs_ppg` (default 100)

If your dataset is already windowed and you have features, you can bypass raw signals and feed features directly.

## Train

### Option A: Your own CSV (JSON-in-cells)

```bash
python -m bp_pipeline.train --data data/train.csv --out artifacts --top-k 20
```

### Option B: PhysioNet `pulse-transit-time-ppg/1.1.0` (CSV)

After downloading with your terminal (e.g. `wget -r -N -c -np ...`), point training to the extracted dataset root (must contain `CSV/subjects_info.csv`).

For a model artifact that is compatible with live ESP32 inference, use the same generic feature extractor as the API:

```bash
python -m bp_pipeline.train --physionet-ptt-dir path/to/pulse-transit-time-ppg/1.1.0 --out artifacts_live --top-k 18 --live-compatible --verbose
```

Then point the API to the live-compatible artifact:

```bash
set BP_MODEL_PATH=artifacts_live/model.joblib
```

The older PhysioNet-specific feature path is still available, but it can use dual-PPG/load-cell features that ESP32 live streaming cannot compute:

```bash
python -m bp_pipeline.train --physionet-ptt-dir path/to/pulse-transit-time-ppg/1.1.0 --out artifacts_physionet --top-k 20 --verbose
```

### Option C: Matched ESP32 + cuff labels

For the strongest final-year methodology, collect live ESP32 windows with matching cuff SBP/DBP labels and train with the generic CSV format:

```bash
python -m bp_pipeline.train --data data/esp32_labeled_windows.csv --out artifacts_esp32 --top-k 18 --verbose
```

That path uses the same `DEFAULT_FEATURES` as `/ws/esp32`, so it avoids the PhysioNet-vs-hardware feature mismatch.

Artifacts produced:

- `artifacts/model.joblib` (model bundle + schema)
- `artifacts/feature_schema.json`
- `artifacts/metrics.json`

## Documentation

Full thesis-style technical write-up (ML pipeline, WebSocket flow, ESP32 issues/fixes):

- [docs/FINAL_YEAR_PROJECT_DOCUMENTATION.md](docs/FINAL_YEAR_PROJECT_DOCUMENTATION.md)
- [docs/ESP32_WS_PROTOCOL.md](docs/ESP32_WS_PROTOCOL.md)

ESP32 firmware: `firmware/esp32_bp_stream/` (streams to `ws://<PC_IP>:8000/ws/esp32`).

## Serve

```bash
uvicorn bp_api.main:app --host 0.0.0.0 --port 8000 --reload
```

Then POST:

- `POST /predict`

```json
{
  "features": [0.18, 3.2, 0.05, 0.12, 0.03, 0.8, 0.1]
}
```

To point the API at a different artifact:

```bash
set BP_MODEL_PATH=artifacts/model.joblib
```

## Notes

- The motion removal is intentionally simple for MVP; you can swap in NLMS later.
- PTT extraction is implemented from detected ECG R-peaks and PPG peaks; you’ll likely want more robust peak logic per your paper.

## Dashboard

Run the dashboard:

```bash
python -m bp_dashboard.app
```

Then open the local URL it prints (usually `http://127.0.0.1:8050`).

Dashboard CSV upload options:

- **Actual mode**: CSV with columns `sbp`, `dbp` (optional `t`)
- **Predict mode**: CSV with either:
  - `features` column containing a JSON array per row, or
  - numeric columns `f0,f1,f2,...`

To point the dashboard to a different API:

- Set `BP_API_URL` (default `http://127.0.0.1:8000`)

## Next.js Dashboard (Supabase Auth + Live/History)

There is also a Next.js dashboard under `dashboard/` that reads from Supabase table `telemetry_windows` (with RLS).

Setup:

```bash
cd dashboard
cp .env.local.example .env.local
npm install
npm run dev
```

Then open the URL printed by Next.js (usually `http://localhost:3000`).

