# Examiner Questions and Viva Preparation README

**Project:** Cuffless Blood Pressure Estimation from Multimodal Wearable Signals  
**Purpose:** Quick preparation guide for final-year project defense, demonstration, and examiner questions.  
**Use this file for:** Viva practice, presentation rehearsal, expected technical questions, and honest limitation handling.

---

## 1. Project in 60 Seconds

This project is an end-to-end prototype for **cuffless blood pressure estimation**. It uses physiological signals such as **ECG**, **PPG**, accelerometer, and gyroscope data to estimate **systolic blood pressure (SBP)** and **diastolic blood pressure (DBP)**.

The system has four major parts:

1. **Signal acquisition:** ESP32 firmware streams ECG, PPG, accelerometer, and gyroscope samples over WebSocket.
2. **Signal processing:** The backend filters ECG/PPG, detects peaks, computes PTT/HRV/motion features, and handles missing values.
3. **Machine learning:** A supervised multi-output regression model predicts SBP and DBP from extracted features.
4. **Deployment and visualization:** FastAPI serves predictions, Supabase stores telemetry, and dashboards show live/history results.

The project is a **proof-of-concept research prototype**, not a clinically certified medical device.

---

## 2. Best Opening Answer

If an examiner asks, **“Briefly explain your project,”** say:

> My project develops a prototype cuffless blood pressure monitoring system. Instead of using an inflatable cuff, it estimates systolic and diastolic blood pressure from ECG, PPG, and motion signals. The system extracts physiological features such as pulse transit time, heart-rate variability, PPG statistics, and motion RMS. These features are passed into a supervised regression model trained on labeled data. I also implemented the deployment pipeline: an ESP32 streams live sensor data to a FastAPI backend, predictions can be stored in Supabase, and dashboards visualize live and historical readings. The aim is not clinical certification, but to demonstrate the full methodology from signal acquisition to real-time BP prediction.

---

## 3. Likely Examiner Questions and Strong Answers

### Q1. What problem are you solving?

I am addressing the inconvenience of traditional cuff-based blood pressure monitoring. Cuff devices are accurate but uncomfortable for frequent or continuous use. My project explores a cuffless approach where physiological signals such as ECG and PPG are used to estimate BP continuously or periodically.

The goal is to demonstrate a complete prototype: sensing, preprocessing, feature extraction, prediction, storage, and dashboard visualization.

---

### Q2. Why is blood pressure estimation from ECG and PPG possible?

ECG gives the electrical timing of the heartbeat, especially the R-peak. PPG gives the optical pulse arrival at a peripheral site. The delay between the ECG R-peak and the PPG pulse is called **pulse transit time (PTT)**. PTT is related to pulse wave velocity, and pulse wave velocity is affected by arterial stiffness and blood pressure.

When BP increases, arteries generally become stiffer, pulse waves travel faster, and PTT often decreases. This relationship is not perfect or universal, but it provides useful predictive information when combined with other features such as heart rate, PPG morphology, and motion.

---

### Q3. What is PTT?

PTT means **pulse transit time**. It is the time delay between a proximal cardiac event and a distal pulse event.

In this project, the generic live pipeline computes PTT by:

1. Detecting ECG R-peaks.
2. Detecting PPG pulse peaks.
3. Finding the first PPG peak after each ECG R-peak.
4. Computing the time difference.
5. Keeping physiologically plausible delays between 0.03 and 0.6 seconds.

The model then uses the mean and standard deviation of PTT, plus nonlinear transforms such as inverse PTT.

---

### Q4. What is the difference between PTT and PWV?

**PTT** is a measured time delay.  
**PWV**, pulse wave velocity, is speed.

The relationship is:

```text
PWV = distance / PTT
```

In this project, true PWV is not computed because the arterial path length is not measured. Therefore, the project uses a **PWV proxy**, mainly `1 / PTT`, which is related to velocity but not a full physical PWV measurement.

---

### Q5. Why did you use ECG and PPG instead of only PPG?

Using ECG and PPG allows the system to estimate timing between the heart’s electrical activity and the peripheral pulse arrival. With only PPG, we can extract morphology and pulse rate, but we lose the ECG reference point needed for classic PTT.

ECG improves timing-based feature extraction. PPG provides peripheral pulse information. IMU data helps describe motion artifacts.

---

### Q6. What signals does your system use?

The system can use:

