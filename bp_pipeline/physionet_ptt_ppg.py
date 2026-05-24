from __future__ import annotations

from dataclasses import dataclass
from math import gcd
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

import numpy as np
import pandas as pd
from scipy.signal import resample_poly
import wfdb

from .features import DEFAULT_FEATURES, extract_features_from_signals
from .preprocess import SamplingRates, bandpass, nan_interp_1d, ppg_physionet_filter, robust_zscore


@dataclass(frozen=True)
class PhysioNetPttConfig:
    """
    Configuration for the PhysioNet pulse-transit-time-ppg dataset.
    """

    window_s: float = 8.0
    max_windows_per_record: int = 40
    live_target_fs: int = 250
    live_ppg_effective_fs: int = 50
    simulate_esp32_ppg_hold: bool = False


def _find_subjects_info_anywhere(root: Path) -> Path:
    # usually under CSV/, but allow other layouts
    direct = root / "subjects_info.csv"
    if direct.exists():
        return direct
    csv = root / "CSV" / "subjects_info.csv"
    if csv.exists():
        return csv
    matches = list(root.rglob("subjects_info.csv"))
    if matches:
        return matches[0]
    raise FileNotFoundError(f"subjects_info.csv not found under {root}")


def _load_subjects_info(root: Path) -> pd.DataFrame:
    info_path = _find_subjects_info_anywhere(root)
    df = pd.read_csv(info_path)
    # Normalize filename col (PhysioNet 1.1.0 CSV uses "record" in some layouts)
    if "filename" not in df.columns and "record" in df.columns:
        df = df.rename(columns={"record": "filename"})
    if "filename" not in df.columns:
        raise ValueError("subjects_info.csv must contain a 'filename' or 'record' column")
    return df


def _parse_hea_metadata_line(line: str) -> Dict[str, str]:
    """
    Parse a PhysioNet PTT/PPG .hea metadata comment line of the form:
      # <filename>: s1_walk <activity>: walk ... <bp_sys_start>: 94 ...
    Returns dict like {"filename": "s1_walk", "bp_sys_start": "94", ...}
    """
    s = line.strip()
    if s.startswith("#"):
        s = s[1:].strip()
    # tokens look like: <key>: value
    out: Dict[str, str] = {}
    parts = [p.strip() for p in s.split("<") if p.strip()]
    for p in parts:
        # p like 'filename>: s1_walk ' (possibly with trailing other text)
        if ">: " not in p:
            continue
        k, rest = p.split(">: ", 1)
        k = k.strip().strip("<>").strip()
        v = rest.split(" <")[0].strip()  # stop before next token if any
        if k:
            out[k] = v
    return out


def _subjects_info_from_headers(root: Path) -> pd.DataFrame:
    """
    Fallback when subjects_info.csv isn't present yet.
    Build a subjects-info-like DataFrame by parsing the last comment line in each .hea file.
    """
    rows: List[Dict[str, object]] = []
    for rec in _iter_wfdb_records(root):
        hea_path = root / f"{rec}.hea"
        if not hea_path.exists():
            continue
        try:
            lines = hea_path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except Exception:
            continue
        meta = {}
        for ln in reversed(lines):
            if ln.strip().startswith("#") and "<bp_sys_start>" in ln and "<bp_dia_start>" in ln:
                meta = _parse_hea_metadata_line(ln)
                break
        if not meta:
            continue
        meta["filename"] = meta.get("filename", rec)
        rows.append(meta)
    if not rows:
        raise FileNotFoundError(f"subjects_info.csv not found under {root} and could not parse any .hea metadata.")
    return pd.DataFrame(rows)


def _bp_label_from_info_row(row: pd.Series) -> Tuple[float, float]:
    """
    Dataset gives start/end BP. For an MVP single label per record:
      SBP = mean(sys_start, sys_end)
      DBP = mean(dia_start, dia_end)
    """
    sys_start = float(row["bp_sys_start"])
    sys_end = float(row["bp_sys_end"])
    dia_start = float(row["bp_dia_start"])
    dia_end = float(row["bp_dia_end"])
    sbp = 0.5 * (sys_start + sys_end)
    dbp = 0.5 * (dia_start + dia_end)
    return sbp, dbp


