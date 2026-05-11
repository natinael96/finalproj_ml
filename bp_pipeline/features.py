from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import neurokit2 as nk
import numpy as np

from .preprocess import SamplingRates, apply_motion_mask, bandpass, motion_mask, ppg_peaks


@dataclass(frozen=True)
class FeatureSchema:
    names: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return {"names": list(self.names)}

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "FeatureSchema":
        return FeatureSchema(names=list(d["names"]))


DEFAULT_FEATURES = FeatureSchema(
    names=[
        "ptt_mean_s",
        "ptt_std_s",
        "pwv_proxy",  # 1/PTT mean (requires a length to be true PWV)
        # Physics-inspired nonlinear transforms (help model Moens–Korteweg-like curvature)
        "log_ptt",
        "inv_ptt",
        "inv_ptt2",
        "inv_ptt_x_hr",
        "rr_mean_s",
        "rr_std_s",
        "hrv_rmssd_s",
        "ppg_mean",
        "ppg_std",
        "ppg_skew",
        "ppg_kurtosis",
        "acc_rms",
        "acc_jerk_rms",
        "gyro_rms",
        "gyro_jerk_rms",
    ]
)


def _rmssd(rr: np.ndarray) -> float:
    rr = np.asarray(rr, dtype=float).ravel()
    if rr.size < 3:
        return float("nan")
    diff = np.diff(rr)
    return float(np.sqrt(np.mean(diff * diff)))


def _safe_stats(x: np.ndarray) -> Tuple[float, float]:
    x = np.asarray(x, dtype=float).ravel()
    if x.size == 0:
        return float("nan"), float("nan")
    return float(np.nanmean(x)), float(np.nanstd(x))


def _skew_kurt(x: np.ndarray) -> Tuple[float, float]:
    x = np.asarray(x, dtype=float).ravel()
    x = x[np.isfinite(x)]
    if x.size < 5:
        return float("nan"), float("nan")
    m = x.mean()
    s = x.std()
    if s == 0:
        return 0.0, 0.0
    z = (x - m) / s
    skew = float(np.mean(z**3))
    kurt = float(np.mean(z**4) - 3.0)
    return skew, kurt


def parse_json_array(s: Any) -> np.ndarray:
    """
    Accepts:
      - list/tuple/np.ndarray of numbers
      - JSON string of a list of numbers
    """
    if isinstance(s, np.ndarray):
        return s.astype(float)
    if isinstance(s, (list, tuple)):
        return np.asarray(s, dtype=float)
    if isinstance(s, str):
        return np.asarray(json.loads(s), dtype=float)
    raise TypeError(f"Unsupported array type: {type(s)}")


def extract_r_peaks(ecg: np.ndarray, fs_ecg: int) -> np.ndarray:
    e = np.asarray(ecg, dtype=float).ravel()
    if e.size < fs_ecg:  # need at least 1s
        return np.array([], dtype=int)
    try:
        _, info = nk.ecg_process(e, sampling_rate=fs_ecg)
        r = np.asarray(info.get("ECG_R_Peaks", []), dtype=int)
        return r
    except Exception:
        return np.array([], dtype=int)


def ptt_series_seconds(
    r_peaks: np.ndarray,
    ppg_peaks_idx: np.ndarray,
    fs_ecg: int,
    fs_ppg: int,
) -> np.ndarray:
    """
    PTT per beat using nearest-next PPG peak after each ECG R-peak.
    Assumes both signals cover same time interval (aligned start).
    """
    r_peaks = np.asarray(r_peaks, dtype=int)
    ppg_peaks_idx = np.asarray(ppg_peaks_idx, dtype=int)
    if r_peaks.size == 0 or ppg_peaks_idx.size == 0:
        return np.array([], dtype=float)

    r_t = r_peaks / float(fs_ecg)
    p_t = ppg_peaks_idx / float(fs_ppg)

    # For each r_t, pick the first p_t strictly after it.
    out = []
    j = 0
    for t in r_t:
        while j < p_t.size and p_t[j] <= t:
            j += 1
        if j < p_t.size:
            dt = p_t[j] - t
            if 0.03 <= dt <= 0.6:  # plausible PTT bounds
                out.append(dt)
    return np.asarray(out, dtype=float)


