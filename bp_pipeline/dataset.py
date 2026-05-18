from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Tuple

import numpy as np
import pandas as pd

from .features import FeatureSchema, extract_features_from_signals, parse_json_array
from .preprocess import SamplingRates


@dataclass(frozen=True)
class DatasetColumns:
    ecg: str = "ecg"
    ppg: str = "ppg"
    accel_x: str = "accel_x"
    accel_y: str = "accel_y"
    accel_z: str = "accel_z"
    sbp: str = "sbp"
    dbp: str = "dbp"
    fs_ecg: str = "fs_ecg"
    fs_ppg: str = "fs_ppg"


def _row_rates(row: Dict[str, Any], cols: DatasetColumns, defaults: SamplingRates) -> SamplingRates:
    fs_ecg = int(row.get(cols.fs_ecg, defaults.fs_ecg))
    fs_ppg = int(row.get(cols.fs_ppg, defaults.fs_ppg))
    return SamplingRates(fs_ecg=fs_ecg, fs_ppg=fs_ppg)


def load_csv_features(
    path: str,
    schema: FeatureSchema,
    cols: DatasetColumns = DatasetColumns(),
    defaults: SamplingRates = SamplingRates(),
    motion_keep_percentile: float = 80.0,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Loads CSV where raw signals are JSON arrays in cells and returns (X, y)
    y is shaped (n, 2) for [SBP, DBP].
    """
    df = pd.read_csv(path)
    required = [cols.ecg, cols.ppg, cols.accel_x, cols.accel_y, cols.accel_z, cols.sbp, cols.dbp]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"Training CSV is missing required columns: {missing}")

    X = []
    y = []
    for row_idx, r in df.iterrows():
        row = r.to_dict()
        ecg = parse_json_array(row[cols.ecg])
        ppg = parse_json_array(row[cols.ppg])
        ax = parse_json_array(row[cols.accel_x])
        ay = parse_json_array(row[cols.accel_y])
        az = parse_json_array(row[cols.accel_z])
        lengths = {ecg.size, ppg.size, ax.size, ay.size, az.size}
        if len(lengths) != 1:
            raise ValueError(
                f"Row {row_idx} has mismatched signal lengths: "
                f"ecg={ecg.size}, ppg={ppg.size}, accel_x={ax.size}, accel_y={ay.size}, accel_z={az.size}"
            )
        accel = np.stack([ax, ay, az], axis=1)
        rates = _row_rates(row, cols=cols, defaults=defaults)

        feats, _ = extract_features_from_signals(
            ecg=ecg,
            ppg=ppg,
            accel_xyz=accel,
            rates=rates,
            motion_keep_percentile=motion_keep_percentile,
            schema=schema,
        )
        X.append(feats)
        y.append([float(row[cols.sbp]), float(row[cols.dbp])])

    return np.vstack(X), np.asarray(y, dtype=float)

