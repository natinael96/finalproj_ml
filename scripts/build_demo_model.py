"""
Build a minimal model.joblib for API and ESP32 WebSocket smoke tests.

This is not a clinically meaningful blood-pressure model. It exists so the
FastAPI service can load an artifact, accept live ESP32 windows, and exercise
the full transport + feature-extraction path while real training data is absent.

Usage from the repository root:
    python scripts/build_demo_model.py --out artifacts
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.multioutput import MultiOutputRegressor

from bp_pipeline.features import DEFAULT_FEATURES


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="artifacts", help="Output directory for model.joblib")
    parser.add_argument("--random-state", type=int, default=42)
    args = parser.parse_args()

    rng = np.random.default_rng(args.random_state)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    n_rows = 400
    n_features = len(DEFAULT_FEATURES.names)

    x = rng.normal(size=(n_rows, n_features))
    # Stable physiological-looking targets for smoke tests only.
    sbp = 120.0 + 4.0 * x[:, 0] - 2.0 * x[:, 7] + rng.normal(0.0, 5.0, n_rows)
    dbp = 78.0 + 2.0 * x[:, 1] - 1.5 * x[:, 8] + rng.normal(0.0, 3.0, n_rows)
    y = np.column_stack([sbp, dbp])
    medians = np.nanmedian(x, axis=0)

    model = MultiOutputRegressor(
        RandomForestRegressor(
            n_estimators=50,
            max_depth=8,
            min_samples_split=4,
            random_state=args.random_state,
            n_jobs=-1,
        )
    )
    model.fit(x, y)

    bundle = {
        "model": model,
        "schema": DEFAULT_FEATURES.to_dict(),
        "full_schema": DEFAULT_FEATURES.to_dict(),
        "medians_full_schema": medians.tolist(),
    }
    joblib.dump(bundle, out_dir / "model.joblib")
    (out_dir / "feature_schema.json").write_text(
        json.dumps(DEFAULT_FEATURES.to_dict(), indent=2),
        encoding="utf-8",
    )
    metrics = {
        "note": "demo artifact for transport/API smoke tests only; not clinically valid",
        "n_train": n_rows,
        "n_features": n_features,
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    print(f"Wrote {out_dir / 'model.joblib'}")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
