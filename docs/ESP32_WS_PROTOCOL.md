## WebSocket ingestion protocol

Endpoint (local dev):
- `ws://127.0.0.1:8000/ws/ingest`

### Message format (client → server)
Send **JSON text frames** shaped like:

```json
{
  "device_id": "esp32-001",
  "ts_ms_start": 1715150000000,
  "fs_hz": 100,
  "window_s": 8.0,
  "ecg": [0.1, 0.2, 0.3],
  "ppg": [0.01, 0.02, 0.03],
  "accel": [[0.0, 0.1, 0.9]],

  "user_id": "SUPABASE_AUTH_USER_UUID (optional, required for DB insert)",
  "session_id": "UUID (optional)",
  "persist_raw": false
}
```

Notes:
- **Chunking**: you can stream small chunks (e.g. 1s). Server buffers until it has `window_s * fs_hz` samples and then extracts features/predicts.
- `accel` is optional; if omitted, the server uses zeros.
- For Supabase inserts, set backend env vars `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` and include `user_id` in frames.

### Server responses (server → client)
Server replies with JSON like:
- Buffering status:
```json
{"ok": true, "buffered_n": 300, "needed_n": 800}
```
- After producing predictions (and optional DB inserts):
```json
{"ok": true, "pred": {"sbp": 118.2, "dbp": 74.1}, "wrote": 1}
```

### Local replay simulator (PhysioNet)
Replays a PhysioNet WFDB record over the WebSocket:

```bash
python scripts/replay_physionet_over_ws.py --dataset-root "C:\Users\user\Desktop\finalproj_ml\data\pulse-transit-time-ppg" --record s1_walk --ws-url ws://127.0.0.1:8000/ws/ingest
```