- **ECG:** electrical heart signal.
- **PPG:** optical blood-volume pulse, from IR/red light.
- **Accelerometer:** motion and activity.
- **Gyroscope:** rotational motion.

The PhysioNet dataset also includes multiple PPG channels and load-cell signals, which help measure sensor contact force and pulse transit between PPG sites.

---

### Q7. What dataset did you use?

The main public dataset is **PhysioNet pulse-transit-time-ppg version 1.1.0**. It contains ECG, multiple PPG channels, accelerometer, gyroscope, load-cell data, and BP metadata.

The project also supports a custom CSV format where each row contains JSON-encoded ECG, PPG, accelerometer signals, and corresponding SBP/DBP labels.

For live demonstration, ESP32 data is streamed to the backend. However, live ESP32 data requires separate cuff labels if it is to be used for real training.

---

### Q8. How are labels assigned in the PhysioNet dataset?

PhysioNet provides BP values at the start and end of each recording. In this project, the label for a record is computed as:

```text
SBP = mean(bp_sys_start, bp_sys_end)
DBP = mean(bp_dia_start, bp_dia_end)
```

Each 8-second window from that recording inherits the same SBP and DBP label. This is a simplifying assumption and is one limitation of the current methodology.

---

### Q9. Is there a risk of data leakage?

Yes. If random splitting is used, windows from the same subject may appear in both training and testing. That can make performance look better than real-world deployment.

To reduce this, the training script supports `--group-by-subject`, which keeps all windows from the same subject either in train or test. For serious evaluation, subject-grouped splitting is more realistic.

---

### Q10. What preprocessing did you apply?

The preprocessing includes:

- ECG bandpass filtering from 0.5 to 40 Hz.
- PPG bandpass filtering from 0.5 to 8 Hz in the generic pipeline.
- PhysioNet PPG DC removal and 0.75 to 5 Hz filtering.
- Accelerometer-based motion masking.
- ECG R-peak detection.
- PPG peak detection.
- NaN/Inf handling by median imputation.

Zero-phase filtering is used so that the filter does not shift peak timing, which is important for PTT.

---

### Q11. Why did you use zero-phase filtering?

PTT depends on accurate timing between ECG and PPG peaks. Normal causal filters can introduce phase delay, shifting peaks in time. `filtfilt` applies the filter forward and backward, resulting in zero net phase delay. This preserves timing relationships in the window.

---

### Q12. How did you handle motion artifacts?

The project uses a simple accelerometer-based motion mask. It calculates acceleration magnitude and keeps samples below the 80th percentile of motion. This reduces the effect of high-motion samples on PPG statistics.

This is not as advanced as adaptive filtering such as NLMS, but it is simple, reproducible, and appropriate for a prototype.

---

### Q13. What features did you extract?

The generic feature set includes:

- PTT mean and standard deviation.
- PWV proxy (`1 / PTT`).
- Log and inverse PTT transforms.
- RR interval mean and standard deviation.
- HRV RMSSD.
- PPG mean, standard deviation, skewness, kurtosis.
- Accelerometer RMS and jerk RMS.
- Gyroscope RMS and jerk RMS.

The PhysioNet-specific path includes features such as cross-correlation PTT between proximal and distal PPG channels, load-cell means, HR, RR, and motion RMS.

---

### Q14. Why did you use handcrafted features instead of deep learning?

Deep learning needs more labeled data and is harder to explain. This project uses handcrafted physiological features because:

- They are interpretable.
- They relate directly to cardiovascular physiology.
- They work with smaller datasets.
- They are easier to debug.
- They allow faster CPU inference.

For a final-year project, interpretability and end-to-end deployment were more important than building a black-box model.

---

### Q15. What machine-learning model did you use?

The training pipeline uses a **multi-output regression model**. Internally, it uses `MultiOutputRegressor`, which trains separate regressors for SBP and DBP.

The main estimator is a **stacked ensemble**:

- Random Forest Regressor.
- Extra Trees Regressor.
- Ridge Regression.
- Ridge meta-learner.

The model predicts two outputs:

```text
[SBP, DBP]
```

---

### Q16. Why use Random Forest and Extra Trees?

Blood pressure relationships are nonlinear. Random Forest and Extra Trees can model nonlinear interactions between features like PTT, heart rate, motion, and PPG morphology.

They also work well on tabular data, require little scaling, and are robust to outliers compared with a purely linear model.

---

### Q17. Why use Ridge Regression in the stack?