def extract_features_from_signals(
    ecg: np.ndarray,
    ppg: np.ndarray,
    accel_xyz: np.ndarray,
    gyro_xyz: Optional[np.ndarray] = None,
    rates: SamplingRates = SamplingRates(),
    motion_keep_percentile: float = 80.0,
    schema: FeatureSchema = DEFAULT_FEATURES,
) -> Tuple[np.ndarray, FeatureSchema]:
    """
    Returns (feature_vector, schema).

    This is an MVP extractor; your paper-specific features can be added here.
    """
    ecg = np.asarray(ecg, dtype=float).ravel()
    ppg = np.asarray(ppg, dtype=float).ravel()
    accel_xyz = np.asarray(accel_xyz, dtype=float)
    gyro_xyz = np.asarray(gyro_xyz, dtype=float) if gyro_xyz is not None else None

    # Pre-filter
    ecg_f = bandpass(ecg, low=0.5, high=40.0, fs=rates.fs_ecg)
    ppg_f = bandpass(ppg, low=0.5, high=8.0, fs=rates.fs_ppg)  # PPG typically lower band

    # Motion mask (simplified) applied to PPG + accel only (ECG often less sensitive in wrist form factors)
    m = motion_mask(accel_xyz, keep_percentile=motion_keep_percentile)
    ppg_m = apply_motion_mask(ppg_f, m)
    accel_m = accel_xyz[: m.shape[0]][m]

    # Peak detection
    r = extract_r_peaks(ecg_f, fs_ecg=rates.fs_ecg)
    p_peaks = ppg_peaks(ppg_m, fs_ppg=rates.fs_ppg)

    # PTT/PWV proxy
    ptt = ptt_series_seconds(r, p_peaks, fs_ecg=rates.fs_ecg, fs_ppg=rates.fs_ppg)
    ptt_mean, ptt_std = _safe_stats(ptt)
    pwv_proxy = float("nan")
    if np.isfinite(ptt_mean) and ptt_mean > 0:
        pwv_proxy = 1.0 / ptt_mean

    eps = 1e-6
    log_ptt = float("nan")
    inv_ptt = float("nan")
    inv_ptt2 = float("nan")
    inv_ptt_x_hr = float("nan")
    if np.isfinite(ptt_mean) and ptt_mean > 0:
        log_ptt = float(np.log(ptt_mean + eps))
        inv_ptt = float(1.0 / (ptt_mean + eps))
        inv_ptt2 = float(1.0 / ((ptt_mean + eps) ** 2))

    # RR/HRV
    rr = np.diff(r) / float(rates.fs_ecg) if r.size >= 2 else np.array([], dtype=float)
    rr_mean, rr_std = _safe_stats(rr)
    hrv_rmssd = _rmssd(rr)
    hr_mean_bpm = float("nan")
    if np.isfinite(rr_mean) and rr_mean > 0:
        hr_mean_bpm = float(60.0 / rr_mean)
    if np.isfinite(inv_ptt) and np.isfinite(hr_mean_bpm):
        inv_ptt_x_hr = float(inv_ptt * hr_mean_bpm)

    # PPG stats
    ppg_mean = float(np.nanmean(ppg_m)) if ppg_m.size else float("nan")
    ppg_std = float(np.nanstd(ppg_m)) if ppg_m.size else float("nan")
    ppg_skew, ppg_kurt = _skew_kurt(ppg_m)

    # Accel stats
    if accel_m.size:
        acc_rms = float(np.sqrt(np.mean(accel_m**2)))
        # jerk RMS: derivative magnitude (assumes uniform sample spacing, accel sampled at ppg rate in MVP)
        jerk = np.diff(accel_m, axis=0)
        acc_jerk_rms = float(np.sqrt(np.mean(jerk**2))) if jerk.size else float("nan")
    else:
        acc_rms = float("nan")
        acc_jerk_rms = float("nan")

    # Gyro stats (optional)
    gyro_rms = float("nan")
    gyro_jerk_rms = float("nan")
    if gyro_xyz is not None and gyro_xyz.ndim == 2 and gyro_xyz.shape[1] == 3 and gyro_xyz.size:
        g = gyro_xyz
        gyro_rms = float(np.sqrt(np.mean(g**2)))
        gj = np.diff(g, axis=0)
        gyro_jerk_rms = float(np.sqrt(np.mean(gj**2))) if gj.size else float("nan")

    feats: Dict[str, float] = {
        "ptt_mean_s": ptt_mean,
        "ptt_std_s": ptt_std,
        "pwv_proxy": pwv_proxy,
        "log_ptt": log_ptt,
        "inv_ptt": inv_ptt,
        "inv_ptt2": inv_ptt2,
        "inv_ptt_x_hr": inv_ptt_x_hr,
        "rr_mean_s": rr_mean,
        "rr_std_s": rr_std,
        "hrv_rmssd_s": hrv_rmssd,
        "ppg_mean": ppg_mean,
        "ppg_std": ppg_std,
        "ppg_skew": ppg_skew,
        "ppg_kurtosis": ppg_kurt,
        "acc_rms": acc_rms,
        "acc_jerk_rms": acc_jerk_rms,
        "gyro_rms": gyro_rms,
        "gyro_jerk_rms": gyro_jerk_rms,
    }

    x = np.array([feats.get(name, float("nan")) for name in schema.names], dtype=float)
    return x, schema