def _find_csv_dir(root: Path) -> Optional[Path]:
    """Return `<root>/CSV` or `<root>/csv`, whichever exists."""
    for name in ("CSV", "csv"):
        p = root / name
        if p.is_dir():
            return p
    return None


def _csv_path_for_record(csv_dir: Path, rec_name: str) -> Optional[Path]:
    fp = csv_dir / f"{rec_name}.csv"
    return fp if fp.is_file() else None


def _wfdb_record_ready(root: Path, rec_name: str) -> bool:
    return (
        (root / f"{rec_name}.hea").is_file()
        and (root / f"{rec_name}.dat").is_file()
        and (root / f"{rec_name}.atr").is_file()
    )


def _append_feature_windows(
    *,
    win_iter: Iterator[Dict[str, float]],
    rec_name: str,
    sbp: float,
    dbp: float,
    live_compatible: bool,
    feature_names: Optional[List[str]],
    X_rows: List[List[float]],
    y_rows: List[List[float]],
    rec_names: List[str],
) -> Tuple[Optional[List[str]], int]:
    n_win = 0
    for wi, feats in enumerate(win_iter):
        if feature_names is None:
            feature_names = list(DEFAULT_FEATURES.names if live_compatible else feats.keys())
        x = [float(feats[k]) for k in feature_names]
        X_rows.append(x)
        y_rows.append([sbp, dbp])
        rec_names.append(f"{rec_name}#w{wi}")
        n_win += 1
    return feature_names, n_win


def _load_wfdb_record_windows(
    root: Path,
    rec_name: str,
    *,
    cfg: PhysioNetPttConfig,
    live_compatible: bool,
    verbose: bool,
) -> Optional[Tuple["wfdb.Record", Iterator[Dict[str, float]]]]:
    try:
        record = wfdb.rdrecord(str(root / rec_name))
        ann = wfdb.rdann(str(root / rec_name), "atr")
    except Exception as e:
        if verbose:
            print(f"[physionet-ptt] skip(read error): {rec_name} ({e})")
        return None
    try:
        win_iter = (
            extract_live_compatible_windowed_features_from_wfdb(record, ann, cfg=cfg)
            if live_compatible
            else extract_windowed_features_from_wfdb(record, ann, cfg=cfg)
        )
    except Exception as e:
        if verbose:
            print(f"[physionet-ptt] skip(feature error): {rec_name} ({e})")
        return None
    return record, win_iter


def _iter_csv_records(csv_dir: Path) -> Iterator[Tuple[str, Path]]:
    # records are in CSV/ folder, one file per activity
    for fp in sorted(csv_dir.glob("*.csv")):
        if fp.name.lower() == "subjects_info.csv":
            continue
        name = fp.stem  # e.g. s1_run
        yield name, fp


def _iter_wfdb_records(root: Path) -> Iterator[str]:
    """
    Iterate WFDB record basenames (without extension).
    Prefer RECORDS file if present.
    """
    records_file = root / "RECORDS"
    if records_file.exists():
        for line in records_file.read_text(encoding="utf-8").splitlines():
            rec = line.strip()
            if rec:
                yield rec
        return

    # fallback: scan for .hea
    for hea in sorted(root.glob("*.hea")):
        yield hea.stem


def _xcorr_lag_seconds(x: np.ndarray, y: np.ndarray, fs: int, max_lag_ms: float = 50.0) -> float:
    """
    Cross-correlation lag between two same-rate signals.
    Returns lag in seconds (positive means y lags x).
    """
    x = np.asarray(x, dtype=float).ravel()
    y = np.asarray(y, dtype=float).ravel()
    n = min(x.size, y.size)
    if n < fs:  # need ~1s
        return float("nan")
    x = x[:n] - np.nanmean(x[:n])
    y = y[:n] - np.nanmean(y[:n])

    max_lag = int((max_lag_ms / 1000.0) * fs)
    max_lag = max(1, min(max_lag, n - 1))

    # Normalized cross-correlation for lags in [-max_lag, +max_lag].
    lags = range(-max_lag, max_lag + 1)
    best_lag = 0
    best_val = -np.inf
    for lag in lags:
        if lag < 0:
            a = x[-lag:]
            b = y[: n + lag]
        elif lag > 0:
            a = x[: n - lag]
            b = y[lag:]
        else:
            a = x
            b = y
        denom = float(np.linalg.norm(a) * np.linalg.norm(b))
        if denom <= 1e-12 or not np.isfinite(denom):
            continue
        val = float(np.dot(a, b) / denom)
        if val > best_val:
            best_val = val
            best_lag = lag

    if not np.isfinite(best_val):
        return float("nan")
    return best_lag / float(fs)