Ridge Regression provides a stable linear baseline. In a stacked model, tree-based models capture nonlinear patterns, while Ridge can help stabilize predictions and combine outputs from the base learners. Ridge also reduces overfitting through L2 regularization.

---

### Q18. What is feature selection in your model?

Before training the final model, a Random Forest ranks features by importance for SBP prediction. The top-k features are selected and saved in `feature_schema.json`.

This reduces noise, improves model simplicity, and ensures that the API knows exactly which feature order the model expects.

---

### Q19. What metrics did you use?

The project uses:

- **MAE:** mean absolute error.
- **RMSE:** root mean squared error.

They are reported separately for SBP and DBP. MAE is easy to interpret because it gives the average error in mmHg. RMSE penalizes larger errors more strongly.

---

### Q20. What were your results?

The committed PhysioNet example metrics are approximately:

- SBP MAE: **11.98 mmHg**
- DBP MAE: **5.65 mmHg**
- SBP RMSE: **16.40 mmHg**
- DBP RMSE: **6.95 mmHg**

This suggests DBP prediction is closer to the target than SBP. SBP remains harder, which is common in cuffless BP estimation.

---

### Q21. Are these results clinically acceptable?

No, not yet. The results demonstrate a proof of concept, but they do not meet the requirements for a clinically certified blood-pressure device.

Clinical validation would require:

- Larger and more diverse subject data.
- Standardized cuff reference measurements.
- Subject-independent evaluation.
- Calibration studies.
- Regulatory testing.

This project should be presented as an engineering prototype, not a medical device.

---

### Q22. Why is SBP harder to predict than DBP?

SBP is influenced by stroke volume, arterial stiffness, wave reflection, vascular tone, age, and activity. It can vary more rapidly and strongly during motion or exercise. DBP is often more stable, so it may be easier for a simple feature-based model to approximate.

---

### Q23. What is the role of the ESP32?

The ESP32 acts as the live acquisition device. It reads:

- ECG from an analog pin.
- PPG from MAX30100.
- Motion from MPU6050.

It streams one JSON packet per sample to the FastAPI server over WebSocket. The server performs feature extraction and prediction.

---

### Q24. Why not run the ML model directly on the ESP32?

The current model and signal-processing pipeline are easier to run and update on the server. Keeping inference on the backend allows:

- Easier debugging.
- Faster model replacement.
- Supabase integration.
- Dashboard broadcasting.
- More complex Python libraries such as NeuroKit2 and scikit-learn.

Future work could export a smaller model to TensorFlow Lite or another embedded format.

---

### Q25. How does the WebSocket stream work?

The ESP32 connects to:

```text
ws://<PC_IP>:8000/ws/esp32?device_id=esp32-001&fs_hz=250&window_s=8.0
```

It sends JSON like:

```json
{
  "t": 123456,
  "ecg": 2048,
  "ir": 180000,
  "red": 175000,
  "ax": 0.1,
  "ay": 0.0,
  "az": 9.8,
  "gx": 0.0,
  "gy": 0.0,
  "gz": 0.0
}
```

The server buffers samples until it has a full 8-second window, then predicts SBP and DBP.

---

### Q26. Why is the first prediction delayed?

The system uses an 8-second window. At 250 Hz, this requires:

```text
8 seconds × 250 samples/second = 2000 samples
```

The server cannot predict until it has a full window, so the first prediction appears after about 8 seconds plus processing time.

---

### Q27. What is the difference between `/ws/esp32` and `/ws/ingest`?

`/ws/esp32` receives one JSON sample at a time from the ESP32 firmware.

`/ws/ingest` receives arrays of samples in chunks. It is useful for replaying PhysioNet records or sending data from a gateway.

Both paths eventually call the same prediction logic once a full window is buffered.

---

### Q28. Why does the ESP32 firmware use a separate PPG drain task?

The MAX30100 has a small FIFO buffer. If the main loop is busy with WiFi or JSON sending, the FIFO can overflow and PPG samples can be lost.

The firmware solves this by using a FreeRTOS task to drain the PPG sensor frequently. This keeps the optical signal updated and reduces flat or frozen PPG readings.

---

### Q29. What is the sampling-rate issue with the MAX30100?

The ECG stream targets 250 Hz, but the MAX30100 PPG sensor is configured at 50 Hz. The firmware holds the latest filtered PPG value between sensor updates, so the server receives a 250 Hz aligned stream but the effective PPG resolution is still 50 Hz.

This is acceptable for the prototype but not ideal for high-precision PPG morphology.

