# Machine Learning Layer README

## Purpose

The machine learning layer trains the blood pressure prediction model used by the API. It takes extracted features from ECG, PPG, motion, and optional dataset-specific signals, then learns to predict:

- Systolic blood pressure, SBP
- Diastolic blood pressure, DBP

The model does not run on the ESP32. Training is performed offline on a computer, and the result is saved as a `model.joblib` artifact. The FastAPI backend later loads that artifact for real-time or REST prediction.

## Main Files

| File | Responsibility |
|------|----------------|
| `bp_pipeline/train.py` | Main training entry point and model-building logic |
| `bp_pipeline/dataset.py` | Loads custom CSV windows and extracts generic live-compatible features |
| `bp_pipeline/physionet_ptt_ppg.py` | Loads and extracts features from the PhysioNet PTT-PPG dataset |
| `bp_pipeline/features.py` | Defines `FeatureSchema` and default live feature extraction |
| `bp_api/main.py` | Loads the trained model artifact during inference |

## High-Level Flow

```text
Raw dataset
    |
    v
Signal preprocessing
    |
    v
Feature extraction
    |
    v
Feature matrix X and labels y
    |
    v
Missing-value imputation
    |
    v
Feature selection
    |
    v
Train/test split
    |
    v
Stacked multi-output regression model
    |
    v
Evaluation metrics
    |
    v
Saved model artifacts
```

The input to the model is not raw signal data. The model receives a table of numeric features, where each row represents one signal window.

## Training Entry Point

Run training with:

```bash
python -m bp_pipeline.train [OPTIONS]
```

Common options:

| Argument | Meaning |
|----------|---------|
| `--data` | Path to a custom CSV dataset |
| `--physionet-ptt-dir` | Path to the PhysioNet pulse-transit-time-ppg dataset |
| `--out` | Output folder for trained artifacts |
| `--top-k` | Number of selected features to keep |
| `--test-size` | Fraction of data used for testing |
| `--random-state` | Seed for reproducibility |
| `--window-s` | Window size in seconds for PhysioNet extraction |
| `--live-compatible` | Uses the same feature extractor as ESP32 live inference |
| `--verbose` | Prints detailed training logs |
| `--group-by-subject` | Splits PhysioNet by subject to reduce leakage; currently default |
| `--random-window-split` | Uses random window splitting instead of subject grouping |

## Dataset Modes

The training code supports two main dataset modes.

### 1. PhysioNet Dataset

Use:

```bash
python -m bp_pipeline.train \
  --physionet-ptt-dir data/pulse-transit-time-ppg/1.1.0 \
  --out artifacts_physionet \
  --top-k 10 \
  --group-by-subject \
  --verbose
```

This mode loads the PhysioNet Pulse Transit Time PPG dataset and extracts features from ECG, multiple PPG channels, motion sensors, and load-cell signals.

The PhysioNet-specific feature set can include:

- `rr_mean_s`
- `rr_std_s`
- `hr_mean_bpm`
- `ptt_xcorr_s`
- `ppg_distal_std`
- `ppg_prox_std`
- `acc_rms`
- `gyro_rms`
- `lc_1_mean`
- `lc_2_mean`

This mode is useful for benchmarking, but it may not match the ESP32 live hardware because the ESP32 does not have multiple PPG channels or load cells.

### 2. ESP32-Compatible PhysioNet Mode

Use this when the trained model should work with the ESP32 live WebSocket path:

```bash
python -m bp_pipeline.train \
  --physionet-ptt-dir data/pulse-transit-time-ppg/1.1.0 \
  --out artifacts_live \
  --top-k 18 \
  --esp32-compatible \
  --group-by-subject \
  --verbose
```

This mode trains on features produced by the same generic `DEFAULT_FEATURES` extractor used during live API inference. It also simulates the ESP32 signal shape more closely by using only one PPG channel, resampling the window to the 250 Hz live stream rate, and holding the PPG value at an effective 50 Hz rate to approximate the MAX30100 behavior.

