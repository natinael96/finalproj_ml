# WebSocket ingestion protocol

This document describes how clients talk to **FastAPI** (`bp_api/main.py`) over WebSockets. For thesis-level detail (ML pipeline, firmware fixes, sequence diagrams), see [FINAL_YEAR_PROJECT_DOCUMENTATION.md](./FINAL_YEAR_PROJECT_DOCUMENTATION.md) Sections 4.5, 9.4, 12, and 13.

**Server (local dev):**

```bash
uvicorn bp_api.main:app --host 0.0.0.0 --port 8000
```

Use your machine’s **LAN IP** from the ESP32 (not `127.0.0.1`).

---

## Endpoints overview

| Path | Payload style | Typical client |
|------|---------------|----------------|
| `/ws/esp32` | One JSON object **per sample** | `firmware/esp32_bp_stream` |
| `/ws/ingest` | JSON with **arrays** per chunk | `scripts/replay_physionet_over_ws.py` |
| `/ws/dashboard` | Server → client only | Next.js live page |

All ingest paths buffer samples until `window_s × fs_hz` samples exist, then run feature extraction + `model.predict`, optionally write Supabase, and broadcast to dashboards.

---

## `/ws/esp32` — per-sample firmware stream

### Connect URL

```text
ws://192.168.x.x:8000/ws/esp32?device_id=esp32-001&fs_hz=250&window_s=8.0
```

Optional query parameters:

| Param | Default | Description |
|-------|---------|-------------|
| `device_id` | `esp32` | Key for server-side buffer |
| `fs_hz` | `250` | **Must match** firmware `WS_FS_HZ` in `config.h` |
| `window_s` | `8.0` | Seconds of data before each prediction |
| `user_id` | — | Supabase Auth UUID (required for DB insert) |
| `session_id` | — | Optional session FK |
| `persist_raw` | `0` | `1` = store raw ecg/ppg/accel/gyro in DB |
| `verbose` | `0` | `1` = periodic `buffered_n` replies while filling |

### Client → server (one text frame per sample)

```json
{
  "t": 123456789,
  "ecg": 2048,
  "ir": 180000,
  "red": 175000,
  "ax": 0.12,
  "ay": -0.05,
  "az": 9.81,
  "gx": 0.01,
  "gy": 0.00,
  "gz": 0.00
}
```

| Field | Type | Required | Server behavior |
|-------|------|----------|-----------------|
| `ecg` | number | yes | Appended to ECG buffer; if `< 0`, last valid value used |
| `ir` | number | no* | Updates PPG; preferred over `red` |
| `red` | number | no* | Used if `ir` absent |
| `ax`…`gz` | number | no | Default `0`; appended to IMU buffers |
| `t` | int | no | Device timestamp (µs); not used for window alignment |

\*At least one of `ir` / `red` should be sent over time so PPG is non-zero.

### Server → client

While buffering (only if `verbose=1`, every 50 samples):

```json
{"ok": true, "buffered_n": 450, "needed_n": 2000}
```

After a full window is processed:

```json
{"ok": true, "pred": {"sbp": 118.2, "dbp": 74.1}, "wrote": 1}
```

Errors:

```json
{"ok": false, "error": "non-finite feature values (NaN/Inf) after imputation"}
```

### What the server does with each sample (summary)

1. Parse JSON → `Esp32Sample` (Pydantic).
2. Sanitize ECG (hold last if negative).
3. Update `last_ppg` from `ir` or `red`; append to per-device buffer.
4. Append IMU rows.
5. When `min(len(ecg), len(ppg)) >= round(window_s * fs_hz)`:
   - Bandpass ECG/PPG, motion-mask PPG, detect peaks, compute features.
   - Impute NaNs with training medians.
   - Predict SBP/DBP; trim buffer by one window; optionally insert DB.

### Firmware

- Sketch: `firmware/esp32_bp_stream/esp32_bp_stream.ino`
- Config: copy `config.example.h` → `config.h`
- Libraries: MAX30100, Adafruit MPU6050, WebSockets (Links2004)

**Known issues fixed in this sketch (vs early Serial-only prototype):**

- MAX30100 FIFO overflow → dedicated core-0 drain task.
- 25 Hz Serial print vs 250 Hz API → `esp_timer` 250 Hz scheduler + WebSocket.
- WiFi off after NTP → WiFi stays up for streaming.
- Wrong JSON shape → flat `Esp32Sample` keys.

---

## `/ws/ingest` — chunked array ingest

### Connect URL

```text
ws://127.0.0.1:8000/ws/ingest
```

Parameters are sent **inside each JSON frame**, not as query strings.

### Client → server

```json
{
  "device_id": "esp32-001",
  "ts_ms_start": 1715150000000,
  "fs_hz": 250,
  "window_s": 8.0,
  "ecg": [2048.0, 2050.0],
  "ppg": [180000.0, 180005.0],
  "accel": [[0.0, 0.1, 9.8], [0.0, 0.1, 9.7]],
  "gyro": [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0]],
  "user_id": "SUPABASE_AUTH_USER_UUID",
  "session_id": "optional-uuid",
  "persist_raw": false
}
```

Notes:

- **Chunking:** send 0.5–2 s of samples per frame; server accumulates until the window is full.
- `accel` / `gyro` are optional (zeros used if missing).
- `ts_ms_start` is taken from the **first** frame for that `device_id`.
- For Supabase: set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` on the server and include `user_id`.

### Server → client

Same response shapes as `/ws/esp32` (`buffered_n` / `pred` / `error`).

---

## `/ws/dashboard` — live predictions

Clients connect to receive broadcasts after each processed window:

```json
{
  "type": "telemetry_window",
  "device_id": "esp32-001",
  "ts_ms_start": 1715150000000,
  "sbp_pred": 120.5,
  "dbp_pred": 78.2
}
```

---

## Timing cheat sheet

| Setting | Default | Samples per window |
|---------|---------|-------------------|
| `fs_hz` | 250 | — |
| `window_s` | 8.0 | **2000** ECG + 2000 PPG |

Time to first prediction ≈ **8 seconds** of continuous streaming at full rate.

---

## Local replay (PhysioNet → `/ws/ingest`)

```bash
python scripts/replay_physionet_over_ws.py \
  --dataset-root "C:\Users\user\Desktop\finalproj_ml\data\pulse-transit-time-ppg" \
  --record s1_walk \
  --ws-url ws://127.0.0.1:8000/ws/ingest \
  --user-id <SUPABASE_USER_UUID> \
  --hop-s 1.0 \
  --window-s 8.0 \
  --realtime
```

---

## Choosing an endpoint

| Use `/ws/esp32` when… | Use `/ws/ingest` when… |
|------------------------|-------------------------|
| Streaming from ESP32 firmware | Replaying WFDB / bulk chunks |
| One sample per WebSocket frame | Lower JSON overhead per sample |
| Query params set at connect | Per-frame metadata in JSON body |

Both call the same `_process_buffered_windows()` inference logic after buffering.