---

### Q30. What is Supabase used for?

Supabase is used to store:

- User-owned devices.
- Measurement sessions.
- Telemetry windows.
- Feature vectors.
- Predicted SBP and DBP.
- Optional raw ECG/PPG/IMU samples.

It also provides authentication and Row Level Security so users can only read their own rows.

---

### Q31. Why did you use FastAPI?

FastAPI supports:

- REST endpoints for `/predict` and `/predict_batch`.
- WebSocket endpoints for live streaming.
- Pydantic validation.
- Easy integration with Python ML artifacts.
- Uvicorn ASGI deployment.

It fits well because the ML pipeline is already in Python.

---

### Q32. What does `/predict` expect?

`/predict` expects an already extracted feature vector in the exact order saved in `feature_schema.json`.

It does not accept raw ECG or PPG arrays. Raw arrays are handled by the WebSocket paths.

---

### Q33. What happens if features contain NaN or Inf?

The API replaces non-finite values using medians saved during training. If values are still non-finite after imputation, the request or window is rejected.

This helps when peak detection fails for some windows, but it does not fully solve bad signal quality.

---

### Q34. What is the biggest limitation of your project?

The biggest limitation is **generalization**. A model trained on PhysioNet may not perfectly transfer to live ESP32 hardware because the sensors, placement, PPG channels, sampling quality, and subject population differ.

Another limitation is that the current prototype is not calibrated per user, and cuffless BP often requires calibration for accurate absolute BP.

---

### Q35. If you had more time, what would you improve?

I would improve:

- Subject-specific calibration.
- More labeled data from the actual ESP32 hardware.
- Subject-grouped cross-validation.
- Adaptive motion artifact removal such as NLMS.
- Overlapping windows for smoother updates.
- A smaller embedded model for edge inference.
- Better sensor hardware with higher-quality PPG.
- JWT-based device authentication.

---

## 4. Questions That Test Understanding

### Q36. Why is feature schema important?

The model expects features in the exact order used during training. If the API sends features in a different order, the model will still output numbers, but those numbers will be meaningless.

That is why the project saves `feature_schema.json` and validates feature length/order.

---

### Q37. What is the difference between training features and live features?

PhysioNet training can use dual PPG channels and load-cell features, while the ESP32 live system has one PPG channel and no load cell. This creates a domain gap.

For best deployment, the model should be trained using the same feature extraction path as the live ESP32 system.

---

### Q38. Why is calibration important?

PTT-BP relationships vary between people because of age, arterial stiffness, vessel length, health conditions, and sensor placement. Calibration adjusts the model to an individual baseline.

Without calibration, the model can show trends but may have systematic offset for a specific person.

---

### Q39. Why is motion a serious problem?

Motion changes sensor contact pressure, introduces optical artifacts into PPG, and can shift or hide pulse peaks. Since PTT depends on accurate peak timing, motion artifacts directly affect prediction quality.

---

### Q40. Why not use only heart rate?

Heart rate alone is not enough because BP is affected by many factors beyond heart rate, including arterial stiffness, vascular resistance, stroke volume, and sensor contact. PTT, PPG morphology, and motion features provide additional information.

---

### Q41. What does RMSSD mean?

RMSSD is the root mean square of successive differences between RR intervals. It is a common HRV feature and captures beat-to-beat variability.

---

### Q42. Why use 8-second windows?

Eight seconds is long enough to contain several heartbeats for stable RR/PTT statistics, while still short enough to give frequent updates. Very short windows may not contain enough beats; very long windows increase latency.

---

### Q43. Is the WebSocket buffer sliding or tumbling?

It is currently tumbling. After one 8-second window is processed, those samples are removed. The next prediction uses the next new 8 seconds of data.

---

### Q44. What happens if the ESP32 disconnects?

The firmware periodically attempts to reconnect the WebSocket. The server buffer is in memory, so if the API restarts, partial buffered data is lost. For this prototype that is acceptable.

---

### Q45. What is the role of `model.joblib`?

`model.joblib` stores:

- The trained model.
- The selected feature schema.
- The full feature schema.
- Training medians for imputation.

The FastAPI backend loads this artifact to perform predictions.

---

## 5. Demo Script for Presentation

### Step 1: Explain the system diagram

Say:

> The ESP32 streams ECG, PPG, and IMU samples to FastAPI. FastAPI buffers the data into 8-second windows, extracts features, predicts SBP and DBP, stores results in Supabase, and broadcasts the prediction to the dashboard.

