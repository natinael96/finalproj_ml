from __future__ import annotations

import os
import time
from pathlib import Path
from functools import lru_cache
from typing import Dict, List, Optional, Tuple

import joblib
import numpy as np
import requests
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field

from bp_pipeline.features import FeatureSchema, extract_features_from_signals
from bp_pipeline.preprocess import SamplingRates

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


class PredictRequest(BaseModel):
    features: List[float] = Field(..., description="Feature vector aligned with the deployed schema")


class PredictResponse(BaseModel):
    sbp: float
    dbp: float
    sbp_std: Optional[float] = None
    dbp_std: Optional[float] = None
    schema_names: Optional[List[str]] = None


@lru_cache(maxsize=1)
def load_artifact():
    path = os.environ.get("BP_MODEL_PATH", os.path.join("artifacts", "model.joblib"))
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


app = FastAPI(title="BP Predictor API", version="0.1.0")

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


class IngestFrame(BaseModel):
    device_id: str
    ts_ms_start: int
    fs_hz: int = 100
    ecg: List[float]
    ppg: List[float]
    accel: Optional[List[List[float]]] = None  # rows of [ax, ay, az]
    gyro: Optional[List[List[float]]] = None  # rows of [gx, gy, gz]
    session_id: Optional[str] = None
    user_id: Optional[str] = None  # server-side auth later; for now allow explicit user_id
    window_s: float = 8.0
    persist_raw: bool = False


class _DeviceBuffer:
    def __init__(self) -> None:
        self.ecg: List[float] = []
        self.ppg: List[float] = []
        self.accel: List[List[float]] = []
        self.gyro: List[List[float]] = []
        self.fs_hz: int = 0
        self.ts_ms_start: int = 0


_buffers: Dict[str, _DeviceBuffer] = {}


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
    model, schema_names, med_map = load_artifact()
    schema = FeatureSchema(names=schema_names) if schema_names else FeatureSchema(names=[])

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

        feats_vec, used_schema = extract_features_from_signals(
            ecg=ecg_w,
            ppg=ppg_w,
            accel_xyz=accel_w,
            gyro_xyz=gyro_w,
            rates=SamplingRates(fs_ecg=fs, fs_ppg=fs),
            schema=schema if schema.names else used_schema,
        )

        x = np.asarray(feats_vec, dtype=float).ravel()
        if schema_names and x.size != len(schema_names):
            await ws.send_json(
                {
                    "ok": False,
                    "error": f"schema mismatch: expected {len(schema_names)} features, got {int(x.size)}",
                }
            )
            break
        if schema_names:
            x = _impute_non_finite(x, names=schema_names, med_map=med_map)
        if not np.all(np.isfinite(x)):
            await ws.send_json({"ok": False, "error": "non-finite feature values (NaN/Inf) after imputation"})
            break

        pred = model.predict([x])
        sbp = float(pred[0][0])
        dbp = float(pred[0][1])
        last_pred = {"sbp": sbp, "dbp": dbp}

        if supabase_rest_config() and user_id:
            row = {
                "user_id": user_id,
                "session_id": session_id,
                "device_id": device_id,
                "ts_ms_start": int(buf.ts_ms_start),
                "fs_hz": int(fs),
                "window_s": float(window_s),
                "schema_names": schema_names or used_schema.names,
                "features": x.tolist(),
                "sbp_pred": sbp,
                "dbp_pred": dbp,
            }
            if persist_raw:
                row["ecg"] = ecg_w.tolist()
                row["ppg"] = ppg_w.tolist()
                row["accel"] = accel_w.tolist()
                row["gyro"] = gyro_w.tolist()
            try:
                _supabase_insert_telemetry(row)
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
            }
        )

        del buf.ecg[:win_n]
        del buf.ppg[:win_n]
        if buf.accel:
            del buf.accel[: min(win_n, len(buf.accel))]
        if buf.gyro:
            del buf.gyro[: min(win_n, len(buf.gyro))]
        buf.ts_ms_start += int(1000.0 * float(window_s))

    return last_pred, wrote


@app.get("/health")
def health():
    try:
        _, names, _ = load_artifact()
        sb = supabase_rest_config()
        return {"ok": True, "n_features": len(names), "supabase": bool(sb)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    model, names, med_map = load_artifact()
    x = np.asarray(req.features, dtype=float).ravel()
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
    features: List[List[float]] = Field(..., description="List of feature vectors aligned with deployed schema")


class PredictBatchResponse(BaseModel):
    sbp: List[float]
    dbp: List[float]
    schema_names: Optional[List[str]] = None


@app.post("/predict_batch", response_model=PredictBatchResponse)
def predict_batch(req: PredictBatchRequest):
    model, names, med_map = load_artifact()
    X = np.asarray(req.features, dtype=float)
    if X.ndim != 2:
        raise HTTPException(status_code=400, detail="features must be a 2D array")
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
    await ws.accept()
    try:
        while True:
            payload = await ws.receive_json()
            frame = IngestFrame.model_validate(payload)

            buf = _buffers.get(frame.device_id)
            if buf is None:
                buf = _DeviceBuffer()
                _buffers[frame.device_id] = buf
                buf.ts_ms_start = int(frame.ts_ms_start)
            if buf.fs_hz == 0:
                buf.fs_hz = int(frame.fs_hz)

            buf.ecg.extend([float(x) for x in frame.ecg])
            buf.ppg.extend([float(x) for x in frame.ppg])
            if frame.accel:
                buf.accel.extend([[float(a), float(b), float(c)] for a, b, c in frame.accel])
            if frame.gyro:
                buf.gyro.extend([[float(a), float(b), float(c)] for a, b, c in frame.gyro])

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
    device_id = ws.query_params.get("device_id") or "esp32"
    fs_hz = int(ws.query_params.get("fs_hz") or 250)
    window_s = float(ws.query_params.get("window_s") or 8.0)
    user_id = ws.query_params.get("user_id") or None
    session_id = ws.query_params.get("session_id") or None
    persist_raw = ws.query_params.get("persist_raw", "0") in ("1", "true", "yes")
    verbose = ws.query_params.get("verbose", "0") in ("1", "true", "yes")

    await ws.accept()
    last_ecg = 0.0
    last_ppg = 0.0
    samples_since_ack = 0

    try:
        while True:
            payload = await ws.receive_json()
            sample = Esp32Sample.model_validate(payload)

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

            buf = _buffers.get(device_id)
            if buf is None:
                buf = _DeviceBuffer()
                _buffers[device_id] = buf
                buf.ts_ms_start = int(time.time() * 1000)
            if buf.fs_hz == 0:
                buf.fs_hz = fs_hz

            buf.ecg.append(ecg_v)
            buf.ppg.append(ppg_v)
            buf.accel.append([ax, ay, az])
            buf.gyro.append([gx, gy, gz])

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
        return


@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket):
    await ws.accept()
    _dash_clients.add(ws)
    try:
        while True:
            # keep connection alive; optionally accept pings/commands later
            await ws.receive_text()
    except Exception:
        _dash_clients.discard(ws)

