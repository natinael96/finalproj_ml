# finalproj_ml - Cuffless Blood Pressure Prediction

This repository contains a final-year project for estimating systolic and diastolic blood pressure from ECG, PPG, and motion-sensor data. It includes a Python machine-learning pipeline, a FastAPI inference service, ESP32 firmware for live sensor streaming, Supabase schema/migrations, and a Next.js dashboard for monitoring and reviewing predictions.

The project is intended for research and demonstration. It is not a clinically validated medical device.

## Repository Layout

- `bp_pipeline/` - signal preprocessing, feature extraction, dataset loading, training, and inference helpers.
- `bp_api/` - FastAPI service for model health checks, prediction, ESP32 ingest, WebSocket streaming, Supabase persistence, and read-only FHIR R4 endpoints.
- `dashboard/` - Next.js dashboard for live monitoring, historical trends, model information, devices, and API lab workflows.
- `firmware/esp32_bp_stream/` - ESP32 sketch and example configuration for streaming ECG/PPG/IMU samples to the API.
- `supabase/` - database schema and migrations used by the dashboard and API persistence layer.
- `scripts/` - helper scripts for demo model generation, PhysioNet download/replay, model checks, admin seeding, and firmware timing validation.
- `artifacts*/` - generated model artifacts such as `model.joblib`, `feature_schema.json`, and `metrics.json`.
- `docs/` - local project notes and extended writeups. This folder is ignored by Git.

## Prerequisites

- Python 3.10+ recommended.
- Node.js 20+ recommended for the Next.js 16 dashboard.
- Git Bash, PowerShell, or another shell on Windows.
- Optional: Supabase project if you want dashboard persistence/auth instead of local-only API testing.
- Optional: ESP32 board with compatible ECG, PPG, accelerometer, and gyroscope wiring.

## 1. Clone and Create the Python Environment

From the repository root:

```bash
python -m venv .venv
source .venv/Scripts/activate
pip install -r requirements.txt
```

On PowerShell, activate the virtual environment with:

```powershell
.\.venv\Scripts\Activate.ps1
```

## 2. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env.local
```

Important backend variables:

- `BP_MODEL_PATH` - model artifact path loaded by FastAPI. Defaults to `artifacts/model.joblib`.
- `BP_API_KEY` - optional local/demo API key. When set, REST clients must send `x-api-key`, and WebSocket clients must send `?api_key=...` or the header.
- `BP_API_CORS_ORIGINS` - comma-separated dashboard origins allowed by FastAPI.
- `BP_WEBSOCKET_ENABLED` - set to `true` to enable `/ws/dashboard`, `/ws/ingest`, and `/ws/esp32`.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` - required for backend writes to Supabase and FHIR reads.
- `BP_DEFAULT_USER_ID` - Supabase auth user UUID used for ESP32-originated rows because the ESP32 does not send a user identity.

Important dashboard variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_BP_API_URL`
- `NEXT_PUBLIC_BP_DASHBOARD_WS_URL`
- `NEXT_PUBLIC_BP_WEBSOCKET_ENABLED`
- `NEXT_PUBLIC_BP_API_KEY`

The dashboard also has its own example file at `dashboard/.env.local.example`.

## 3. Create or Train a Model Artifact

The API needs a model artifact before `/health` and prediction endpoints can fully work.

For a quick smoke-test model, run:

```bash
python scripts/build_demo_model.py --out artifacts
```

This creates:

- `artifacts/model.joblib`
- `artifacts/feature_schema.json`
- `artifacts/metrics.json`

The demo model is only for transport/API testing and is not clinically meaningful.

## 4. Train With Real Data

### Custom CSV

Use this when you have matched ECG/PPG/motion windows and cuff labels:

```bash
python -m bp_pipeline.train --data data/esp32_labeled_windows.csv --out artifacts --top-k 40 --verbose
```

Expected labels are `sbp` and `dbp`. The loader supports the project feature schema and raw/windowed signal inputs handled by `bp_pipeline.dataset`.

### PhysioNet PTT Dataset

After downloading and extracting `pulse-transit-time-ppg/1.1.0`, train an ESP32-compatible model with:

```bash
python -m bp_pipeline.train --physionet-ptt-dir path/to/pulse-transit-time-ppg/1.1.0 --out artifacts_live --top-k 40 --max-windows-per-record 40 --esp32-compatible --optuna-trials 0 --verbose
```

Then point the API at that artifact:

```bash
export BP_MODEL_PATH=artifacts_live/model.joblib
```

On Windows `cmd.exe`, use:

```cmd
set BP_MODEL_PATH=artifacts_live/model.joblib
```

## 5. Run the FastAPI Backend

Start the API from the repository root:

```bash
uvicorn bp_api.main:app --host 0.0.0.0 --port 8000 --reload
```

Useful endpoints:

- `GET /health` - verifies model loading, feature count, Supabase config, WebSocket status, and live schema compatibility.
- `POST /predict` - predicts one SBP/DBP pair from a feature vector.
- `POST /predict_batch` - predicts multiple rows of feature vectors.
- `POST /esp32/ingest` - HTTP ingest endpoint used by the ESP32 firmware.
- `GET /fhir/metadata` - FHIR R4 CapabilityStatement.
- `GET /fhir/Observation`, `/fhir/Patient/{patient_id}`, `/fhir/Device` - read-only FHIR resources backed by Supabase.
- `/ws/dashboard`, `/ws/ingest`, `/ws/esp32` - optional WebSocket endpoints when `BP_WEBSOCKET_ENABLED=true`.

Example health check:

```bash
curl http://127.0.0.1:8000/health
```

Example prediction:

```bash
curl -X POST http://127.0.0.1:8000/predict \
  -H "Content-Type: application/json" \
  -d "{\"features\":[0.18,3.2,0.05,0.12,0.03,0.8,0.1]}"
