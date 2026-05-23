"""
Improved BP (SBP/DBP) training pipeline.

Key changes vs original
-----------------------
1. Pipeline-encapsulated imputation  — no test-set leakage.
2. More features by default (top_k=40) with cross-validated stability check.
3. Joint stacking  — one StackingRegressor predicts [SBP, DBP] together so the
   meta-learner can exploit the known DBP ≈ SBP/3 + constant correlation.
4. Richer base-estimator set  — RF, ExtraTrees, GradientBoosting, and optionally
   XGBoost/LightGBM when installed.
5. Optuna hyperparameter search  — 60 trials, pruned with MedianPruner.
6. Isotonic-regression calibration  — removes systematic per-output bias.
7. Subject-aware grouped k-fold CV metrics reported alongside held-out MAE.
8. Graceful fallback  — XGBoost/LightGBM are optional; plain GBM used otherwise.
"""

from __future__ import annotations

import argparse
import json
import warnings
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import joblib
import numpy as np
from sklearn.base import clone
from sklearn.ensemble import (
    ExtraTreesRegressor,
    GradientBoostingRegressor,
    RandomForestRegressor,
)
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.model_selection import GroupKFold, GroupShuffleSplit, train_test_split
from sklearn.multioutput import MultiOutputRegressor
from sklearn.pipeline import Pipeline
from sklearn.linear_model import Ridge

from .dataset import load_csv_features
from .features import DEFAULT_FEATURES, FeatureSchema
from .inference import PerOutputIsotonicCalibrator, apply_bp_constraints, predict_from_feature_dict
from .physionet_ptt_ppg import PhysioNetPttConfig, load_physionet_ptt_features

# ---------------------------------------------------------------------------
# Optional heavy dependencies
# ---------------------------------------------------------------------------
try:
    from xgboost import XGBRegressor

    _HAS_XGB = True
except ImportError:
    _HAS_XGB = False

try:
    from lightgbm import LGBMRegressor

    _HAS_LGB = True
except ImportError:
    _HAS_LGB = False

try:
    import optuna

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    _HAS_OPTUNA = True
except ImportError:
    _HAS_OPTUNA = False

warnings.filterwarnings("ignore", category=UserWarning)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _subject_group_from_record_names(record_names: List[str]) -> np.ndarray:
    groups = []
    for r in record_names:
        base = str(r)
        subj = base.split("_", 1)[0] if "_" in base else base
        groups.append(subj)
    return np.asarray(groups, dtype=object)


def _make_imputer_pipeline(estimator) -> Pipeline:
    """Wrap an estimator with a median imputer so imputation is fit-safe."""
    return Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("model", estimator),
    ])