### Step 2: Show the API health endpoint

Open:

```text
http://127.0.0.1:8000/health
```

Expected:

```json
{
  "ok": true,
  "n_features": 16,
  "supabase": true
}
```

The number of features depends on the model artifact.

### Step 3: Show the dashboard

Explain:

> The dashboard displays the latest predicted SBP and DBP values and a table of recent telemetry windows. If Supabase is configured, historical readings are saved per user.

### Step 4: Show ESP32 streaming or replay script

If hardware is working, stream from ESP32. If not, run replay:

```bash
python scripts/replay_physionet_over_ws.py \
  --dataset-root data/pulse-transit-time-ppg \
  --record s1_walk \
  --ws-url ws://127.0.0.1:8000/ws/ingest
```

Say:

> The replay script is useful because it tests the same backend buffering and prediction path without depending on live sensor contact.

---

## 6. If Something Fails During the Demo

### If the ESP32 does not connect

Say:

> The ESP32 and laptop must be on the same network, and the firmware must use the laptop’s LAN IP, not localhost. I also prepared a PhysioNet replay script to demonstrate the backend pipeline independently of WiFi or hardware issues.

### If predictions look unrealistic

Say:

> This is a research prototype. Absolute BP estimates can be affected by domain shift, lack of calibration, poor PPG contact, and motion artifacts. The important demonstration is that the full acquisition-to-inference pipeline works and that the model methodology is reproducible.

### If Supabase rows do not appear

Say:

> Supabase insertion requires the backend service-role key and a valid user_id. The prediction itself can still work without database persistence.

### If `/health` fails

Say:

> The backend requires a valid `BP_MODEL_PATH`. If the trained artifact is unavailable, I can generate a demo artifact using `scripts/build_demo_model.py`, but that is only for pipeline testing, not clinical evaluation.

---

## 7. Weaknesses to Admit Honestly

Do not hide these. Examiners usually appreciate honest engineering judgment.

| Weakness | Best explanation |
|----------|------------------|
| Not clinically validated | It is a proof-of-concept prototype, not a certified device. |
| Dataset mismatch | PhysioNet hardware differs from ESP32 hardware; retraining on device data is needed. |
| No subject calibration | Personal calibration would reduce systematic offset. |
| Motion artifacts | Current masking is simple; adaptive filtering is future work. |
| SBP error still high | SBP is harder and more variable than DBP. |
| PPG effective rate is 50 Hz | MAX30100 limits optical sampling; firmware aligns it to 250 Hz by holding values. |
| Random split can leak subject info | Use subject-grouped split for more realistic reporting. |

---

## 8. Strong Closing Statement

If asked to conclude, say:

> The main contribution of this project is not only the regression model, but the complete methodology and working prototype. I implemented the full chain from biomedical signal acquisition to preprocessing, feature extraction, machine-learning prediction, API deployment, database storage, and dashboard visualization. The results show that the approach is technically feasible, while also revealing the key limitations that must be addressed before clinical use: better labeled hardware data, subject calibration, stronger motion removal, and formal validation.

---

## 9. One-Line Answers for Fast Questions

| Question | One-line answer |
|----------|-----------------|
| What are SBP and DBP? | SBP is peak pressure during contraction; DBP is minimum pressure during relaxation. |
| What is PPG? | Optical measurement of blood volume changes. |
| What is ECG? | Electrical activity of the heart. |
| What is PTT? | Time delay between ECG R-peak and PPG pulse arrival. |
| What is HRV? | Variation in time between consecutive heartbeats. |
| What model did you use? | Multi-output stacked regression using Random Forest, Extra Trees, and Ridge. |
| Why FastAPI? | It supports Python ML, REST, WebSockets, and validation. |
| Why Supabase? | It provides PostgreSQL, Auth, RLS, and realtime-friendly storage. |
| Is it medical-grade? | No, it is a proof-of-concept prototype. |
| Biggest future improvement? | Collect labeled ESP32 data and add subject calibration. |

---

## 10. Final Advice for Viva

Focus on these three messages:

1. **You understand the physiology:** PTT, HRV, PPG morphology, motion artifacts.
2. **You understand the engineering:** ESP32 streaming, FastAPI buffering, model artifacts, schema matching, Supabase storage.
3. **You understand the limitations:** not clinical, needs calibration, dataset mismatch, motion sensitivity.

Do not overclaim. Present the project as a complete, honest, well-engineered prototype.

