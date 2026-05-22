# Signal Preprocessing Layer README

## Purpose

The signal preprocessing layer prepares raw biomedical and motion signals before feature extraction. Its job is to reduce noise, handle invalid values, limit the effect of motion artifacts, and make ECG and PPG signals suitable for peak detection.

In this project, preprocessing is intentionally based on classical signal-processing methods instead of deep learning. This keeps the system explainable, lightweight, and suitable for a final-year project prototype.

## Main File

The preprocessing code is located in:

```text
bp_pipeline/preprocess.py
```

This file supports the generic live pipeline used by ESP32 WebSocket inference, custom CSV training, and demo model generation. It also includes helper functions for the PhysioNet-specific PPG path.

## Role in the Full Pipeline

The preprocessing layer sits between raw signal acquisition and feature extraction:

```text
Raw ECG / PPG / IMU samples
        |
        v
Signal preprocessing
        |
        v
Feature extraction
        |
        v
Feature imputation and schema alignment
        |
        v
Blood pressure prediction
```

Without preprocessing, ECG and PPG peak detection would be more sensitive to baseline drift, high-frequency noise, poor sensor contact, and motion artifacts.

## Input Signals

The preprocessing utilities work with:

| Signal | Description |
|--------|-------------|
| ECG | Electrical heart signal used mainly for R-peak detection |
| PPG | Optical pulse signal used for pulse peak detection and morphology |
| Accelerometer X/Y/Z | Motion signal used to identify lower-motion samples |
| Gyroscope X/Y/Z | Optional rotational motion signal used later by feature extraction |

The default sampling-rate container is:

```python
SamplingRates(fs_ecg=250, fs_ppg=100)
```

During ESP32 live inference, the API usually overrides this so ECG and PPG are both treated as the incoming WebSocket sampling rate, commonly 250 Hz.

## Core Functions

| Function | Purpose |
|----------|---------|
| `nan_interp_1d` | Replaces NaN/Inf values in a 1D signal using interpolation |
| `robust_zscore` | Normalizes a 1D signal using median and MAD |
| `bandpass` | Applies zero-phase Butterworth bandpass filtering |
| `accel_magnitude` | Converts 3-axis acceleration into magnitude |
| `motion_mask` | Builds a boolean mask for lower-motion samples |
| `apply_motion_mask` | Applies a boolean mask to a signal |
| `ppg_peaks` | Detects PPG systolic peaks |
| `remove_dc_gaussian` | Removes slow DC trend using Gaussian smoothing |
| `ppg_physionet_filter` | Applies PhysioNet-specific PPG filtering |

## 1. Invalid Value Handling

### `nan_interp_1d(x)`

This function replaces invalid values in a 1D signal:

- If all samples are finite, the signal is returned unchanged.
- If all samples are NaN or Inf, it returns zeros.
- If only one finite sample exists, it returns a constant signal.
- If multiple finite samples exist, it uses linear interpolation.

This makes later filtering and feature extraction more robust because most numerical functions expect finite arrays.

## 2. Robust Normalization

### `robust_zscore(x, eps=1e-8)`

This function performs robust normalization:

```text
normalized = (x - median) / MAD
```

Where MAD means median absolute deviation. If MAD is too small, the function falls back to standard deviation. If that is also unsuitable, it uses a safe scale value.

This is useful when a signal contains outliers because median and MAD are less affected by extreme values than mean and standard deviation.

## 3. Bandpass Filtering

### `bandpass(x, low, high, fs, order=4)`

The main filter is a 4th-order Butterworth bandpass filter applied using `scipy.signal.filtfilt`.

`filtfilt` applies the filter forward and backward, producing zero net phase delay. This is important because pulse transit time depends on accurate timing between ECG R-peaks and PPG pulse peaks. A normal causal filter could shift signals in time and distort the PTT estimate.

### Default Bands

| Signal | Low Cutoff | High Cutoff | Reason |
|--------|------------|-------------|--------|
| ECG | 0.5 Hz | 40 Hz | Removes baseline drift while keeping QRS energy |
| Generic PPG | 0.5 Hz | 8 Hz | Keeps pulse waveform energy and removes high-frequency noise |
| PhysioNet PPG | 0.75 Hz | 5 Hz | Matches the PhysioNet-specific preprocessing path |

### Short-Window Protection

If a signal is too short for stable filtering, the function returns a copy of the input signal instead of forcing `filtfilt`.

The guard is:

```python
if x.size < max(3 * order, 15):
    return x.copy()
```

This prevents filter instability on very small windows.

## 4. Motion Magnitude

### `accel_magnitude(accel_xyz)`

The accelerometer arrives as three axes:

```text
accel_x, accel_y, accel_z
```

The preprocessing layer converts this into one motion magnitude:

```text
magnitude = sqrt(x^2 + y^2 + z^2)
```

This gives a simple estimate of how much the device or body was moving at each sample.

## 5. Motion Masking

### `motion_mask(accel_xyz, keep_percentile=80)`

Motion masking selects samples with lower accelerometer magnitude. With the default value, the system keeps samples below the 80th percentile of motion magnitude.

