from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import websockets
import wfdb


def _chunks(x: np.ndarray, n: int):
    for i in range(0, len(x), n):
        yield x[i : i + n]


async def main_async(args) -> None:
    root = Path(args.dataset_root)
    rec = args.record
    record = wfdb.rdrecord(str(root / rec))

    names = [str(n) for n in record.sig_name]
    name_to_idx = {n: i for i, n in enumerate(names)}
    sig = record.p_signal
    fs = int(record.fs)

    def col(name: str) -> np.ndarray:
        i = name_to_idx[name]
        return sig[:, i].astype(float)

    ecg = col("ecg")
    ppg = col(args.ppg_channel)
    if all(k in name_to_idx for k in ["a_x", "a_y", "a_z"]):
        accel = np.stack([col("a_x"), col("a_y"), col("a_z")], axis=1)
    else:
        accel = np.zeros((len(ecg), 3), dtype=float)
    if all(k in name_to_idx for k in ["g_x", "g_y", "g_z"]):
        gyro = np.stack([col("g_x"), col("g_y"), col("g_z")], axis=1)
    else:
        gyro = np.zeros((len(ecg), 3), dtype=float)

    hop_n = int(round(args.hop_s * fs))
    if hop_n <= 0:
        hop_n = fs

    ts_ms = int(time.time() * 1000)
    async with websockets.connect(args.ws_url) as ws:
        for ecg_c, ppg_c, acc_c, gyr_c in zip(
            _chunks(ecg, hop_n), _chunks(ppg, hop_n), _chunks(accel, hop_n), _chunks(gyro, hop_n)
        ):
            frame = {
                "device_id": args.device_id,
                "ts_ms_start": ts_ms,
                "fs_hz": fs,
                "window_s": float(args.window_s),
                "ecg": [float(v) for v in ecg_c.tolist()],
                "ppg": [float(v) for v in ppg_c.tolist()],
                "accel": [[float(a), float(b), float(c)] for a, b, c in acc_c.tolist()],
                "gyro": [[float(a), float(b), float(c)] for a, b, c in gyr_c.tolist()],
                "user_id": args.user_id,
                "session_id": args.session_id,
                "persist_raw": bool(args.persist_raw),
            }
            await ws.send(json.dumps(frame))
            resp = await ws.recv()
            print(resp)
            ts_ms += int(1000.0 * args.hop_s)
            if args.realtime:
                time.sleep(args.hop_s)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset-root", required=True)
    ap.add_argument("--record", default="s1_walk")
    ap.add_argument("--ppg-channel", default="pleth_2")
    ap.add_argument("--ws-url", default="ws://127.0.0.1:8000/ws/ingest")
    ap.add_argument("--device-id", default="sim-physionet")
    ap.add_argument("--user-id", default=None)
    ap.add_argument("--session-id", default=None)
    ap.add_argument("--window-s", type=float, default=8.0)
    ap.add_argument("--hop-s", type=float, default=1.0, help="How often to send frames (seconds)")
    ap.add_argument("--realtime", action="store_true", help="Sleep between frames to mimic real time")
    ap.add_argument("--persist-raw", action="store_true")
    args = ap.parse_args()

    import asyncio

    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()

