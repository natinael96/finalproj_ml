"""Load trained artifacts and run SBP/DBP inference (REST + live WebSocket)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import joblib
import numpy as np
from sklearn.isotonic import IsotonicRegression

from .features import FeatureSchema


class PerOutputIsotonicCalibrator:
    """Isotonic calibration per output (SBP / DBP)."""

    def __init__(self) -> None:
        self._cals: List[IsotonicRegression] = []

    def fit(self, y_pred: np.ndarray, y_true: np.ndarray) -> "PerOutputIsotonicCalibrator":
        self._cals = []
        for j in range(y_pred.shape[1]):
            cal = IsotonicRegression(out_of_bounds="clip")
            cal.fit(y_pred[:, j], y_true[:, j])
            self._cals.append(cal)
        return self

    def transform(self, y_pred: np.ndarray) -> np.ndarray:
        out = np.empty_like(y_pred)
        for j, cal in enumerate(self._cals):
            out[:, j] = cal.predict(y_pred[:, j])
        return out


def _impute_non_finite(x: np.ndarray, names: List[str], med_map: Dict[str, float]) -> np.ndarray:
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


@dataclass
class ArtifactBundle:
    """In-memory model bundle used by the FastAPI service."""

    model: Any
    schema_names: List[str]
    med_map: Dict[str, float]
    calibrator: Optional[PerOutputIsotonicCalibrator] = None
    medians_selected: Optional[np.ndarray] = None
    imputer: Any = None
    full_schema: Optional[FeatureSchema] = None
    feat_idx: Optional[List[int]] = None

    def impute_features(self, x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, dtype=float).ravel()
        if self.medians_selected is not None and x.size == self.medians_selected.size:
            out = x.copy()
            bad = ~np.isfinite(out)
            if bad.any():
                out[bad] = self.medians_selected[bad]
            return out
        if self.schema_names and self.med_map:
            return _impute_non_finite(x, self.schema_names, self.med_map)
        out = x.copy()
        bad = ~np.isfinite(out)
        if bad.any():
            out[bad] = 0.0
        return out

    def predict(self, x: np.ndarray) -> Tuple[float, float]:
        x = self.impute_features(x)
        if not np.all(np.isfinite(x)):
            raise ValueError("non-finite features after imputation")
        pred_raw = self.model.predict(x.reshape(1, -1))
        pred = self.calibrator.transform(pred_raw) if self.calibrator is not None else pred_raw
        return float(pred[0, 0]), float(pred[0, 1])

    def predict_batch(self, X: np.ndarray) -> np.ndarray:
        X = np.asarray(X, dtype=float)
        if X.ndim == 1:
            X = X.reshape(1, -1)
        rows = [self.impute_features(row) for row in X]
        X_imp = np.vstack(rows) if rows else X
        if not np.all(np.isfinite(X_imp)):
            raise ValueError("non-finite features after imputation")
        pred_raw = self.model.predict(X_imp)
        if self.calibrator is not None:
            return self.calibrator.transform(pred_raw)
        return pred_raw


def load_artifact_bundle(path: Path) -> ArtifactBundle:
    bundle = joblib.load(path)
    model = bundle["model"]
    schema = bundle.get("schema", {})
    schema_names = list(schema.get("names", []))

    med_map: Dict[str, float] = {}
    full_schema_dict = bundle.get("full_schema", {})
    full_names = list(full_schema_dict.get("names", []))
    med_full = bundle.get("medians_full_schema")
    if isinstance(med_full, (list, tuple)) and len(full_names) == len(med_full):
        for name, med in zip(full_names, med_full):
            try:
                med_map[str(name)] = float(med)
            except Exception:
                continue
    elif schema_names:
        med_sel = bundle.get("medians_selected_schema")
        if isinstance(med_sel, (list, tuple)) and len(schema_names) == len(med_sel):
            for name, med in zip(schema_names, med_sel):
                try:
                    med_map[str(name)] = float(med)
                except Exception:
                    continue

    medians_selected = None
    med_sel = bundle.get("medians_selected_schema")
    if isinstance(med_sel, (list, tuple)) and med_sel:
        medians_selected = np.asarray(med_sel, dtype=float)

    calibrator = bundle.get("calibrator")
    imputer = bundle.get("imputer")
    feat_idx = bundle.get("feat_idx")
    full_schema = FeatureSchema(**full_schema_dict) if full_names else None

    return ArtifactBundle(
        model=model,
        schema_names=schema_names,
        med_map=med_map,
        calibrator=calibrator,
        medians_selected=medians_selected,
        imputer=imputer,
        full_schema=full_schema,
        feat_idx=list(feat_idx) if feat_idx is not None else None,
    )


def predict_from_feature_dict(artifact_dir: str | Path, features: Dict[str, float]) -> Dict[str, float]:
    """
    Predict from a full-schema feature dict (offline / replay tooling).
    Uses imputer + feature index when the artifact includes them.
    """
    art_path = Path(artifact_dir) / "model.joblib"
    bundle = load_artifact_bundle(art_path)

    if bundle.imputer is not None and bundle.full_schema is not None and bundle.feat_idx is not None:
        row = np.array(
            [features.get(n, np.nan) for n in bundle.full_schema.names],
            dtype=float,
        ).reshape(1, -1)
        row_sel = bundle.imputer.transform(row)[:, bundle.feat_idx]
        pred_raw = bundle.model.predict(row_sel)
        pred = bundle.calibrator.transform(pred_raw) if bundle.calibrator is not None else pred_raw
        return {"sbp": float(pred[0, 0]), "dbp": float(pred[0, 1])}

    names = bundle.schema_names or list(features.keys())
    x = np.array([features.get(n, np.nan) for n in names], dtype=float)
    sbp, dbp = bundle.predict(x)
    return {"sbp": sbp, "dbp": dbp}