In simple terms:

```text
Keep the calmest 80% of samples in the current window.
```

This is adaptive per window. If the subject is very still, the threshold is low. If the subject is moving more, the threshold increases.

### `apply_motion_mask(x, mask)`

This function applies the boolean mask to a signal. It safely uses the shorter length if the signal and mask do not have exactly the same number of samples.

In the live feature extraction path:

- The mask is created from accelerometer magnitude.
- Motion-masked PPG is used for PPG morphology statistics.
- Motion-masked accelerometer data is used for accelerometer RMS and jerk features.
- ECG R-peak detection is not motion-masked.
- PPG peak detection for PTT uses the filtered PPG on the original time axis.

This design keeps PTT timing simpler while still reducing the effect of motion on amplitude-based features.

## 6. PPG Peak Detection

### `ppg_peaks(ppg, fs_ppg)`

PPG peak detection uses `scipy.signal.find_peaks`.

The detector includes:

- A minimum peak distance of about 0.27 seconds.
- A prominence threshold equal to 25% of the PPG standard deviation.

The 0.27-second distance corresponds to a high but plausible maximum heart rate of about 220 beats per minute. This prevents the detector from counting very close noise spikes as separate pulse peaks.

If the PPG signal is shorter than half a second, the function returns an empty peak list.

## 7. PhysioNet-Specific PPG Preprocessing

The repository also includes a PhysioNet-specific path:

```python
ppg_physionet_filter(ppg, fs)
```

This performs:

1. DC removal using `remove_dc_gaussian`.
2. Bandpass filtering from approximately 0.75 to 5 Hz.

### `remove_dc_gaussian(x, fs, window_s=1.0)`

This function estimates the slow signal trend using a centered Gaussian smoothing window and subtracts it from the original signal.

This removes slow baseline movement before the PhysioNet PPG bandpass filter is applied.

## Generic Live Path vs PhysioNet Path

| Path | Used For | Preprocessing Style |
|------|----------|---------------------|
| Generic path | ESP32 live inference, custom CSV training, demo model | ECG 0.5-40 Hz, PPG 0.5-8 Hz, accelerometer motion masking |
| PhysioNet path | PhysioNet dataset training | Gaussian DC removal, PPG 0.75-5 Hz filtering, dataset-specific processing |

The generic path is the correct reference for live deployment because it matches the signals available from the ESP32 prototype.

## Example Live Window Flow

For one 8-second ESP32 window at 250 Hz:

```text
2000 ECG samples
2000 PPG samples
2000 accelerometer samples
optional 2000 gyroscope samples
        |
        v
ECG bandpass: 0.5-40 Hz
PPG bandpass: 0.5-8 Hz
        |
        v
Accelerometer magnitude
        |
        v
80th percentile low-motion mask
        |
        v
Filtered ECG and PPG passed to peak detection
Motion-masked PPG passed to morphology statistics
Motion-masked accelerometer passed to motion features
```

## Why Zero-Phase Filtering Matters

Pulse transit time is calculated from the delay between an ECG R-peak and the following PPG pulse peak. If filtering shifts either signal in time, the calculated delay becomes inaccurate.

Using zero-phase filtering avoids introducing an artificial delay. This is why `filtfilt` is used instead of a one-direction causal filter.

## Why Motion Masking Matters

PPG is very sensitive to motion because finger or wrist movement changes optical contact with the sensor. Motion can create waveform changes that look like pulse changes but are actually artifacts.

The current system does not fully remove motion from PPG. Instead, it reduces motion influence by using lower-motion samples for morphology statistics. This is simpler than adaptive filtering and easier to explain, but it is also less powerful.

## Limitations

The preprocessing layer is suitable for a prototype, but it has limitations:

- Motion masking does not fully remove motion artifacts.
- The mask is based only on accelerometer magnitude.
- It does not use advanced adaptive filtering such as LMS or NLMS.
- Very noisy ECG can still cause missed or false R-peaks.
- Very noisy PPG can still cause missed or false pulse peaks.
- Short windows may skip bandpass filtering for stability.
- Filtering is window-based, so it needs a complete window before processing.

## Common Problems

| Problem | Likely Cause | Result |
|---------|--------------|--------|
| No R-peaks detected | Noisy ECG, poor electrodes, short window | PTT and RR features become NaN |
| No PPG peaks detected | Poor finger contact, weak IR signal, motion | PTT features become NaN |
| Unstable PPG statistics | Motion artifacts or sensor movement | Morphology features become unreliable |
| Filter appears skipped | Window too short for `filtfilt` | Raw signal is returned unchanged |
| Motion mask removes useful samples | High movement throughout the whole window | Features may not represent clean physiology |

## Summary

The signal preprocessing layer cleans and prepares ECG, PPG, and motion signals before feature extraction. It uses zero-phase bandpass filtering, accelerometer-based motion masking, PPG peak detection, robust normalization, and invalid-value handling.

Its main purpose is to make the downstream feature extraction layer more reliable while keeping the system understandable, lightweight, and suitable for real-time prototype inference.
