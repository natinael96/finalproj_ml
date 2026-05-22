from __future__ import annotations

import asyncio
import csv
import json
import os
import socket
import time
from uuid import UUID
from pathlib import Path
from functools import lru_cache
from threading import Lock
from typing import Dict, List, Optional, Tuple

import joblib
import numpy as np
import requests
from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from bp_pipeline.features import DEFAULT_FEATURES, FeatureSchema, extract_features_from_signals
from bp_pipeline.preprocess import SamplingRates

MAX_BATCH_ROWS = 256
MAX_FEATURES_PER_ROW = 512
MAX_FRAME_SAMPLES = 5000
MAX_BUFFER_SAMPLES = 20000
MIN_FS_HZ = 20
MAX_FS_HZ = 1000
MIN_WINDOW_S = 1.0
MAX_WINDOW_S = 30.0
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
def load_artifact():
    path = _model_artifact_path()
    if not path.is_file():
        raise RuntimeError(
            f"Model artifact not found at {path}. "
            "Train with: python -m bp_pipeline.train --physionet-ptt-dir <data> --out artifacts "
            "Or create a smoke-test model: python scripts/build_demo_model.py"
        )
    try:
        bundle = joblib.load(path)
    except Exception as e:
        raise RuntimeError(f"Failed to load model artifact at {path}: {e}") from e

    model = bundle["model"]
    schema = bundle.get("schema", {})
    names = list(schema.get("names", []))
    # Build per-feature median map for NaN/Inf imputation at inference time
    med_map: Dict[str, float] = {}
    try:
        full_schema = bundle.get("full_schema", {})
        full_names = list(full_schema.get("names", []))
        med_full = bundle.get("medians_full_schema", None)
        if isinstance(med_full, (list, tuple)) and len(full_names) == len(med_full):
            for n, m in zip(full_names, med_full):
                try:
                    med_map[str(n)] = float(m)
                except Exception:
                    continue
    except Exception:
        pass
    return model, names, med_map


def _impute_non_finite(x: np.ndarray, names: List[str], med_map: Dict[str, float]) -> np.ndarray:
    """
    Replace NaN/Inf using medians saved during training.
    Falls back to 0.0 if no median is available.
    """
    x = np.asarray(x, dtype=float).ravel()
    if x.size != len(names):
        return x
    out = x.copy()
    bad = ~np.isfinite(out)
    if not bad.any():
        return out
    for i in np.flatnonzero(bad):
        out[i] = float(med_map.get(names[i], 0.0))
    return out


def _missing_live_feature_names(names: List[str]) -> List[str]:
    live_names = set(DEFAULT_FEATURES.names)
    return [name for name in names if name not in live_names]


def _configured_api_key() -> str:
    return os.environ.get("BP_API_KEY", "").strip()


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
    print(f"  ESP32 WebSocket:  ws://{lan_ip}:{port}/ws/esp32?device_id=esp32-01&fs_hz=250&window_s=8", flush=True)
    print(f"  Dashboard WS:     ws://127.0.0.1:{port}/ws/dashboard", flush=True)
    print(f"  Synthetic CSV:    {_synthetic_csv_path()}", flush=True)
    print("", flush=True)


_dash_clients: set[WebSocket] = set()

async def _dash_broadcast(msg: Dict[str, object]) -> None:
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


