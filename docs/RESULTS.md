# Cuffless Blood Pressure Estimation System
## Final Project Report

> **Document version:** 1.0 — May 2026  
> **Project path:** `finalproj_ml`  
> **Scope:** End-to-end MVP — sensor firmware, signal processing, machine learning, REST API, real-time dashboard

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Introduction & Background](#2-introduction--background)
3. [System Architecture](#3-system-architecture)
4. [Hardware Design](#4-hardware-design) — includes [§4.4 Firmware timing validation](#44-firmware-timing-validation)
5. [Signal Acquisition & Preprocessing](#5-signal-acquisition--preprocessing)
6. [Feature Engineering](#6-feature-engineering)
7. [Machine Learning Model](#7-machine-learning-model)
8. [Model Performance Results](#8-model-performance-results)
9. [Backend API](#9-backend-api)
10. [Database Design](#10-database-design)
11. [Real-Time Dashboard](#11-real-time-dashboard)
12. [Device & Cycle Management](#12-device--cycle-management)
13. [Technology Stack](#13-technology-stack)
14. [Limitations & Future Work](#14-limitations--future-work)
15. [Conclusion](#15-conclusion)

---

## 1. Executive Summary

This project presents a complete, end-to-end **cuffless blood pressure (BP) estimation system** built from hardware to user interface. An ESP32 microcontroller equipped with a MAX30100 pulse oximeter and MPU6050 inertial sensor continuously acquires ECG, photoplethysmography (PPG), and accelerometer signals. These are streamed to a FastAPI server that performs real-time signal processing, feature extraction, and prediction using a trained machine learning model. Results are persisted in a Supabase PostgreSQL database and displayed on a Next.js real-time web dashboard.

**Key results on the PhysioNet PTT-PPG hold-out set:**

| Metric | Systolic BP (SBP) | Diastolic BP (DBP) |
|---|---|---|
| Mean Absolute Error (MAE) | **10.25 mmHg** | **6.62 mmHg** |
| Root Mean Square Error (RMSE) | 14.26 mmHg | 8.39 mmHg |
| Within ±5 mmHg | 41.7 % | 58.3 % |
| LOSO CV MAE (22 subjects) | 10.19 ± 9.43 mmHg | 7.10 ± 5.07 mmHg |

---

## 2. Introduction & Background

### 2.1 Problem Statement

Hypertension is a leading global risk factor for cardiovascular disease and stroke. Conventional cuff-based sphygmomanometers interrupt daily life and cannot provide continuous monitoring. Cuffless BP estimation using wearable sensors offers the potential for ambulatory, unobtrusive monitoring.

### 2.2 Physiological Basis

The system leverages **Pulse Transit Time (PTT)** — the time delay between electrical cardiac depolarisation (R-peak in ECG) and the arrival of the pressure pulse at a peripheral site (PPG peak). PTT is inversely related to arterial blood pressure through the **Moens-Korteweg equation**:

$$
PWV = \sqrt{\frac{Eh}{2\rho r}}
$$

where $E$ is the elastic modulus of the arterial wall, $h$ is wall thickness, $\rho$ is blood density, and $r$ is vessel radius. Since PTT ≈ distance / PWV, higher blood pressure distends vessel walls (increases E), shortening PTT. This relationship is captured through features like `inv_ptt`, `inv_ptt2`, and `pwv_proxy`.

### 2.3 Dataset

Training data comes from the publicly available **PhysioNet PTT-PPG** dataset (v1.1.0), containing simultaneous ECG, PPG, and reference cuff BP measurements from 22 subjects performing sit, walk, and run activities.

---

## 3. System Architecture

The system follows a layered architecture spanning four tiers:

```
┌──────────────────────────────────────────────────────────────┐
│  HARDWARE TIER                                               │
│  ESP32 + MAX30100 + MPU6050 + ECG (GPIO 34)                 │
│  20 Hz batched HTTP POST (20 samples / 1 s)                 │
└──────────────────┬───────────────────────────────────────────┘
                   │ POST /esp32/ingest
┌──────────────────▼───────────────────────────────────────────┐
│  PROCESSING TIER                                             │
│  FastAPI (Python)                                            │
│  • Buffer 2000 samples per device/cycle                      │
│  • Bandpass → R-peak detection → PTT/HRV/PPG features        │
│  • ExtraTrees regressor → SBP / DBP                          │
│  • Supabase writes (raw batches + telemetry windows)         │
└──────────────────┬───────────────────────────────────────────┘
                   │ INSERT (PostgREST)
┌──────────────────▼───────────────────────────────────────────┐
│  PERSISTENCE TIER                                            │
│  Supabase (PostgreSQL + RLS)                                 │
│  devices · sessions · telemetry_windows                      │
│  esp32_raw_batches · cycle_labels                            │
└──────────────────┬───────────────────────────────────────────┘
                   │ Supabase JS client (RLS)
┌──────────────────▼───────────────────────────────────────────┐
│  PRESENTATION TIER                                           │
│  Next.js 16 / React 18 Dashboard                             │
│  Live monitor · History · Devices · Signal Viewer · API Lab  │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Hardware Design

### 4.1 Sensor Suite

| Sensor | Signal | Interface | Rate |
|---|---|---|---|
| Analog ECG circuit | Lead-I ECG | GPIO 34 (12-bit ADC) | 20 Hz app / hardware doubled-read |
| MAX30100 | PPG Infrared (IR) | I²C | 100 Hz hardware FIFO → 20 Hz app |
| MPU6050 | 3-axis accelerometer, 3-axis gyroscope | I²C | 20 Hz (10 Hz LPF anti-alias) |

### 4.2 ESP32 Firmware Design (`esp32_bp_stream.ino`)

The firmware was written for the ESP32 microcontroller using the Arduino framework. Key design decisions:

**Timing architecture:**
- A cooperative **50 ms** sample scheduler (`SAMPLE_PERIOD_US = 1_000_000 / 20`) driven by `esp_timer_get_time()` in `loop()` — not a hardware ISR — gates ECG, held PPG, and IMU reads at **20 Hz**.
- `gettimeofday()` provides NTP-disciplined UNIX timestamps for each batch when WiFi is synced; falls back to `millis()`.
- The catch-up loop advances `nextSampleUs` fully past the current time to prevent perpetual scheduling drift after WiFi/HTTP stalls (see §4.4).

**MAX30100 FIFO management:**
- Hardware configured at 100 Hz sample rate for cleaner oversampling; the application drains the FIFO every 50 ms and retains every 5th sample to produce 20 Hz PPG.
- WiFi and NTP are initialised before the sensor to prevent FIFO overflow during the WiFi association delay.
- A `ppgRecoverFifo()` routine resets the sensor if the FIFO is found in an inconsistent state.

**MPU6050 anti-aliasing:**
- Low-pass filter bandwidth set to **10 Hz** (satisfying Nyquist for 20 Hz sampling; `MPU6050_BAND_10_HZ`).

**Transmission:**
- Each batch contains exactly **20 samples** (1 second of data) in JSON arrays: `ecg`, `ppg`, `ax`, `ay`, `az`, `gx`, `gy`, `gz`.
- Fields include `device_id`, `device_name`, `ts_ms_start`, `fs_hz`, `window_s`.
- The server handles all database writes; the firmware only sends and reads the HTTP response for diagnostics.

**Validity gating:**
- ECG samples are rejected if outside 5–4090 ADC (12-bit saturation guard).
- PPG batches are skipped if values are stale or below a minimum threshold.

### 4.3 Firmware Configuration (`config.h`)

```c
#define WS_DEVICE_ID  "esp32-001"
#define DEVICE_NAME   "ESP32-001"     // Friendly name registered on first POST
#define WS_FS_HZ      20
#define WS_WINDOW_S   1.0f            // 20 samples per POST
#define USE_WEBSOCKET 0               // HTTP POST mode only
#define GMT_OFFSET_SEC (3 * 3600)     // UTC+3
```

### 4.4 Firmware Timing Validation

Section 4.2 describes the timing **design**; this section records how that design was **verified** on hardware and at the API boundary. Without these checks, PTT features would be meaningless even if the ML model were accurate.

#### 4.4.1 What must be true for PTT to work

| Requirement | Target | Why it matters |
|---|---|---|
| Application sample period | **50 ms** (20 Hz) | Matches `WS_FS_HZ` and server buffer math |
| Samples per HTTP batch | **20** | `WINDOW_SAMPLES = fs_hz × window_s` |
| Batch POST cadence | **~1 s** | One batch per filled window |
| ECG / IMU / PPG co-timestamp | Same `pushSample()` call | PTT is a cross-channel delay |
| PPG freshness | `ppg_age_ms` ≪ 3000 | Stale IR invalidates the batch |
| Wall-clock batch start | NTP epoch ms when synced | Dashboard absolute time (GMT+3) |
| Server accumulation | **100 batches → 2000 samples** | Triggers one `telemetry_windows` row |

#### 4.4.2 On-device checks (Serial Monitor @ 921600)

After flash, `setup()` prints the configured contract:

```text
[cfg] sample_rate_hz=20
[cfg] batch_samples=20
[cfg] batch_interval_s=1.0
[cfg] sync: ECG/IMU=0ms PPG<=10ms all@20Hz
```

During streaming, throttled debug lines (`PRINT_SAMPLE_MS = 200`) confirm the scheduler is alive and sensors are valid:

```text
[sample] t=12345678 ecg=1842 ir=45231 red=44102 ppg_age_ms=12 fifo_total=842 win=7/20 wifi=1 buf=ok
[http] POST http://192.168.x.x:8088/esp32/ingest bytes=...
[http] status=200 resp={"ok":true,"buffered_n":140,"needed_n":2000,...}
```

**Pass criteria used in development:**

| Check | Pass condition |
|---|---|
| Window fill | `win` advances 0→20 within ~1 s, then resets after `[http] batch cleared` |
| PPG age | `ppg_age_ms` typically **&lt; 50** during finger contact; spikes only during HTTP POST |
| FIFO health | `[ppg] fifo reset` rare; `ppgDrainSlowCount` not climbing steadily |
| HTTP cadence | One `[http] POST` per second while WiFi connected |
| API buffer | `buffered_n` increases by **20** per successful POST until `needed_n=2000` |

The **catch-up scheduler** (FIX 2 in firmware) was validated by deliberately blocking the loop (long HTTP timeout or Serial flood): after release, `win` still reaches 20/20 within one second and `t=` deltas in serial output return to ~200 ms print spacing — no unbounded lag across minutes of run time.

#### 4.4.3 Server-side timing checks (`bp_api`)

Each `POST /esp32/ingest` is validated before buffering:

- **Pydantic** enforces array lengths and `fs_hz` ∈ [10, 1000].
- **`sample_count`** stored in `esp32_raw_batches` must match `len(ecg)`.
- If firmware reports `fs_hz=20` but prediction uses `ESP32_PREDICTION_FS_HZ=250`, the response includes  
  `warning: ingest_fs_hz=20_prediction_uses_250` — documenting the known rate bridge (§14.1), not a silent mismatch.
- **`buffered_n` / `needed_n`** in the JSON response are the authoritative end-to-end counter: **100 consecutive 20-sample batches** must arrive before the first live prediction.

Integration smoke test (no cuff labels required):

1. `uvicorn bp_api.main:app --host 0.0.0.0 --port 8088`
2. `curl http://127.0.0.1:8000/health` → model loaded, Supabase reachable.
3. Flash ESP32 with `API_HOST` = PC LAN IP, `WS_FS_HZ=20`, `WS_WINDOW_S=1.0`.
4. Stream ≥2 minutes; confirm **~120** rows in `esp32_raw_batches` and **≥1** row in `telemetry_windows` for that `device_id`.
5. On Devices page, confirm cycle shows **~100 batches** and duration consistent with ~100 s of 20 Hz data.

#### 4.4.4 Quantitative analysis (repeatable)

`scripts/validate_firmware_timing.py` turns logs or DB exports into pass/fail metrics:

```bash
# Export recent rows from esp32_raw_batches (ts_ms_start, sample_count, window_s, created_at)
python scripts/validate_firmware_timing.py --batches-json docs/evidence/batches_export.json

# Optional: USB capture with [sample] lines
python scripts/validate_firmware_timing.py --serial-log docs/evidence/esp32_serial.txt
```

**Example output (batch cadence — illustrative thresholds):**

```json
{
  "ok": true,
  "kind": "http_batch_cadence",
  "n_batches": 120,
  "expected_samples_per_batch": 20,
  "samples_match_pct": 100.0,
  "expected_interval_ms": 1000.0,
  "ts_ms_start_median_delta_ms": 1004.0,
  "cadence_within_15pct_pct": 96.6,
  "cycles_to_2000_samples": 100.0
}
```

Acceptance: median inter-batch `ts_ms_start` within **±15%** of 1000 ms; **≥95%** of batches contain exactly 20 samples.

#### 4.4.5 Cross-channel synchronisation (design + spot-check)

At each 20 Hz tick, firmware reads ECG ADC, snapshots **held** PPG (`ppgIrHeld` from the FIFO drain in the same `loop()` pass), and reads MPU6050 on every sample. Serial sync summary from `setup()`:

| Channel | Latency vs tick | Mechanism |
|---|---|---|
| ECG | 0 ms | `readEcgRaw()` in scheduler tick |
| IMU | 0 ms | `readImu()` every sample, MPU LPF **10 Hz** |
| PPG | ≤10 ms | MAX30100 @ **100 Hz** HW; FIFO drained each loop iteration |

Spot-check: overlay ECG and PPG from one `esp32_raw_batches` row on the Signal Viewer — both arrays length 20 with coherent pulse delay; gross misalignment (flat PPG, jumping ECG) indicates FIFO or contact failure, not model error.

#### 4.4.6 Validation status summary

| Layer | Validated? | Evidence |
|---|---|---|
| 20 Hz scheduler + drift recovery | Yes | Serial `win`/`t=` behaviour; catch-up after HTTP stall |
| 1 s HTTP batch cadence | Yes | `ts_ms_start` deltas / `validate_firmware_timing.py` |
| 20 samples × 100 batches → predict | Yes | API `buffered_n`→2000; Supabase row counts |
| NTP wall time | Yes | `ts_ms_start` ≥ 2020-01-01 when WiFi+NTP up |
| PPG FIFO under WiFi load | Yes | `ppg_age_ms`, rare `fifo reset` after POST |
| **Clinical BP accuracy on ESP32** | **No** | Model trained on PhysioNet only (§8, §14.1) |

Firmware timing and ingest plumbing are **tested and observable**; cuffless BP accuracy on the custom ESP32 path remains a separate, not-yet-completed validation study.

---

## 5. Signal Acquisition & Preprocessing

### 5.1 Preprocessing Pipeline

Applied per **2000-sample** accumulation window (~100 seconds of 20 Hz data, extrapolated to 8 s at 250 Hz for the model):

1. **NaN interpolation** — linear fill of missing samples.
2. **ECG bandpass** — 2nd-order Butterworth, **0.5–40 Hz**.
3. **PPG bandpass** — 2nd-order Butterworth, **0.5–8 Hz**.
4. **Motion masking** — PPG samples with simultaneous accelerometer magnitude above the 80th percentile are masked before peak detection.
5. **Robust z-score** — median / MAD normalisation for motion channels before feature computation.

### 5.2 R-Peak & PPG Peak Detection

- **ECG R-peaks:** `neurokit2.ecg_process()` with the `"neurokit"` algorithm; provides RR intervals for HRV features.
- **PPG peaks:** custom scipy-based peak finder with physiological distance constraint (minimum 25 samples apart) applied to the bandpass-filtered IR channel.

### 5.3 Pulse Transit Time (PTT) Computation

For each R-peak, the algorithm searches for the first PPG peak occurring within **30–600 ms** after the R-peak (physiologically valid PTT window). Segments with fewer than 3 valid PTT estimates are rejected as insufficient for statistics.

---

## 6. Feature Engineering

The model uses a fixed schema of **18 features** aligned between training and live inference.

### 6.1 Feature Schema (`DEFAULT_FEATURES`)

| Category | Feature | Description |
|---|---|---|
| **PTT / PWV** | `ptt_mean_s` | Mean PTT in seconds |
| | `ptt_std_s` | PTT variability (pulse-to-pulse) |
| | `pwv_proxy` | Pulse wave velocity proxy (distance / PTT) |
| | `log_ptt` | log(PTT) — linearises PTT–BP relationship |
| | `inv_ptt` | 1/PTT — proportional to PWV |
| | `inv_ptt2` | (1/PTT)² — Moens-Korteweg quadratic term |
| | `inv_ptt_x_hr` | (1/PTT) × heart rate — interaction term |
| **HRV** | `rr_mean_s` | Mean RR interval |
| | `rr_std_s` | SDNN (standard deviation of NN intervals) |
| | `hrv_rmssd_s` | RMSSD (root mean square successive differences) |
| **PPG Morphology** | `ppg_mean` | DC component of PPG signal |
| | `ppg_std` | PPG amplitude variability |
| | `ppg_skew` | Waveform asymmetry |
| | `ppg_kurtosis` | Waveform peakedness |
| **Motion** | `acc_rms` | Accelerometer RMS magnitude |
| | `acc_jerk_rms` | Accelerometer jerk (derivative) RMS |
| | `gyro_rms` | Gyroscope angular velocity RMS |
| | `gyro_jerk_rms` | Gyroscope jerk RMS |

### 6.2 Train/Serve Alignment

A critical design requirement is that the feature extraction code path is **identical** between training (`bp_pipeline/train.py`) and live inference (`bp_api/main.py`). Both call `extract_features_from_signals()` under the `--esp32-compatible` / `live_compatible` mode. Training uses the same `DEFAULT_FEATURES` 18-name schema stored alongside the model artifact (`artifacts_live/feature_schema.json`).

---

## 7. Machine Learning Model

### 7.1 Algorithm Selection

After benchmarking RandomForest, ExtraTrees, GradientBoosting, Ridge, and optional XGBoost/LightGBM (stacking), the final production model is a **multi-output ExtraTreesRegressor**:

```python
ExtraTreesRegressor(
    n_estimators = 500,
    max_features  = "sqrt",
    min_samples_leaf = 5,
    max_depth     = (tuned via GroupKFold: {6, 8, 10, 12}),
    random_state  = 42,
)
```

ExtraTrees was chosen over RandomForest for speed and slightly lower variance on physiological data; its random split selection provides implicit regularisation that generalises well under subject-grouped evaluation.

### 7.2 Training Pipeline

1. **Data source:** PhysioNet PTT-PPG, ESP32-compatible single-PPG path.
2. **Windowing:** 8-second non-overlapping windows; `max_windows_per_record` capped to limit label inflation.
3. **Subject grouping:** `GroupShuffleSplit` ensures no subject appears in both train and test splits.
4. **Imputation:** Median imputer fitted on training data only; medians stored in artifact for live deployment.
5. **Feature selection:** GroupKFold (k=5) RandomForest importance voting; top-40 most consistently important features retained.
6. **Depth tuning:** GroupKFold inner loop over max_depth ∈ {6, 8, 10, 12}.
7. **Post-processing constraints:**
   - SBP clamped to [70, 220] mmHg
   - DBP clamped to [40, 130] mmHg
   - DBP ≤ SBP − 15 mmHg (physiological sanity)
8. **Optional stacking:** RF + ET + GBM base estimators with Ridge meta-learner; available via `--stacking` flag.

### 7.3 Evaluation Protocol

Two evaluation strategies are used:

- **Hold-out:** Random 20% of windows after subject-grouped train/test split.
- **Leave-One-Subject-Out (LOSO) Cross-Validation:** Each of the 22 subjects is held out in turn; provides the most realistic estimate of generalisation to unseen subjects.

---

## 8. Model Performance Results

### 8.1 Hold-Out Test Set (n_test = 300 windows)

| Metric | SBP | DBP |
|---|---|---|
| **MAE (mmHg)** | **10.25** | **6.62** |
| **RMSE (mmHg)** | 14.26 | 8.39 |
| **Within ±5 mmHg (%)** | 41.7 | 58.3 |
| **Within ±10 mmHg (%)** | — | — |

### 8.2 Leave-One-Subject-Out Cross-Validation (22 subjects)

| Subject metric | SBP | DBP |
|---|---|---|
| **Mean LOSO MAE (mmHg)** | 10.19 | 7.10 |
| **Std LOSO MAE (mmHg)** | ± 9.43 | ± 5.07 |

The high standard deviation in LOSO MAE indicates significant inter-subject variability — a known challenge in calibration-free cuffless BP estimation. The DBP estimates are substantially more stable (lower MAE and std) than SBP, consistent with the physiological literature, as DBP is less sensitive to stiffness changes.

### 8.3 Training Configuration

| Parameter | Value |
|---|---|
| Dataset | PhysioNet PTT-PPG v1.1.0 |
| Training samples | 1,020 windows |
| Test samples | 300 windows |
| LOSO subjects | 22 |
| Window length | 8 seconds |
| Sampling rate | 250 Hz (resampled for model) |
| Features used | 18 (DEFAULT_FEATURES) |
| Model | ExtraTreesRegressor (500 trees) |
| Training mode | `esp32_compatible` (single PPG) |

### 8.4 Clinical Benchmark Context

The AAMI/ISO 81060-2 standard for automated BP devices requires mean error < 5 mmHg and SD < 8 mmHg. The current model does **not** meet this clinical standard (`target_sbp_met: false, target_dbp_met: false`). This is expected for a calibration-free MVP trained on a limited public dataset. The system is suitable for research and trend monitoring purposes.

---

## 9. Backend API

### 9.1 FastAPI Application (`bp_api/main.py`)

The server is built with **FastAPI** and served via `uvicorn`. It acts as the integration point between the ESP32 hardware, the ML model, and the Supabase database.

### 9.2 Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Model status, feature count, Supabase connectivity, live schema match |
| `POST` | `/predict` | Single feature vector → SBP/DBP prediction |
| `POST` | `/predict_batch` | Up to 256 feature rows → batch predictions |
| `POST` | `/esp32/ingest` | Raw sensor batch → buffer → predict → persist |
| `WS` | `/ws/dashboard` | Fan-out broadcast to connected dashboard clients |

### 9.3 ESP32 Ingest Flow

```
POST /esp32/ingest
        │
        ▼
Validate Esp32IngestRequest
(device_id, ts_ms_start, fs_hz, ecg[], ppg[], ax[], ay[], az[], gx[], gy[], gz[])
        │
        ▼
Insert → esp32_raw_batches (with cycle_id UUID)
Auto-register device name in devices table (if firmware sent device_name)
        │
        ▼
Append to per-device _DeviceBuffer
        │
        ├── buffer_n < 2000 → return {ok:true, buffered_n, needed_n}
        │
        └── buffer_n ≥ 2000
                │
                ▼
        extract_features_from_signals()
        Impute NaN → model.predict() → BP constraints
                │
                ▼
        _clean_floats() (NaN/Inf → null)
                │
                ▼
        Insert → telemetry_windows
        Rotate cycle_id → new UUID
        Broadcast → /ws/dashboard clients
```

### 9.4 Per-Device Buffer

The `_DeviceBuffer` class maintains separate ECG, PPG, and IMU accumulation arrays per `device_id`. Each buffer tracks:
- Accumulated raw samples
- `fs_hz` and `window_s` from incoming frames
- `cycle_id` (UUID, rotated after each 2000-sample prediction)
- `ts_ms_start` for the current accumulation window

This design ensures that multiple ESP32 devices can connect simultaneously with independent buffering and prediction cycles.

### 9.5 Environment Configuration

| Variable | Purpose |
|---|---|
| `BP_MODEL_PATH` | Path to `model.joblib` artifact |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key for server-side writes |
| `BP_DEFAULT_USER_ID` | User UUID to associate ingest rows with |
| `BP_API_KEY` | Optional API key for endpoint auth |
| `BP_WEBSOCKET_ENABLED` | `true` to enable WS fan-out |

---

## 10. Database Design

### 10.1 Supabase Schema

All tables use **Row Level Security (RLS)** enforced by `auth.uid() = user_id`, ensuring users can only access their own data.

```sql
-- Devices with friendly names
devices (id, user_id, device_id TEXT UNIQUE, label TEXT, created_at)

-- Measurement sessions
sessions (id, user_id, device_id, started_at, ended_at, notes)

-- ML prediction results per 8-second window
telemetry_windows (
  id, user_id, session_id, device_id,
  ts_ms_start BIGINT,     -- epoch-ms of window start
  fs_hz INT, window_s REAL,
  schema_names JSONB,     -- feature names
  features JSONB,         -- feature vector
  sbp_pred REAL, dbp_pred REAL,
  sbp_std REAL, dbp_std REAL,
  synthetic BOOLEAN,
  ecg JSONB, ppg JSONB, accel JSONB, gyro JSONB,  -- optional raw
  created_at
)

-- Every HTTP POST from ESP32 (raw sensor batches)
esp32_raw_batches (
  id, user_id, session_id, device_id,
  ts_ms_start BIGINT, fs_hz INT, window_s REAL, sample_count INT,
  ecg JSONB, ppg JSONB,
  ax JSONB, ay JSONB, az JSONB,
  gx JSONB, gy JSONB, gz JSONB,
  cycle_id TEXT,          -- groups batches into 2000-sample prediction windows
  created_at
)

-- User-defined cycle names
cycle_labels (cycle_id TEXT, user_id UUID, label TEXT, PRIMARY KEY (cycle_id, user_id))
```

### 10.2 Indexes

```sql
-- Fast recent lookups by user/device/time
telemetry_windows(user_id, created_at DESC)
telemetry_windows(device_id, created_at DESC)
esp32_raw_batches(user_id, created_at DESC)
esp32_raw_batches(device_id, created_at DESC)
esp32_raw_batches(device_id, cycle_id)   -- cycle grouping
```

### 10.3 Cycle Concept

A **cycle** represents one complete 2000-sample accumulation window — the fundamental unit of prediction. Each cycle:
- Has a unique UUID (`cycle_id`) generated server-side.
- Groups 100 raw batch rows (20 samples each × 100 = 2000).
- Produces exactly one row in `telemetry_windows`.
- Can be given a user-defined name via the `cycle_labels` table.

---

## 11. Real-Time Dashboard

### 11.1 Technology

- **Framework:** Next.js 16 (App Router), React 18, TypeScript
- **Data:** `@supabase/supabase-js` client (Realtime INSERT subscriptions)
- **Charts:** Custom SVG — no external charting library
- **Internationalisation:** English and Amharic (Ethiopic) via `i18n/` messages

### 11.2 Pages

| Route | Description |
|---|---|
| `/overview` | Landing page: system pipeline diagram, setup checklist, demo links |
| `/live` | Real-time BP monitor: latest SBP/DBP KPIs, hypertension stage badge, trend sparkline, telemetry feed table, signal viewer |
| `/history` | Historical analysis: device/date filter, trend chart, per-window table, CSV export, signal viewer |
| `/devices` | Device registry: per-device cycle list with timestamps, predictions, rename device/cycle |
| `/cycles/[cycleId]` | Full waveform page: ECG, PPG, accelerometer charts + paginated sample table |
| `/model` | Model card: MAE/RMSE metrics, AHA BP stage distribution, feature importance list |
| `/lab` | Developer tools: manual `/predict` call, batch prediction, CSV feature upload |
| `/about` | Project description and runbook |

### 11.3 Signal Chart (`SignalChart.tsx`)

A fully custom SVG-based waveform component built without any charting library:

- **Decimation:** Min-max decimation to ≤ 1400 render points regardless of signal length.
- **Interactivity:** Scroll-to-zoom (wheel), drag-to-pan, double-click reset.
- **Modal expansion:** Click to open full-screen modal with 420px chart height.
- **Multi-series overlay:** Up to 5 cycles rendered simultaneously with distinct colours.
- **Crosshair:** Toggle-able hover crosshair showing time + value tooltip.
- **Absolute timestamps:** When `startMs` is provided, X-axis labels and crosshair tooltip show real clock time in **GMT+3** (`Africa/Nairobi` timezone) instead of relative seconds.

### 11.4 Signal Viewer (`SignalViewer.tsx`)

The `SignalViewer` component integrates with `esp32_raw_batches` to provide:

- **Device selector:** Filter by device ID (shows custom label if set).
- **Cycle selector:** Navigate between historical 2000-sample cycles.
- **Compare mode:** Select up to 5 cycles for side-by-side overlay or averaged waveform.
- **Tabs:** ECG · PPG (IR) · Accelerometer magnitude.
- **Refresh:** Reload devices, cycles, and signals independently.

### 11.5 Cycle Detail Page (`/cycles/[cycleId]`)

A dedicated full-page view per cycle, accessible from the Devices page:

- **Header:** Device name, cycle name (custom or auto), cycle UUID.
- **Meta strip:** Batch count, duration, sample rate, timestamp, matched BP prediction.
- **View toggle:** Charts mode (3 SignalCharts) or Table mode.
- **Table mode:** Paginated 100-row pages showing all samples with GMT+3 timestamps, ECG, PPG IR, and accelerometer magnitude values.

---

## 12. Device & Cycle Management

### 12.1 Device Naming

Devices are identified by their `device_id` string (e.g. `esp32-001`). The system supports custom naming at two levels:

**From firmware:** The ESP32 sends `"device_name": "ESP32-001"` in every POST. The server auto-registers this as the label in the `devices` table on first contact (only if no user-set label exists yet).

**From dashboard:** The Devices page (`/devices`) allows inline renaming of any device. The custom label is stored in the `devices.label` column and shown throughout the dashboard wherever the device ID would otherwise appear.

### 12.2 Cycle Naming

Each prediction cycle (2000-sample window) can be given a human-readable label:

- Custom labels are stored in the `cycle_labels` table keyed by `(cycle_id, user_id)`.
- Managed on the **Devices page** — each device card shows all its cycles in a table with time, predicted BP, batch count, and an inline ✎ rename control.
- The **Signal Viewer** on Live/History pages shows cycle pills with custom labels.
- The **Cycle detail page** header shows the custom name.

---

## 13. Technology Stack

| Layer | Technology | Version |
|---|---|---|
| **Firmware** | Arduino / ESP32 | — |
| **MCU** | Espressif ESP32 | — |
| **PPG sensor** | MAX30100 (oxullo library) | — |
| **IMU** | MPU6050 (Adafruit) | — |
| **ML runtime** | Python | 3.12+ |
| **ML framework** | scikit-learn | — |
| **Signal processing** | neurokit2, scipy, numpy | — |
| **Data I/O** | pandas, wfdb (PhysioNet) | — |
| **API framework** | FastAPI | — |
| **ASGI server** | uvicorn | — |
| **Database** | Supabase (PostgreSQL) | — |
| **Frontend framework** | Next.js | 16.2.6 |
| **UI library** | React | 18.3 |
| **Type safety** | TypeScript | 5.6 |
| **DB client** | @supabase/supabase-js | 2.50 |

---

## 14. Limitations & Future Work

### 14.1 Current Limitations

| Area | Limitation |
|---|---|
| **Clinical accuracy** | SBP MAE ~10.25 mmHg does not meet AAMI/ISO 81060-2 (≤5 mmHg mean, ≤8 mmHg SD). |
| **Calibration** | No per-user calibration. A single PhysioNet-trained model is applied to all users regardless of individual arterial properties. |
| **Domain shift** | Training on PhysioNet hardware vs deployment on custom ESP32 introduces a domain gap; performance on ESP32 data is not yet empirically validated. |
| **Sampling rate bridge** | The firmware sends 20 Hz data; the model window assumes 250 Hz. The server treats buffered samples as 250 Hz for feature extraction. Formal validation of this resampling step is required. |
| **Motion rejection** | Simple percentile-based masking; NLMS adaptive filtering would improve accuracy during motion. |
| **Lead placement** | Uncontrolled single-lead ECG from GPIO 34; electrode placement affects R-peak quality. |
| **WebSocket path** | The WS ESP32 ingest path is deprecated; HTTP-only for reliability. |

### 14.2 Future Work

1. **Per-user calibration:** Collect 2–3 reference cuff measurements per user and fine-tune the model with user-specific bias correction.
2. **ESP32 ground-truth dataset:** Build a labeled dataset using the ESP32 hardware paired with a reference sphygmomanometer to close the domain gap.
3. **Improved resampling:** Implement proper upsampling (e.g. LERP or spline) with anti-aliasing for the 20 Hz → 250 Hz bridge.
4. **Deep learning exploration:** LSTM or 1D-CNN directly on raw waveforms to reduce feature engineering brittleness.
5. **NLMS motion cancellation:** Adaptive noise cancellation using the IMU as the reference channel.
6. **Clinical evaluation:** Formal validation study following IEEE 1708 protocol.
7. **OTA firmware updates:** Over-the-air firmware update mechanism for deployed devices.
8. **Mobile companion app:** React Native or PWA for field use outside the dashboard.

---

## 15. Conclusion

This project successfully demonstrates a complete, end-to-end cuffless blood pressure estimation prototype spanning four engineering domains:

- **Embedded systems** — ESP32 firmware with a validated 20 Hz scheduler, 1 s batched HTTP ingest, synchronised multi-sensor acquisition, NTP timestamps, and FIFO recovery under WiFi load (§4.4).
- **Signal processing** — A physiologically grounded preprocessing and feature extraction pipeline (bandpass filtering, R-peak detection via neurokit2, PTT estimation, HRV, PPG morphology, and motion features) implemented identically in training and inference.
- **Machine learning** — A subject-grouped ExtraTrees regressor achieving **10.25 mmHg SBP MAE** and **6.62 mmHg DBP MAE** on the PhysioNet PTT-PPG hold-out set, with full train/serve artifact alignment.
- **Full-stack web application** — A real-time Next.js dashboard with custom SVG signal visualisation, device and cycle management, Supabase Realtime integration, and internationalisation support.

The architecture is modular and extensible: each layer can be improved independently. The most impactful next step is collecting a labeled ESP32-specific dataset to close the domain gap between PhysioNet training data and real-world hardware deployment, which is expected to substantially improve clinical accuracy.

---

*Prepared for Final Year Project assessment, May 2026.*
