from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Dict, List, Tuple

import joblib
import numpy as np
from sklearn.ensemble import ExtraTreesRegressor, RandomForestRegressor, StackingRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.model_selection import GroupShuffleSplit, train_test_split
from sklearn.multioutput import MultiOutputRegressor

from .dataset import load_csv_features
from .features import DEFAULT_FEATURES, FeatureSchema
from .physionet_ptt_ppg import PhysioNetPttConfig, load_physionet_ptt_features


def _nan_impute(X: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """
    Replace NaNs with per-column median.
    Returns (X_imputed, medians).
    """
    X = np.asarray(X, dtype=float)
    med = np.nanmedian(X, axis=0)
    med = np.where(np.isfinite(med), med, 0.0)
    X2 = np.where(np.isfinite(X), X, med)
    return X2, med


def select_top_k_features(
    X: np.ndarray, y: np.ndarray, schema: FeatureSchema, k: int, random_state: int
) -> FeatureSchema:
    """
    Fit a RF on SBP only to get feature importances, then keep top-k.
    """
    rf = RandomForestRegressor(
        n_estimators=200,
        max_depth=10,
        min_samples_split=5,
        random_state=random_state,
        n_jobs=-1,
    )
    rf.fit(X, y[:, 0])
    imp = np.asarray(rf.feature_importances_, dtype=float)
    idx = np.argsort(imp)[::-1][: max(1, min(k, imp.size))]
    names = [schema.names[i] for i in idx]
    return FeatureSchema(names=names)


def slice_schema(X: np.ndarray, full_schema: FeatureSchema, keep_schema: FeatureSchema) -> np.ndarray:
    name_to_idx = {n: i for i, n in enumerate(full_schema.names)}
    idx = [name_to_idx[n] for n in keep_schema.names]
    return X[:, idx]

def _subject_group_from_record_names(record_names: List[str]) -> np.ndarray:
    """
    PhysioNet PTT/PPG records look like: s1_walk, s22_run, ...
    Group by subject prefix (s1, s22, ...).
    """
    groups = []
    for r in record_names:
        base = str(r)
        subj = base.split("_", 1)[0] if "_" in base else base
        groups.append(subj)
    return np.asarray(groups, dtype=object)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", help="Path to training CSV (our JSON-in-CSV format)")
    ap.add_argument("--physionet-ptt-dir", help="Dataset root for PhysioNet pulse-transit-time-ppg (expects CSV/ folder)")
    ap.add_argument("--out", default="artifacts", help="Output directory for artifacts")
    ap.add_argument("--top-k", type=int, default=20, help="Keep top-k features by importance")
    ap.add_argument("--test-size", type=float, default=0.2)
    ap.add_argument("--random-state", type=int, default=42)
    ap.add_argument("--window-s", type=float, default=8.0, help="Window length in seconds (PhysioNet PTT dataset)")
    ap.add_argument("--verbose", action="store_true", help="Print very verbose extraction/training logs")
    ap.add_argument(
        "--group-by-subject",
        action="store_true",
        help="When using PhysioNet PTT, split train/test by subject (reduces leakage)",
    )
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    full_schema = DEFAULT_FEATURES
    record_names: List[str] = []
    if args.physionet_ptt_dir:
        X, y, feat_names, record_names = load_physionet_ptt_features(
            args.physionet_ptt_dir,
            cfg=PhysioNetPttConfig(window_s=args.window_s),
            verbose=bool(args.verbose),
        )
        # Override schema to match this dataset’s feature set
        full_schema = FeatureSchema(names=feat_names)
    elif args.data:
        X, y = load_csv_features(args.data, schema=full_schema)
    else:
        raise SystemExit("Provide either --physionet-ptt-dir or --data")
    X, medians = _nan_impute(X)

    keep_schema = select_top_k_features(X, y, schema=full_schema, k=args.top_k, random_state=args.random_state)
    Xk = slice_schema(X, full_schema=full_schema, keep_schema=keep_schema)

    if args.group_by_subject and record_names:
        groups = _subject_group_from_record_names(record_names)
        splitter = GroupShuffleSplit(n_splits=1, test_size=args.test_size, random_state=args.random_state)
        tr_idx, te_idx = next(splitter.split(Xk, y, groups=groups))
        X_train, X_test = Xk[tr_idx], Xk[te_idx]
        y_train, y_test = y[tr_idx], y[te_idx]
    else:
        X_train, X_test, y_train, y_test = train_test_split(
            Xk, y, test_size=args.test_size, random_state=args.random_state
        )

    rf = RandomForestRegressor(
        n_estimators=400,
        max_depth=None,
        min_samples_split=4,
        random_state=args.random_state,
        n_jobs=-1,
    )
    et = ExtraTreesRegressor(
        n_estimators=600,
        max_depth=None,
        min_samples_split=4,
        random_state=args.random_state + 1,
        n_jobs=-1,
    )
    ridge = Ridge(alpha=2.0, random_state=args.random_state)

    # Stacking for *single* target. Wrap with MultiOutputRegressor for (SBP, DBP).
    stack = StackingRegressor(
        estimators=[("rf", rf), ("et", et), ("ridge", ridge)],
        final_estimator=Ridge(alpha=1.0, random_state=args.random_state),
        passthrough=True,
        n_jobs=-1,
    )
    model = MultiOutputRegressor(stack)
    model.fit(X_train, y_train)
    if args.verbose:
        print(f"[train] fit complete. train={X_train.shape} test={X_test.shape}")

    pred = model.predict(X_test)
    mae_sbp = mean_absolute_error(y_test[:, 0], pred[:, 0])
    mae_dbp = mean_absolute_error(y_test[:, 1], pred[:, 1])
    rmse_sbp = float(np.sqrt(mean_squared_error(y_test[:, 0], pred[:, 0])))
    rmse_dbp = float(np.sqrt(mean_squared_error(y_test[:, 1], pred[:, 1])))

    metrics: Dict[str, float] = {
        "mae_sbp": float(mae_sbp),
        "mae_dbp": float(mae_dbp),
        "rmse_sbp": float(rmse_sbp),
        "rmse_dbp": float(rmse_dbp),
        "n_train": int(X_train.shape[0]),
        "n_test": int(X_test.shape[0]),
        "n_features": int(Xk.shape[1]),
    }

    joblib.dump(
        {
            "model": model,
            "schema": keep_schema.to_dict(),
            "full_schema": full_schema.to_dict(),
            "medians_full_schema": medians.tolist(),
        },
        out_dir / "model.joblib",
    )
    (out_dir / "feature_schema.json").write_text(json.dumps(keep_schema.to_dict(), indent=2), encoding="utf-8")
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()

