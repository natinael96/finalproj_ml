# Feature Extraction Layer README

## Purpose

The feature extraction layer converts raw physiological and motion signals into a fixed-length numeric vector that the blood pressure regression model can use.

In this project, the model does not learn directly from raw ECG, PPG, accelerometer, or gyroscope waveforms. Instead, each signal window is summarized into hand-engineered features related to:

- Pulse transit timing between ECG and PPG
- Heart rhythm and heart-rate variability
- PPG waveform morphology
- Motion intensity and motion artifacts

This design makes the machine-learning pipeline easier to explain, debug, and deploy on a final-year project prototype.

## Main Files

| File | Responsibility |
|------|----------------|
| `bp_pipeline/features.py` | Builds feature vectors from ECG, PPG, accelerometer, and optional gyroscope arrays |
| `bp_pipeline/preprocess.py` | Provides filtering, motion masking, interpolation, and peak-detection helpers |
| `bp_pipeline/dataset.py` | Loads custom CSV windows and calls the same live feature extractor |
| `bp_pipeline/physionet_ptt_ppg.py` | Provides a separate PhysioNet-specific feature path |
| `bp_api/main.py` | Calls feature extraction during live WebSocket inference |

## Input Signals

The default live extractor expects one time window containing:

| Input | Shape | Description |
|-------|-------|-------------|
| `ecg` | 1D array | ECG samples for R-peak detection |
| `ppg` | 1D array | PPG samples for pulse peak detection and morphology |
| `accel_xyz` | `(n, 3)` array | Accelerometer X/Y/Z samples used for motion masking and motion features |
| `gyro_xyz` | Optional `(n, 3)` array | Gyroscope X/Y/Z samples used for rotational motion features |
| `rates` | `SamplingRates` | ECG and PPG sampling rates |
| `schema` | `FeatureSchema` | Ordered list of feature names to return |

For the ESP32 live demo, the server usually buffers an 8-second window at 250 Hz, which gives about 2000 samples per channel before extraction.

## Output

The main function is:

```python
extract_features_from_signals(...)
```

It returns:

```python
(feature_vector, schema)
```

Where:

- `feature_vector` is a NumPy array of floats.
- `schema` is a `FeatureSchema` object containing the feature names and order.
- The order is important because the trained model expects features in exactly the same order used during training.

NaN values are allowed at the feature extraction stage. Later, training and API inference replace invalid values using stored training medians where possible.

## Default Feature Schema

The default live schema is defined in `bp_pipeline/features.py` as `DEFAULT_FEATURES`.

| Feature | Meaning |
|---------|---------|
| `ptt_mean_s` | Mean pulse transit time in seconds from ECG R-peak to the next PPG peak |
| `ptt_std_s` | Standard deviation of the PTT series |
| `pwv_proxy` | Approximate pulse wave velocity proxy, calculated as `1 / ptt_mean_s` |
| `log_ptt` | Log transform of mean PTT |
| `inv_ptt` | Inverse transform of mean PTT |
| `inv_ptt2` | Squared inverse transform of mean PTT |
| `inv_ptt_x_hr` | Interaction between inverse PTT and heart rate |
| `rr_mean_s` | Mean R-R interval in seconds |
| `rr_std_s` | Standard deviation of R-R intervals |
| `hrv_rmssd_s` | RMSSD heart-rate-variability feature |
| `ppg_mean` | Mean value of motion-masked PPG |
| `ppg_std` | Standard deviation of motion-masked PPG |
| `ppg_skew` | Skewness of motion-masked PPG |
| `ppg_kurtosis` | Excess kurtosis of motion-masked PPG |
| `acc_rms` | RMS accelerometer magnitude after motion masking |
| `acc_jerk_rms` | RMS first difference of accelerometer samples |
| `gyro_rms` | RMS gyroscope magnitude when gyroscope data is available |
| `gyro_jerk_rms` | RMS first difference of gyroscope samples |

## Extraction Process

For one complete signal window, the live feature extraction flow is:

1. Convert `ecg`, `ppg`, `accel_xyz`, and optional `gyro_xyz` into NumPy arrays.
2. Bandpass-filter ECG between approximately 0.5 and 40 Hz.
3. Bandpass-filter PPG between approximately 0.5 and 8 Hz.
4. Compute accelerometer magnitude.
5. Build a low-motion mask by keeping samples below the selected accelerometer percentile.
6. Apply the motion mask to PPG and accelerometer samples for morphology and motion statistics.
7. Detect ECG R-peaks using NeuroKit2.
8. Detect PPG systolic peaks using SciPy `find_peaks`.
9. Match each ECG R-peak to the first later PPG peak.
10. Keep only plausible PTT values between 0.03 and 0.6 seconds.
11. Compute PTT, RR, HRV, PPG morphology, accelerometer, and gyroscope features.
12. Pack values into a vector using `schema.names`.

## Signal Flow Diagram

```text
Raw ECG, PPG, accelerometer, gyroscope window
        |
        v
Bandpass filtering
        |
        v
Motion mask from accelerometer magnitude
        |
        v
ECG R-peaks + PPG pulse peaks
        |
        v
PTT series, RR intervals, PPG statistics, IMU statistics
        |
        v
Ordered feature vector
        |
        v
Imputation and model prediction
```