This is usually the better choice for a live demo because the model schema is compatible with the real-time ESP32 pipeline.

The older `--live-compatible` option is still available if you only want the same feature names as the live API without simulating the ESP32 PPG timing.

### 3. Custom CSV Dataset

Use:

```bash
python -m bp_pipeline.train \
  --data data/train.csv \
  --out artifacts \
  --top-k 18 \
  --verbose
```

This mode is best when you collect your own ESP32 windows with matching cuff-based SBP/DBP labels.

The custom CSV path uses the generic feature extraction layer, which means the training features match the live ESP32 inference features.

## Inputs and Outputs

After loading a dataset, training produces:

```text
X = feature matrix
y = blood pressure labels
```

Where:

- `X` has shape `(number_of_windows, number_of_features)`
- `y` has shape `(number_of_windows, 2)`
- `y[:, 0]` is SBP
- `y[:, 1]` is DBP

Each row of `X` corresponds to one signal window, usually 8 seconds long.

## Missing Value Handling

Physiological signals can be noisy. Sometimes feature extraction cannot compute a value, for example when:

- ECG R-peaks are not detected
- PPG peaks are not detected
- PTT is outside the plausible range
- A motion or load-cell channel is missing

The training layer handles these values using median imputation.

In code:

```python
X_train_full, medians = _nan_impute(X_train_full_raw)
X_test_full = _apply_medians(X_test_full_raw, medians)
```

Important point: medians are fitted on the training set and then applied to the test set. This avoids leaking information from the test set into training.

The medians are saved inside `model.joblib` as:

```text
medians_full_schema
```

The API uses these same medians during inference when a live feature value is NaN or Inf.

## Feature Selection

The model does not always keep every extracted feature. It first ranks features using a Random Forest trained on SBP.

In code:

```python
select_top_k_features(...)
```

This function:

1. Trains a `RandomForestRegressor` on all features.
2. Uses feature importance scores.
3. Sorts features from most important to least important.
4. Keeps the top `k` features.
5. Saves the selected feature names as a `FeatureSchema`.

The selected feature order is important. The same order must be used during inference.

The selected schema is saved to:

```text
feature_schema.json
```

## Train/Test Split

The current training code supports two split modes.

### Subject-Grouped Split

This is the recommended split for PhysioNet:

```bash
--group-by-subject
```

It groups records by subject ID, such as:

```text
s1_walk -> s1
s1_run  -> s1
s2_sit  -> s2
```

All windows from the same subject are kept either in training or testing, not both.

This reduces data leakage because windows from the same subject and activity can be very similar.

### Random Window Split

Use:

```bash
--random-window-split
```

This randomly splits individual windows. It can give better-looking metrics, but it is less strict because windows from the same subject may appear in both train and test sets.

For a final-year report, subject-grouped results are more honest.

## Model Architecture

The final model is a multi-output stacked regression model.

At the outer level:

```python
MultiOutputRegressor(...)
```

This trains one model for SBP and one model for DBP.

Inside each target model, the system uses:

```python
StackingRegressor(...)
```

The stacking model combines three base learners:

| Learner | Role |
|---------|------|
| Random Forest | Captures nonlinear feature relationships and handles tabular data well |
| Extra Trees | Adds more randomized trees and can reduce variance |
| Ridge Regression | Provides a stable linear baseline |

The final meta-model is:

```python
Ridge(alpha=1.0)
```

The stack also uses:

```python
passthrough=True
```

This means the meta-model sees both the base model predictions and the original selected features.

## Model Parameters

The current main model uses:

| Component | Main Settings |
|-----------|---------------|
| Random Forest | `n_estimators=400`, `min_samples_split=4`, `max_depth=None` |
| Extra Trees | `n_estimators=600`, `min_samples_split=4`, `max_depth=None` |
| Ridge base learner | `alpha=2.0` |
| Ridge meta-learner | `alpha=1.0` |
| Multi-output wrapper | Separate model for SBP and DBP |

These values are fixed in the current project. They are not tuned by nested cross-validation.

## Evaluation Metrics