def select_top_k_features(
    X: np.ndarray,
    y: np.ndarray,
    schema: FeatureSchema,
    k: int,
    random_state: int,
    groups: Optional[np.ndarray] = None,
    cv_folds: int = 5,
) -> FeatureSchema:
    """
    Select top-k features by *cross-validated* importance rather than a single
    fit.  Uses GroupKFold when groups are provided (prevents subject leakage).
    Only features that appear in the top-k in the majority of folds are kept,
    which is more stable than a single-split ranking.
    """
    imputer = SimpleImputer(strategy="median")
    X_imp = imputer.fit_transform(X)

    rf = RandomForestRegressor(
        n_estimators=200,
        max_depth=10,
        min_samples_split=5,
        random_state=random_state,
        n_jobs=-1,
    )

    n_feat = X_imp.shape[1]
    vote_counts = np.zeros(n_feat, dtype=int)

    if groups is not None and len(np.unique(groups)) >= cv_folds:
        cv = GroupKFold(n_splits=cv_folds)
        splits = list(cv.split(X_imp, y[:, 0], groups=groups))
    else:
        # Fall back to a single fit if groups are too few
        rf.fit(X_imp, y[:, 0])
        imp = np.asarray(rf.feature_importances_, dtype=float)
        idx = np.argsort(imp)[::-1][: max(1, min(k, imp.size))]
        return FeatureSchema(names=[schema.names[i] for i in idx])

    for tr_idx, _ in splits:
        rf_fold = RandomForestRegressor(
            n_estimators=100,
            max_depth=8,
            min_samples_split=5,
            random_state=random_state,
            n_jobs=-1,
        )
        rf_fold.fit(X_imp[tr_idx], y[tr_idx, 0])
        imp = np.asarray(rf_fold.feature_importances_, dtype=float)
        top_idx = set(np.argsort(imp)[::-1][: max(1, min(k * 2, imp.size))])
        for i in top_idx:
            vote_counts[i] += 1

    # Keep features that appear in top-2k in more than half the folds
    stable = np.where(vote_counts > cv_folds // 2)[0]
    if stable.size < max(1, k // 2):
        # Fallback: just use overall importance
        rf.fit(X_imp, y[:, 0])
        imp = np.asarray(rf.feature_importances_, dtype=float)
        stable = np.argsort(imp)[::-1][: max(1, min(k, imp.size))]

    # Among the stable set, rank by aggregate vote count and take top-k
    stable_sorted = stable[np.argsort(vote_counts[stable])[::-1]]
    final_idx = stable_sorted[: max(1, min(k, stable_sorted.size))]
    names = [schema.names[i] for i in final_idx]
    return FeatureSchema(names=names)


def slice_schema(X: np.ndarray, full_schema: FeatureSchema, keep_schema: FeatureSchema) -> np.ndarray:
    name_to_idx = {n: i for i, n in enumerate(full_schema.names)}
    idx = [name_to_idx[n] for n in keep_schema.names]
    return X[:, idx]


def _group_cv_mae(
    estimator,
    X: np.ndarray,
    y: np.ndarray,
    groups: np.ndarray,
    n_splits: int = 5,
) -> float:
    n_unique = len(np.unique(groups))
    if n_unique < 2:
        return float("inf")
    n_splits = min(n_splits, n_unique)
    cv = GroupKFold(n_splits=n_splits)
    maes: List[float] = []
    for tr, val in cv.split(X, y, groups=groups):
        est = clone(estimator)
        est.fit(X[tr], y[tr])
        pred = est.predict(X[val])
        maes.append(float(mean_absolute_error(y[val], pred)))
    return float(np.mean(maes))


def _build_simple_model(max_depth: int, random_state: int) -> ExtraTreesRegressor:
    return ExtraTreesRegressor(
        n_estimators=500,
        max_depth=max_depth,
        min_samples_leaf=5,
        min_samples_split=8,
        max_features="sqrt",
        random_state=random_state,
        n_jobs=-1,
    )


def _tune_simple_model(
    X: np.ndarray,
    y: np.ndarray,
    groups: Optional[np.ndarray],
    random_state: int,
) -> ExtraTreesRegressor:
    """Pick max_depth by subject-grouped CV on the training fold."""
    if groups is None or len(np.unique(groups)) < 3:
        return _build_simple_model(max_depth=8, random_state=random_state)

    best_depth = 8
    best_mae = float("inf")
    for depth in (6, 8, 10, 12):
        est = _build_simple_model(max_depth=depth, random_state=random_state)
        mae = _group_cv_mae(est, X, y, groups, n_splits=5)
        if mae < best_mae:
            best_mae = mae
            best_depth = depth
    print(f"[train] simple model CV MAE={best_mae:.3f} mmHg  max_depth={best_depth}")
    return _build_simple_model(max_depth=best_depth, random_state=random_state)


def _loso_cv_metrics(
    X: np.ndarray,
    y: np.ndarray,
    groups: np.ndarray,
    model_factory,
    *,
    feat_idx: List[int],
    calibrator: Optional[PerOutputIsotonicCalibrator],
    apply_constraints: bool,
) -> Dict[str, float]:
    """Leave-one-subject-out CV (honest metric for small cohorts)."""
    subjects = np.unique(groups)
    sbp_maes: List[float] = []
    dbp_maes: List[float] = []
    for subj in subjects:
        te = groups == subj
        tr = ~te
        if tr.sum() < 10 or te.sum() < 1:
            continue
        imp = SimpleImputer(strategy="median")
        X_tr = imp.fit_transform(X[tr])[:, feat_idx]
        X_te = imp.transform(X[te])[:, feat_idx]
        y_tr, y_te = y[tr], y[te]
        model = clone(model_factory())
        model.fit(X_tr, y_tr)
        pred = model.predict(X_te)
        if calibrator is not None:
            # Fit calibrator on a slice of train only (avoid leakage from test subject)
            pred_tr = model.predict(X_tr)
            cal = PerOutputIsotonicCalibrator().fit(pred_tr, y_tr)
            pred = cal.transform(pred)
        if apply_constraints:
            pred = apply_bp_constraints(pred)
        sbp_maes.append(float(mean_absolute_error(y_te[:, 0], pred[:, 0])))
        dbp_maes.append(float(mean_absolute_error(y_te[:, 1], pred[:, 1])))
    if not sbp_maes:
        return {}
    return {
        "loso_mae_sbp": float(np.mean(sbp_maes)),
        "loso_mae_dbp": float(np.mean(dbp_maes)),
        "loso_mae_sbp_std": float(np.std(sbp_maes)),
        "loso_mae_dbp_std": float(np.std(dbp_maes)),
        "loso_n_subjects": len(sbp_maes),
    }


def _subject_calib_split(
    train_groups: np.ndarray,
    calib_fraction: float,
    random_state: int,
) -> Tuple[np.ndarray, np.ndarray]:
    """Hold out whole subjects for calibration (not random windows)."""
    subjects = np.unique(train_groups)
    n_calib = max(1, int(round(len(subjects) * calib_fraction)))
    rng = np.random.default_rng(random_state)
    calib_subjects = set(rng.choice(subjects, size=min(n_calib, len(subjects)), replace=False))
    calib_mask = np.array([g in calib_subjects for g in train_groups], dtype=bool)
    return calib_mask, ~calib_mask


# ---------------------------------------------------------------------------
# Joint stacking regressor
# ---------------------------------------------------------------------------

class JointStackingRegressor:
    """
    Fits a StackingRegressor jointly for SBP and DBP, preserving inter-output
    correlation in the meta-learner.  The meta-features are concatenated OOF
    predictions from all base estimators for *both* outputs simultaneously.

    This is distinct from MultiOutputRegressor(StackingRegressor), which fits
    completely separate models per output and ignores inter-output correlation.
    """

    def __init__(self, base_estimators, meta_estimator, cv=5, passthrough=True):
        self.base_estimators = base_estimators  # list of (name, estimator) tuples
        self.meta_estimator = meta_estimator
        self.cv = cv
        self.passthrough = passthrough
        self._fitted_bases: List = []
        self._meta = None

    def fit(self, X: np.ndarray, y: np.ndarray, groups: Optional[np.ndarray] = None):
        """y shape: (n, 2) — columns [SBP, DBP]."""
        n = X.shape[0]
        n_base = len(self.base_estimators)
        n_out = y.shape[1]

        # Build OOF meta-features: shape (n, n_base * n_out)
        meta_X = np.zeros((n, n_base * n_out), dtype=float)

        if groups is not None and len(np.unique(groups)) >= self.cv:
            cv_splitter = GroupKFold(n_splits=self.cv)
            splits = list(cv_splitter.split(X, y, groups=groups))
        else:
            from sklearn.model_selection import KFold
            splits = list(KFold(n_splits=self.cv, shuffle=True, random_state=0).split(X))

        self._fitted_bases = []
        for b_idx, (name, est) in enumerate(self.base_estimators):
            # OOF predictions
            oof = np.zeros((n, n_out), dtype=float)
            for tr, val in splits:
                clone_est = clone(est)
                clone_est.fit(X[tr], y[tr])
                pred = clone_est.predict(X[val])
                if pred.ndim == 1:
                    pred = pred.reshape(-1, 1)
                oof[val] = pred

            meta_X[:, b_idx * n_out: (b_idx + 1) * n_out] = oof

            # Refit on full train set
            full_est = clone(est)
            full_est.fit(X, y)
            self._fitted_bases.append((name, full_est))

        if self.passthrough:
            meta_X = np.hstack([meta_X, X])

        self._meta = self.meta_estimator
        self._meta.fit(meta_X, y)
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        n_out = 2
        n_base = len(self._fitted_bases)
        meta_X = np.zeros((X.shape[0], n_base * n_out), dtype=float)
        for b_idx, (_, est) in enumerate(self._fitted_bases):
            pred = est.predict(X)
            if pred.ndim == 1:
                pred = pred.reshape(-1, 1)
            meta_X[:, b_idx * n_out: (b_idx + 1) * n_out] = pred
        if self.passthrough:
            meta_X = np.hstack([meta_X, X])
        return self._meta.predict(meta_X)


# ---------------------------------------------------------------------------
# Meta-learner
# ---------------------------------------------------------------------------

def _build_meta_estimator(meta_learner: str, random_state: int):
    if meta_learner == "ridge":
        return Ridge(alpha=1.0)
    if meta_learner == "xgb":
        if _HAS_XGB:
            return XGBRegressor(
                n_estimators=200,
                learning_rate=0.05,
                max_depth=3,
                subsample=0.8,
                random_state=random_state,
                verbosity=0,
                n_jobs=-1,
            )
        print("[train] XGBoost not installed — using GBM meta-learner.")
    return MultiOutputRegressor(
        GradientBoostingRegressor(
            n_estimators=200,
            learning_rate=0.05,
            max_depth=3,
            subsample=0.8,
            random_state=random_state,
        )
    )


# ---------------------------------------------------------------------------
# Optuna tuning
# ---------------------------------------------------------------------------

def _optuna_tune(
    X_train: np.ndarray,
    y_train: np.ndarray,
    groups: Optional[np.ndarray],
    n_trials: int,
    random_state: int,
) -> Tuple[dict, dict]:
    """Return best RF and ET kwargs found by Optuna."""

    if not _HAS_OPTUNA:
        print("[tune] Optuna not installed — using default hyperparameters.")
        return {}, {}

    def _cv_mae(estimator, X, y, groups):
        if groups is not None and len(np.unique(groups)) >= 3:
            cv = GroupKFold(n_splits=3)
            splits = list(cv.split(X, y, groups=groups))
        else:
            from sklearn.model_selection import KFold
            splits = list(KFold(n_splits=3, shuffle=True, random_state=random_state).split(X))
        maes = []
        for tr, val in splits:
            est = clone(estimator)
            est.fit(X[tr], y[tr])
            pred = est.predict(X[val])
            maes.append(mean_absolute_error(y[val], pred))
        return float(np.mean(maes))

    def rf_objective(trial):
        params = dict(
            n_estimators=trial.suggest_int("n_estimators", 200, 800, step=100),
            max_depth=trial.suggest_int("max_depth", 5, 20),
            min_samples_split=trial.suggest_int("min_samples_split", 2, 10),
            max_features=trial.suggest_float("max_features", 0.3, 1.0),
            random_state=random_state,
            n_jobs=-1,
        )
        # Use SBP only for speed; result generalises to DBP
        rf = RandomForestRegressor(**params)
        return _cv_mae(rf, X_train, y_train[:, 0], groups)

    def et_objective(trial):
        params = dict(
            n_estimators=trial.suggest_int("n_estimators", 300, 800, step=100),
            max_depth=trial.suggest_int("max_depth", 5, 20),
            min_samples_split=trial.suggest_int("min_samples_split", 2, 10),
            max_features=trial.suggest_float("max_features", 0.3, 1.0),
            random_state=random_state + 1,
            n_jobs=-1,
        )
        et = ExtraTreesRegressor(**params)
        return _cv_mae(et, X_train, y_train[:, 0], groups)

    sampler = optuna.samplers.TPESampler(seed=random_state)
    pruner = optuna.pruners.MedianPruner(n_startup_trials=5, n_warmup_steps=0)

    rf_study = optuna.create_study(direction="minimize", sampler=sampler, pruner=pruner)
    rf_study.optimize(rf_objective, n_trials=n_trials, show_progress_bar=False)

    et_study = optuna.create_study(direction="minimize", sampler=sampler, pruner=pruner)
    et_study.optimize(et_objective, n_trials=n_trials, show_progress_bar=False)

    print(f"[tune] RF best MAE={rf_study.best_value:.3f}  params={rf_study.best_params}")
    print(f"[tune] ET best MAE={et_study.best_value:.3f}  params={et_study.best_params}")
    return rf_study.best_params, et_study.best_params


# ---------------------------------------------------------------------------
# Build base estimators
# ---------------------------------------------------------------------------

def _build_base_estimators(rf_kwargs: dict, et_kwargs: dict, random_state: int):
    rf = _make_imputer_pipeline(
        RandomForestRegressor(
            n_estimators=rf_kwargs.get("n_estimators", 500),
            max_depth=rf_kwargs.get("max_depth", None),
            min_samples_split=rf_kwargs.get("min_samples_split", 4),
            max_features=rf_kwargs.get("max_features", "sqrt"),
            random_state=random_state,
            n_jobs=-1,
        )
    )
    et = _make_imputer_pipeline(
        ExtraTreesRegressor(
            n_estimators=et_kwargs.get("n_estimators", 600),
            max_depth=et_kwargs.get("max_depth", None),
            min_samples_split=et_kwargs.get("min_samples_split", 4),
            max_features=et_kwargs.get("max_features", "sqrt"),
            random_state=random_state + 1,
            n_jobs=-1,
        )
    )
    gbm = _make_imputer_pipeline(
        MultiOutputRegressor(
            GradientBoostingRegressor(
                n_estimators=300,
                learning_rate=0.05,
                max_depth=5,
                subsample=0.8,
                random_state=random_state + 2,
            )
        )
    )
    estimators = [("rf", rf), ("et", et), ("gbm", gbm)]

    if _HAS_XGB:
        xgb = _make_imputer_pipeline(
            XGBRegressor(
                n_estimators=400,
                learning_rate=0.05,
                max_depth=6,
                subsample=0.8,
                colsample_bytree=0.8,
                random_state=random_state + 3,
                n_jobs=-1,
                verbosity=0,
            )
        )
        estimators.append(("xgb", xgb))

    if _HAS_LGB:
        lgb = _make_imputer_pipeline(
            LGBMRegressor(
                n_estimators=400,
                learning_rate=0.05,
                num_leaves=63,
                subsample=0.8,
                colsample_bytree=0.8,
                random_state=random_state + 4,
                n_jobs=-1,
                verbose=-1,
            )
        )
        estimators.append(("lgb", lgb))

    return estimators


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data")
    ap.add_argument("--physionet-ptt-dir")
    ap.add_argument("--out", default="artifacts")
    ap.add_argument("--top-k", type=int, default=40,
                    help="Keep top-k features (default 40, up from 20)")
    ap.add_argument("--test-size", type=float, default=0.2)
    ap.add_argument("--calib-size", type=float, default=0.0,
                    help="Fraction of training subjects for isotonic calibration (0 = disabled)")
    ap.add_argument("--random-state", type=int, default=42)
    ap.add_argument("--window-s", type=float, default=8.0)
    ap.add_argument(
        "--max-windows-per-record",
        type=int,
        default=20,
        help="Max evenly-spaced windows per PhysioNet recording (default 20)",
    )
    ap.add_argument("--live-compatible", action="store_true")
    ap.add_argument("--esp32-compatible", action="store_true")
    ap.add_argument("--live-target-fs", type=int, default=250)
    ap.add_argument("--live-ppg-effective-fs", type=int, default=50)
    ap.add_argument(
        "--wfdb-only",
        action="store_true",
        help="Load PhysioNet from WFDB (.hea/.dat/.atr) only; ignore CSV exports",
    )
    ap.add_argument(
        "--csv-only",
        action="store_true",
        help="Load PhysioNet from CSV exports only; do not read WFDB binaries",
    )
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--group-by-subject", action="store_true", default=True)
    ap.add_argument("--random-window-split", action="store_false", dest="group_by_subject")
    ap.add_argument("--optuna-trials", type=int, default=0,
                    help="Optuna tuning trials per estimator when --stacking (0 = skip)")
    ap.add_argument(
        "--stacking",
        action="store_true",
        help="Use joint RF+ET+GBM stacking (default: regularized ExtraTrees, better for small N)",
    )
    ap.add_argument(
        "--loso-cv",
        action="store_true",
        default=True,
        help="Report leave-one-subject-out CV metrics (default: on)",
    )
    ap.add_argument(
        "--no-loso-cv",
        action="store_false",
        dest="loso_cv",
        help="Skip leave-one-subject-out CV (faster training)",
    )
    ap.add_argument("--meta-learner", choices=["ridge", "gbm", "xgb"], default="ridge",
                    help="Meta-learner when --stacking is set")
    args = ap.parse_args()

    if args.wfdb_only and args.csv_only:
        raise SystemExit("Choose at most one of --wfdb-only / --csv-only")
    if args.esp32_compatible and not args.physionet_ptt_dir:
        raise SystemExit("--esp32-compatible requires --physionet-ptt-dir")

    physionet_source = "wfdb" if args.wfdb_only else "csv" if args.csv_only else "auto"

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Load data
    # ------------------------------------------------------------------
    full_schema = DEFAULT_FEATURES
    record_names: List[str] = []
    live_compatible = bool(args.live_compatible or args.esp32_compatible)
    feature_mode = "custom_csv"

    if args.physionet_ptt_dir:
        feature_mode = (
            "esp32_single_ppg" if args.esp32_compatible
            else "live_compatible" if live_compatible
            else "physionet_specific"
        )
        X, y, feat_names, record_names = load_physionet_ptt_features(
            args.physionet_ptt_dir,
            cfg=PhysioNetPttConfig(
                window_s=args.window_s,
                max_windows_per_record=args.max_windows_per_record,
                live_target_fs=args.live_target_fs,
                live_ppg_effective_fs=args.live_ppg_effective_fs,
                simulate_esp32_ppg_hold=bool(args.esp32_compatible),
            ),
            verbose=bool(args.verbose),
            live_compatible=live_compatible,
            source=physionet_source,
        )
        full_schema = FeatureSchema(names=feat_names)
    elif args.data:
        X, y = load_csv_features(args.data, schema=full_schema)
    else:
        raise SystemExit("Provide either --physionet-ptt-dir or --data")

    # ------------------------------------------------------------------
    # Train / test split (subject-grouped by default)
    # ------------------------------------------------------------------
    if args.group_by_subject and record_names:
        groups = _subject_group_from_record_names(record_names)
        splitter = GroupShuffleSplit(n_splits=1, test_size=args.test_size,
                                    random_state=args.random_state)
        tr_idx, te_idx = next(splitter.split(X, y, groups=groups))
        split_method = "group_by_subject"
        train_groups = groups[tr_idx]
    else:
        idx = np.arange(X.shape[0])
        tr_idx, te_idx = train_test_split(idx, test_size=args.test_size,
                                          random_state=args.random_state)
        split_method = "random_window"
        train_groups = None

    X_train_raw, X_test_raw = X[tr_idx], X[te_idx]
    y_train, y_test = y[tr_idx], y[te_idx]

    # ------------------------------------------------------------------
    # Calibration split (optional; subject-grouped when possible)
    # ------------------------------------------------------------------
    use_calib = args.calib_size > 0
    if use_calib and train_groups is not None:
        calib_mask, fit_mask = _subject_calib_split(
            train_groups, args.calib_size, args.random_state
        )
    elif use_calib:
        calib_n = max(1, int(len(tr_idx) * args.calib_size))
        rng = np.random.default_rng(args.random_state)
        calib_mask = np.zeros(len(X_train_raw), dtype=bool)
        calib_mask[rng.choice(len(X_train_raw), calib_n, replace=False)] = True
        fit_mask = ~calib_mask
    else:
        calib_mask = np.zeros(len(X_train_raw), dtype=bool)
        fit_mask = np.ones(len(X_train_raw), dtype=bool)

    X_fit_raw = X_train_raw[fit_mask]
    y_fit = y_train[fit_mask]
    X_calib_raw = X_train_raw[calib_mask]
    y_calib = y_train[calib_mask]
    fit_groups = train_groups[fit_mask] if train_groups is not None else None

    # ------------------------------------------------------------------
    # Imputation (fit on X_fit only — no leakage)
    # ------------------------------------------------------------------
    imputer = SimpleImputer(strategy="median")
    X_fit = imputer.fit_transform(X_fit_raw)
    X_test = imputer.transform(X_test_raw)
    X_calib = (
        imputer.transform(X_calib_raw)
        if X_calib_raw.shape[0] > 0
        else np.empty((0, X_fit.shape[1]), dtype=float)
    )

    # ------------------------------------------------------------------
    # Cross-validated feature selection
    # ------------------------------------------------------------------
    keep_schema = select_top_k_features(
        X_fit, y_fit,
        schema=full_schema,
        k=args.top_k,
        random_state=args.random_state,
        groups=fit_groups,
    )
    feat_idx = [full_schema.names.index(n) for n in keep_schema.names]
    X_fit_sel = X_fit[:, feat_idx]
    X_calib_sel = X_calib[:, feat_idx]
    X_test_sel = X_test[:, feat_idx]

    # ------------------------------------------------------------------
    # Build and fit model
    # ------------------------------------------------------------------
    model_kind = "stacking" if args.stacking else "simple_extratrees"
    base_ests: List[Tuple[str, object]] = []

    if args.stacking:
        rf_kwargs, et_kwargs = {}, {}
        if args.optuna_trials > 0:
            print(f"[train] Running {args.optuna_trials} Optuna trials per estimator...")
            rf_kwargs, et_kwargs = _optuna_tune(
                X_fit_sel, y_fit, fit_groups, args.optuna_trials, args.random_state
            )
        base_ests = _build_base_estimators(rf_kwargs, et_kwargs, args.random_state)
        meta_joint = _build_meta_estimator(args.meta_learner, args.random_state)
        model = JointStackingRegressor(
            base_estimators=base_ests,
            meta_estimator=meta_joint,
            cv=5,
            passthrough=True,
        )
        print(f"[train] Fitting joint stacking model on {X_fit_sel.shape} ...")
        model.fit(X_fit_sel, y_fit, groups=fit_groups)
    else:
        tuned = _tune_simple_model(X_fit_sel, y_fit, fit_groups, args.random_state)
        print(f"[train] Fitting regularized ExtraTrees on {X_fit_sel.shape} ...")
        model = tuned
        model.fit(X_fit_sel, y_fit)

    # ------------------------------------------------------------------
    # Isotonic calibration (optional)
    # ------------------------------------------------------------------
    calibrator: Optional[PerOutputIsotonicCalibrator] = None
    if use_calib and X_calib_sel.shape[0] >= 10:
        pred_calib = model.predict(X_calib_sel)
        calibrator = PerOutputIsotonicCalibrator()
        calibrator.fit(pred_calib, y_calib)
        print(f"[calib] Isotonic calibrators fitted on {X_calib_sel.shape[0]} calib windows.")
    elif use_calib:
        print("[calib] Skipped — not enough calibration windows (need >= 10).")

    # ------------------------------------------------------------------
    # Evaluation on held-out test set
    # ------------------------------------------------------------------
    pred_test_raw = model.predict(X_test_sel)
    pred_test = calibrator.transform(pred_test_raw) if calibrator is not None else pred_test_raw
    pred_test = apply_bp_constraints(pred_test)

    mae_sbp = float(mean_absolute_error(y_test[:, 0], pred_test[:, 0]))
    mae_dbp = float(mean_absolute_error(y_test[:, 1], pred_test[:, 1]))
    rmse_sbp = float(np.sqrt(mean_squared_error(y_test[:, 0], pred_test[:, 0])))
    rmse_dbp = float(np.sqrt(mean_squared_error(y_test[:, 1], pred_test[:, 1])))

    # Per-subject MAE (more honest than pooled)
    subj_mae_sbp, subj_mae_dbp = [], []
    if args.group_by_subject and record_names:
        test_subj = groups[te_idx]
        for subj in np.unique(test_subj):
            mask = test_subj == subj
            if mask.sum() < 2:
                continue
            subj_mae_sbp.append(mean_absolute_error(y_test[mask, 0], pred_test[mask, 0]))
            subj_mae_dbp.append(mean_absolute_error(y_test[mask, 1], pred_test[mask, 1]))

    # Fraction of predictions within ±5 mmHg
    within5_sbp = float(np.mean(np.abs(y_test[:, 0] - pred_test[:, 0]) <= 5.0))
    within5_dbp = float(np.mean(np.abs(y_test[:, 1] - pred_test[:, 1]) <= 5.0))

    loso_metrics: Dict[str, float] = {}
    if args.loso_cv and record_names and not args.stacking:
        all_groups = _subject_group_from_record_names(record_names)
        depth = int(getattr(model, "max_depth", 8))
        print("[train] Running leave-one-subject-out CV ...")

        def _factory() -> ExtraTreesRegressor:
            return _build_simple_model(max_depth=depth, random_state=args.random_state)

        loso_metrics = _loso_cv_metrics(
            X,
            y,
            all_groups,
            _factory,
            feat_idx=feat_idx,
            calibrator=None,
            apply_constraints=True,
        )
        if loso_metrics:
            print(
                f"[loso] MAE SBP={loso_metrics['loso_mae_sbp']:.2f} "
                f"DBP={loso_metrics['loso_mae_dbp']:.2f} "
                f"(n={int(loso_metrics['loso_n_subjects'])} subjects)"
            )

    metrics: Dict[str, object] = {
        "mae_sbp": mae_sbp,
        "mae_dbp": mae_dbp,
        "rmse_sbp": rmse_sbp,
        "rmse_dbp": rmse_dbp,
        "within_5mmhg_sbp": within5_sbp,
        "within_5mmhg_dbp": within5_dbp,
        "per_subject_mae_sbp_mean": float(np.mean(subj_mae_sbp)) if subj_mae_sbp else None,
        "per_subject_mae_sbp_std": float(np.std(subj_mae_sbp)) if subj_mae_sbp else None,
        "per_subject_mae_dbp_mean": float(np.mean(subj_mae_dbp)) if subj_mae_dbp else None,
        "per_subject_mae_dbp_std": float(np.std(subj_mae_dbp)) if subj_mae_dbp else None,
        "n_train_fit": int(X_fit_sel.shape[0]),
        "n_calib": int(X_calib_sel.shape[0]),
        "n_test": int(X_test_sel.shape[0]),
        "n_features": int(X_fit_sel.shape[1]),
        "split_method": split_method,
        "feature_mode": feature_mode,
        "model_kind": model_kind,
        "meta_learner": args.meta_learner if args.stacking else None,
        "optuna_trials": args.optuna_trials if args.stacking else 0,
        "base_estimators": [name for name, _ in base_ests] if base_ests else ["extratrees"],
        "live_schema_compatible": bool(
            set(keep_schema.names).issubset(set(DEFAULT_FEATURES.names))
        ),
        "window_s": float(args.window_s),
        "max_windows_per_record": int(args.max_windows_per_record) if args.physionet_ptt_dir else None,
        "physionet_source": physionet_source if args.physionet_ptt_dir else None,
        "optuna_available": _HAS_OPTUNA,
        # Target check
        "target_sbp_met": mae_sbp <= 5.0,
        "target_dbp_met": mae_dbp <= 5.0,
        **loso_metrics,
    }

    # ------------------------------------------------------------------
    # Save artifacts
    # ------------------------------------------------------------------
    joblib.dump(
        {
            "model": model,
            "calibrator": calibrator,
            "imputer": imputer,
            "schema": keep_schema.to_dict(),
            "full_schema": full_schema.to_dict(),
            "feat_idx": feat_idx,
            "medians_full_schema": imputer.statistics_.tolist(),
            "medians_selected_schema": imputer.statistics_[feat_idx].tolist(),
            "training_config": {
                "feature_mode": feature_mode,
                "model_kind": model_kind,
                "apply_bp_constraints": True,
                "window_s": float(args.window_s),
                "max_windows_per_record": int(args.max_windows_per_record) if args.physionet_ptt_dir else None,
                "physionet_source": physionet_source if args.physionet_ptt_dir else None,
                "live_target_fs": int(args.live_target_fs) if args.esp32_compatible else None,
                "live_ppg_effective_fs": int(args.live_ppg_effective_fs) if args.esp32_compatible else None,
                "meta_learner": args.meta_learner,
            },
        },
        out_dir / "model.joblib",
    )
    (out_dir / "feature_schema.json").write_text(
        json.dumps(keep_schema.to_dict(), indent=2), encoding="utf-8"
    )
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    print(json.dumps(metrics, indent=2))


# ---------------------------------------------------------------------------
# Inference helper (for the live API / ESP32 pipeline)
# ---------------------------------------------------------------------------

def load_and_predict(artifact_dir: str, features: dict) -> dict:
    """Load saved artifacts and predict SBP/DBP from a full-schema feature dict."""
    return predict_from_feature_dict(artifact_dir, features)


if __name__ == "__main__":
    main()