def _fit_length(x: np.ndarray, target_n: int) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    if target_n <= 0:
        return x[:0].copy()
    if x.shape[0] == target_n:
        return x
    if x.shape[0] > target_n:
        return x[:target_n]
    if x.shape[0] == 0:
        pad_shape = (target_n,) + x.shape[1:]
        return np.zeros(pad_shape, dtype=float)
    pad_n = target_n - x.shape[0]
    pad = np.repeat(x[-1:], pad_n, axis=0)
    return np.concatenate([x, pad], axis=0)


def _resample_1d(x: np.ndarray, src_fs: int, dst_fs: int, target_n: int) -> np.ndarray:
    x = nan_interp_1d(np.asarray(x, dtype=float).ravel())
    if x.size == 0:
        return np.zeros(target_n, dtype=float)
    if src_fs == dst_fs:
        return _fit_length(x, target_n)
    factor = gcd(int(src_fs), int(dst_fs))
    y = resample_poly(x, int(dst_fs) // factor, int(src_fs) // factor)
    return _fit_length(y, target_n)


def _resample_2d(x: np.ndarray, src_fs: int, dst_fs: int, target_n: int) -> np.ndarray:
    a = np.asarray(x, dtype=float)
    if a.ndim != 2 or a.shape[0] == 0:
        return np.zeros((target_n, 3), dtype=float)
    if src_fs == dst_fs:
        return _fit_length(a, target_n)
    factor = gcd(int(src_fs), int(dst_fs))
    cols = [
        resample_poly(nan_interp_1d(a[:, col]), int(dst_fs) // factor, int(src_fs) // factor)
        for col in range(a.shape[1])
    ]
    return _fit_length(np.stack(cols, axis=1), target_n)


def _simulate_esp32_ppg_stream(ppg: np.ndarray, src_fs: int, cfg: PhysioNetPttConfig) -> np.ndarray:
    """
    Approximate the ESP32 MAX30100 path: one PPG channel sampled at a lower
    effective rate, then held/repeated inside the 250 Hz WebSocket stream.
    """
    target_n = int(round(cfg.window_s * cfg.live_target_fs))
    effective_n = int(round(cfg.window_s * cfg.live_ppg_effective_fs))
    if target_n <= 0 or effective_n <= 0:
        return np.array([], dtype=float)

    ppg_eff = _resample_1d(
        ppg,
        src_fs=src_fs,
        dst_fs=cfg.live_ppg_effective_fs,
        target_n=effective_n,
    )
    idx = np.floor(np.arange(target_n) * cfg.live_ppg_effective_fs / cfg.live_target_fs).astype(int)
    idx = np.clip(idx, 0, max(ppg_eff.size - 1, 0))
    return ppg_eff[idx]


def _prepare_live_window(
    *,
    ecg: np.ndarray,
    ppg: np.ndarray,
    acc: np.ndarray,
    gyr: np.ndarray,
    src_fs: int,
    cfg: PhysioNetPttConfig,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, int]:
    if not cfg.simulate_esp32_ppg_hold:
        return ecg, ppg, acc, gyr, src_fs

    target_n = int(round(cfg.window_s * cfg.live_target_fs))
    ecg_live = _resample_1d(ecg, src_fs=src_fs, dst_fs=cfg.live_target_fs, target_n=target_n)
    ppg_live = _simulate_esp32_ppg_stream(ppg, src_fs=src_fs, cfg=cfg)
    acc_live = _resample_2d(acc, src_fs=src_fs, dst_fs=cfg.live_target_fs, target_n=target_n)
    gyr_live = _resample_2d(gyr, src_fs=src_fs, dst_fs=cfg.live_target_fs, target_n=target_n)
    return ecg_live, ppg_live, acc_live, gyr_live, cfg.live_target_fs


def extract_record_features_from_arrays(
    *,
    fs: int,
    ecg: np.ndarray,
    r_peaks_idx: np.ndarray,
    pleth_2: Optional[np.ndarray],
    pleth_5: Optional[np.ndarray],
    pleth_1: Optional[np.ndarray] = None,
    pleth_4: Optional[np.ndarray] = None,
    acc_xyz: Optional[np.ndarray] = None,
    gyro_xyz: Optional[np.ndarray] = None,
    lc_1: Optional[np.ndarray] = None,
    lc_2: Optional[np.ndarray] = None,
) -> Dict[str, float]:
    """
    Unified feature extractor for CSV or WFDB-derived arrays.
    """
    feats: Dict[str, float] = {}

    # ECG: bandpass for stability, but peaks already provided
    ecg = nan_interp_1d(np.asarray(ecg, dtype=float).ravel())
    ecg_f = bandpass(ecg, low=0.5, high=40.0, fs=fs)
    ecg_f = robust_zscore(ecg_f)

    r_idx = np.asarray(r_peaks_idx, dtype=int).ravel()
    rr = np.diff(r_idx) / float(fs) if r_idx.size >= 2 else np.array([], dtype=float)
    feats["rr_mean_s"] = float(np.nanmean(rr)) if rr.size else float("nan")
    feats["rr_std_s"] = float(np.nanstd(rr)) if rr.size else float("nan")
    # HR (bpm)
    feats["hr_mean_bpm"] = float(60.0 / feats["rr_mean_s"]) if np.isfinite(feats["rr_mean_s"]) and feats["rr_mean_s"] > 0 else float("nan")

    # PPG: use infrared channels by default (pleth_2 distal, pleth_5 proximal)
    ppg_d = pleth_2 if pleth_2 is not None else pleth_1
    ppg_p = pleth_5 if pleth_5 is not None else pleth_4
    if ppg_d is None or ppg_p is None:
        ppg_d = np.array([], dtype=float)
        ppg_p = np.array([], dtype=float)

    ppg_d = nan_interp_1d(np.asarray(ppg_d, dtype=float).ravel()) if len(ppg_d) else np.asarray(ppg_d, dtype=float)
    ppg_p = nan_interp_1d(np.asarray(ppg_p, dtype=float).ravel()) if len(ppg_p) else np.asarray(ppg_p, dtype=float)
    ppg_d_f = robust_zscore(ppg_physionet_filter(ppg_d, fs=fs)) if np.size(ppg_d) else np.asarray(ppg_d, dtype=float)
    ppg_p_f = robust_zscore(ppg_physionet_filter(ppg_p, fs=fs)) if np.size(ppg_p) else np.asarray(ppg_p, dtype=float)

    feats["ptt_xcorr_s"] = float(_xcorr_lag_seconds(ppg_d_f, ppg_p_f, fs=fs, max_lag_ms=50.0))
    feats["ppg_distal_std"] = float(np.nanstd(ppg_d_f)) if ppg_d_f.size else float("nan")
    feats["ppg_prox_std"] = float(np.nanstd(ppg_p_f)) if ppg_p_f.size else float("nan")

    # Motion: accel/gyro RMS (if present)
    if acc_xyz is not None and np.asarray(acc_xyz).ndim == 2 and np.asarray(acc_xyz).shape[1] == 3:
        acc = np.asarray(acc_xyz, dtype=float)
        feats["acc_rms"] = float(np.sqrt(np.mean(acc**2)))
    else:
        feats["acc_rms"] = float("nan")
    if gyro_xyz is not None and np.asarray(gyro_xyz).ndim == 2 and np.asarray(gyro_xyz).shape[1] == 3:
        gyr = np.asarray(gyro_xyz, dtype=float)
        feats["gyro_rms"] = float(np.sqrt(np.mean(gyr**2)))
    else:
        feats["gyro_rms"] = float("nan")

    # Optional: load-cell mean (attachment pressure proxy)
    feats["lc_1_mean"] = float(np.nanmean(lc_1)) if lc_1 is not None and len(lc_1) else float("nan")
    feats["lc_2_mean"] = float(np.nanmean(lc_2)) if lc_2 is not None and len(lc_2) else float("nan")

    return feats


def extract_record_features_from_csv(df: pd.DataFrame, fs: int) -> Dict[str, float]:
    if "ecg" not in df.columns:
        raise ValueError("CSV record must include 'ecg' column")
    if "peaks" not in df.columns:
        raise ValueError("CSV record must include 'peaks' column (R-peak annotations)")

    ecg = df["ecg"].astype(float).to_numpy()
    r_idx = np.flatnonzero(df["peaks"].astype(int).to_numpy() == 1)

    pleth_2 = df["pleth_2"].astype(float).to_numpy() if "pleth_2" in df.columns else None
    pleth_5 = df["pleth_5"].astype(float).to_numpy() if "pleth_5" in df.columns else None
    pleth_1 = df["pleth_1"].astype(float).to_numpy() if "pleth_1" in df.columns else None
    pleth_4 = df["pleth_4"].astype(float).to_numpy() if "pleth_4" in df.columns else None

    acc = df[["a_x", "a_y", "a_z"]].astype(float).to_numpy() if all(c in df.columns for c in ["a_x", "a_y", "a_z"]) else None
    gyr = df[["g_x", "g_y", "g_z"]].astype(float).to_numpy() if all(c in df.columns for c in ["g_x", "g_y", "g_z"]) else None
    lc_1 = df["lc_1"].astype(float).to_numpy() if "lc_1" in df.columns else None
    lc_2 = df["lc_2"].astype(float).to_numpy() if "lc_2" in df.columns else None

    return extract_record_features_from_arrays(
        fs=fs,
        ecg=ecg,
        r_peaks_idx=r_idx,
        pleth_2=pleth_2,
        pleth_5=pleth_5,
        pleth_1=pleth_1,
        pleth_4=pleth_4,
        acc_xyz=acc,
        gyro_xyz=gyr,
        lc_1=lc_1,
        lc_2=lc_2,
    )


def _iter_windows(n: int, fs: int, window_s: float, max_windows: int) -> Iterator[Tuple[int, int]]:
    win = int(round(window_s * fs))
    if win <= 0 or n < win:
        return
    # Deterministic non-overlapping windows. Near-duplicate overlapping windows
    # inflate evaluation metrics when records share one BP label.
    if max_windows <= 0:
        max_windows = 1
    if n == win:
        yield 0, win
        return
    step = win
    start = 0
    k = 0
    while start + win <= n and k < max_windows:
        yield start, start + win
        start += step
        k += 1


def extract_windowed_features_from_csv(df: pd.DataFrame, *, fs: int, cfg: PhysioNetPttConfig) -> Iterator[Dict[str, float]]:
    if "ecg" not in df.columns or "peaks" not in df.columns:
        return
    n = int(df.shape[0])
    ecg = df["ecg"].astype(float).to_numpy()
    r_all = np.flatnonzero(df["peaks"].astype(int).to_numpy() == 1)
    pleth_2 = df["pleth_2"].astype(float).to_numpy() if "pleth_2" in df.columns else None
    pleth_5 = df["pleth_5"].astype(float).to_numpy() if "pleth_5" in df.columns else None
    pleth_1 = df["pleth_1"].astype(float).to_numpy() if "pleth_1" in df.columns else None
    pleth_4 = df["pleth_4"].astype(float).to_numpy() if "pleth_4" in df.columns else None
    acc = df[["a_x", "a_y", "a_z"]].astype(float).to_numpy() if all(c in df.columns for c in ["a_x", "a_y", "a_z"]) else None
    gyr = df[["g_x", "g_y", "g_z"]].astype(float).to_numpy() if all(c in df.columns for c in ["g_x", "g_y", "g_z"]) else None
    lc_1 = df["lc_1"].astype(float).to_numpy() if "lc_1" in df.columns else None
    lc_2 = df["lc_2"].astype(float).to_numpy() if "lc_2" in df.columns else None

    for a, b in _iter_windows(n, fs=fs, window_s=cfg.window_s, max_windows=cfg.max_windows_per_record):
        r_idx = r_all[(r_all >= a) & (r_all < b)] - a
        yield extract_record_features_from_arrays(
            fs=fs,
            ecg=ecg[a:b],
            r_peaks_idx=r_idx,
            pleth_2=pleth_2[a:b] if pleth_2 is not None else None,
            pleth_5=pleth_5[a:b] if pleth_5 is not None else None,
            pleth_1=pleth_1[a:b] if pleth_1 is not None else None,
            pleth_4=pleth_4[a:b] if pleth_4 is not None else None,
            acc_xyz=acc[a:b] if acc is not None else None,
            gyro_xyz=gyr[a:b] if gyr is not None else None,
            lc_1=lc_1[a:b] if lc_1 is not None else None,
            lc_2=lc_2[a:b] if lc_2 is not None else None,
        )


def extract_live_compatible_windowed_features_from_csv(
    df: pd.DataFrame, *, fs: int, cfg: PhysioNetPttConfig
) -> Iterator[Dict[str, float]]:
    """
    Extract the exact DEFAULT_FEATURES used by the live ESP32 WebSocket path.

    This intentionally ignores PhysioNet-only dual-PPG/load-cell shortcuts so a
    trained artifact can be used by live hardware without schema imputation.
    """
    if "ecg" not in df.columns:
        return
    ppg_col = "pleth_2" if "pleth_2" in df.columns else "pleth_1" if "pleth_1" in df.columns else None
    if ppg_col is None:
        return
    n = int(df.shape[0])
    ecg = df["ecg"].astype(float).to_numpy()
    ppg = df[ppg_col].astype(float).to_numpy()
    acc = (
        df[["a_x", "a_y", "a_z"]].astype(float).to_numpy()
        if all(c in df.columns for c in ["a_x", "a_y", "a_z"])
        else np.zeros((n, 3), dtype=float)
    )
    gyr = (
        df[["g_x", "g_y", "g_z"]].astype(float).to_numpy()
        if all(c in df.columns for c in ["g_x", "g_y", "g_z"])
        else np.zeros((n, 3), dtype=float)
    )

    for a, b in _iter_windows(n, fs=fs, window_s=cfg.window_s, max_windows=cfg.max_windows_per_record):
        ecg_w, ppg_w, acc_w, gyr_w, feature_fs = _prepare_live_window(
            ecg=ecg[a:b],
            ppg=ppg[a:b],
            acc=acc[a:b],
            gyr=gyr[a:b],
            src_fs=fs,
            cfg=cfg,
        )
        x, schema = extract_features_from_signals(
            ecg=ecg_w,
            ppg=ppg_w,
            accel_xyz=acc_w,
            gyro_xyz=gyr_w,
            rates=SamplingRates(fs_ecg=feature_fs, fs_ppg=feature_fs),
            schema=DEFAULT_FEATURES,
        )
        yield {name: float(value) for name, value in zip(schema.names, x)}


def extract_windowed_features_from_wfdb(
    record: "wfdb.Record", ann: "wfdb.Annotation", *, cfg: PhysioNetPttConfig
) -> Iterator[Dict[str, float]]:
    fs = int(record.fs)
    sig = record.p_signal
    n = int(sig.shape[0])
    names = [str(nm) for nm in record.sig_name]
    name_to_idx = {nm: i for i, nm in enumerate(names)}

    def col(name: str) -> Optional[np.ndarray]:
        i = name_to_idx.get(name)
        return sig[:, i].astype(float) if i is not None else None

    ecg = col("ecg")
    if ecg is None:
        return
    r_all = np.asarray(ann.sample, dtype=int)

    pleth_2 = col("pleth_2")
    pleth_5 = col("pleth_5")
    pleth_1 = col("pleth_1")
    pleth_4 = col("pleth_4")

    acc = None
    if all(k in name_to_idx for k in ["a_x", "a_y", "a_z"]):
        acc = np.stack([col("a_x"), col("a_y"), col("a_z")], axis=1)  # type: ignore[arg-type]
    gyr = None
    if all(k in name_to_idx for k in ["g_x", "g_y", "g_z"]):
        gyr = np.stack([col("g_x"), col("g_y"), col("g_z")], axis=1)  # type: ignore[arg-type]
    lc_1 = col("lc_1")
    lc_2 = col("lc_2")

    for a, b in _iter_windows(n, fs=fs, window_s=cfg.window_s, max_windows=cfg.max_windows_per_record):
        r_idx = r_all[(r_all >= a) & (r_all < b)] - a
        yield extract_record_features_from_arrays(
            fs=fs,
            ecg=ecg[a:b],
            r_peaks_idx=r_idx,
            pleth_2=pleth_2[a:b] if pleth_2 is not None else None,
            pleth_5=pleth_5[a:b] if pleth_5 is not None else None,
            pleth_1=pleth_1[a:b] if pleth_1 is not None else None,
            pleth_4=pleth_4[a:b] if pleth_4 is not None else None,
            acc_xyz=acc[a:b] if acc is not None else None,
            gyro_xyz=gyr[a:b] if gyr is not None else None,
            lc_1=lc_1[a:b] if lc_1 is not None else None,
            lc_2=lc_2[a:b] if lc_2 is not None else None,
        )


def extract_live_compatible_windowed_features_from_wfdb(
    record: "wfdb.Record", ann: "wfdb.Annotation", *, cfg: PhysioNetPttConfig
) -> Iterator[Dict[str, float]]:
    """
    WFDB variant of the live-compatible DEFAULT_FEATURES extractor.

    The annotation is accepted for API symmetry with the PhysioNet-specific path,
    but R-peaks are deliberately re-detected by extract_features_from_signals to
    match live ESP32 inference behavior.
    """
    _ = ann
    fs = int(record.fs)
    sig = record.p_signal
    n = int(sig.shape[0])
    names = [str(nm) for nm in record.sig_name]
    name_to_idx = {nm: i for i, nm in enumerate(names)}

    def col(name: str) -> Optional[np.ndarray]:
        i = name_to_idx.get(name)
        return sig[:, i].astype(float) if i is not None else None

    ecg = col("ecg")
    if ecg is None:
        return
    ppg = col("pleth_2")
    if ppg is None:
        ppg = col("pleth_1")
    if ppg is None:
        return

    acc = (
        np.stack([col("a_x"), col("a_y"), col("a_z")], axis=1)  # type: ignore[arg-type]
        if all(k in name_to_idx for k in ["a_x", "a_y", "a_z"])
        else np.zeros((n, 3), dtype=float)
    )
    gyr = (
        np.stack([col("g_x"), col("g_y"), col("g_z")], axis=1)  # type: ignore[arg-type]
        if all(k in name_to_idx for k in ["g_x", "g_y", "g_z"])
        else np.zeros((n, 3), dtype=float)
    )

    for a, b in _iter_windows(n, fs=fs, window_s=cfg.window_s, max_windows=cfg.max_windows_per_record):
        ecg_w, ppg_w, acc_w, gyr_w, feature_fs = _prepare_live_window(
            ecg=ecg[a:b],
            ppg=ppg[a:b],
            acc=acc[a:b],
            gyr=gyr[a:b],
            src_fs=fs,
            cfg=cfg,
        )
        x, schema = extract_features_from_signals(
            ecg=ecg_w,
            ppg=ppg_w,
            accel_xyz=acc_w,
            gyro_xyz=gyr_w,
            rates=SamplingRates(fs_ecg=feature_fs, fs_ppg=feature_fs),
            schema=DEFAULT_FEATURES,
        )
        yield {name: float(value) for name, value in zip(schema.names, x)}


def extract_record_features_from_wfdb(record: "wfdb.Record", ann: "wfdb.Annotation") -> Dict[str, float]:
    fs = int(record.fs)
    sig = record.p_signal
    names = [str(n) for n in record.sig_name]
    name_to_idx = {n: i for i, n in enumerate(names)}

    def col(name: str) -> Optional[np.ndarray]:
        i = name_to_idx.get(name)
        return sig[:, i].astype(float) if i is not None else None

    ecg = col("ecg")
    if ecg is None:
        raise ValueError("WFDB record missing 'ecg' channel")

    # R-peaks from annotation sample indices
    r_idx = np.asarray(ann.sample, dtype=int)

    pleth_2 = col("pleth_2")
    pleth_5 = col("pleth_5")
    pleth_1 = col("pleth_1")
    pleth_4 = col("pleth_4")

    acc = None
    if all(k in name_to_idx for k in ["a_x", "a_y", "a_z"]):
        acc = np.stack([col("a_x"), col("a_y"), col("a_z")], axis=1)  # type: ignore[arg-type]
    gyr = None
    if all(k in name_to_idx for k in ["g_x", "g_y", "g_z"]):
        gyr = np.stack([col("g_x"), col("g_y"), col("g_z")], axis=1)  # type: ignore[arg-type]

    return extract_record_features_from_arrays(
        fs=fs,
        ecg=ecg,
        r_peaks_idx=r_idx,
        pleth_2=pleth_2,
        pleth_5=pleth_5,
        pleth_1=pleth_1,
        pleth_4=pleth_4,
        acc_xyz=acc,
        gyro_xyz=gyr,
        lc_1=col("lc_1"),
        lc_2=col("lc_2"),
    )


def load_physionet_ptt_features(
    dataset_root: str | Path,
    cfg: PhysioNetPttConfig,
    verbose: bool = False,
    live_compatible: bool = False,
    source: str = "auto",
) -> Tuple[np.ndarray, np.ndarray, List[str], List[str]]:
    """
    Loads the PhysioNet pulse-transit-time-ppg dataset and returns (X, y, feature_names, record_names).

    source:
      - "auto" (default): CSV when `{rec}.csv` exists, else WFDB when `.hea/.dat/.atr` exist
      - "csv": CSV exports only (`<root>/csv/` or `<root>/CSV/`)
      - "wfdb": WFDB records only (`.hea`, `.dat`, `.atr` in dataset root)

    If live_compatible=True, features are extracted with the same generic
    DEFAULT_FEATURES code path used by the ESP32 live API.
    """
    root = Path(dataset_root)
    source = str(source).lower().strip()
    if source not in {"auto", "csv", "wfdb"}:
        raise ValueError(f"source must be auto, csv, or wfdb (got {source!r})")

    try:
        info = _load_subjects_info(root)
    except FileNotFoundError:
        # Allow training/inference while download is incomplete: parse metadata from headers.
        info = _subjects_info_from_headers(root)
    info = info.set_index("filename", drop=False)

    X_rows: List[List[float]] = []
    y_rows: List[List[float]] = []
    rec_names: List[str] = []

    feature_names: Optional[List[str]] = None

    csv_dir = _find_csv_dir(root) if source != "wfdb" else None
    record_names = sorted(str(name) for name in info.index)

    for rec_name in record_names:
        sbp, dbp = _bp_label_from_info_row(info.loc[rec_name])
        csv_fp = _csv_path_for_record(csv_dir, rec_name) if csv_dir is not None else None
        wfdb_ready = _wfdb_record_ready(root, rec_name)

        use_csv = source == "csv" or (source == "auto" and csv_fp is not None)
        use_wfdb = source == "wfdb" or (source == "auto" and csv_fp is None and wfdb_ready)

        if source == "csv" and csv_fp is None:
            if verbose:
                print(f"[physionet-ptt] skip(no csv): {rec_name}")
            continue
        if source == "wfdb" and not wfdb_ready:
            if verbose:
                print(f"[physionet-ptt] skip(no wfdb): {rec_name}")
            continue

        if use_csv and csv_fp is not None:
            df = pd.read_csv(csv_fp)
            extractor = (
                extract_live_compatible_windowed_features_from_csv
                if live_compatible
                else extract_windowed_features_from_csv
            )
            feature_names, n_win = _append_feature_windows(
                win_iter=extractor(df, fs=500, cfg=cfg),
                rec_name=rec_name,
                sbp=sbp,
                dbp=dbp,
                live_compatible=live_compatible,
                feature_names=feature_names,
                X_rows=X_rows,
                y_rows=y_rows,
                rec_names=rec_names,
            )
            if verbose:
                print(f"[physionet-ptt][csv] {rec_name}: windows={n_win} SBP={sbp:.1f} DBP={dbp:.1f}")
            continue

        if use_wfdb and wfdb_ready:
            loaded_wfdb = _load_wfdb_record_windows(
                root,
                rec_name,
                cfg=cfg,
                live_compatible=live_compatible,
                verbose=verbose,
            )
            if loaded_wfdb is not None:
                record, win_iter = loaded_wfdb
                feature_names, n_win = _append_feature_windows(
                    win_iter=win_iter,
                    rec_name=rec_name,
                    sbp=sbp,
                    dbp=dbp,
                    live_compatible=live_compatible,
                    feature_names=feature_names,
                    X_rows=X_rows,
                    y_rows=y_rows,
                    rec_names=rec_names,
                )
                if verbose:
                    print(
                        f"[physionet-ptt][wfdb] {rec_name}: fs={record.fs} windows={n_win} "
                        f"SBP={sbp:.1f} DBP={dbp:.1f}"
                    )
            continue

        if verbose and source == "auto":
            print(f"[physionet-ptt] skip(no csv/wfdb): {rec_name}")

    if not X_rows or feature_names is None:
        raise ValueError("No PhysioNet PTT features extracted. Check dataset path and files.")

    return np.asarray(X_rows, dtype=float), np.asarray(y_rows, dtype=float), feature_names, rec_names