After training, the model predicts on the test set:

```python
pred = model.predict(X_test)
```

The training layer calculates:

| Metric | Meaning |
|--------|---------|
| `mae_sbp` | Mean absolute error for systolic BP |
| `mae_dbp` | Mean absolute error for diastolic BP |
| `rmse_sbp` | Root mean squared error for systolic BP |
| `rmse_dbp` | Root mean squared error for diastolic BP |

MAE is easy to explain because it is measured directly in mmHg.

Example interpretation:

```text
MAE DBP = 5.65 mmHg
```

Means the model is wrong by about 5.65 mmHg on average for diastolic pressure.

RMSE penalizes larger errors more strongly than MAE, so a much higher RMSE suggests occasional large mistakes.

## Saved Artifacts

Training saves three main files in the output directory.

| File | Contents |
|------|----------|
| `model.joblib` | Trained model bundle used by the API |
| `feature_schema.json` | Selected feature names in model input order |
| `metrics.json` | Evaluation results and training metadata |

## `model.joblib` Contents

The saved model bundle contains:

```python
{
  "model": model,
  "schema": keep_schema.to_dict(),
  "full_schema": full_schema.to_dict(),
  "medians_full_schema": medians.tolist(),
}
```

Meaning:

| Key | Purpose |
|-----|---------|
| `model` | The fitted `MultiOutputRegressor` |
| `schema` | Selected feature names expected by the model |
| `full_schema` | All features before top-k selection |
| `medians_full_schema` | Training medians used for imputation |

This bundle is loaded by the API during inference.

## `metrics.json` Contents

The metrics file includes:

- `mae_sbp`
- `mae_dbp`
- `rmse_sbp`
- `rmse_dbp`
- `n_train`
- `n_test`
- `n_features`
- `split_method`
- `feature_mode`
- `live_schema_compatible`

The `live_schema_compatible` field is especially useful for deployment. If it is `true`, the selected feature names are compatible with the live API feature schema.

## Relationship With API Inference

The API expects the incoming feature vector to match the saved model schema.

During WebSocket inference:

1. The API receives raw ECG, PPG, and IMU samples.
2. It extracts features using the saved schema.
3. It imputes invalid values using saved medians.
4. It calls:

```python
model.predict([x])
```

5. It returns predicted SBP and DBP.

This means the machine learning layer defines the contract that the inference layer must follow.

## Recommended Training Choice

For offline PhysioNet benchmarking:

```bash
python -m bp_pipeline.train \
  --physionet-ptt-dir data/pulse-transit-time-ppg/1.1.0 \
  --out artifacts_physionet \
  --top-k 10 \
  --group-by-subject \
  --verbose
```

For ESP32 live demo compatibility:

```bash
python -m bp_pipeline.train \
  --physionet-ptt-dir data/pulse-transit-time-ppg/1.1.0 \
  --out artifacts_live \
  --top-k 18 \
  --esp32-compatible \
  --group-by-subject \
  --verbose
```

For the strongest final-year methodology, collect your own ESP32 data with cuff labels:

```bash
python -m bp_pipeline.train \
  --data data/esp32_labeled_windows.csv \
  --out artifacts_esp32 \
  --top-k 18 \
  --verbose
```

## Limitations

The current machine learning layer is suitable for a working prototype, but it has limitations:

- It uses hand-engineered features, not raw waveform deep learning.
- Feature selection is based on SBP importance only.
- Hyperparameters are fixed manually.
- PhysioNet-trained models may not transfer perfectly to ESP32 hardware.
- The model does not include subject-specific calibration.
- Small or noisy datasets can cause unstable feature importance rankings.
- Random window splits can overestimate performance if subject leakage occurs.

## Summary

The machine learning layer converts extracted physiological features into a trained SBP/DBP prediction model. It loads feature datasets, imputes missing values, selects important features, trains a stacked multi-output regression model, evaluates the result, and saves all artifacts needed by the API.

For the final-year project, this layer shows how the system moves from biomedical signal features to deployable blood pressure prediction.