```

If `BP_API_KEY` is set, include:

```bash
-H "x-api-key: YOUR_KEY"
```

## 6. Run the Dashboard

In a second terminal:

```bash
cd dashboard
cp .env.local.example .env.local
npm install
npm run dev
```

Open the URL printed by Next.js, usually `http://localhost:3000`.

Common dashboard pages:

- `/overview` - high-level monitoring overview.
- `/live` - live telemetry and prediction monitoring.
- `/history` - historical prediction trends.
- `/devices` - device-oriented views.
- `/model` - model/API status and methodology.
- `/lab` - API lab for batch prediction workflows.

## 7. Supabase Setup

The database schema lives in `supabase/`. Apply the migrations to your Supabase project using your preferred Supabase workflow, then configure:

- Backend service-role access in `.env.local` with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- Dashboard browser access in `dashboard/.env.local` with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- `BP_DEFAULT_USER_ID` with a real dashboard auth user UUID before saving ESP32 predictions server-side.

The API writes prediction windows to `telemetry_windows` and raw ESP32 batches to `esp32_raw_batches` when Supabase is configured.

## 8. ESP32 Firmware

The firmware is in `firmware/esp32_bp_stream/`.

1. Copy `config.example.h` to `config.h`.
2. Fill in Wi-Fi and API connection settings.
3. Start the FastAPI backend on `0.0.0.0:8000`.
4. Use the LAN IP printed by the API startup log for the ESP32 target.
5. Flash the sketch to the ESP32.

By default, the ESP32 path uses HTTP `POST /esp32/ingest`. The server buffers samples until it has enough data for the configured prediction window, extracts live-compatible features, predicts SBP/DBP, and optionally writes rows to Supabase.

## 9. Helpful Scripts

- `python scripts/build_demo_model.py --out artifacts` - create a local smoke-test model.
- `python scripts/check_model.py` - inspect/check the configured model artifact.
- `python scripts/download_physionet_ptt_ppg.py` - helper for PhysioNet dataset download workflows.
- `python scripts/replay_physionet_over_ws.py` - replay data through the WebSocket ingest path.
- `python scripts/validate_firmware_timing.py` - validate firmware sample timing assumptions.
- `python scripts/seed_admins.py` - seed dashboard admin data when configured.

## Troubleshooting

- If `/health` returns a missing model error, run `python scripts/build_demo_model.py --out artifacts` or set `BP_MODEL_PATH` to a trained artifact.
- If the dashboard cannot reach the API, confirm `NEXT_PUBLIC_BP_API_URL=http://127.0.0.1:8000` and that FastAPI is running.
- If browser requests are blocked, update `BP_API_CORS_ORIGINS` to include the dashboard origin.
- If WebSocket pages do not connect, set both `BP_WEBSOCKET_ENABLED=true` and `NEXT_PUBLIC_BP_WEBSOCKET_ENABLED=true`.
- If Supabase writes do not appear, confirm `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `BP_DEFAULT_USER_ID`.
- If ESP32 cannot connect, use the API LAN URL printed at startup, not `127.0.0.1`.

## Git Notes

Generated datasets, model binaries, local environments, secrets, and `docs/` are ignored. Keep the root `README.md` as the maintained public usage guide.

