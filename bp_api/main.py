from __future__ import annotations

import asyncio
import csv
import json
import os
import socket
import time
import math
import uuid
from uuid import UUID
from pathlib import Path
from functools import lru_cache
from threading import Lock
from typing import Dict, List, Optional, Tuple

import numpy as np
import requests
from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from bp_pipeline.features import DEFAULT_FEATURES, FeatureSchema, extract_features_from_signals
from bp_pipeline.inference import ArtifactBundle, load_artifact_bundle
from bp_pipeline.preprocess import SamplingRates

MAX_BATCH_ROWS = 256
MAX_FEATURES_PER_ROW = 512
MAX_FRAME_SAMPLES = 5000
MAX_BUFFER_SAMPLES = 20000
MIN_FS_HZ = 10
MAX_FS_HZ = 1000
MIN_WINDOW_S = 1.0
MAX_WINDOW_S = 30.0
# Model inference window (8 s @ 250 Hz) — ESP32 may POST small batches; server buffers.
ESP32_PREDICTION_SAMPLES = int(os.getenv("ESP32_PREDICTION_SAMPLES", "2000"))
ESP32_PREDICTION_FS_HZ = int(os.getenv("ESP32_PREDICTION_FS_HZ", "250"))
ESP32_PREDICTION_WINDOW_S = float(os.getenv("ESP32_PREDICTION_WINDOW_S", "8.0"))
_synthetic_csv_lock = Lock()

def _load_env() -> None:
    """
    Load repo-root `.env.local` explicitly for FastAPI runtime.

    This keeps local dev ergonomic on Windows/Git Bash where exporting env vars
    can be inconsistent across terminals.
    """
    try:
        from dotenv import load_dotenv  # type: ignore
    except Exception:
        return

    # bp_api/main.py -> repo root
    root = Path(__file__).resolve().parents[1]
    env_path = root / ".env.local"
    if env_path.exists():
        load_dotenv(env_path, override=False)


_load_env()


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _model_artifact_path() -> Path:
    raw = os.environ.get("BP_MODEL_PATH", "artifacts/model.joblib")
    p = Path(raw)
    if not p.is_absolute():
        p = _repo_root() / p
    return p


def _synthetic_csv_path() -> Path:
    raw = os.environ.get("BP_SYNTHETIC_CSV_PATH", "artifacts/synthetic_telemetry.csv")
    p = Path(raw)
    if not p.is_absolute():
        p = _repo_root() / p
    return p


class PredictRequest(BaseModel):
    features: List[float] = Field(
        ..., min_length=1, max_length=MAX_FEATURES_PER_ROW, description="Feature vector aligned with the deployed schema"
    )


class PredictResponse(BaseModel):
    sbp: float
    dbp: float
    sbp_std: Optional[float] = None
    dbp_std: Optional[float] = None
    schema_names: Optional[List[str]] = None


@lru_cache(maxsize=1)
def load_artifact() -> ArtifactBundle:
    path = _model_artifact_path()
    if not path.is_file():
        raise RuntimeError(
            f"Model artifact not found at {path}. "
            "Train with: python -m bp_pipeline.train --physionet-ptt-dir <data> --out artifacts "
            "Or create a smoke-test model: python scripts/build_demo_model.py"
        )
    try:
        return load_artifact_bundle(path)
    except Exception as e:
        raise RuntimeError(f"Failed to load model artifact at {path}: {e}") from e


def _missing_live_feature_names(names: List[str]) -> List[str]:
    live_names = set(DEFAULT_FEATURES.names)
    return [name for name in names if name not in live_names]


def _configured_api_key() -> str:
    return os.environ.get("BP_API_KEY", "").strip()


def _websockets_enabled() -> bool:
    """Set BP_WEBSOCKET_ENABLED=true to re-enable /ws/* endpoints and dashboard broadcasts."""
    raw = os.environ.get("BP_WEBSOCKET_ENABLED", "false").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _require_api_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    expected = _configured_api_key()
    if expected and x_api_key != expected:
        raise HTTPException(status_code=401, detail="Missing or invalid API key")


async def _ws_api_key_allowed(ws: WebSocket) -> bool:
    expected = _configured_api_key()
    if not expected:
        return True
    provided = ws.query_params.get("api_key") or ws.headers.get("x-api-key")
    if provided == expected:
        return True
    await ws.accept()
    await ws.send_json({"ok": False, "error": "missing_or_invalid_api_key"})
    await ws.close()
    return False