## Motion Handling

The extractor uses accelerometer magnitude to identify lower-motion samples. This matters because PPG is sensitive to motion artifacts.

In the current MVP:

- PPG morphology statistics are calculated on motion-masked PPG.
- Accelerometer RMS is calculated on masked accelerometer samples.
- ECG peak detection is performed on filtered ECG without applying the motion mask.
- PPG peak detection for PTT is performed on the filtered PPG signal so peak indices remain on the original time axis.

This keeps timing calculations simpler while still reducing the effect of motion on morphology features.

## Pulse Transit Time Features

Pulse transit time is estimated by comparing electrical heart activity with the optical pulse:

1. Detect ECG R-peaks.
2. Detect PPG pulse peaks.
3. For each R-peak, find the first PPG peak after it.
4. Calculate the time difference.
5. Keep the value only if it is physiologically plausible.

PTT is important because arterial pressure and pulse propagation speed are related. The project therefore includes both direct PTT features and nonlinear transforms such as `1 / PTT`, `1 / PTT^2`, and `log(PTT)`.

## Schema Alignment

Schema alignment is one of the most important responsibilities of this layer.

During training, the selected feature order is saved in `feature_schema.json` and inside `model.joblib`. During WebSocket inference, the API passes that schema back into `extract_features_from_signals`, so the extractor returns exactly the features the model expects.

If the model was trained with a different feature path, predictions can fail or become meaningless. For example:

- Live ESP32 inference should use the `DEFAULT_FEATURES` path.
- PhysioNet-specific training without `--live-compatible` may produce features such as load-cell or dual-PPG features that the ESP32 does not provide.

For live deployment, prefer training with:

```bash
python -m bp_pipeline.train \
  --physionet-ptt-dir data/pulse-transit-time-ppg/1.1.0 \
  --out artifacts \
  --top-k 10 \
  --group-by-subject \
  --live-compatible
```

## Training Usage

For custom CSV data, `bp_pipeline/dataset.py` reads each row as one labeled window and calls the same default extractor used by the live API.

This is the best path when collecting your own ESP32 data because it keeps training and deployment consistent:

```bash
python -m bp_pipeline.train --data data/train.csv --out artifacts --top-k 16
```

The training pipeline then:

1. Extracts full feature vectors.
2. Imputes missing or invalid values.
3. Selects the strongest features.
4. Saves the selected schema.
5. Trains the final stacked model.

## Live Inference Usage

During live ESP32 inference:

1. ESP32 streams raw samples to the FastAPI WebSocket endpoint.
2. The API buffers samples by `device_id`.
3. Once a full window is available, `_process_buffered_windows()` slices the window.
4. The server calls `extract_features_from_signals(...)`.
5. Feature values are aligned to the trained schema.
6. Invalid values are imputed using medians stored in `model.joblib`.
7. The model predicts SBP and DBP.
8. The result can be stored in Supabase and broadcast to dashboards.

## PhysioNet-Specific Path

The repository also contains a separate extractor for the PhysioNet pulse-transit-time PPG dataset.

That path is useful because the dataset includes signals and metadata not available on the ESP32 prototype, such as:

- Provided R-peak annotations
- Distal and proximal PPG channels
- Load-cell signals

However, this path can produce feature names that are different from `DEFAULT_FEATURES`. A model trained using those features is not automatically compatible with live ESP32 inference.

Use the PhysioNet-specific path for dataset benchmarking. Use the live-compatible path for deployment testing.

## Common Failure Cases

| Problem | Likely Cause | Effect |
|---------|--------------|--------|
| NaN PTT features | Too few ECG R-peaks or PPG peaks | PTT-derived values need imputation |
| Noisy PPG morphology | Motion artifact or poor sensor contact | PPG statistics become unreliable |
| Schema mismatch | Model trained with different feature names | API prediction can fail |
| Weak live performance | Training data differs from ESP32 hardware data | Model may not generalize well |
| Missing gyro values | Gyroscope not provided | Gyro features become NaN and are imputed |

## Design Rationale

The feature extraction layer uses hand-engineered biomedical features instead of deep learning on raw waveforms because:

- It works with smaller datasets.
- It is easier to explain in a final-year project report or presentation.
- It supports real-time inference with low computational cost.
- It gives interpretable features linked to physiology.
- It allows the same model interface to work for offline training and online streaming.

## Limitations

The current extractor is suitable for a prototype, but it is not a clinical-grade signal-processing pipeline.

Main limitations:

- PPG from the ESP32 may have lower effective resolution than the server sampling rate.
- Motion masking is simple and based only on accelerometer magnitude.
- PTT depends heavily on reliable ECG and PPG peak detection.
- Missing physiological values are imputed, which helps software robustness but does not recover lost signal quality.
- Subject-specific calibration is not yet included.
- The PhysioNet and ESP32 domains can differ significantly.

## Summary

The feature extraction layer is the bridge between raw biomedical signals and machine-learning prediction. It filters ECG and PPG, reduces motion effects, detects peaks, calculates timing and morphology features, aligns the feature vector to the trained model schema, and enables both offline training and live WebSocket inference.

For the final-year project, this layer is important because it demonstrates the biomedical reasoning behind the model rather than treating blood pressure prediction as a black-box regression task.
