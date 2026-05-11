from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal import butter, filtfilt, find_peaks


@dataclass(frozen=True)
class SamplingRates:
    fs_ecg: int = 250
    fs_ppg: int = 100


def nan_interp_1d(x: np.ndarray) -> np.ndarray:
    """
    Replace NaN/inf in a 1D signal using linear interpolation.

    - If all samples are non-finite, returns zeros.
    - If only one finite sample exists, returns a constant array.
    """
    x = np.asarray(x, dtype=float).ravel()
    if x.size == 0:
        return x
    finite = np.isfinite(x)
    if finite.all():
        return x
    if not finite.any():
        return np.zeros_like(x)
    idx = np.arange(x.size, dtype=float)
    good_x = x[finite]
    good_i = idx[finite]
    if good_x.size == 1:
        return np.full_like(x, float(good_x[0]))
    x2 = x.copy()
    x2[~finite] = np.interp(idx[~finite], good_i, good_x)
    return x2


def robust_zscore(x: np.ndarray, eps: float = 1e-8) -> np.ndarray:
    """
    Robust-ish normalization for 1D signals:
      - center by median
      - scale by MAD (median absolute deviation)
    Falls back to standard deviation if MAD is ~0.
    """
    x = np.asarray(x, dtype=float).ravel()
    if x.size == 0:
        return x
    med = float(np.nanmedian(x))
    dev = np.abs(x - med)
    mad = float(np.nanmedian(dev))
    if not np.isfinite(mad) or mad < eps:
        sd = float(np.nanstd(x))
        scale = sd if np.isfinite(sd) and sd >= eps else 1.0
        return (x - float(np.nanmean(x))) / scale
    return (x - med) / (1.4826 * mad + eps)


def bandpass(x: np.ndarray, low: float, high: float, fs: int, order: int = 4) -> np.ndarray:
    """
    Zero-phase Butterworth bandpass.

    Notes:
      - Expects 1D array.
      - Uses filtfilt -> no phase delay, but needs enough samples.
    """
    x = np.asarray(x, dtype=float).ravel()
    if x.size < max(3 * order, 15):
        return x.copy()
    nyq = fs / 2.0
    low_n = max(low / nyq, 1e-6)
    high_n = min(high / nyq, 0.999999)
    if not (0 < low_n < high_n < 1):
        return x.copy()
    b, a = butter(order, [low_n, high_n], btype="band")
    return filtfilt(b, a, x)


def accel_magnitude(accel_xyz: np.ndarray) -> np.ndarray:
    a = np.asarray(accel_xyz, dtype=float)
    if a.ndim != 2 or a.shape[1] != 3:
        raise ValueError("accel_xyz must have shape (n, 3)")
    return np.sqrt(np.sum(a * a, axis=1))


def motion_mask(accel_xyz: np.ndarray, keep_percentile: float = 80.0) -> np.ndarray:
    """
    Boolean mask selecting low-motion samples.
    keep_percentile=80 keeps samples below the 80th percentile magnitude.
    """
    mag = accel_magnitude(accel_xyz)
    thr = np.percentile(mag, keep_percentile)
    return mag < thr


def apply_motion_mask(x: np.ndarray, mask: np.ndarray) -> np.ndarray:
    x = np.asarray(x)
    mask = np.asarray(mask, dtype=bool)
    n = min(x.shape[0], mask.shape[0])
    return x[:n][mask[:n]]


def ppg_peaks(ppg: np.ndarray, fs_ppg: int) -> np.ndarray:
    """
    Simple PPG peak detector (MVP).
    Returns indices of systolic peaks.
    """
    p = np.asarray(ppg, dtype=float).ravel()
    if p.size < int(0.5 * fs_ppg):
        return np.array([], dtype=int)
    # Typical HR range 40-220 bpm => min distance ~0.27s
    min_dist = max(int(0.27 * fs_ppg), 1)
    prominence = np.nanstd(p) * 0.25
    peaks, _ = find_peaks(p, distance=min_dist, prominence=prominence)
    return peaks.astype(int)


def remove_dc_gaussian(x: np.ndarray, fs: int, window_s: float = 1.0) -> np.ndarray:
    """
    Remove DC component using a centered Gaussian smoothing window.

    This matches the PhysioNet PTT dataset note: subtract a centered mean rolling
    Gaussian window (approximation via gaussian_filter1d).
    """
    x = np.asarray(x, dtype=float).ravel()
    if x.size == 0:
        return x
    sigma = max((window_s * fs) / 6.0, 1.0)  # ~99% within ±3σ
    trend = gaussian_filter1d(x, sigma=sigma, mode="nearest")
    return x - trend


def ppg_physionet_filter(ppg: np.ndarray, fs: int) -> np.ndarray:
    """
    PhysioNet pulse-transit-time-ppg suggested preprocessing:
      - remove DC via centered Gaussian rolling mean
      - bandpass ~0.75–5 Hz
    """
    x = remove_dc_gaussian(ppg, fs=fs, window_s=1.0)
    return bandpass(x, low=0.75, high=5.0, fs=fs, order=4)