app = FastAPI(title="BP Predictor API", version="0.1.0")
_allowed_origins = [
    origin.strip()
    for origin in os.environ.get(
        "BP_API_CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _local_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return str(s.getsockname()[0])
    except Exception:
        return "YOUR_PC_LAN_IP"


@app.on_event("startup")
async def _print_runtime_urls() -> None:
    port = int(os.environ.get("BP_API_PORT", "8000"))
    lan_ip = os.environ.get("BP_API_LAN_IP", "").strip() or _local_lan_ip()
    local_base = f"http://127.0.0.1:{port}"
    lan_base = f"http://{lan_ip}:{port}"
    print("", flush=True)
    print("BP Predictor API ready", flush=True)
    print(f"  Local API:        {local_base}", flush=True)
    print(f"  LAN API:          {lan_base}", flush=True)
    print(f"  Health:           {local_base}/health", flush=True)
    print(
        f"  ESP32 ingest:     POST {lan_base}/esp32/ingest  "
        f"(buffer → {ESP32_PREDICTION_SAMPLES} samples @ {ESP32_PREDICTION_FS_HZ} Hz)",
        flush=True,
    )
    sb = supabase_rest_config()
    if sb and not _server_db_user_id():
        print("  WARN: SUPABASE_* set but BP_DEFAULT_USER_ID missing — ESP32 DB writes disabled", flush=True)
    elif sb:
        print("  Supabase writes:  esp32_raw_batches + telemetry_windows (server-side)", flush=True)
    if _websockets_enabled():
        print(f"  Dashboard WS:     ws://127.0.0.1:{port}/ws/dashboard", flush=True)
        print(f"  Ingest WS:        ws://{lan_ip}:{port}/ws/ingest", flush=True)
    else:
        print("  WebSockets:       disabled (set BP_WEBSOCKET_ENABLED=true to enable)", flush=True)
    print(f"  Synthetic CSV:    {_synthetic_csv_path()}", flush=True)
    print("", flush=True)


_dash_clients: set[WebSocket] = set()

async def _dash_broadcast(msg: Dict[str, object]) -> None:
    if not _websockets_enabled():
        return
    dead: List[WebSocket] = []
    for c in list(_dash_clients):
        try:
            await c.send_json(msg)
        except Exception:
            dead.append(c)
    for c in dead:
        _dash_clients.discard(c)

@lru_cache(maxsize=1)
def supabase_rest_config() -> Optional[Dict[str, str]]:
    """
    Use Supabase PostgREST directly to avoid installing the supabase Python package,
    which pulls dependencies that require MSVC build tools on Windows.

    Requires:
      - SUPABASE_URL (e.g. https://xxxx.supabase.co)
      - SUPABASE_SERVICE_ROLE_KEY
    """
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        return None
    return {"url": url, "key": key}


def _ensemble_std(artifact: ArtifactBundle, x: np.ndarray) -> Tuple[Optional[float], Optional[float]]:
    """Tree-ensemble spread heuristic (same logic as POST /predict)."""
    sbp_std: Optional[float] = None
    dbp_std: Optional[float] = None
    try:
        model = artifact.model
        est0 = getattr(model, "estimators_", None)
        if isinstance(est0, (list, tuple)) and len(est0) == 2:
            sbp_models = getattr(est0[0], "estimators_", None)
            dbp_models = getattr(est0[1], "estimators_", None)
            if sbp_models and dbp_models:
                sbp_preds = np.asarray([m.predict([x])[0] for m in sbp_models], dtype=float)
                dbp_preds = np.asarray([m.predict([x])[0] for m in dbp_models], dtype=float)
                if np.all(np.isfinite(sbp_preds)):
                    sbp_std = float(np.std(sbp_preds))
                if np.all(np.isfinite(dbp_preds)):
                    dbp_std = float(np.std(dbp_preds))
    except Exception:
        pass
    return sbp_std, dbp_std


def _clean_floats(obj: object) -> object:
    """Replace NaN / Inf floats (including inside lists/dicts) with None.

    PostgREST rejects JSON payloads that contain bare NaN or Infinity values,
    producing the "Out of range float values are not JSON compliant" error.
    This must be applied to every row before inserting into Supabase.
    """
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, list):
        return [_clean_floats(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _clean_floats(v) for k, v in obj.items()}
    return obj


def _supabase_postgrest_insert(table: str, row: Dict[str, object]) -> None:
    cfg = supabase_rest_config()
    if not cfg:
        return
    endpoint = f"{cfg['url']}/rest/v1/{table}"
    headers = {
        "apikey": cfg["key"],
        "Authorization": f"Bearer {cfg['key']}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    r = requests.post(endpoint, headers=headers, json=row, timeout=20)
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase insert into {table} failed {r.status_code}: {r.text}")


def _supabase_insert_telemetry(row: Dict[str, object]) -> None:
    _supabase_postgrest_insert("telemetry_windows", row)


def _supabase_insert_raw_batch(row: Dict[str, object]) -> None:
    _supabase_postgrest_insert("esp32_raw_batches", row)


async def _supabase_insert_telemetry_async(row: Dict[str, object]) -> None:
    # Keep slow PostgREST calls out of the WebSocket event loop.
    await asyncio.to_thread(_supabase_insert_telemetry, row)


def _server_db_user_id() -> Optional[str]:
    """Owner UUID for Supabase rows (ESP32 does not send user_id)."""
    return (os.environ.get("BP_DEFAULT_USER_ID") or "").strip() or None


def _server_db_session_id() -> Optional[str]:
    return (os.environ.get("BP_DEFAULT_SESSION_ID") or "").strip() or None


def _esp32_db_write_context() -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Resolve user/session for server-side DB inserts.
    Returns (user_id, session_id, error_message).
    """
    if not supabase_rest_config():
        return None, None, None
    user_id = _server_db_user_id()
    if not user_id:
        return (
            None,
            None,
            "Supabase is configured but BP_DEFAULT_USER_ID is not set in server .env",
        )
    if not _is_uuid(user_id):
        return None, None, "BP_DEFAULT_USER_ID must be a UUID"
    session_id = _server_db_session_id()
    if session_id and not _is_uuid(session_id):
        return None, None, "BP_DEFAULT_SESSION_ID must be a UUID"
    return user_id, session_id or None, None


def _join_warnings(*parts: Optional[str]) -> Optional[str]:
    tokens = [str(p).strip() for p in parts if p and str(p).strip()]
    return ";".join(tokens) if tokens else None


def _epoch_ms_now() -> int:
    return int(time.time() * 1000)


def _iso_utc_from_ms(ts_ms: int) -> str:
    """RFC 3339 / ISO-8601 UTC for Supabase timestamptz columns."""
    from datetime import datetime, timezone

    dt = datetime.fromtimestamp(int(ts_ms) / 1000.0, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _is_plausible_epoch_ms(ts_ms: int) -> bool:
    """Reject ESP millis()-since-boot values; accept real Unix epoch ms."""
    now = _epoch_ms_now()
    return 1_577_836_800_000 <= int(ts_ms) <= now + 86_400_000


def _normalize_batch_ts_ms(req: "Esp32IngestRequest") -> int:
    """
    Window start as Unix epoch milliseconds (UTC).
    ESP may send millis() uptime before NTP — server substitutes wall clock.
    """
    ts = int(req.ts_ms_start)
    if _is_plausible_epoch_ms(ts):
        return ts
    return _epoch_ms_now() - int(round(float(req.window_s) * 1000.0))


def _build_esp32_raw_batch_row(req: "Esp32IngestRequest", n: int, user_id: Optional[str]) -> Dict[str, object]:
    ts_start = _normalize_batch_ts_ms(req)
    ts_end = _epoch_ms_now()
    row: Dict[str, object] = {
        "device_id": req.device_id,
        "ts_ms_start": ts_start,
        "created_at": _iso_utc_from_ms(ts_end),
        "fs_hz": int(req.fs_hz),
        "window_s": float(req.window_s),
        "sample_count": int(n),
        "ecg": [float(x) for x in req.ecg[:n]],
        "ppg": [float(x) for x in req.ppg[:n]],
    }
    if user_id:
        row["user_id"] = user_id
    if req.session_id:
        row["session_id"] = req.session_id
    if req.ax is not None and req.ay is not None and req.az is not None:
        lim = min(n, len(req.ax), len(req.ay), len(req.az))
        row["ax"] = [float(req.ax[i]) for i in range(lim)]
        row["ay"] = [float(req.ay[i]) for i in range(lim)]
        row["az"] = [float(req.az[i]) for i in range(lim)]
    if req.gx is not None and req.gy is not None and req.gz is not None:
        lim = min(n, len(req.gx), len(req.gy), len(req.gz))
        row["gx"] = [float(req.gx[i]) for i in range(lim)]
        row["gy"] = [float(req.gy[i]) for i in range(lim)]
        row["gz"] = [float(req.gz[i]) for i in range(lim)]
    return row


def _append_synthetic_telemetry_csv(row: Dict[str, object]) -> None:
    path = _synthetic_csv_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "created_at_ms",
        "device_id",
        "ts_ms_start",
        "fs_hz",
        "window_s",
        "sbp_pred",
        "dbp_pred",
        "schema_names",
        "features",
        "ecg",
        "ppg",
        "accel",
        "gyro",
    ]
    serializable = {
        "created_at_ms": int(time.time() * 1000),
        "device_id": row.get("device_id", ""),
        "ts_ms_start": row.get("ts_ms_start", ""),
        "fs_hz": row.get("fs_hz", ""),
        "window_s": row.get("window_s", ""),
        "sbp_pred": row.get("sbp_pred", ""),
        "dbp_pred": row.get("dbp_pred", ""),
        "schema_names": json.dumps(row.get("schema_names", [])),
        "features": json.dumps(row.get("features", [])),
        "ecg": json.dumps(row.get("ecg", [])),
        "ppg": json.dumps(row.get("ppg", [])),
        "accel": json.dumps(row.get("accel", [])),
        "gyro": json.dumps(row.get("gyro", [])),
    }
    with _synthetic_csv_lock:
        exists = path.exists()
        with path.open("a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            if not exists:
                writer.writeheader()
            writer.writerow(serializable)


async def _append_synthetic_telemetry_csv_async(row: Dict[str, object]) -> None:
    await asyncio.to_thread(_append_synthetic_telemetry_csv, row)


class IngestFrame(BaseModel):
    device_id: str = Field(..., min_length=1, max_length=80)
    ts_ms_start: int
    fs_hz: int = Field(100, ge=MIN_FS_HZ, le=MAX_FS_HZ)
    ecg: List[float] = Field(..., min_length=1, max_length=MAX_FRAME_SAMPLES)
    ppg: List[float] = Field(..., min_length=1, max_length=MAX_FRAME_SAMPLES)
    accel: Optional[List[Tuple[float, float, float]]] = Field(default=None, max_length=MAX_FRAME_SAMPLES)
    gyro: Optional[List[Tuple[float, float, float]]] = Field(default=None, max_length=MAX_FRAME_SAMPLES)
    session_id: Optional[str] = Field(default=None, max_length=120)
    user_id: Optional[str] = Field(default=None, max_length=120)  # server-side auth later; for now explicit user_id
    window_s: float = Field(8.0, ge=MIN_WINDOW_S, le=MAX_WINDOW_S)
    persist_raw: bool = False


class Esp32IngestRequest(BaseModel):
    """ESP32 sample batch (any size); server buffers until prediction window is full."""

    model_config = ConfigDict(extra="ignore")

    device_id: str = Field(..., min_length=1, max_length=80)
    ts_ms_start: int
    fs_hz: int = Field(250, ge=MIN_FS_HZ, le=MAX_FS_HZ)
    window_s: float = Field(8.0, ge=MIN_WINDOW_S, le=MAX_WINDOW_S)
    ecg: List[float] = Field(..., min_length=1, max_length=MAX_FRAME_SAMPLES)
    ppg: List[float] = Field(..., min_length=1, max_length=MAX_FRAME_SAMPLES)
    ax: Optional[List[float]] = Field(default=None, max_length=MAX_FRAME_SAMPLES)
    ay: Optional[List[float]] = Field(default=None, max_length=MAX_FRAME_SAMPLES)
    az: Optional[List[float]] = Field(default=None, max_length=MAX_FRAME_SAMPLES)
    gx: Optional[List[float]] = Field(default=None, max_length=MAX_FRAME_SAMPLES)
    gy: Optional[List[float]] = Field(default=None, max_length=MAX_FRAME_SAMPLES)
    gz: Optional[List[float]] = Field(default=None, max_length=MAX_FRAME_SAMPLES)
    user_id: Optional[str] = Field(default=None, max_length=120)
    session_id: Optional[str] = Field(default=None, max_length=120)
    persist_raw: bool = False


class Esp32IngestResponse(BaseModel):
    ok: bool
    pred: Optional[Dict[str, float]] = None
    wrote: int = 0  # rows written to telemetry_windows (predictions)
    raw_wrote: int = 0  # rows written to esp32_raw_batches
    error: Optional[str] = None
    warning: Optional[str] = None
    missing_live_features: Optional[List[str]] = None
    buffered_n: Optional[int] = None
    needed_n: Optional[int] = None


class _DeviceBuffer:
    def __init__(self) -> None:
        self.ecg: List[float] = []
        self.ppg: List[float] = []
        self.accel: List[List[float]] = []
        self.gyro: List[List[float]] = []
        self.synthetic: List[bool] = []
        self.fs_hz: int = 0
        self.ts_ms_start: int = 0
        self.last_seen_ms: int = int(time.time() * 1000)
        # Identifies the current 2000-sample accumulation window.
        # Rotated to a new UUID every time a window is flushed for prediction.
        self.cycle_id: str = str(uuid.uuid4())


_buffers: Dict[str, _DeviceBuffer] = {}
_buffer_locks: Dict[str, asyncio.Lock] = {}
_buffer_refs: Dict[str, int] = {}


def _get_buffer(device_id: str, ts_ms_start: Optional[int] = None) -> _DeviceBuffer:
    buf = _buffers.get(device_id)
    if buf is None:
        buf = _DeviceBuffer()
        _buffers[device_id] = buf
        buf.ts_ms_start = int(ts_ms_start if ts_ms_start is not None else time.time() * 1000)
    buf.last_seen_ms = int(time.time() * 1000)
    return buf


def _get_buffer_lock(device_id: str) -> asyncio.Lock:
    lock = _buffer_locks.get(device_id)
    if lock is None:
        lock = asyncio.Lock()
        _buffer_locks[device_id] = lock
    return lock


def _trim_buffer(buf: _DeviceBuffer, max_samples: int = MAX_BUFFER_SAMPLES) -> None:
    n = min(len(buf.ecg), len(buf.ppg))
    if n <= max_samples:
        return
    drop = n - max_samples
    del buf.ecg[:drop]
    del buf.ppg[:drop]
    if buf.accel:
        del buf.accel[: min(drop, len(buf.accel))]
    if buf.gyro:
        del buf.gyro[: min(drop, len(buf.gyro))]
    if buf.synthetic:
        del buf.synthetic[: min(drop, len(buf.synthetic))]
    if buf.fs_hz > 0:
        buf.ts_ms_start += int(1000.0 * drop / float(buf.fs_hz))


def _retain_buffer(device_id: str) -> None:
    _buffer_refs[device_id] = _buffer_refs.get(device_id, 0) + 1


def _release_buffer(device_id: str) -> None:
    refs = max(_buffer_refs.get(device_id, 1) - 1, 0)
    if refs:
        _buffer_refs[device_id] = refs
        return
    _buffer_refs.pop(device_id, None)
    _buffers.pop(device_id, None)
    _buffer_locks.pop(device_id, None)


def _parse_int_query(ws: WebSocket, name: str, default: int, min_value: int, max_value: int) -> int:
    raw = ws.query_params.get(name)
    try:
        value = int(raw) if raw not in (None, "") else default
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if not min_value <= value <= max_value:
        raise ValueError(f"{name} must be between {min_value} and {max_value}")
    return value


def _parse_float_query(ws: WebSocket, name: str, default: float, min_value: float, max_value: float) -> float:
    raw = ws.query_params.get(name)
    try:
        value = float(raw) if raw not in (None, "") else default
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    if not min_value <= value <= max_value:
        raise ValueError(f"{name} must be between {min_value} and {max_value}")
    return value


def _is_uuid(value: Optional[str]) -> bool:
    if not value:
        return True
    try:
        UUID(str(value))
        return True
    except ValueError:
        return False


class Esp32Sample(BaseModel):
    """One sample from ESP32 firmware: t, ecg, ir, red, ax..gz (JSON keys as in Arduino)."""

    model_config = ConfigDict(extra="ignore")

    t: Optional[int] = None
    ecg: float
    ir: Optional[float] = None
    red: Optional[float] = None
    ax: Optional[float] = None
    ay: Optional[float] = None
    az: Optional[float] = None
    gx: Optional[float] = None
    gy: Optional[float] = None
    gz: Optional[float] = None
    synthetic: Optional[bool] = None


def _flat_imu_matrix(
    ax: Optional[List[float]],
    ay: Optional[List[float]],
    az: Optional[List[float]],
    win_n: int,
) -> np.ndarray:
    if not ax or not ay or not az:
        return np.zeros((win_n, 3), dtype=float)
    n = min(win_n, len(ax), len(ay), len(az))
    mat = np.zeros((win_n, 3), dtype=float)
    if n > 0:
        mat[:n, 0] = np.asarray(ax[:n], dtype=float)
        mat[:n, 1] = np.asarray(ay[:n], dtype=float)
        mat[:n, 2] = np.asarray(az[:n], dtype=float)
    return mat


def _append_esp32_batch(buf: _DeviceBuffer, req: Esp32IngestRequest) -> int:
    """Append one HTTP batch to the per-device buffer. Returns sample count appended."""
    n = min(len(req.ecg), len(req.ppg))
    if n <= 0:
        return 0
    if buf.fs_hz == 0:
        buf.fs_hz = int(req.fs_hz)
    if not buf.ecg:
        buf.ts_ms_start = _normalize_batch_ts_ms(req)

    buf.ecg.extend(float(x) for x in req.ecg[:n])
    buf.ppg.extend(float(x) for x in req.ppg[:n])
    if req.ax is not None and req.ay is not None and req.az is not None:
        lim = min(n, len(req.ax), len(req.ay), len(req.az))
        buf.accel.extend(
            [float(req.ax[i]), float(req.ay[i]), float(req.az[i])] for i in range(lim)
        )
    if req.gx is not None and req.gy is not None and req.gz is not None:
        lim = min(n, len(req.gx), len(req.gy), len(req.gz))
        buf.gyro.extend(
            [float(req.gx[i]), float(req.gy[i]), float(req.gz[i])] for i in range(lim)
        )
    _trim_buffer(buf)
    return n


def _ingest_esp32_buffered_sync(req: Esp32IngestRequest, buf: _DeviceBuffer) -> Esp32IngestResponse:
    """
    Save every POST to esp32_raw_batches; buffer samples until ESP32_PREDICTION_SAMPLES
    (default 2000); then predict and insert one row into telemetry_windows.
    """
    win_n = ESP32_PREDICTION_SAMPLES
    pred_fs = ESP32_PREDICTION_FS_HZ
    pred_window_s = ESP32_PREDICTION_WINDOW_S

    if not req.ecg or not req.ppg:
        return Esp32IngestResponse(ok=False, error="empty ecg or ppg batch")

    batch_n = min(len(req.ecg), len(req.ppg))
    if batch_n <= 0:
        return Esp32IngestResponse(ok=False, error="empty ecg or ppg batch")

    db_user_id, db_session_id, db_err = _esp32_db_write_context()
    if db_err:
        return Esp32IngestResponse(ok=False, error=db_err)

    raw_wrote = 0
    warning: Optional[str] = None

    if db_user_id:
        try:
            raw_row = _build_esp32_raw_batch_row(req, batch_n, db_user_id)
            if db_session_id:
                raw_row["session_id"] = db_session_id
            # Tag with the current accumulation-window cycle so the dashboard can
            # group all batches that belong to the same 2000-sample prediction run.
            raw_row["cycle_id"] = buf.cycle_id
            _supabase_insert_raw_batch(raw_row)
            raw_wrote = 1
        except Exception as e:
            return Esp32IngestResponse(ok=False, error=f"raw_db_insert_failed: {e}")

    if _append_esp32_batch(buf, req) <= 0:
        return Esp32IngestResponse(ok=False, error="empty ecg or ppg batch", raw_wrote=raw_wrote)

    buf_n = min(len(buf.ecg), len(buf.ppg))
    if buf_n < win_n:
        return Esp32IngestResponse(
            ok=True,
            buffered_n=buf_n,
            needed_n=win_n,
            raw_wrote=raw_wrote,
            warning=warning,
        )

    try:
        artifact = load_artifact()
    except RuntimeError as e:
        return Esp32IngestResponse(ok=False, error=str(e), buffered_n=buf_n, needed_n=win_n)

    schema_names = artifact.schema_names
    schema = FeatureSchema(names=schema_names) if schema_names else DEFAULT_FEATURES
    missing_live_features = _missing_live_feature_names(schema_names)
    if missing_live_features:
        warning = _join_warnings(warning, "live_feature_schema_mismatch")
    if buf.fs_hz and int(buf.fs_hz) != pred_fs:
        warning = _join_warnings(warning, f"ingest_fs_hz={buf.fs_hz}_prediction_uses_{pred_fs}")

    last_pred: Optional[Dict[str, float]] = None
    wrote = 0
    active_names: List[str] = []

    while min(len(buf.ecg), len(buf.ppg)) >= win_n:
        window_ts = int(buf.ts_ms_start)
        ecg_w = np.asarray(buf.ecg[:win_n], dtype=float)
        ppg_w = np.asarray(buf.ppg[:win_n], dtype=float)
        accel_w = (
            np.asarray(buf.accel[:win_n], dtype=float)
            if buf.accel and len(buf.accel) >= win_n
            else np.zeros((win_n, 3), dtype=float)
        )
        gyro_w = (
            np.asarray(buf.gyro[:win_n], dtype=float)
            if buf.gyro and len(buf.gyro) >= win_n
            else np.zeros((win_n, 3), dtype=float)
        )

        feats_vec, used_schema = extract_features_from_signals(
            ecg=ecg_w,
            ppg=ppg_w,
            accel_xyz=accel_w,
            gyro_xyz=gyro_w,
            rates=SamplingRates(fs_ecg=pred_fs, fs_ppg=pred_fs),
            schema=schema,
        )

        x = np.asarray(feats_vec, dtype=float).ravel()
        if schema_names and x.size != len(schema_names):
            return Esp32IngestResponse(
                ok=False,
                error=f"schema mismatch: expected {len(schema_names)} features, got {int(x.size)}",
                buffered_n=min(len(buf.ecg), len(buf.ppg)),
                needed_n=win_n,
            )

        try:
            sbp, dbp = artifact.predict(x)
        except ValueError:
            return Esp32IngestResponse(
                ok=False,
                error="non-finite feature values (NaN/Inf) after imputation",
                buffered_n=min(len(buf.ecg), len(buf.ppg)),
                needed_n=win_n,
            )

        sbp_std, dbp_std = _ensemble_std(artifact, x)
        active_names = schema_names or used_schema.names
        last_pred = {
            "sbp": sbp,
            "dbp": dbp,
            "sbp_std": sbp_std,
            "dbp_std": dbp_std,
            "synthetic": False,
            "ts_ms_start": window_ts,
        }

        telemetry_row: Dict[str, object] = {
            "device_id": req.device_id,
            "ts_ms_start": window_ts,
            "created_at": _iso_utc_from_ms(window_ts + int(round(pred_window_s * 1000.0))),
            "fs_hz": pred_fs,
            "window_s": float(pred_window_s),
            "schema_names": active_names,
            "features": x.tolist(),
            "sbp_pred": sbp,
            "dbp_pred": dbp,
            "sbp_std": sbp_std,
            "dbp_std": dbp_std,
            "synthetic": False,
        }

        if db_user_id:
            db_row: Dict[str, object] = {
                **telemetry_row,
                "user_id": db_user_id,
            }
            if db_session_id:
                db_row["session_id"] = db_session_id
            if req.persist_raw:
                db_row["ecg"] = ecg_w.tolist()
                db_row["ppg"] = ppg_w.tolist()
                db_row["accel"] = accel_w.tolist()
                db_row["gyro"] = gyro_w.tolist()
            try:
                _supabase_insert_telemetry(_clean_floats(db_row))
                wrote += 1
            except Exception as e:
                return Esp32IngestResponse(
                    ok=False,
                    error=f"telemetry_db_insert_failed: {e}",
                    pred=last_pred,
                    buffered_n=min(len(buf.ecg), len(buf.ppg)),
                    needed_n=win_n,
                    raw_wrote=raw_wrote,
                )

        del buf.ecg[:win_n]
        del buf.ppg[:win_n]
        if buf.accel:
            del buf.accel[: min(win_n, len(buf.accel))]
        if buf.gyro:
            del buf.gyro[: min(win_n, len(buf.gyro))]
        buf.ts_ms_start += int(1000.0 * pred_window_s)
        # Start a fresh cycle so the next batches get a distinct cycle_id.
        buf.cycle_id = str(uuid.uuid4())

    buf_n = min(len(buf.ecg), len(buf.ppg))
    return Esp32IngestResponse(
        ok=True,
        pred=last_pred,
        wrote=wrote,
        raw_wrote=raw_wrote,
        warning=warning,
        missing_live_features=missing_live_features or None,
        buffered_n=buf_n,
        needed_n=win_n,
    )


async def _process_buffered_windows(
    ws: WebSocket,
    buf: _DeviceBuffer,
    *,
    device_id: str,
    user_id: Optional[str],
    session_id: Optional[str],
    window_s: float,
    persist_raw: bool,
    fs: int,
) -> Tuple[Optional[Dict[str, float]], int]:
    """
    Consume as many full windows from buf as possible (same logic as /ws/ingest).
    Returns (last_pred, wrote_rows).
    """
    win_n = int(round(float(window_s) * fs))
    try:
        artifact = load_artifact()
    except RuntimeError as e:
        await ws.send_json({"ok": False, "error": str(e)})
        # Drop one window so the client does not retry the same samples forever.
        if min(len(buf.ecg), len(buf.ppg)) >= win_n:
            del buf.ecg[:win_n]
            del buf.ppg[:win_n]
            if buf.accel:
                del buf.accel[: min(win_n, len(buf.accel))]
            if buf.gyro:
                del buf.gyro[: min(win_n, len(buf.gyro))]
        if buf.synthetic:
            del buf.synthetic[: min(win_n, len(buf.synthetic))]
        return None, 0

    schema_names = artifact.schema_names
    schema = FeatureSchema(names=schema_names) if schema_names else DEFAULT_FEATURES

    wrote = 0
    last_pred: Optional[Dict[str, float]] = None
    while min(len(buf.ecg), len(buf.ppg)) >= win_n:
        ecg_w = np.asarray(buf.ecg[:win_n], dtype=float)
        ppg_w = np.asarray(buf.ppg[:win_n], dtype=float)
        accel_w = (
            np.asarray(buf.accel[:win_n], dtype=float)
            if buf.accel and len(buf.accel) >= win_n
            else np.zeros((win_n, 3), dtype=float)
        )
        gyro_w = (
            np.asarray(buf.gyro[:win_n], dtype=float)
            if buf.gyro and len(buf.gyro) >= win_n
            else np.zeros((win_n, 3), dtype=float)
        )
        synthetic_w = bool(any(buf.synthetic[:win_n])) if buf.synthetic else False

        feats_vec, used_schema = extract_features_from_signals(
            ecg=ecg_w,
            ppg=ppg_w,
            accel_xyz=accel_w,
            gyro_xyz=gyro_w,
            rates=SamplingRates(fs_ecg=fs, fs_ppg=fs),
            schema=schema,
        )

        x = np.asarray(feats_vec, dtype=float).ravel()
        missing_live_features = _missing_live_feature_names(schema_names)
        if schema_names and x.size != len(schema_names):
            await ws.send_json(
                {
                    "ok": False,
                    "error": f"schema mismatch: expected {len(schema_names)} features, got {int(x.size)}",
                }
            )
            break
        active_names = schema_names or used_schema.names
        if missing_live_features:
            await ws.send_json(
                {
                    "ok": True,
                    "warning": "live_feature_schema_mismatch",
                    "missing_live_features": missing_live_features,
                    "detail": "Some model features are not computed by the live ESP32 extractor and were imputed.",
                }
            )
        try:
            sbp, dbp = artifact.predict(x)
        except ValueError:
            await ws.send_json({"ok": False, "error": "non-finite feature values (NaN/Inf) after imputation"})
            break
        sbp_std, dbp_std = _ensemble_std(artifact, x)
        last_pred = {
            "sbp": sbp,
            "dbp": dbp,
            "sbp_std": sbp_std,
            "dbp_std": dbp_std,
            "synthetic": synthetic_w,
        }

        telemetry_row = {
            "device_id": device_id,
            "ts_ms_start": int(buf.ts_ms_start),
            "fs_hz": int(fs),
            "window_s": float(window_s),
            "schema_names": active_names,
            "features": x.tolist(),
            "sbp_pred": sbp,
            "dbp_pred": dbp,
            "sbp_std": sbp_std,
            "dbp_std": dbp_std,
            "synthetic": synthetic_w,
        }

        if synthetic_w:
            csv_row = {
                **telemetry_row,
                "ecg": ecg_w.tolist(),
                "ppg": ppg_w.tolist(),
                "accel": accel_w.tolist(),
                "gyro": gyro_w.tolist(),
            }
            try:
                await _append_synthetic_telemetry_csv_async(csv_row)
            except Exception as e:
                await ws.send_json({"ok": False, "error": f"synthetic_csv_write_failed: {e}"})

        if supabase_rest_config() and user_id:
            db_row = {
                **telemetry_row,
                "user_id": user_id,
                "session_id": session_id,
            }
            if persist_raw:
                db_row["ecg"] = ecg_w.tolist()
                db_row["ppg"] = ppg_w.tolist()
                db_row["accel"] = accel_w.tolist()
                db_row["gyro"] = gyro_w.tolist()
            try:
                await _supabase_insert_telemetry_async(_clean_floats(db_row))
                wrote += 1
            except Exception as e:
                await ws.send_json({"ok": False, "error": f"db_insert_failed: {e}"})

        await _dash_broadcast(
            {
                "type": "telemetry_window",
                "device_id": device_id,
                "ts_ms_start": int(buf.ts_ms_start),
                "sbp_pred": sbp,
                "dbp_pred": dbp,
                "sbp_std": sbp_std,
                "dbp_std": dbp_std,
                "warning": "live_feature_schema_mismatch" if missing_live_features else None,
                "synthetic": synthetic_w,
            }
        )

        del buf.ecg[:win_n]
        del buf.ppg[:win_n]
        if buf.accel:
            del buf.accel[: min(win_n, len(buf.accel))]
        if buf.gyro:
            del buf.gyro[: min(win_n, len(buf.gyro))]
        if buf.synthetic:
            del buf.synthetic[: min(win_n, len(buf.synthetic))]
        buf.ts_ms_start += int(1000.0 * float(window_s))

    return last_pred, wrote


@app.get("/health", dependencies=[Depends(_require_api_key)])
def health():
    try:
        artifact = load_artifact()
        names = artifact.schema_names
        sb = supabase_rest_config()
        missing_live_features = _missing_live_feature_names(names)
        return {
            "ok": True,
            "model_loaded": True,
            "n_features": len(names),
            "feature_count": len(names),
            "supabase": bool(sb),
            "supabase_configured": bool(sb),
            "live_schema_compatible": len(missing_live_features) == 0,
            "missing_live_features": missing_live_features,
            "websockets_enabled": _websockets_enabled(),
            "demo_security": "Set BP_API_KEY to require an API key for REST and WebSocket demo endpoints.",
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/predict", response_model=PredictResponse, dependencies=[Depends(_require_api_key)])
def predict(req: PredictRequest):
    artifact = load_artifact()
    names = artifact.schema_names
    x = np.asarray(req.features, dtype=float).ravel()
    if x.size == 0 or x.size > MAX_FEATURES_PER_ROW:
        raise HTTPException(status_code=400, detail=f"features must contain 1..{MAX_FEATURES_PER_ROW} values")
    if names and x.size != len(names):
        raise HTTPException(status_code=400, detail=f"Expected {len(names)} features, got {x.size}")

    try:
        sbp, dbp = artifact.predict(x)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    sbp_std, dbp_std = _ensemble_std(artifact, x)
    return PredictResponse(sbp=sbp, dbp=dbp, sbp_std=sbp_std, dbp_std=dbp_std, schema_names=names or None)


class PredictBatchRequest(BaseModel):
    features: List[List[float]] = Field(
        ..., min_length=1, max_length=MAX_BATCH_ROWS, description="List of feature vectors aligned with deployed schema"
    )


class PredictBatchResponse(BaseModel):
    sbp: List[float]
    dbp: List[float]
    schema_names: Optional[List[str]] = None


@app.post("/predict_batch", response_model=PredictBatchResponse, dependencies=[Depends(_require_api_key)])
def predict_batch(req: PredictBatchRequest):
    artifact = load_artifact()
    names = artifact.schema_names
    if len(req.features) > MAX_BATCH_ROWS:
        raise HTTPException(status_code=400, detail=f"At most {MAX_BATCH_ROWS} rows are allowed per batch")
    X = np.asarray(req.features, dtype=float)
    if X.ndim != 2:
        raise HTTPException(status_code=400, detail="features must be a 2D array")
    if X.shape[0] == 0 or X.shape[1] == 0 or X.shape[1] > MAX_FEATURES_PER_ROW:
        raise HTTPException(status_code=400, detail=f"Each row must contain 1..{MAX_FEATURES_PER_ROW} features")
    if names and X.shape[1] != len(names):
        raise HTTPException(status_code=400, detail=f"Expected {len(names)} features, got {X.shape[1]}")
    try:
        pred = artifact.predict_batch(X)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    sbp = [float(v) for v in pred[:, 0].tolist()]
    dbp = [float(v) for v in pred[:, 1].tolist()]
    return PredictBatchResponse(sbp=sbp, dbp=dbp, schema_names=names or None)


@app.post("/esp32/ingest", response_model=Esp32IngestResponse, dependencies=[Depends(_require_api_key)])
async def esp32_ingest(req: Esp32IngestRequest):
    """
    HTTP ingest for ESP32 (sensor data only). Server saves each batch to
    esp32_raw_batches, buffers until ESP32_PREDICTION_SAMPLES, then writes
    predictions to telemetry_windows. Set BP_DEFAULT_USER_ID on the server.
    """
    async with _get_buffer_lock(req.device_id):
        buf = _get_buffer(req.device_id)
        result = await asyncio.to_thread(_ingest_esp32_buffered_sync, req, buf)

    if result.ok and result.pred:
        await _dash_broadcast(
            {
                "type": "telemetry_window",
                "device_id": req.device_id,
                "ts_ms_start": int(result.pred.get("ts_ms_start") or req.ts_ms_start),
                "sbp_pred": result.pred.get("sbp"),
                "dbp_pred": result.pred.get("dbp"),
                "sbp_std": result.pred.get("sbp_std"),
                "dbp_std": result.pred.get("dbp_std"),
                "warning": result.warning,
                "synthetic": False,
            }
        )
    return result


@app.websocket("/ws/ingest")
async def ws_ingest(ws: WebSocket):
    if not await _ws_api_key_allowed(ws):
        return
    if not _websockets_enabled():
        await ws.accept()
        await ws.send_json({"ok": False, "error": "websockets_disabled_set_BP_WEBSOCKET_ENABLED_true"})
        await ws.close()
        return
    await ws.accept()
    current_device_id: Optional[str] = None
    try:
        while True:
            try:
                payload = await ws.receive_json()
                frame = IngestFrame.model_validate(payload)
            except Exception as e:
                await ws.send_json({"ok": False, "error": f"invalid_ingest_frame: {e}"})
                continue
            if not _is_uuid(frame.user_id):
                await ws.send_json({"ok": False, "error": "user_id must be a UUID when provided"})
                continue

            if current_device_id != frame.device_id:
                if current_device_id:
                    _release_buffer(current_device_id)
                current_device_id = frame.device_id
                _retain_buffer(frame.device_id)
            async with _get_buffer_lock(frame.device_id):
                buf = _get_buffer(frame.device_id, ts_ms_start=int(frame.ts_ms_start))
                if buf.fs_hz == 0:
                    buf.fs_hz = int(frame.fs_hz)

                buf.ecg.extend([float(x) for x in frame.ecg])
                buf.ppg.extend([float(x) for x in frame.ppg])
                if frame.accel:
                    buf.accel.extend([[float(a), float(b), float(c)] for a, b, c in frame.accel])
                if frame.gyro:
                    buf.gyro.extend([[float(a), float(b), float(c)] for a, b, c in frame.gyro])
                buf.synthetic.extend([False] * min(len(frame.ecg), len(frame.ppg)))
                _trim_buffer(buf)

                fs = int(frame.fs_hz)
                win_n = int(round(float(frame.window_s) * fs))
                n = min(len(buf.ecg), len(buf.ppg))
                if win_n <= 0 or n < win_n:
                    await ws.send_json({"ok": True, "buffered_n": n, "needed_n": win_n})
                    continue

                last_pred, wrote = await _process_buffered_windows(
                    ws,
                    buf,
                    device_id=frame.device_id,
                    user_id=frame.user_id,
                    session_id=frame.session_id,
                    window_s=float(frame.window_s),
                    persist_raw=bool(frame.persist_raw),
                    fs=fs,
                )
                n = min(len(buf.ecg), len(buf.ppg))
                if last_pred is not None:
                    await ws.send_json({"ok": True, "pred": last_pred, "wrote": wrote})
                else:
                    await ws.send_json({"ok": True, "buffered_n": n, "needed_n": win_n, "wrote": wrote})
    except WebSocketDisconnect:
        if current_device_id:
            _release_buffer(current_device_id)
        return
    except Exception as e:
        if current_device_id:
            _release_buffer(current_device_id)
        try:
            await ws.send_json({"ok": False, "error": f"ingest_handler_failed: {e}"})
        except Exception:
            pass
        return


@app.websocket("/ws/esp32")
async def ws_esp32(ws: WebSocket):
    if not await _ws_api_key_allowed(ws):
        return
    if not _websockets_enabled():
        await ws.accept()
        await ws.send_json({"ok": False, "error": "websockets_disabled_set_BP_WEBSOCKET_ENABLED_true"})
        await ws.close()
        return
    await ws.accept()
    await ws.send_json({"ok": False, "error": "websocket_esp32_disabled_use_post_esp32_ingest"})
    await ws.close()


@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket):
    if not await _ws_api_key_allowed(ws):
        return
    if not _websockets_enabled():
        await ws.accept()
        await ws.send_json({"ok": False, "error": "websockets_disabled_set_BP_WEBSOCKET_ENABLED_true"})
        await ws.close()
        return
    await ws.accept()
    _dash_clients.add(ws)
    try:
        while True:
            # keep connection alive; optionally accept pings/commands later
            await ws.receive_text()
    except Exception:
        _dash_clients.discard(ws)