def _supabase_insert_telemetry(row: Dict[str, object]) -> None:
    cfg = supabase_rest_config()
    if not cfg:
        return
    endpoint = f"{cfg['url']}/rest/v1/telemetry_windows"
    headers = {
        "apikey": cfg["key"],
        "Authorization": f"Bearer {cfg['key']}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    r = requests.post(endpoint, headers=headers, json=row, timeout=20)
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase insert failed {r.status_code}: {r.text}")


async def _supabase_insert_telemetry_async(row: Dict[str, object]) -> None:
    # Keep slow PostgREST calls out of the WebSocket event loop.
    await asyncio.to_thread(_supabase_insert_telemetry, row)


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
        model, schema_names, med_map = load_artifact()
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
        if active_names:
            x = _impute_non_finite(x, names=active_names, med_map=med_map)
        if not np.all(np.isfinite(x)):
            await ws.send_json({"ok": False, "error": "non-finite feature values (NaN/Inf) after imputation"})
            break
        if missing_live_features:
            await ws.send_json(
                {
                    "ok": True,
                    "warning": "live_feature_schema_mismatch",
                    "missing_live_features": missing_live_features,
                    "detail": "Some model features are not computed by the live ESP32 extractor and were imputed.",
                }
            )

        pred = model.predict([x])
        sbp = float(pred[0][0])
        dbp = float(pred[0][1])
        last_pred = {"sbp": sbp, "dbp": dbp, "synthetic": synthetic_w}

        telemetry_row = {
            "device_id": device_id,
            "ts_ms_start": int(buf.ts_ms_start),
            "fs_hz": int(fs),
            "window_s": float(window_s),
            "schema_names": active_names,
            "features": x.tolist(),
            "sbp_pred": sbp,
            "dbp_pred": dbp,
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
        elif supabase_rest_config() and user_id:
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
                await _supabase_insert_telemetry_async(db_row)
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
        _, names, _ = load_artifact()
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
            "demo_security": "Set BP_API_KEY to require an API key for REST and WebSocket demo endpoints.",
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/predict", response_model=PredictResponse, dependencies=[Depends(_require_api_key)])
def predict(req: PredictRequest):
    model, names, med_map = load_artifact()
    x = np.asarray(req.features, dtype=float).ravel()
    if x.size == 0 or x.size > MAX_FEATURES_PER_ROW:
        raise HTTPException(status_code=400, detail=f"features must contain 1..{MAX_FEATURES_PER_ROW} values")
    if names and x.size != len(names):
        raise HTTPException(status_code=400, detail=f"Expected {len(names)} features, got {x.size}")

    if names:
        x = _impute_non_finite(x, names=names, med_map=med_map)
    if not np.all(np.isfinite(x)):
        raise HTTPException(status_code=400, detail="Features must be finite numbers (no NaN/Inf) after imputation")

    # Mean prediction
    pred = model.predict([x])
    sbp = float(pred[0][0])
    dbp = float(pred[0][1])

    # Simple uncertainty proxy for tree ensembles: std across estimators (if available)
    sbp_std = None
    dbp_std = None
    try:
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
    model, names, med_map = load_artifact()
    if len(req.features) > MAX_BATCH_ROWS:
        raise HTTPException(status_code=400, detail=f"At most {MAX_BATCH_ROWS} rows are allowed per batch")
    X = np.asarray(req.features, dtype=float)
    if X.ndim != 2:
        raise HTTPException(status_code=400, detail="features must be a 2D array")
    if X.shape[0] == 0 or X.shape[1] == 0 or X.shape[1] > MAX_FEATURES_PER_ROW:
        raise HTTPException(status_code=400, detail=f"Each row must contain 1..{MAX_FEATURES_PER_ROW} features")
    if names and X.shape[1] != len(names):
        raise HTTPException(status_code=400, detail=f"Expected {len(names)} features, got {X.shape[1]}")
    if names:
        X2 = []
        for row in X:
            X2.append(_impute_non_finite(np.asarray(row), names=names, med_map=med_map))
        X = np.vstack(X2) if X2 else X
    if not np.all(np.isfinite(X)):
        raise HTTPException(status_code=400, detail="Features must be finite numbers (no NaN/Inf) after imputation")
    pred = model.predict(X)
    sbp = [float(v) for v in pred[:, 0].tolist()]
    dbp = [float(v) for v in pred[:, 1].tolist()]
    return PredictBatchResponse(sbp=sbp, dbp=dbp, schema_names=names or None)


@app.websocket("/ws/ingest")
async def ws_ingest(ws: WebSocket):
    if not await _ws_api_key_allowed(ws):
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
    """
    Streaming ingest for ESP32 WebSocketsClient: one JSON object per sample, e.g.
    {"t": micros, "ecg": int, "ir": long, "red": long, "ax".. "gz": int16}.

    Query params:
      device_id (default esp32)
      fs_hz (default 250) — must match firmware sample rate
      window_s (default 8.0)
      user_id, session_id — optional; user_id enables Supabase telemetry insert
      persist_raw (0/1) — optional
      verbose (0/1) — if 1, send buffered_n periodically while filling a window

    Firmware should connect to ws://<PC_IP>:8000/ws/esp32?device_id=myboard
    (FastAPI / uvicorn port, not a separate Node server on 3000.)
    """
    if not await _ws_api_key_allowed(ws):
        return
    device_id = ws.query_params.get("device_id") or "esp32"
    if len(device_id) > 80:
        device_id = device_id[:80]
    try:
        fs_hz = _parse_int_query(ws, "fs_hz", 250, MIN_FS_HZ, MAX_FS_HZ)
        window_s = _parse_float_query(ws, "window_s", 8.0, MIN_WINDOW_S, MAX_WINDOW_S)
    except ValueError as e:
        await ws.accept()
        await ws.send_json({"ok": False, "error": str(e)})
        await ws.close()
        return
    user_id = ws.query_params.get("user_id") or None
    if not _is_uuid(user_id):
        await ws.accept()
        await ws.send_json({"ok": False, "error": "user_id must be a UUID when provided"})
        await ws.close()
        return
    session_id = ws.query_params.get("session_id") or None
    persist_raw = ws.query_params.get("persist_raw", "0") in ("1", "true", "yes")
    verbose = ws.query_params.get("verbose", "0") in ("1", "true", "yes")

    await ws.accept()
    _retain_buffer(device_id)
    last_ecg = 0.0
    last_ppg = 0.0
    samples_since_ack = 0

    try:
        while True:
            try:
                payload = await ws.receive_json()
                sample = Esp32Sample.model_validate(payload)
            except Exception as e:
                await ws.send_json({"ok": False, "error": f"invalid_esp32_sample: {e}"})
                continue

            ecg_v = float(sample.ecg)
            if ecg_v < 0:
                ecg_v = last_ecg
            else:
                last_ecg = ecg_v

            if sample.ir is not None:
                last_ppg = float(sample.ir)
            elif sample.red is not None:
                last_ppg = float(sample.red)
            ppg_v = last_ppg

            ax = float(sample.ax or 0.0)
            ay = float(sample.ay or 0.0)
            az = float(sample.az or 0.0)
            gx = float(sample.gx or 0.0)
            gy = float(sample.gy or 0.0)
            gz = float(sample.gz or 0.0)

            async with _get_buffer_lock(device_id):
                buf = _get_buffer(device_id)
                if buf.fs_hz == 0:
                    buf.fs_hz = fs_hz

                buf.ecg.append(ecg_v)
                buf.ppg.append(ppg_v)
                buf.accel.append([ax, ay, az])
                buf.gyro.append([gx, gy, gz])
                buf.synthetic.append(bool(sample.synthetic))
                _trim_buffer(buf)

                fs = int(buf.fs_hz) if buf.fs_hz else fs_hz
                win_n = int(round(window_s * fs))
                n = min(len(buf.ecg), len(buf.ppg))

                if win_n <= 0:
                    await ws.send_json({"ok": False, "error": "invalid window_s or fs_hz"})
                    continue

                if n < win_n:
                    samples_since_ack += 1
                    if verbose and samples_since_ack >= 50:
                        samples_since_ack = 0
                        await ws.send_json({"ok": True, "buffered_n": n, "needed_n": win_n})
                    continue

                samples_since_ack = 0
                last_pred, wrote = await _process_buffered_windows(
                    ws,
                    buf,
                    device_id=device_id,
                    user_id=user_id,
                    session_id=session_id,
                    window_s=window_s,
                    persist_raw=persist_raw,
                    fs=fs,
                )
                n = min(len(buf.ecg), len(buf.ppg))
                if last_pred is not None:
                    await ws.send_json({"ok": True, "pred": last_pred, "wrote": wrote})
                else:
                    await ws.send_json({"ok": True, "buffered_n": n, "needed_n": win_n, "wrote": wrote})
    except WebSocketDisconnect:
        _release_buffer(device_id)
        return
    except Exception as e:
        _release_buffer(device_id)
        try:
            await ws.send_json({"ok": False, "error": f"esp32_handler_failed: {e}"})
        except Exception:
            pass
        return


@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket):
    if not await _ws_api_key_allowed(ws):
        return
    await ws.accept()
    _dash_clients.add(ws)
    try:
        while True:
            # keep connection alive; optionally accept pings/commands later
            await ws.receive_text()
    except Exception:
        _dash_clients.discard(ws)

