# Cuffless Blood Pressure Estimation

## Methodology and Technical Documentation

**Project title (working):** Cuffless Blood Pressure Estimation from Multimodal Wearable Signals  
**Repository:** `finalproj_ml`  
**Document version:** 1.4  
**Last updated:** May 2026  
**Document purpose:** Final-year project methodology, implementation reference, and technical appendix  

---

## Contents

This document is organized in two parts. Sections 1-4 are written in a report style and can be adapted directly into the final-year project write-up. Sections 5-23 provide implementation evidence, operating procedures, limitations, and troubleshooting. The appendices provide feature, API, CLI, file, and glossary references.

1. [Executive summary](#1-executive-summary)
2. [Problem statement and motivation](#2-problem-statement-and-motivation)
3. [Project objectives](#3-project-objectives)
4. [Project methodology and scientific background](#4-project-methodology-and-scientific-background)
   - [4.1 Methodological overview](#41-methodological-overview)
   - [4.2 Research design](#42-research-design)
   - [4.3 System development methodology](#43-system-development-methodology)
   - [4.4 Data methodology](#44-data-methodology)
   - [4.5 Signal-processing methodology](#45-signal-processing-methodology)
   - [4.6 Model development methodology](#46-model-development-methodology)
   - [4.7 Inference and deployment methodology](#47-inference-and-deployment-methodology)
   - [4.8 Firmware and hardware methodology](#48-firmware-and-hardware-methodology)
   - [4.9 Testing, validation, and evaluation methodology](#49-testing-validation-and-evaluation-methodology)
   - [4.10 Reproducibility and experimental control](#410-reproducibility-and-experimental-control)
   - [4.11 Pulse transit time](#411-pulse-transit-time-ptt)
   - [4.12 Heart rate variability](#412-heart-rate-variability-hrv)
   - [4.13 Motion artifacts](#413-motion-artifacts)
   - [4.14 Machine learning approach](#414-machine-learning-approach)
   - [4.15 How the regression model works](#415-how-the-regression-model-works-training-and-inference)
5. [System architecture](#5-system-architecture)
6. [Repository structure](#6-repository-structure)
7. [Technology stack](#7-technology-stack)
8. [Datasets](#8-datasets)
9. [Machine learning pipeline](#9-machine-learning-pipeline)
10. [Model training](#10-model-training)
11. [Inference and API service](#11-inference-and-api-service)
12. [Real-time ingestion (WebSockets)](#12-real-time-ingestion-websockets)
13. [ESP32 firmware integration](#13-esp32-firmware-integration)
14. [Database (Supabase)](#14-database-supabase)
15. [Dashboards](#15-dashboards)
16. [Environment configuration](#16-environment-configuration)
17. [Installation and setup](#17-installation-and-setup)
18. [Running the full system](#18-running-the-full-system)
19. [Evaluation metrics and reported results](#19-evaluation-metrics-and-reported-results)
20. [Security and privacy](#20-security-and-privacy)
21. [Known limitations and risks](#21-known-limitations-and-risks)
22. [Future work](#22-future-work)
23. [Troubleshooting](#23-troubleshooting)
24. [Appendix A — Feature reference](#appendix-a--feature-reference)
25. [Appendix B — API reference](#appendix-b--api-reference)
26. [Appendix C — CLI reference](#appendix-c--cli-reference)
27. [Appendix D — File-by-file reference](#appendix-d--file-by-file-reference)
28. [Appendix E — Glossary](#appendix-e--glossary)

---

## 1. Executive summary

This final-year project implements an **end-to-end cuffless blood pressure (BP) estimation system**. The system:

1. Acquires **ECG**, **PPG** (photoplethysmography), and **inertial** (accelerometer/gyroscope) signals from a wearable device (ESP32-based prototype) or from public research datasets.
2. **Preprocesses** signals (filtering, motion masking, peak detection).
3. **Extracts physiological features**, including pulse transit time (PTT) proxies, heart rate variability (HRV), and motion statistics.
4. **Trains** a multi-output regression model to predict **systolic blood pressure (SBP)** and **diastolic blood pressure (DBP)** in mmHg.
5. **Serves** predictions through a **FastAPI** backend with REST and WebSocket endpoints.
6. **Persists** telemetry and predictions to **Supabase** (PostgreSQL with Row Level Security).
7. **Visualizes** live and historical predictions through **Dash** and **Next.js** dashboards.

The MVP uses ensemble tree models (Random Forest + Extra Trees + Ridge stacking) rather than deep learning, prioritizing interpretability, fast inference on edge hardware, and reproducible feature engineering aligned with cardiovascular physiology literature.

---

## 2. Problem statement and motivation

### 2.1 Clinical context

Hypertension affects a large fraction of the global population and is a major risk factor for stroke, heart failure, and kidney disease. Continuous or frequent BP monitoring improves treatment adherence and early detection of hypertensive crises. Traditional **cuff-based** monitors (auscultatory or oscillometric) are accurate but:

- Cause discomfort and sleep disruption when used frequently.
- Cannot provide beat-to-beat or continuous trends without repeated inflations.
- Are impractical for 24/7 ambulatory monitoring in many settings.

**Cuffless BP estimation** aims to infer SBP and DBP from optical, electrical, or mechanical biosignals already present in wearables (smartwatches, chest patches, ear-worn sensors).

### 2.2 Technical challenge

Mapping biosignals to absolute BP (mmHg) is **ill-posed** without individual calibration:

- Arterial stiffness, vessel length, and peripheral resistance vary between subjects.
- Sensor placement, skin tone, motion, and temperature affect PPG morphology.
- Pulse transit time (PTT) relates to pulse wave velocity (PWV), which correlates with BP via the **Moens–Korteweg** relationship—but requires knowing arterial path length \(L\):  
  \[
  PWV = \sqrt{\frac{Eh}{2\rho r}} \quad,\quad PTT \approx \frac{L}{PWV}
  \]
  Without \(L\), only **PTT proxies** are available.

This project addresses the challenge with a **pragmatic MVP pipeline**: robust feature extraction, public dataset training, and a deployable inference stack suitable for demonstration and further research.

### 2.3 Scope of this repository

| In scope | Out of scope (current MVP) |
|----------|---------------------------|
| ECG + PPG + IMU feature pipeline | FDA/clinical validation |
| PTT / HRV / PPG statistical features | Personalized per-user calibration UI |
| Random Forest stacking regressor | End-to-end deep learning (CNN/LSTM) |
| FastAPI + WebSocket ingestion | Production mobile app |
| Supabase persistence + RLS | NLMS adaptive motion cancellation |
| Dash + Next.js dashboards | Full regulatory documentation |

---

## 3. Project objectives

### 3.1 Primary objectives

1. **Design** a reproducible signal-processing and feature-extraction pipeline from raw ECG/PPG/accelerometer windows.
2. **Train** a multi-output regression model predicting SBP and DBP from extracted features.
3. **Deploy** a REST/WebSocket API for real-time inference from ESP32 or simulated streams.
4. **Store** predictions and metadata in a cloud database with per-user access control.
5. **Present** results through interactive dashboards for live demo and historical review.

### 3.2 Success criteria (engineering targets)

| Metric | Target (MVP) | Notes |
|--------|--------------|-------|
| MAE (DBP) | < 5 mmHg | AHA general acceptance often cited ~5 mmHg for DBP |
| MAE (SBP) | < 10 mmHg | SBP is typically harder; project reported ~10–12 mmHg on PhysioNet split |
| Inference latency | < 500 ms per 8 s window | Dominated by feature extraction + small forest predict |
| End-to-end demo | ESP32 → API → DB → dashboard | Requires aligned `user_id` and env configuration |

---

## 4. Project methodology and scientific background

This chapter is written as the **methodology chapter** of the project. It explains not only what was built, but **how the work was carried out**, why each technical decision was made, what data and experimental controls were used, and how the final system was validated. The methodology follows an applied engineering research approach: a real-world healthcare monitoring problem was identified, a prototype system was designed, public and device-generated data pathways were prepared, machine-learning models were trained and evaluated, and the resulting model was integrated into a live hardware-software demonstration.

The project methodology combines four disciplines:

1. **Biomedical signal processing**, because ECG and PPG must be filtered, aligned, and converted into physiological timing features before they can be used for blood-pressure prediction.
2. **Supervised machine learning**, because SBP and DBP are learned from labeled examples rather than derived from a closed-form equation.
3. **Embedded systems development**, because the ESP32 firmware must sample real sensors at stable rates and stream data reliably over WiFi.
4. **Full-stack software engineering**, because inference, persistence, and visualization require a backend API, database, and dashboard.

The methodology is therefore not a single linear activity. It is an **iterative pipeline**: signal acquisition informs feature design; feature reliability informs model choice; model schema informs API validation; API behavior informs firmware packet design; and dashboard results reveal whether end-to-end timing and persistence work in practice.

### 4.1 Methodological overview

The project was implemented using a **prototype-based experimental methodology**. Instead of attempting to design a clinically validated system in one step, the work was divided into smaller build-and-test cycles. First, a working machine-learning pipeline was built using public data. Next, the trained model was exported as a reusable artifact. Then an API was created to load that artifact and perform inference. After that, an ESP32 streaming path was added so that live data could exercise the same inference code. Finally, Supabase and dashboards were added to make the system demonstrable and auditable.

At a high level, the method can be summarized as:

```text
Literature / physiology basis
        ↓
Dataset selection and preparation
        ↓
Signal preprocessing and feature engineering
        ↓
Model training and evaluation
        ↓
Model artifact export
        ↓
API inference integration
        ↓
ESP32 firmware streaming
        ↓
Database storage and dashboard visualization
        ↓
End-to-end validation and limitation analysis
```

This approach is suitable for a final-year engineering project because it demonstrates the complete journey from theory to implementation. The project does not stop at an offline notebook score; it shows how the model can be served, how live sensor packets are handled, how predictions are stored, and how a user can observe results in real time.

The methodology also separates **research evaluation** from **system demonstration**. Research evaluation uses labeled datasets and MAE/RMSE metrics to judge model performance. System demonstration uses the ESP32, WebSockets, Supabase, and dashboards to show that the trained pipeline can operate as a complete monitoring prototype. These are related but different: a demo model can prove integration, while a trained model with proper held-out validation proves predictive performance.

### 4.2 Research design

The research design is **quantitative, experimental, and implementation-oriented**. It is quantitative because the main output is numerical blood pressure prediction in mmHg, and model quality is measured with numerical error metrics. It is experimental because alternative design choices such as window size, feature selection, train/test split strategy, and model architecture can be changed and evaluated. It is implementation-oriented because the final deliverable is a working hardware/software prototype rather than only a theoretical analysis.

The main research question can be stated as:

> Can ECG, PPG, and motion-derived features be used to estimate systolic and diastolic blood pressure in an end-to-end cuffless monitoring prototype?

From this main question, the project uses the following methodological sub-questions:

- Which signal features can be extracted reliably from ECG, PPG, accelerometer, and gyroscope data?
- Can PTT-related and HRV-related features provide useful predictive information for SBP and DBP?
- How accurately can an interpretable ensemble regression model estimate BP on held-out windows?
- Can the trained model be deployed behind an API and used with real-time ESP32 sensor streams?
- What technical limitations appear when moving from public datasets to live low-cost hardware?

The project does not claim clinical-grade validation. Instead, it treats the prototype as a **proof-of-concept research system**. This matters because cuffless BP estimation normally requires extensive subject-specific calibration, clinical protocols, and regulatory evaluation. The project deliberately focuses on an MVP that is technically complete and scientifically explainable.

### 4.3 System development methodology

The system was developed using a **modular incremental methodology**. Each module was designed to have a clear responsibility and a testable interface:

- `bp_pipeline` handles data loading, preprocessing, feature extraction, feature selection, training, and artifact export.
- `bp_api` loads the exported model and exposes inference through REST and WebSocket endpoints.
- `firmware/esp32_bp_stream` samples hardware sensors and streams one JSON packet per sample.
- `supabase` stores authenticated telemetry windows, predictions, and optional raw waveforms.
- `dashboard` and `bp_dashboard` present live or uploaded data to the user.

The modular approach was chosen because biomedical systems are difficult to debug if acquisition, filtering, model inference, and visualization are mixed together. For example, if a prediction is wrong, the developer can inspect whether the issue is due to missing PPG peaks, wrong feature order, model mismatch, WebSocket buffering, or database permissions. Each layer can be tested independently before testing the full pipeline.

The development process followed this sequence:

1. **Core ML prototype:** Define features, train a regression model, and save artifacts.
2. **API integration:** Load `model.joblib`, validate feature vectors, and expose `/predict`.
3. **Streaming integration:** Add WebSocket buffers so raw signals can be converted into windows.
4. **Hardware integration:** Refactor ESP32 firmware to stream API-compatible JSON at stable timing.
5. **Persistence:** Insert prediction windows into Supabase with user-level RLS.
6. **Visualization:** Display latest predictions and history in the dashboard.
7. **Documentation and evaluation:** Record assumptions, metrics, limitations, and reproducibility steps.

The project therefore follows a **vertical-slice** strategy: each stage adds a working slice through the full system. This is preferable to building all ML first and all firmware later, because streaming and sampling constraints directly affect feature reliability.

### 4.4 Data methodology

The data methodology has two complementary data sources. The first is the public PhysioNet pulse-transit-time-ppg dataset, used for model training and evaluation. The second is the ESP32 live acquisition pathway, used to demonstrate how the system would operate with wearable sensors. The project treats these sources differently because they have different strengths and weaknesses.

The PhysioNet dataset provides structured recordings with ECG, multi-channel PPG, IMU signals, load-cell signals, and reference BP metadata. It is suitable for supervised model development because labels are available and the recording format is reproducible. However, it was collected using research-grade equipment and multiple PPG sites, so its feature distribution may not match the low-cost ESP32 prototype.

The ESP32 data path provides realistic device behavior, including sensor noise, WiFi timing issues, finger-contact variation, and MAX30100 sampling limitations. It is essential for demonstrating feasibility, but it does not automatically provide ground-truth BP labels unless the user collects simultaneous cuff readings. Therefore, ESP32 streaming is used primarily for system integration unless a labeled custom dataset is collected.

The data-processing methodology is:

1. **Identify recording unit:** One supervised sample corresponds to one fixed-length window, usually 8 seconds.
2. **Assign labels:** For PhysioNet, each window inherits the mean of start and end SBP/DBP values for its recording. For custom CSV, each row contains its own `sbp` and `dbp`.
3. **Extract features:** Convert raw arrays into scalar values such as PTT, RR interval, PPG statistics, and motion RMS.
4. **Handle missing values:** Replace NaN/Inf values using feature medians learned during training.
5. **Preserve schema:** Store selected feature names in `feature_schema.json` so inference uses the same order.
6. **Evaluate split strategy:** Prefer subject-grouped splitting when reporting realistic performance.

A key methodological concern is **data leakage**. If windows from the same subject and same activity are split randomly, the model may be evaluated on data that is extremely similar to its training examples. This makes results look better than real deployment performance. The repository includes `--group-by-subject` to reduce this risk by assigning entire subjects to either train or test.

### 4.5 Signal-processing methodology

The signal-processing method is designed to convert raw biomedical waveforms into robust and interpretable features. ECG and PPG are not directly comparable in amplitude because they measure different physical phenomena. ECG measures electrical depolarization of the heart, while PPG measures optical changes caused by blood volume. Therefore, the methodology emphasizes **timing**, especially delays between ECG R-peaks and PPG pulse peaks.

The ECG signal is bandpass-filtered between 0.5 Hz and 40 Hz. The lower cutoff reduces slow baseline wander caused by movement, breathing, or electrode drift. The upper cutoff keeps the main QRS energy while reducing high-frequency noise. Zero-phase filtering (`filtfilt`) is used so that peak locations are not shifted by the filter. This is methodologically important because PTT depends on accurate timing.

The PPG signal is bandpass-filtered in a lower range because PPG pulse waves vary more slowly than ECG. The generic path uses 0.5–8 Hz, while the PhysioNet path applies DC removal and a 0.75–5 Hz band. This suppresses slow optical baseline drift and high-frequency noise from the sensor and environment.

Motion artifact handling is performed using an accelerometer-based mask. The magnitude of acceleration is computed for each sample, and samples above the 80th percentile are treated as higher-motion samples. The method is intentionally simple: it does not reconstruct the corrupted signal; it reduces the influence of high-motion intervals on PPG statistics. This is a practical MVP compromise because adaptive filtering would require more tuning and validation.

Peak detection follows two approaches depending on data source. In the generic live pipeline, ECG R-peaks are detected using NeuroKit2, and PPG peaks are detected using SciPy `find_peaks`. In the PhysioNet training path, R-peak annotations are already available, so the project uses those annotations instead of re-detecting them. This improves training feature reliability.

The final signal-processing output is not a waveform but a feature vector. Each element has physiological meaning: PTT features describe pulse timing, RR features describe cardiac rhythm, PPG features describe pulse morphology, and IMU features describe motion context.

### 4.6 Model development methodology

The model development methodology uses supervised regression. The input is a fixed-length feature vector, and the output is a two-dimensional target: predicted SBP and predicted DBP. This is implemented with `MultiOutputRegressor`, which trains one regression pipeline for SBP and one for DBP.

The model was designed around tabular, hand-engineered features rather than raw waveform deep learning. This choice was made for several reasons. First, the available labeled dataset is not large enough to justify a high-capacity neural model. Second, feature-based models are easier to explain in a final-year project because each input can be related to physiology. Third, tree ensembles perform well on nonlinear tabular data and require less preprocessing than linear-only models.

Training proceeds in stages. After feature extraction, missing values are imputed using per-feature medians. A Random Forest is then trained to estimate SBP from all available features and rank feature importances. The most important features are selected as the model schema. A stacked ensemble is then trained on those selected features. The stack combines Random Forest, Extra Trees, and Ridge regression, then uses a Ridge meta-learner to combine their outputs.

The reason for stacking is methodological robustness. Random Forest handles nonlinear relationships, Extra Trees adds more randomized decision boundaries and can reduce variance, while Ridge provides a stable linear baseline. The meta-model learns how much to trust each learner for each target. This is especially helpful when physiological relationships are not purely linear but the dataset is not large enough for deep learning.

The trained model is exported with both the estimator and the feature schema. This is essential because a machine-learning model is not only its weights or trees; it is also the exact meaning and order of its inputs. The API validates this schema before prediction.

### 4.7 Inference and deployment methodology

The inference methodology has two forms: **offline feature inference** and **online raw-signal inference**. Offline feature inference is used when a client already has a feature vector and calls `POST /predict`. Online raw-signal inference is used by WebSocket streams, where the server receives ECG/PPG/IMU samples and performs feature extraction internally.

For online inference, the API maintains a buffer per `device_id`. Incoming samples are appended until the buffer reaches `window_s × fs_hz` samples. With the default 8-second window and 250 Hz rate, this means 2000 ECG samples and 2000 PPG samples. The server then extracts one full window, computes features, imputes invalid values, runs `model.predict`, stores optional telemetry, broadcasts the result, and removes the consumed samples from the buffer.

This is a **tumbling-window** method, not an overlapping sliding-window method. A new prediction is produced after each complete 8-second block. This simplifies implementation and avoids repeated predictions from nearly identical data, but it means the dashboard updates every 8 seconds instead of every second. Future work could use overlapping windows, for example an 8-second window with a 1-second hop, to improve display smoothness.

Deployment uses FastAPI because it supports both REST and WebSocket endpoints in one application. REST is appropriate for dashboard CSV uploads and batch feature vectors. WebSockets are appropriate for live hardware streams because they keep a connection open and avoid the overhead of repeatedly creating HTTP requests.

### 4.8 Firmware and hardware methodology

The firmware methodology focuses on reliable sampling rather than local intelligence. The ESP32 reads ECG from an analog pin, PPG from the MAX30100 over I2C, and motion data from the MPU6050. The firmware packages these readings into flat JSON objects and sends them to the server over WebSocket.

The initial firmware problem was that low-rate Serial printing and sensor polling caused timing failures. The corrected methodology separates the PPG FIFO service from the main loop using a FreeRTOS task. The PPG drain task runs frequently enough to prevent FIFO overflow. The main loop then handles ECG sampling, periodic IMU sampling, WebSocket service, and JSON transmission at a target rate of 250 Hz.

This division is important because the MAX30100 internally samples PPG at 50 Hz, while the ECG path targets 250 Hz. The firmware holds the latest filtered PPG value between new MAX30100 samples so that the server receives arrays of equal length. This is an engineering compromise: it simplifies server buffering, but it means the effective PPG resolution is still 50 Hz. The methodology acknowledges this limitation rather than treating the stream as true 250 Hz optical sampling.

The firmware also externalizes configuration into `config.h`: WiFi credentials, API host, port, device ID, sampling rate, window size, and optional user/session IDs. This allows deployment parameters to change without modifying the main sketch and helps keep secrets out of documentation and version control.

### 4.9 Testing, validation, and evaluation methodology

Testing is performed at three levels: component testing, integration testing, and model evaluation.

**Component testing** checks individual modules. For example, `preprocess.py` can be tested with synthetic signals to ensure filters return finite arrays. `features.py` can be checked with known ECG/PPG-like signals to verify that PTT and RR features are produced. `bp_api/main.py` can be checked with `/health` and `/predict` using a known artifact.

**Integration testing** checks that modules work together. The replay script streams PhysioNet records over `/ws/ingest`, allowing the API, buffer, feature extractor, model, Supabase insert, and dashboard broadcast to be tested without hardware. The ESP32 test then confirms that actual sensor packets match the same schema and timing assumptions.

**Model evaluation** uses held-out test data and reports MAE and RMSE separately for SBP and DBP. MAE is the most interpretable metric because it directly states the average absolute mmHg error. RMSE is also reported because it penalizes occasional large errors more strongly. Results should be reported with the exact split method, number of train/test windows, number of features, and whether the split was random or subject-grouped.

The validation methodology also includes qualitative checks. During live demonstrations, the dashboard should show plausible values, update at the expected interval, and store rows under the correct user. Serial debug output should show low PPG FIFO overflow counts. If live readings look unstable, the methodology requires diagnosing sensor contact and feature validity before blaming the regression model.

### 4.10 Reproducibility and experimental control

Reproducibility is controlled through code, artifacts, schemas, and command-line arguments. The training script accepts `--random-state`, which fixes stochastic elements such as train/test split and tree construction. The feature schema is saved separately in `feature_schema.json`, allowing the exact model input order to be inspected later. Metrics are saved to `metrics.json` so reported results can be traced back to a particular run.

The repository also separates generated artifacts from source code. Large model files and data directories are ignored by Git, while scripts and schemas are committed. This keeps the project portable while still allowing another developer to reproduce results by downloading the same dataset and running the same training command.

For a formal report, each experiment should record:

- Dataset path and version.
- Feature path used (`--physionet-ptt-dir` or `--data`).
- Window length.
- Top-k feature count.
- Random seed.
- Split method.
- Number of train and test windows.
- Selected feature names.
- MAE and RMSE for SBP and DBP.
- Whether the artifact was used for offline evaluation, live demo, or both.

The most important reproducibility rule is: **the deployed API must use the same feature schema as the trained model**. Many apparent inference failures are actually schema mismatches.

### 4.11 Pulse transit time (PTT)

**PTT** is the delay between a proximal arterial event (e.g., ECG R-peak representing ventricular depolarization) and a distal pulse arrival (e.g., PPG foot or systolic peak). Shorter PTT generally indicates faster pulse wave velocity and higher arterial pressure, though the relationship is subject-specific.

**Implementation in this project (generic path — `bp_pipeline/features.py`):**

- Detect R-peaks with **NeuroKit2** `ecg_process`.
- Detect PPG systolic peaks with `scipy.signal.find_peaks`.
- For each R-peak time \(t_R\), find the **first PPG peak strictly after** \(t_R\).
- PTT = \(t_{PPG} - t_R\) in seconds; keep only values in **0.03–0.6 s** (plausible physiological range).
- Compute `ptt_mean_s`, `ptt_std_s`, and `pwv_proxy = 1 / ptt_mean`.

**Implementation (PhysioNet path — `bp_pipeline/physionet_ptt_ppg.py`):**

- Uses **pre-annotated R-peaks** from dataset `peaks` column or WFDB `.atr` annotations.
- Computes **cross-correlation lag** between distal (`pleth_2`) and proximal (`pleth_5`) PPG channels as `ptt_xcorr_s` (max lag ±50 ms).

### 4.12 Heart rate variability (HRV)

From consecutive R-R intervals (in seconds):

- **Mean RR** (`rr_mean_s`), **std RR** (`rr_std_s`)
- **RMSSD** (`hrv_rmssd_s`): \(\sqrt{\mathrm{mean}((\Delta RR)^2)}\)

### 4.13 Motion artifacts

Wrist and finger PPG are corrupted by acceleration. The MVP applies:

- **Percentile-based motion mask**: keep samples where accelerometer magnitude is below the 80th percentile (`motion_mask` in `preprocess.py`).
- Mask applied to **PPG** for statistics; ECG is filtered but not masked in the generic extractor.

**Not implemented:** Normalized Least Mean Squares (NLMS) adaptive filtering referenced in literature for motion removal.

### 4.14 Machine learning approach

- **Multi-output regression**: single model predicts \([SBP, DBP]\).
- **Feature selection**: Random Forest importance on SBP, keep top-\(k\) features.
- **Final estimator**: `MultiOutputRegressor(StackingRegressor([RF, ExtraTrees, Ridge]))` — see [Section 10](#10-model-training).

### 4.15 How the regression model works (training and inference)

This project does **not** feed raw ECG/PPG waveforms directly into the neural-network-style end-to-end model. Instead it uses a **two-stage** design that mirrors classical cuffless-BP literature:

```text
Raw window (ECG, PPG, IMU)  →  Hand-crafted features (PTT, HRV, stats)  →  Tree ensemble  →  SBP, DBP (mmHg)
```

#### 4.15.1 What the model learns

The training labels are **scalar SBP and DBP** (mmHg) per window — from PhysioNet CSV metadata (mean of start/end BP) or from your own labeled CSV. The model learns a mapping:

\[
f: \mathbb{R}^{k} \rightarrow \mathbb{R}^{2}, \quad \mathbf{x} \mapsto (\widehat{SBP}, \widehat{DBP})
\]

where \(\mathbf{x}\) is the **top-\(k\) selected feature vector** (typically \(k \approx 10\)–20), not the 2000+ raw samples in an 8 s window.

**Interpretation:** Features like `ptt_mean_s`, `inv_ptt`, and `hrv_rmssd_s` encode timing and morphology proxies that correlate with vascular state; tree models capture **nonlinear interactions** (e.g. PTT combined with HR) without requiring a differentiable signal front-end.

#### 4.15.2 Training pipeline (offline)

| Step | Code | What happens |
|------|------|----------------|
| 1 | `load_physionet_ptt_features` or `load_csv_features` | Build matrix \(X \in \mathbb{R}^{n \times F}\), \(y \in \mathbb{R}^{n \times 2}\) |
| 2 | `_nan_impute` | Replace NaN per column with training median |
| 3 | `select_top_k_features` | Fit RF on **SBP only**; rank importances; keep top-\(k\) names |
| 4 | `slice_schema` | Reduce \(X\) to \(k\) columns in fixed order |
| 5 | `train_test_split` or `GroupShuffleSplit` | Hold-out evaluation (subject-grouped recommended) |
| 6 | `MultiOutputRegressor(StackingRegressor(...))` | Fit ensemble; save `model.joblib` |

**StackingRegressor internals (per output — SBP and DBP each get a copy via `MultiOutputRegressor`):**

1. **Base learners** (level 0): Random Forest (400 trees), Extra Trees (600 trees), Ridge (\(\alpha=2\)).
2. **Meta learner** (level 1): Ridge (\(\alpha=1\)) on concatenated base predictions + optional passthrough of original features (`passthrough=True`).
3. **Prediction:** Each base model outputs a scalar; meta Ridge combines them into one SBP (or DBP) value.

**Why trees instead of deep learning (MVP rationale):**

- Small-to-medium tabular feature sets (\(k \ll n\) often not true, but \(k\) is small).
- Fast CPU inference (< 50 ms) suitable for Raspberry Pi / server.
- Feature importances support thesis discussion and debugging.
- Works with **limited labeled windows** without GPU training.

#### 4.15.3 Inference pipeline (online, via WebSocket or REST)

| Step | Module | Detail |
|------|--------|--------|
| 1 | Buffer | Accumulate `win_n = round(window_s × fs_hz)` aligned samples |
| 2 | `extract_features_from_signals` | Bandpass → motion mask → peaks → 16-D (or schema subset) |
| 3 | Schema align | Keep only names in `feature_schema.json` (order matters) |
| 4 | `_impute_non_finite` | Replace NaN/Inf with training medians from `model.joblib` |
| 5 | `model.predict([x])` | Returns `[sbp, dbp]` |
| 6 | Optional | Insert row to Supabase; broadcast to `/ws/dashboard` |

**Inference contract:** `/predict` expects the **already extracted** feature vector. WebSocket paths call extraction **inside** `_process_buffered_windows` before prediction.

**Uncertainty proxy:** `/predict` can return `sbp_std` / `dbp_std` by measuring spread across individual trees in the ensemble — this is a **heuristic**, not a calibrated Bayesian interval.

#### 4.15.4 Failure modes that produce bad BP estimates

| Symptom | Typical cause |
|---------|----------------|
| NaN features after imputation | Too few R-peaks or PPG peaks in window (poor contact, motion) |
| Flat PPG line | MAX30100 FIFO overflow or finger not on sensor (see [Section 13](#13-esp32-firmware-integration)) |
| Systematic offset | Train distribution (PhysioNet) ≠ your hardware population; no per-user calibration |
| Jittery predictions | Short windows or inconsistent `fs_hz` |

---

## 5. System architecture

This section explains **how the system is structured**, not only which boxes connect to which. The design follows a classic **three-tier sensing → compute → presentation** pattern, with a deliberate split between **offline learning** (batch training on public data) and **online inference** (streaming windows from hardware). That split is important for the report methodology: the model never sees raw waveforms at prediction time in the REST API, but the WebSocket paths *do* run the full digital signal-processing chain on the server. This keeps firmware simple and allows algorithms to improve without reflashing the ESP32.

### 5.1 Architectural principles

**Separation of concerns.** Firmware is responsible only for time-aligned sampling and JSON transport. The Python `bp_pipeline` package owns all physiology-aware processing (filters, peaks, PTT). The FastAPI layer owns buffering, session state, and I/O to Supabase. Dashboards are read-only consumers of predictions (plus optional Supabase Realtime). This means you can unit-test feature extraction without hardware, and you can swap the model file without changing the frontend.

**Single inference core.** Whether data arrives as PhysioNet replay chunks (`/ws/ingest`), ESP32 samples (`/ws/esp32`), or precomputed CSV features (`POST /predict`), the *live* path always converges on `_process_buffered_windows()` once a full window exists. That function calls `extract_features_from_signals`, imputes missing values, and invokes the same `model.joblib`. Avoiding duplicate inference logic reduces the risk of training-time and deployment-time feature definitions drifting apart.

**Stateful streaming vs stateless REST.** REST `/predict` is stateless: the client must supply a finished feature vector. WebSockets are stateful: the server maintains `_buffers[device_id]` across hundreds of frames. The buffer is an in-memory Python list, so restarting uvicorn clears all partial windows—acceptable for demos, but production would need Redis or disk spillover for multi-instance APIs.

**Security boundary.** The browser never receives the Supabase **service role** key. Only the backend uses it to insert rows on behalf of a `user_id` supplied in the WebSocket query string. Row Level Security ensures each logged-in dashboard user reads only their own `telemetry_windows`. (A production system should bind `user_id` to a verified JWT instead of trusting the query param—see Section 20.)

### 5.2 High-level data flow

```text
┌─────────────────┐     WebSocket/REST      ┌──────────────────┐
│  ESP32 device   │ ───────────────────────►│  FastAPI (bp_api) │
│  ECG, PPG, IMU  │   /ws/esp32, /ws/ingest │  Feature extract  │
└─────────────────┘                         │  Model predict    │
        │                                   └────────┬─────────┘
        │                                            │
        │ replay script                              │ PostgREST
        ▼                                            ▼
┌─────────────────┐                         ┌──────────────────┐
│ PhysioNet WFDB  │                         │ Supabase Postgres │
│ (offline train) │                         │ telemetry_windows │
└─────────────────┘                         └────────┬─────────┘
        │                                            │
        │ train.py                                   │ Realtime + SELECT
        ▼                                            ▼
┌─────────────────┐                         ┌──────────────────┐
│ artifacts/      │                         │ Next.js dashboard │
│ model.joblib    │◄── BP_MODEL_PATH ───────│ Dash dashboard    │
└─────────────────┘                         └──────────────────┘
```

### 5.3 Logical layers (detailed)

| Layer | Location | Responsibility | Runs when |
|-------|----------|----------------|-----------|
| **Acquisition** | ESP32 / PhysioNet files | Produce synchronized samples | Continuous (device) or offline (files) |
| **Transport** | WebSocket, HTTP | Move samples or features across network | Demo / deployment |
| **Buffer & sync** | `bp_api/main.py` | Accumulate `win_n` samples; align ECG/PPG lengths | Each incoming frame |
| **Signal processing** | `bp_pipeline/preprocess.py` | Filters, masks, peak detection | Each full window |
| **Feature engineering** | `bp_pipeline/features.py` | Scalar physiology proxies | Each full window |
| **Inference** | `model.joblib` | Map \(\mathbb{R}^k \rightarrow \mathbb{R}^2\) | Each full window |
| **Persistence** | Supabase PostgREST | Store features + predictions + optional raw | If `user_id` + keys set |
| **Presentation** | Next.js / Dash | Charts, tables, alerts | User browser |

Between **feature engineering** and **inference**, the system applies **schema alignment**: the model was trained on a *subset* of features (top‑k after importance ranking). The artifact stores those names in order. If you train on PhysioNet’s `ptt_xcorr_s` but deploy with the generic extractor’s `ptt_mean_s`, predictions will be meaningless even if the API returns HTTP 200. Your thesis should state clearly which path trained the deployed artifact.

Between **inference** and **persistence**, the API optionally attaches **raw waveforms** (`persist_raw=1`). That can exceed Postgres row size for long windows at 250 Hz; use only for debugging.

### 5.4 Processing stages (per inference window)

Each full window triggers the same core function: `_process_buffered_windows()` in `bp_api/main.py`. Both `/ws/ingest` and `/ws/esp32` converge on this path after buffering.

**Narrative walkthrough.** Imagine the ESP32 has just sent its 2000th sample at 250 Hz. The WebSocket handler appends the sample to `buf.ecg` and `buf.ppg`, then notices `len(ecg) >= win_n`. Control enters `_process_buffered_windows`, which slices exactly the first 2000 points from each list—no overlap yet, a **tumbling window** (not sliding with hop). Those arrays are copied to NumPy and passed into `extract_features_from_signals`. Inside that function, ECG is bandpass-filtered to emphasize the QRS band; PPG is filtered more narrowly because pulse shape is low-frequency. Accelerometer magnitude is computed sample-by-sample; the 80th percentile defines a “high motion” threshold, and only low-motion PPG samples contribute to morphology statistics. R-peaks are detected independently of PPG so that PTT can be defined as a time delay from electrical to optical pulse. The resulting scalars are compared against the trained schema; any NaN—common when only one or two beats exist in 8 s—is replaced with the median seen during training. Finally `model.predict` returns two numbers interpreted as mmHg. The server deletes the consumed 2000 samples from the buffers, advances `ts_ms_start` by 8000 ms, and may insert a database row. If the subject keeps streaming, the next prediction occurs after another 2000 *new* samples arrive, so **update rate** is one BP estimate per 8 seconds of wall time (not per overlapping window).

| Stage | Module | Input → output |
|-------|--------|----------------|
| 1. Buffering | `_DeviceBuffer` | Per-sample or chunked arrays → lists of length ≥ `win_n` |
| 2. Slice window | `_process_buffered_windows` | First `win_n` samples of `ecg`, `ppg`, `accel`, `gyro` |
| 3. Bandpass | `preprocess.bandpass` | Raw ECG → 0.5–40 Hz; PPG → 0.5–8 Hz |
| 4. Motion mask | `motion_mask` + `apply_motion_mask` | Accel magnitude → boolean mask; masked PPG for stats |
| 5. Peak detection | `nk.ecg_process`, `ppg_peaks` | R-peak indices, PPG systolic peak indices |
| 6. PTT series | `ptt_series_seconds` | Per-beat delays R → next PPG peak (0.03–0.6 s kept) |
| 7. Feature dict | `extract_features_from_signals` | 16 named scalars (or schema subset) |
| 8. Schema align | `FeatureSchema` from `model.joblib` | Vector \(\mathbf{x} \in \mathbb{R}^{k}\) in training order |
| 9. Imputation | `_impute_non_finite` | NaN/Inf → training median per feature name |
| 10. Prediction | `MultiOutputRegressor.predict` | \(\widehat{SBP}, \widehat{DBP}\) |
| 11. Trim buffer | in-place `del buf.ecg[:win_n]` … | Sliding window; `ts_ms_start += window_s × 1000` |
| 12. Persistence | `_supabase_insert_telemetry` | If `user_id` + Supabase env set |
| 13. Broadcast | `_dash_broadcast` | Push to all `/ws/dashboard` clients |

**Sampling-rate note for real-time ingest:** WebSocket handlers pass `SamplingRates(fs_ecg=fs, fs_ppg=fs)` — both channels use the **same** `fs_hz` from the client (default 250). This differs from offline defaults (`fs_ecg=250`, `fs_ppg=100`) used only when rates are not overridden.

**Multi-window drain:** If the buffer holds 2× `win_n` samples (e.g. ESP32 sends faster than processing), the `while` loop in `_process_buffered_windows` emits **multiple** predictions in one handler iteration.

### 5.5 Deployment topology (typical demo)

In a typical demonstration setup, three runtime roles are present: (1) the **ESP32** on WiFi, (2) a **laptop** running `uvicorn bp_api.main:app --host 0.0.0.0 --port 8000`, and (3) the same or another browser tab running `npm run dev` for Next.js. The ESP32 must target the laptop’s **LAN IP** (e.g. `192.168.43.100`), not `127.0.0.1`, because localhost on the PC is unreachable from the microcontroller. Windows Defender may block port 8000 until an inbound rule is added. Supabase runs in the cloud; only HTTPS outbound from the laptop is required. Latency is dominated by the 8 s window fill time, not network round-trip time, because predictions are window-based rather than sample-based.

For **offline development** without hardware, `scripts/replay_physionet_over_ws.py` pushes WFDB data into `/ws/ingest`, which exercises the identical buffer and inference code path while bypassing ADC noise and FIFO issues.

### 5.6 Default window parameters

| Parameter | Default | Used by |
|-----------|---------|---------|
| `window_s` | 8.0 seconds | Training (PhysioNet), API ingest, ESP32 WS |
| `fs_ecg` | 250 Hz | Generic feature extractor |
| `fs_ppg` | 100 Hz | Generic feature extractor |
| PhysioNet CSV `fs` | 500 Hz | `physionet_ptt_ppg.py` |
| ESP32 `fs_hz` | 250 Hz (query param) | `/ws/esp32` |

For an 8 s window at 250 Hz: **2000 samples** per channel before feature extraction.

---

## 6. Repository structure

```text
finalproj_ml/
├── bp_pipeline/              # ML: preprocess, features, training, dataset loaders
│   ├── preprocess.py         # Filters, motion mask, peak detection utilities
│   ├── features.py           # Feature extraction + DEFAULT_FEATURES schema
│   ├── dataset.py            # CSV loader (JSON signals in cells)
│   ├── physionet_ptt_ppg.py  # PhysioNet pulse-transit-time-ppg loader
│   └── train.py              # Training CLI, artifact export
├── bp_api/
│   └── main.py               # FastAPI: /predict, WebSockets, Supabase insert
├── bp_dashboard/
│   └── app.py                # Plotly Dash CSV upload dashboard
├── dashboard/                # Next.js 16 + Supabase Auth UI
│   └── src/app/              # page.tsx (live), history/page.tsx
├── scripts/
│   ├── download_physionet_ptt_ppg.py
│   └── replay_physionet_over_ws.py
├── supabase/
│   ├── schema.sql            # Full schema + RLS policies
│   └── migrations/           # Versioned migration(s)
├── firmware/
│   └── esp32_bp_stream/      # Arduino sketch: ECG + MAX30100 + MPU6050 → /ws/esp32
│       ├── esp32_bp_stream.ino
│       ├── config.example.h  # Template (committed)
│       └── config.h          # WiFi/WS secrets (gitignored)
├── docs/
│   ├── ESP32_WS_PROTOCOL.md
│   └── FINAL_YEAR_PROJECT_DOCUMENTATION.md  # This file
├── artifacts/                # Gitignored: trained model (local)
├── artifacts_physionet/      # Example committed metrics + schema
├── requirements.txt          # Python dependencies
├── .env.example                # Environment variable template
├── README.md                   # Quick start
└── PROGRESS.md                 # Development log / architecture notes
```

Repository notes:

- `bp_pipeline/kaggle_noninvasivebp.py` is referenced in `PROGRESS.md` but is not present in the current repository snapshot.
- `dashboard/src/lib/supabaseClient.ts` is imported by the Next.js pages but is missing from the repository; add the file in Section 15.3 before building the dashboard.

---

## 7. Technology stack

### 7.1 Python (ML + API)

| Package | Version constraint | Purpose |
|---------|-------------------|---------|
| numpy | (requirements.txt) | Numerical arrays |
| scipy | | Signal processing (`butter`, `filtfilt`, `find_peaks`) |
| scikit-learn | | RandomForest, ExtraTrees, StackingRegressor, metrics |
| joblib | | Model serialization |
| neurokit2 | | ECG R-peak detection |
| pandas | | CSV I/O |
| wfdb | | PhysioNet WFDB read/write |
| fastapi | | HTTP + WebSocket API |
| uvicorn | | ASGI server |
| pydantic | | Request validation |
| dash, plotly | | Legacy dashboard |
| requests | | Supabase REST (avoids supabase-py native deps on Windows) |
| websockets | | Replay script client |

Optional: `python-dotenv` — loaded in `bp_api/main.py` if installed for `.env.local`.

### 7.2 JavaScript / TypeScript (Next.js dashboard)

| Package | Version | Purpose |
|---------|---------|---------|
| next | ^16.2.6 | React framework |
| react | ^18.3.1 | UI |
| @supabase/supabase-js | ^2.50.0 | Auth + database client |

### 7.3 Infrastructure

| Service | Role |
|---------|------|
| Supabase | PostgreSQL, Auth, Row Level Security, Realtime |
| Uvicorn | Local/dev API hosting |

---

## 8. Datasets

Data is the foundation of any supervised BP model. This project uses **two complementary ingestion formats**: (A) the public **PhysioNet pulse-transit-time-ppg** corpus for training and benchmarking, and (B) a **custom CSV** layout for your own lab-collected windows. Critically, these two paths do **not** produce identical feature vectors—the PhysioNet loader exploits multiple PPG sites and pre-annotated R-peaks, while the generic path uses single-channel PPG and NeuroKit2 peak detection. Your final report must state which path produced the model you deploy on the ESP32 demo.

### 8.1 PhysioNet — pulse-transit-time-ppg (v1.1.0)

**Primary training dataset** for the committed `artifacts_physionet/` model.

#### 8.1.1 What the dataset is (study design)

PhysioNet’s *Pulse Transit Time PPG* collection was acquired from **22 healthy volunteers** wearing a research ear-worn or head-mounted assembly with **multi-site photoplethysmography** (several `pleth_*` channels), **ECG**, **tri-axial accelerometer and gyroscope**, and **load cells** measuring attachment force. Recordings span activities such as **walking, running, and sitting** (encoded in filenames like `s1_walk`, `s3_run`). The dataset was published to study how PTT derived from spatially separated PPG waves relates to blood pressure under motion—not specifically to validate consumer cuffless watches, but it remains one of the few open datasets combining rich IMU, multi-PPG, and reference BP.

Each recording is **many minutes long** at high sampling rate. This project does **not** learn from entire recordings end-to-end; instead `physionet_ptt_ppg.py` cuts each recording into up to **30 windows** of **8 seconds** (`PhysioNetPttConfig`), evenly spaced along the timeline. That yields thousands of training rows while keeping labels stationary within a short segment (BP is assumed constant per recording in the MVP).

#### 8.1.2 Labels and how they are used

Reference BP values live in `subjects_info.csv` (or parsed from `.hea` comment lines if CSV is missing). For each record you will see **start** and **end** systolic/diastolic pressures (mmHg) measured by conventional means at the beginning and end of the activity. The training code collapses these to a **single label pair per recording**:

\[
SBP = \tfrac{1}{2}(\text{bp\_sys\_start} + \text{bp\_sys\_end}),\quad
DBP = \tfrac{1}{2}(\text{bp\_dia\_start} + \text{bp\_dia\_end})
\]

This is a simplifying assumption: it ignores intra-recording BP drift during exercise, but it provides a clean supervised target when you have only sparse cuff readings. Every window sliced from `s1_walk` therefore shares the **same** `(SBP, DBP)` label, which inflates the effective sample size but also correlates errors within a subject-activity—another reason to use `--group-by-subject` when reporting test metrics honestly.

#### 8.1.3 Signals available in each record

| Signal group | Column / channel names | Role in this project |
|--------------|------------------------|----------------------|
| ECG | `ecg` | RR interval, HR; bandpassed for stability |
| R-peaks | `peaks` (CSV) or `.atr` annotation (WFDB) | **Ground-truth timing**—no NeuroKit2 on training path |
| Proximal PPG | `pleth_5` (or `pleth_4`) | Reference waveform for cross-correlation PTT |
| Distal PPG | `pleth_2` (or `pleth_1`) | Delayed waveform vs proximal |
| IMU | `a_x,a_y,a_z`, `g_x,g_y,g_z` | `acc_rms`, `gyro_rms` features |
| Load cells | `lc_1`, `lc_2` | Mean force proxies (`lc_*_mean`) |

The **PTT feature used in training** (`ptt_xcorr_s`) is **not** the same as the ESP32 online feature (`ptt_mean_s` from R-peak to PPG peak). Cross-correlation between two PPG sites estimates a **spatial** transit delay robust to single-channel artifact; the online device has one PPG LED and must use **temporal** R→PPG delay. Expect a **domain gap** between PhysioNet-trained models and ESP32 deployment unless you retrain on device-like data or fine-tune.

#### 8.1.4 CSV vs WFDB ingestion

The loader prefers `dataset_root/CSV/*.csv` if that folder exists; otherwise it iterates WFDB records listed in `RECORDS` or `*.hea` files. CSV exports are uniformly **500 Hz** in this codebase. WFDB records expose `record.fs` per file. Windowing logic is shared: `_iter_windows` computes `win_n = round(window_s * fs)` and steps through the record deterministically.

| Property | Value |
|----------|-------|
| Source | [PhysioNet pulse-transit-time-ppg 1.1.0](https://physionet.org/content/pulse-transit-time-ppg/1.1.0/) |
| Signals | ECG, multiple PPG channels (pleth_1…6), accelerometer, gyroscope, load cells |
| Sampling rate | 500 Hz (CSV export); WFDB records vary (check per record) |
| Labels | SBP/DBP start and end per recording in `subjects_info.csv` |
| MVP label rule | `SBP = mean(bp_sys_start, bp_sys_end)`, same for DBP |

**Directory layout (expected):**

```text
pulse-transit-time-ppg/1.1.0/
├── CSV/
│   ├── subjects_info.csv
│   ├── s1_walk.csv
│   ├── s1_run.csv
│   └── ...
├── RECORDS                 # WFDB mode
├── s1_walk.hea / .dat / .atr
└── ...
```

**Download:**

```bash
python scripts/download_physionet_ptt_ppg.py --out data/pulse-transit-time-ppg
# CSV only:
python scripts/download_physionet_ptt_ppg.py --out data/pulse-transit-time-ppg --csv-only
# WFDB only:
python scripts/download_physionet_ptt_ppg.py --out data/pulse-transit-time-ppg --wfdb-only
```

**Features extracted (PhysioNet path):** `rr_mean_s`, `rr_std_s`, `hr_mean_bpm`, `ptt_xcorr_s`, `ppg_distal_std`, `ppg_prox_std`, `acc_rms`, `gyro_rms`, `lc_1_mean`, `lc_2_mean` (10 features before top-k selection).

**Windowing:** Up to `max_windows_per_record=30` evenly spaced 8 s windows per recording (`PhysioNetPttConfig`).

#### 8.1.5 Downloading and storage layout

The helper `scripts/download_physionet_ptt_ppg.py` can fetch WFDB binaries via `wfdb.dl_database` and/or scrape the `csv/` index from the PhysioNet web server. Store everything under a single root, e.g. `data/pulse-transit-time-ppg/1.1.0/`, and point training with `--physionet-ptt-dir` to that root (the code searches recursively for `subjects_info.csv`). Expect **multiple gigabytes** for the full WFDB corpus; CSV-only is smaller but sufficient for the PhysioNet-specific feature path.

#### 8.1.6 Train/test leakage and how to report honestly

Because many windows share one label per recording, a random `train_test_split` lets the model see **other windows from the same walk** in training while evaluating on held-out windows from the same walk—optimistic bias. The flag `--group-by-subject` groups by subject prefix (`s1`, `s2`, …) so all activities from subject 1 stay entirely in train or entirely in test. For a final-year report, present **both** metrics if time permits: random split (higher scores) and subject-grouped split (more realistic).

### 8.2 Custom CSV format (generic pipeline)

For proprietary or lab-collected data—e.g. windows exported from your ESP32 logger after a cuff reference reading—use `bp_pipeline/dataset.py`. Each CSV row is one **independent window** with its own `sbp` and `dbp` labels, unlike PhysioNet where one label spans many windows. That makes leakage easier to control (one row = one label) but places burden on you to **window and label** correctly in upstream tooling.

The loader reads JSON-encoded arrays from string cells (or native lists if using pandas with object dtype). For each row it calls the **same** `extract_features_from_signals` used at WebSocket inference time with `DEFAULT_FEATURES` (16 dimensions before top‑k selection). This is the right path if you want training and ESP32 deployment to share identical feature definitions.

| Column | Type | Description |
|--------|------|-------------|
| `ecg` | JSON array string | ECG samples |
| `ppg` | JSON array string | PPG samples |
| `accel_x`, `accel_y`, `accel_z` | JSON array strings | Accelerometer axes |
| `sbp`, `dbp` | float | Labels (mmHg) |
| `fs_ecg` | int (optional) | Default 250 |
| `fs_ppg` | int (optional) | Default 100 |

**Example row:**

```csv
ecg,ppg,accel_x,accel_y,accel_z,sbp,dbp,fs_ecg,fs_ppg
"[0.1,0.2,...]","[0.01,...]","[0,0,0]","[0,0,0]","[0,0,0]",120,80,250,100
```

### 8.3 Demo / smoke-test model (no real dataset)

When PhysioNet is not downloaded and you only need the **transport path** working (ESP32 → API → dashboard), run:

```bash
python scripts/build_demo_model.py --out artifacts
```

This script fits a small `RandomForestRegressor` on **synthetic random features** with fake SBP/DBP targets. The resulting `model.joblib` uses the full `DEFAULT_FEATURES` schema (16 names) so WebSocket extraction succeeds. These metrics should not be reported as model-performance results; the bundled `metrics.json` explicitly notes that the artifact is for transport and API smoke tests only.

### 8.4 Data leakage consideration

By default, `train_test_split` **shuffles all windows** — windows from the same subject can appear in both train and test. Use:

```bash
python -m bp_pipeline.train --physionet-ptt-dir ... --group-by-subject
```

This uses `GroupShuffleSplit` grouped by subject prefix (`s1`, `s22`, …) from record names.

---

## 9. Machine learning pipeline

The ML pipeline is the scientific core of the project: it turns **noisy voltage traces** into a **small tabular feature vector** that encodes timing and morphology information believed to correlate with arterial pressure. The pipeline is intentionally **interpretable**—every feature has a name and a formula—so examiners can relate outputs to physiology. It is **not** end-to-end deep learning; convolutional networks could learn from raw waveforms but would require more labeled data, GPU training, and careful explainability for a final-year viva.

There are **two parallel implementations** in the repository:

1. **Generic path** (`features.py` + `preprocess.py`) — used by WebSocket inference, custom CSV training, and demo model builder. Assumes one ECG channel, one PPG channel, and IMU at the same sample rate when passed from the API.
2. **PhysioNet path** (`physionet_ptt_ppg.py`) — used only when `--physionet-ptt-dir` is passed to `train.py`. Exploits multi-channel PPG and external R-peak annotations.

The sections below focus on the **generic path** because that is what runs when your ESP32 streams live data.

### 9.1 Preprocessing (`bp_pipeline/preprocess.py`)

Preprocessing answers one question: *“How do we suppress noise and motion enough that peak detectors and statistics are meaningful?”* The code favors **classical DSP** (IIR bandpass, percentile masking) over learned filters because the dataset is small and the thesis narrative stays clear.

#### 9.1.1 `bandpass(x, low, high, fs, order=4)`

- 4th-order **Butterworth** bandpass.
- **Zero-phase** filtering via `scipy.signal.filtfilt` (no phase delay; needs sufficient samples).
- If sample count < `max(3*order, 15)`, returns input unchanged.
- Normalizes corner frequencies to Nyquist: `low_n = low/(fs/2)`, `high_n = high/(fs/2)`.

**Why zero-phase (`filtfilt`)?** Ordinary IIR filtering introduces frequency-dependent delay. If you filtered ECG and PPG with causal filters, their relative timing would shift unpredictably and **destroy PTT**. `filtfilt` applies the filter forward and backward so the output has zero net phase delay, at the cost of needing the entire window in memory—which is exactly what we have (8 s).

**Short-window guard:** If the user sets a very small `window_s`, bandpass is skipped when `len(x) < max(3*order, 15)` to avoid filtfilt instability. In that edge case features may be noisy; the default 8 s window is safe at 250 Hz.

**Default bands:**

| Signal | Low (Hz) | High (Hz) | Rationale |
|--------|----------|-----------|-----------|
| ECG | 0.5 | 40.0 | Removes baseline wander; keeps QRS energy |
| PPG (generic) | 0.5 | 8.0 | Pulse shape is low-frequency; rejects high-frequency LED switching noise |
| PPG (PhysioNet) | 0.75 | 5.0 (after DC removal) | Matches dataset authors’ recommendations |

#### 9.1.2 `remove_dc_gaussian` + `ppg_physionet_filter`

PhysioNet-recommended PPG path:

1. Subtract DC using centered Gaussian smoothing (`sigma = window_s * fs / 6`).
2. Bandpass 0.75–5 Hz.

#### 9.1.3 `motion_mask(accel_xyz, keep_percentile=80)`

Accelerometer magnitude measures how much the wearer moved during each sample. The MVP does **not** subtract motion from PPG via adaptive filtering; it **discards** high-motion samples before computing PPG amplitude statistics. The threshold is **adaptive per window**: the 80th percentile means “keep the calmest 80% of samples.” If the subject walks vigorously, even the “calm” subset may still contain motion—this is a known weakness compared to NLMS or accelerometer regression methods in the literature.

**Important nuance:** Motion masking shortens the effective PPG array (`ppg_m = ppg_f[mask]`). Peak detection runs on this irregularly subsampled series indexed by original sample order only through the mask indices—peaks are still valid indices into the masked array, and PTT conversion uses separate time bases for ECG and PPG via sampling rates.

#### 9.1.4 `ppg_peaks(ppg, fs_ppg)`

- Minimum peak distance ≈ 0.27 s (HR up to ~220 bpm).
- Prominence = 0.25 × std(PPG).

#### 9.1.5 Utility functions

- `nan_interp_1d` — linear interpolation for NaN/Inf.
- `robust_zscore` — median/MAD normalization (PhysioNet path).

### 9.2 Feature extraction (`bp_pipeline/features.py`)

#### 9.2.1 Default feature schema (16 features)

| Name | Description |
|------|-------------|
| `ptt_mean_s` | Mean PTT (s), R-peak → next PPG peak |
| `ptt_std_s` | Std dev of PTT series |
| `pwv_proxy` | `1 / ptt_mean_s` |
| `log_ptt` | `log(ptt_mean + ε)` |
| `inv_ptt` | `1 / (ptt_mean + ε)` |
| `inv_ptt2` | `1 / (ptt_mean + ε)²` |
| `inv_ptt_x_hr` | `inv_ptt × HR` (physics-inspired interaction) |
| `rr_mean_s` | Mean R-R interval (s) |
| `rr_std_s` | Std R-R interval |
| `hrv_rmssd_s` | RMSSD of RR intervals |
| `ppg_mean` | Mean of motion-masked PPG |
| `ppg_std` | Std of motion-masked PPG |
| `ppg_skew` | Skewness (standardized 3rd moment) |
| `ppg_kurtosis` | Excess kurtosis |
| `acc_rms` | RMS accelerometer magnitude (masked) |
| `acc_jerk_rms` | RMS of diff(accel) |
| `gyro_rms` | RMS gyro (if provided) |
| `gyro_jerk_rms` | RMS gyro jerk |

ε = `1e-6` for numerical stability in log/inverse transforms.

#### 9.2.2 Function: `extract_features_from_signals(...)`

**Inputs:**

- `ecg`, `ppg`: 1D float arrays
- `accel_xyz`: `(n, 3)` array
- `gyro_xyz`: optional `(n, 3)`
- `rates`: `SamplingRates(fs_ecg=250, fs_ppg=100)`
- `motion_keep_percentile`: default 80
- `schema`: which features to return (order matters)

**Returns:** `(feature_vector, schema)` as `np.ndarray` and `FeatureSchema`.

**Implementation detail:** ECG is bandpass-filtered but **not** motion-masked. PPG is masked.

**Step-by-step inside `extract_features_from_signals` (generic path):**

1. **Inputs validated** as 1D `ecg`, `ppg` and `(n,3)` `accel_xyz`; optional `gyro_xyz`.
2. **Filter** both biosignals (Section 9.1.1).
3. **Build motion mask** from accelerometer; apply to PPG only → `ppg_m`.
4. **Detect R-peaks** on filtered ECG via NeuroKit2. If fewer than ~1 s of data or processing fails, return empty peak list → PTT features become NaN.
5. **Detect PPG peaks** on `ppg_m` with `find_peaks` constrained to plausible heart rates.
6. **Construct PTT series:** for each R-peak timestamp, find first PPG peak time strictly after it; if delay ∈ [0.03, 0.6] s, keep it.
7. **Aggregate** mean/std of PTT; compute nonlinear transforms (`log_ptt`, `inv_ptt`, `inv_ptt2`, `inv_ptt_x_hr`) motivated by Moens–Korteweg-style nonlinear pressure–PWV relations.
8. **RR domain:** successive differences of R-peak indices → RR intervals in seconds → mean, std, RMSSD.
9. **PPG morphology:** mean, std, skewness, kurtosis on masked PPG.
10. **IMU:** RMS accel on masked samples; RMS of first difference (jerk); analogous gyro stats if provided.
11. **Pack** values in `schema.names` order into `np.ndarray` (NaN allowed).

Any step failure propagates NaNs; training medians and API imputation handle missingness but cannot invent true physiology.

### 9.3 PhysioNet feature path (`physionet_ptt_ppg.py`)

Separate extractor optimized for dataset structure:

- Uses provided R-peak indices (not NeuroKit2 re-detection on full record).
- Cross-correlation PTT between distal/proximal PPG.
- Load cell means as attachment pressure proxies.
- Produces **different feature names** than `DEFAULT_FEATURES` — training must use consistent path end-to-end.

### 9.4 End-to-end signal flow (one 8 s window at 250 Hz)

The following describes what happens **inside the server** when 2000 ESP32 samples have been received (default `window_s=8`, `fs_hz=250`).

```text
2000 × ecg[i], ppg[i], accel[i], gyro[i]
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ ecg_f = bandpass(ecg, 0.5–40 Hz, fs=250)                  │
│ ppg_f = bandpass(ppg, 0.5–8 Hz, fs=250)                   │
│ mask  = accel_mag < percentile_80(accel_mag)              │
│ ppg_m = ppg_f[mask]   (ECG is NOT masked in MVP)          │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ R_peaks = NeuroKit2 ecg_process(ecg_f)                   │
│ P_peaks = find_peaks(ppg_m)                               │
│ For each R at t_R: PTT = first P_peak after t_R − t_R     │
│ Keep PTT ∈ [0.03, 0.6] s                                  │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ Scalar features: ptt_mean, ptt_std, 1/ptt, log(ptt),     │
│   RR stats, RMSSD, PPG mean/std/skew/kurt, acc/gyro RMS   │
└───────────────────────────────────────────────────────────┘
        │
        ▼
  x[k] → impute → model.predict → SBP, DBP (mmHg)
```

**PPG channel on ESP32:** Hardware samples IR at **50 Hz** internally, but firmware **holds** the latest filtered IR value between updates so the server receives 250 PPG-aligned samples per second. Feature extraction therefore sees a **stair-step** PPG at 50 Hz effective resolution embedded in a 250 Hz stream — acceptable for peak-based PTT in the MVP but not ideal for high-frequency PPG morphology.

**ECG channel:** Assumed real 250 Hz ADC reads (GPIO34). Negative values are treated as dropout in `/ws/esp32` (replaced with last valid sample).

### 9.5 Design trade-offs (for thesis discussion)

| Choice | Benefit | Cost |
|--------|---------|------|
| Hand-crafted features | Explainable, works with hundreds of labels | Misses subtle waveform patterns CNNs might catch |
| 8 s window | Stable HR/PTT estimates | Slow BP update rate on device |
| Tumbling buffer | Simple code | No overlap averaging; higher variance |
| Top‑k RF selection | Reduces overfitting | SBP-only ranking ignores DBP-specific features |
| Stacking ensemble | Strong tabular accuracy | Larger `model.joblib`, slower than single RF |

---

## 10. Model training

Training is **fully offline**: it does not run on the ESP32. The output is a serialized bundle (`model.joblib`) consumed by FastAPI at startup. Training is idempotent given the same data, flags, and `random_state`, which helps reproducibility in your report.

**End-to-end training story:** Raw public recordings → thousands of 8 s windows → two different feature extractors depending on CLI flags → a design matrix \(X\) and label matrix \(y\) → cleaning → dimensionality reduction → ensemble fit → evaluation on held-out windows → export artifacts.

### 10.1 Entry point

```bash
python -m bp_pipeline.train [OPTIONS]
```

### 10.2 CLI arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--data` | — | Path to custom CSV (mutually exclusive with PhysioNet) |
| `--physionet-ptt-dir` | — | Root of PhysioNet dataset |
| `--out` | `artifacts` | Output directory |
| `--top-k` | 20 | Features to keep after importance ranking |
| `--test-size` | 0.2 | Hold-out fraction |
| `--random-state` | 42 | Reproducibility seed |
| `--window-s` | 8.0 | Window length for PhysioNet |
| `--verbose` | false | Print progress |
| `--group-by-subject` | false | GroupShuffleSplit by subject |

### 10.3 Training algorithm (step by step, with rationale)

**Step 1 — Load data.**  
`load_physionet_ptt_features` or `load_csv_features` returns `X` (n rows × F features) and `y` (n × 2). Each row is one window; F is 10 for PhysioNet features or 16 for generic defaults before selection. Record names like `s1_walk#w3` are tracked for grouping.

**Step 2 — Median imputation (`_nan_impute`).**  
Peak failures and motion gaps produce NaNs. Replacing each column with its **global median** across all training windows is a simple strategy that preserves scale. Medians are stored in the artifact as `medians_full_schema` aligned to `full_schema.names` so inference can map by feature name. *Limitation:* imputation on the full dataset before splitting leaks test distribution into train medians slightly; a stricter implementation would compute medians on train only.

**Step 3 — Feature selection (`select_top_k_features`).**  
A Random Forest with 200 trees fits **only SBP** (`y[:,0]`) against all F features. Feature importances (mean decrease impurity) rank predictors; the top `k` names form `keep_schema`. The SBP-only ranking was chosen for speed and simplicity in the MVP. A stronger follow-up experiment would rank features using combined SBP/DBP importance or separate selection per target, because DBP may depend on different variables such as peripheral resistance.

**Step 4 — Slice (`slice_schema`).**  
Reorders and drops columns so `X_train` has exactly `k` columns in the order stored in `feature_schema.json`. **Order is part of the model contract.**

**Step 5 — Split.**  
Default: `train_test_split(test_size=0.2, shuffle=True)`. Optional: `GroupShuffleSplit` on subject IDs derived from record name prefixes. Always report which you used.

**Step 6 — Fit stacked ensemble.**  
`MultiOutputRegressor` clones the entire stacking pipeline for **SBP** and **DBP** independently (two meta-learners). Inside each:

- **Random Forest (400 trees, unlimited depth):** captures nonlinear interactions, robust to outliers.
- **Extra Trees (600):** more random splits, lowers variance.
- **Ridge (α=2):** linear baseline stabilizes extremes.
- **Meta Ridge (α=1, passthrough=True):** learns a weighted combination of base predictions **and** can see original features again via passthrough—useful when stacking underfits on small n.

Hyperparameters are fixed in code and are not tuned by nested cross-validation in the MVP. This is recorded as a future improvement rather than hidden as an implicit assumption.

**Step 7 — Evaluate.**  
`mean_absolute_error` and `mean_squared_error` per target on the hold-out split. MAE is interpreted in **mmHg** directly (“on average we are 6 mmHg off DBP”).

**Step 8 — Persist.**  
`joblib.dump` bundles everything the API needs. Without this file, `/health` returns `ok: false`.

### 10.4 What is inside `model.joblib`

Understanding the bundle prevents integration bugs:

```python
{
  "model": MultiOutputRegressor(...),      # fitted estimator
  "schema": {"names": [...]},              # k selected names, IN ORDER
  "full_schema": {"names": [...]},         # all F names before selection
  "medians_full_schema": [float, ...]      # length F, for imputation by name
}
```

At WebSocket inference, `extract_features_from_signals` is called with `schema=FeatureSchema(names=schema_names)` so the returned vector already has length `k`. REST `/predict` assumes the client did that work externally.

### 10.5 Output artifacts

| File | Contents |
|------|----------|
| `model.joblib` | Dict: `model`, `schema`, `full_schema`, `medians_full_schema` |
| `feature_schema.json` | `{"names": [...]}` selected features |
| `metrics.json` | MAE, RMSE, train/test counts |

### 10.6 Example commands

```bash
# PhysioNet training (recommended)
python -m bp_pipeline.train \
  --physionet-ptt-dir data/pulse-transit-time-ppg/1.1.0 \
  --out artifacts \
  --top-k 10 \
  --group-by-subject \
  --verbose

# Custom CSV
python -m bp_pipeline.train --data data/train.csv --out artifacts --top-k 16
```

### 10.7 Committed example metrics (`artifacts_physionet/`)

From `artifacts_physionet/metrics.json`:

| Metric | Value |
|--------|-------|
| MAE SBP | 11.98 mmHg |
| MAE DBP | 5.65 mmHg |
| RMSE SBP | 16.40 mmHg |
| RMSE DBP | 6.95 mmHg |
| n_train | 1530 |
| n_test | 450 |
| n_features | 10 |

Selected features (`artifacts_physionet/feature_schema.json`):

`gyro_rms`, `lc_1_mean`, `hr_mean_bpm`, `rr_mean_s`, `lc_2_mean`, `acc_rms`, `ptt_xcorr_s`, `ppg_distal_std`, `rr_std_s`, `ppg_prox_std`

**How to interpret these results in prose:** DBP MAE ≈ 5.65 mmHg meets the project’s informal DBP target; SBP MAE ≈ 11.98 mmHg does not meet the 10 mmHg aspiration. RMSE > MAE indicates occasional large errors—often from windows with poor PPG peaks or activity mismatch. The selected features emphasize **gyroscope and load-cell** measures alongside PTT cross-correlation, suggesting the model exploits motion context and sensor contact force as much as classical timing features—reasonable for a dataset acquired during walking/running.

### 10.8 Aligning training with ESP32 deployment

| Training source | Feature set | Suitable for ESP32 live demo? |
|-----------------|-------------|-------------------------------|
| `--physionet-ptt-dir --live-compatible` | `DEFAULT_FEATURES` extracted by the live API code path | **Best PhysioNet option** — schema matches ESP32 live inference |
| `--physionet-ptt-dir` | `ptt_xcorr_s`, dual PPG, load-cell, etc. | **Poor for live ESP32** — device lacks dual PPG/load-cell signals |
| `--data` custom CSV from device windows | `DEFAULT_FEATURES` | **Good** — same code path as API |
| `build_demo_model.py` | All default live features | **Good for plumbing only** |

Recommended thesis narrative: use `--live-compatible` for the live dashboard artifact so `/health` reports `live_schema_compatible: true`. For the strongest deployment metric, collect a small labeled set from your own ESP32 hardware and retrain with `--data`.

---

## 11. Inference and API service

Inference is where trained mathematics meets runtime data. The FastAPI application (`bp_api/main.py`) is an **ASGI** app: WebSocket handlers are `async`, but feature extraction and `sklearn` prediction run **synchronously** inside the event loop. For the MVP sample rates this is acceptable; heavy load would require `run_in_executor` to avoid blocking other clients.

There are **three inference entry patterns**:

1. **Online raw → features → predict** — WebSocket buffers + `_process_buffered_windows`.
2. **Precomputed features → predict** — `POST /predict` or Dash predict mode.
3. **Batch precomputed** — `POST /predict_batch` for CSV dashboards.

Only (1) exercises the full pipeline identical to a wearable streaming scenario.

### 11.1 Starting the server

```bash
# From repository root
uvicorn bp_api.main:app --reload --host 0.0.0.0 --port 8000
```

Set model path:

```bash
export BP_MODEL_PATH=artifacts/model.joblib   # Linux/macOS/Git Bash
set BP_MODEL_PATH=artifacts\model.joblib      # Windows cmd
```

### 11.2 Environment loading

`bp_api/main.py` attempts to load `repo_root/.env.local` via `python-dotenv` (optional). Variables:

| Variable | Purpose |
|----------|---------|
| `BP_MODEL_PATH` | Path to `model.joblib` |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side DB insert (bypasses RLS) |

### 11.3 REST endpoints

See [Appendix B](#appendix-b--api-reference) for full request/response schemas.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Model load status, feature count, Supabase configured |
| POST | `/predict` | Single feature vector → SBP, DBP |
| POST | `/predict_batch` | Multiple rows → arrays of SBP, DBP |

**Uncertainty proxy:** For tree ensembles, `/predict` optionally returns `sbp_std` / `dbp_std` as std dev across individual trees in each output regressor.

### 11.4 Model loading and imputation

`load_artifact()` is `@lru_cache`d — loaded once per process.

At inference:

1. Validate `len(features) == len(schema.names)`.
2. Replace NaN/Inf per-feature using `medians_full_schema` mapped by name.
3. Reject if still non-finite.

**Contract:** API expects the **post-selection** feature vector in **exact schema order** from `feature_schema.json`. It does **not** accept raw 16-D vectors and slice automatically (WebSocket ingest path extracts full features then aligns to saved schema).

### 11.5 Detailed online inference path (`_process_buffered_windows`)

When the buffer contains at least `win_n = round(window_s * fs_hz)` samples in **both** ECG and PPG lists, the server enters a `while` loop that may emit **multiple** predictions if the client sent data faster than real time (catch-up after WiFi stall).

1. **Slice** exactly `win_n` samples from the front of each list (tumbling window).
2. **Load model** once per call via cached `load_artifact()`; on failure, send error JSON and drop one window to avoid infinite retry loops.
3. **Extract features** with `SamplingRates(fs_ecg=fs, fs_ppg=fs)` — both set to the client’s `fs_hz` (typically 250). This overrides the offline default where PPG was 100 Hz.
4. **Validate shape** against `schema_names`. Mismatch usually means you trained with PhysioNet features but deployed with generic extraction (or vice versa).
5. **Impute** non-finite values using training medians by feature name (`_impute_non_finite`).
6. **Predict** `model.predict([x])` → `[sbp, dbp]`.
7. **Optional Supabase insert** if `user_id` is set and env vars exist. Row includes `features`, `schema_names`, predictions, and optional raw JSON arrays.
8. **Broadcast** slim JSON to all `/ws/dashboard` subscribers.
9. **Trim buffer** by deleting the first `win_n` samples; increment `ts_ms_start` by `window_s * 1000` ms.

**REST `/predict` differences:** No buffering; no feature extraction; optional `sbp_std`/`dbp_std` by iterating individual trees inside each `MultiOutputRegressor` sub-estimator—useful as a **relative** uncertainty hint, not a calibrated 95% interval.

**Failure handling:** If features remain NaN after imputation (e.g. no R-peaks in entire 8 s), the handler returns `{"ok": false, "error": "non-finite feature values..."}` and **breaks** the while-loop, leaving remaining buffer data for the next attempt—operators should watch for repeated errors indicating loose electrodes or FIFO starvation on the device.

### 11.6 Cold start and model missing

On startup, no model is loaded until the first request triggers `load_artifact()`. If `artifacts/model.joblib` is absent, `/health` reports `ok: false` and WebSockets return an error after the first full window. Use `scripts/build_demo_model.py` to generate a placeholder model for integration testing without PhysioNet.

---

## 12. Real-time ingestion (WebSockets)

FastAPI exposes three WebSocket routes in `bp_api/main.py`. All inference paths load the same `model.joblib` and share an in-memory **`_buffers: Dict[str, _DeviceBuffer]`** keyed by `device_id`.

### 12.1 Shared server components

#### `_DeviceBuffer` (per device)

| Field | Type | Purpose |
|-------|------|---------|
| `ecg` | `List[float]` | Growing ECG samples |
| `ppg` | `List[float]` | Growing PPG samples (IR preferred on ESP32 path) |
| `accel` | `List[List[float]]` | `[ax, ay, az]` per sample |
| `gyro` | `List[List[float]]` | `[gx, gy, gz]` per sample |
| `fs_hz` | `int` | Set from first frame or query param |
| `ts_ms_start` | `int` | Epoch ms at start of current window (advanced after each prediction) |

#### `_process_buffered_windows(ws, buf, ...)`

Called when `min(len(ecg), len(ppg)) >= win_n` where `win_n = round(window_s × fs_hz)`.

**Pseudocode:**

```python
while len(ecg) >= win_n and len(ppg) >= win_n:
    ecg_w, ppg_w = ecg[:win_n], ppg[:win_n]
    accel_w = accel[:win_n] or zeros
    gyro_w = gyro[:win_n] or zeros
    feats = extract_features_from_signals(ecg_w, ppg_w, accel_w, gyro_w, fs_ecg=fs, fs_ppg=fs)
    feats = impute(feats, training_medians)
    sbp, dbp = model.predict(feats)
    optional: insert Supabase row
    broadcast to /ws/dashboard clients
    delete first win_n samples from all buffers
    ts_ms_start += window_s * 1000
return last_pred, rows_written
```

**Responses to the ingest client** (ESP32 or replay script):

| Condition | JSON response |
|-----------|----------------|
| Still buffering | `{"ok": true, "buffered_n": n, "needed_n": win_n}` |
| Prediction made | `{"ok": true, "pred": {"sbp": …, "dbp": …}, "wrote": N}` |
| Schema / NaN error | `{"ok": false, "error": "…"}` |

### 12.2 `/ws/ingest` — chunked array ingest

**Use case:** PhysioNet replay script, custom clients that already batch samples, or gateways that aggregate data.

**Connection:** `ws://<host>:8000/ws/ingest` (no query params; parameters are in each JSON frame).

**Client → server (each WebSocket text frame):**

```json
{
  "device_id": "esp32-001",
  "ts_ms_start": 1715150000000,
  "fs_hz": 250,
  "window_s": 8.0,
  "ecg": [2048.0, 2051.0, "..."],
  "ppg": [180000.0, 180010.0, "..."],
  "accel": [[0.0, 0.1, 9.8], "..."],
  "gyro": [[0.0, 0.0, 0.0], "..."],
  "user_id": "uuid-optional",
  "session_id": "uuid-optional",
  "persist_raw": false
}
```

**Handler flow (`ws_ingest`):**

1. `await ws.accept()`
2. Loop: `payload = await ws.receive_json()`
3. Validate with Pydantic `IngestFrame`
4. Get or create `_DeviceBuffer` for `frame.device_id`
5. On first frame: set `buf.ts_ms_start = frame.ts_ms_start`, `buf.fs_hz = frame.fs_hz`
6. `buf.ecg.extend(frame.ecg)`, same for `ppg`, optional `accel`/`gyro`
7. If `n < win_n`: reply buffering status and `continue`
8. Else: call `_process_buffered_windows(...)`, reply with `pred` or buffering

**Notes:**

- Arrays in one frame can be any length (e.g. 1 s = 250 samples per chunk).
- `accel` / `gyro` are optional; missing gyro → zeros in feature extraction.
- **`user_id` required** for Supabase insert (plus server env vars).

### 12.3 `/ws/esp32` — per-sample stream (production firmware)

**Use case:** `firmware/esp32_bp_stream` sends **one compact JSON object per sample** at 250 Hz.

**Connection URL (query params fixed at connect time):**

```text
ws://192.168.1.100:8000/ws/esp32?device_id=esp32-001&fs_hz=250&window_s=8.0&user_id=<UUID>&verbose=1
```

| Query param | Default | Meaning |
|-------------|---------|---------|
| `device_id` | `esp32` | Buffer key in `_buffers` |
| `fs_hz` | `250` | Must match firmware `WS_FS_HZ` |
| `window_s` | `8.0` | Seconds per inference window |
| `user_id` | — | Supabase Auth UUID for DB writes |
| `session_id` | — | Optional FK |
| `persist_raw` | `0` | If `1`, store raw waveforms in `telemetry_windows` |
| `verbose` | `0` | If `1`, send `buffered_n` every 50 samples while filling |

**Client → server (one frame per sample):**

```json
{
  "t": 123456789,
  "ecg": 2048,
  "ir": 180000,
  "red": 175000,
  "ax": 0.12, "ay": -0.05, "az": 9.81,
  "gx": 0.01, "gy": 0.00, "gz": 0.00
}
```

Validated by `Esp32Sample` (extra keys ignored).

**Handler flow (`ws_esp32`) — line-by-line behavior:**

1. Parse query params once at connect.
2. `await ws.accept()`; initialize `last_ecg`, `last_ppg` hold variables.
3. For each `receive_json()`:
   - **ECG:** `ecg_v = float(sample.ecg)`. If `ecg_v < 0`, use `last_ecg` (ADC dropout). Else update `last_ecg`.
   - **PPG:** If `ir` present → `last_ppg = ir`; elif `red` present → `last_ppg = red`. Append `last_ppg` to `buf.ppg` (hold-last-value when a channel is omitted).
   - **IMU:** Default missing axes to `0.0`.
   - Append to `buf.ecg`, `buf.ppg`, `buf.accel`, `buf.gyro`.
   - On first sample: `buf.ts_ms_start = int(time.time() * 1000)` (wall clock, not ESP `t`).
   - If `n < win_n`: optionally ack with `verbose`; `continue`.
   - Else: `_process_buffered_windows`, send `pred` or status.

**Timestamp detail:** Field `t` (microseconds on device) is stored but not used for window timing on the server; window timestamps use server wall clock at buffer creation.

### 12.4 Sequence diagram (ESP32 → prediction)

```text
ESP32                         FastAPI                         Supabase / Dashboard
  |                              |                                    |
  |--- WS connect /ws/esp32 ---->|                                    |
  |<-------- accept -------------|                                    |
  |                              |                                    |
  |--- sample 1..1999 --------->|  buffer (no pred)                  |
  |<-- {buffered_n, needed_n} ---|  (only if verbose=1)               |
  |                              |                                    |
  |--- sample 2000 ------------->|  extract features + predict        |
  |<-- {ok, pred, wrote} --------|  -------- insert (if user_id) ---->|
  |                              |  -------- broadcast ------------->|
  |--- sample 2001..3999 ------->|  buffer next window                |
  |                              |                                    |
```

First prediction latency ≈ **`window_s` seconds** of streaming (8 s default) plus ~100–500 ms Python processing.

### 12.5 `/ws/dashboard` — live broadcast

Passive subscribers; server pushes after each successful window:

```json
{
  "type": "telemetry_window",
  "device_id": "esp32-001",
  "ts_ms_start": 1715150000000,
  "sbp_pred": 120.5,
  "dbp_pred": 78.2
}
```

Handler keeps connection alive by reading (and discarding) client text pings.

### 12.6 Replay simulator (`/ws/ingest`)

```bash
python scripts/replay_physionet_over_ws.py \
  --dataset-root data/pulse-transit-time-ppg \
  --record s1_walk \
  --ws-url ws://127.0.0.1:8000/ws/ingest \
  --user-id <SUPABASE_USER_UUID> \
  --hop-s 1.0 \
  --window-s 8.0 \
  --realtime
```

Sends 1 s chunks (`hop_s`) from WFDB; server accumulates to full window. Uses **aligned PhysioNet sampling** in the replay script, not the ESP32 50 Hz PPG hold pattern.

### 12.7 Choosing `/ws/ingest` vs `/ws/esp32`

| Aspect | `/ws/ingest` | `/ws/esp32` |
|--------|--------------|-------------|
| Payload | Batched arrays | One sample per frame |
| Bandwidth | Lower overhead | Higher (JSON per sample) |
| Client | Python replay, gateways | ESP32 `WebSocketsClient` |
| `ts_ms_start` | Client supplies | Server sets on first sample |
| Best for | Simulation, bulk upload | Live wearable streaming |

---

## 13. ESP32 firmware integration

The firmware is the **edge acquisition layer** of the architecture. It turns physical voltages from an ECG analog front-end, a MAX30100 optical sensor, and an MPU6050 inertial unit into a **steady JSON stream** the server can buffer. The sketch deliberately contains **no machine learning**—only sampling, filtering, and networking—so that thesis experiments can change Python code without reflashing the microcontroller on every iteration.

**Sketch location:** `firmware/esp32_bp_stream/esp32_bp_stream.ino`  
**Config:** copy `config.example.h` → `config.h` (gitignored; never commit WiFi passwords).

### 13.0 Hardware stack (typical wiring)

| Component | Interface | Pin / setting in sketch | Notes |
|-----------|-----------|-------------------------|-------|
| ESP32 dev board | — | — | Dual-core; WiFi STA mode |
| MAX30100 PPG | I2C | SDA=21, SCL=22, 100 kHz | Finger contact critical; oxullo **MAX30100lib** |
| MPU6050 IMU | I2C | Same bus | Adafruit driver; ±8 g accel, ±500 °/s gyro |
| ECG analog out | ADC | GPIO34, 12-bit, 11 dB attenuation | `readEcgRaw()` averages two quick reads |
| USB Serial | 921600 baud | Debug only when `DEBUG_SERIAL 1` | Not used for production inference |

Power, grounding, and keeping the MAX30100 away from WiFi antenna noise are practical concerns for demos. Loose finger pressure on the LED causes flat IR traces that make the server return non-finite features.

### 13.1 Problems in the original prototype (before refactor)

The first Arduino sketch (Serial-only, hybrid loop) exhibited several **system-level** failures that looked like “bad ML” but were actually **data acquisition** issues:

| Issue | Symptom | Root cause |
|-------|---------|------------|
| **MAX30100 FIFO overflow** | Flat or frozen `ir`/`red`, random drops | `sensor.update()` only ran in the main loop, which was **blocked** for up to 40 ms waiting to print Serial JSON |
| **Sample rate mismatch** | Server never reached `needed_n`, or wrong PTT | Firmware printed every **40 ms (~25 Hz)** while API defaulted to **`fs_hz=250`** (expected 2000 samples in 8 s, only got ~200) |
| **WiFi disabled after NTP** | No WebSocket possible | `WiFi.disconnect()` + `WIFI_OFF` after one-shot time sync |
| **MPU tied to print gate** | IMU data stale or jittery | `mpu.getEvent()` only when printing, not on a fixed schedule |
| **Nested Serial JSON** | Hard to parse on PC; not `Esp32Sample` | Structure `{"ppg":{...},"ecg":{...}}` did not match `/ws/esp32` flat schema |
| **PPG vs ECG rate** | Beat alignment errors | MAX30100 hardware **50 Hz** vs ECG **250 Hz** without explicit hold/interpolation strategy |

### 13.2 Fixes applied (current firmware)

| Fix | Implementation |
|-----|----------------|
| Continuous FIFO drain | FreeRTOS task `ppgDrainTask` on **core 0**, runs every **2 ms**, calls `update()` + drains all `getRawValues()` |
| True 250 Hz stream | `esp_timer_get_time()` scheduler on core 1; `SAMPLE_PERIOD_US = 1_000_000 / 250` |
| PPG at 50 Hz inside 250 Hz stream | Latest filtered IR/RED **held** between MAX30100 samples (`volatile` shared vars) |
| WebSocket streaming | `WebSocketsClient` to `/ws/esp32?...`; WiFi stays connected |
| IMU scheduling | `readImu()` every **4** samples (~62.5 Hz), values held between reads |
| API-aligned JSON | Flat keys: `t`, `ecg`, `ir`, `red`, `ax`…`gz` |
| Overflow diagnostics | `ppgDrainOverflows` increments when >8 samples drained at once (sign of previous starvation) |
| Secrets out of repo | `config.h` gitignored; `config.example.h` committed |

### 13.3 Firmware architecture (dual-core)

The ESP32 has two Xtensa cores. The refactored sketch **pins FIFO service to core 0** and **network + sampling to core 1** (`loop()`), reducing the chance that WiFi stack or JSON formatting starves the optical sensor.

**Why dual-core matters in prose:** The MAX30100 does not interrupt the CPU when its FIFO fills; you must poll `update()` frequently. A single-threaded loop that prints JSON at 25 Hz can block for 40 ms—long enough to lose **more than one FIFO worth** of PPG samples at 50 Hz. Once samples are lost, PPG peaks shift and PTT features become NaN, which looks like “the ML model is broken” when the root cause is firmware scheduling.

```text
┌──────────────────────────────── Core 0 ────────────────────────────────┐
│  ppgDrainTask (every 2 ms)                                            │
│    ppgSensor.update()                                                 │
│    while getRawValues(&ir, &red): IIR filter → ppgIrFiltered, ...     │
└───────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ volatile latest IR/RED
┌──────────────────────────────── Core 1 (loop) ─────────────────────────┐
│  serviceNetwork() → webSocket.loop(), reconnect                       │
│  every 4000 µs: read ECG, maybe IMU, sendSampleWs(JSON)               │
└───────────────────────────────────────────────────────────────────────┘
```

### 13.4 Sensor mapping (firmware → server)

| Firmware field | Server field | Notes |
|----------------|--------------|-------|
| `ecg` | `buf.ecg[]` | 12-bit ADC GPIO34, averaged 2× reads |
| `ir` | `buf.ppg[]` | Preferred for PPG channel |
| `red` | fallback if no `ir` | Server uses `last_ppg` hold logic |
| `ax`, `ay`, `az` | `buf.accel[]` | m/s² from Adafruit MPU6050 |
| `gx`, `gy`, `gz` | `buf.gyro[]` | rad/s |
| `t` | (ignored for windows) | Device microseconds; useful for debug |

### 13.5 Main loop timing budget (250 Hz)

Each iteration targets **4000 µs** between samples (`SAMPLE_PERIOD_US = 1_000_000 / 250`).

| Work item | Approx. cost | Notes |
|-----------|--------------|-------|
| `serviceNetwork()` | 0–several ms | `webSocket.loop()`; reconnect every 5 s if down |
| ECG `analogRead` ×2 | < 1 ms | Must stay under budget |
| IMU I2C read | ~1 ms | Only every 4th sample (~62.5 Hz effective) |
| `snprintf` + `sendTXT` | 0.5–2 ms | JSON ~220 bytes per sample |
| Catch-up logic | max 2 ticks | If WiFi blocked, skips ahead to avoid unbounded backlog |

If `nowUs < nextSampleUs`, `loop()` returns early—busy-wait free. When the device falls behind, it advances at most **two** sample periods per iteration to prevent permanent lag while accepting brief duplicate timing jitter.

**PPG hold logic:** `ppgDrainTask` updates `volatile ppgIrFiltered` at up to 50 new values per second. The main loop reads those volatiles every 4 ms and sends them as `ir` in JSON. The server therefore receives 250 PPG numbers per second where **80% are repeats** of the last valid optical sample. That is intentional: it aligns array lengths with ECG for buffering while acknowledging the optical front-end is slower.

### 13.6 MAX30100 configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| Mode | `MAX30100_MODE_SPO2_HR` | IR + red LEDs |
| Sample rate | `MAX30100_SAMPRATE_50HZ` | Chip maximum for SpO2 mode |
| LED current | `27.1 mA` both channels | Strong finger signal |
| Pulse width | `MAX30100_SPC_PW_1600US_16BITS` via `setLedsPulseWidth()` | SNR vs power (MAX30100lib / oxullo API) |
| I2C clock | 100 kHz | Stable reads on jumper wires |
| High-res mode | enabled | Finer ADC |

**Why a drain task is mandatory:** The MAX30100 buffers samples in an internal **FIFO** (~16 samples). At 50 Hz, the FIFO fills in ~320 ms. Any main-loop stall longer than that (Serial printing, WiFi blocking, MPU I2C) causes **overflow** → duplicated or lost samples → distorted PPG and failed peak detection.

### 13.7 WebSocket URL construction

`buildWsPath()` formats:

```text
/ws/esp32?device_id=<WS_DEVICE_ID>&fs_hz=<WS_FS_HZ>&window_s=<WS_WINDOW_S>[&user_id=...][&session_id=...]
```

This must match what `bp_api` expects at connect time. Changing `WS_FS_HZ` in firmware without updating the query string (or server default) causes buffer length mismatch: the server waits for 2000 samples while the device sends at a different rate, delaying predictions or distorting apparent window duration.

`sendSampleWs` builds flat JSON matching Pydantic `Esp32Sample`—no nested objects. Extra keys are ignored by the server; missing `ir`/`red` cause PPG to freeze at last value.

### 13.8 Configuration checklist

1. Copy `config.example.h` → `config.h`.
2. Set `WIFI_SSID`, `WIFI_PASSWORD`.
3. Set `WS_HOST` to your PC **LAN IP** (e.g. `192.168.43.100` from phone hotspot).
4. Match `WS_FS_HZ` (250) to URL query `fs_hz=250`.
5. Optional: `WS_USER_ID` for Supabase inserts.
6. Flash with libraries: **MAX30100lib** (oxullo), Adafruit MPU6050, WebSockets. Uninstall **MAX3010x_Sensor_Library** if Arduino reports duplicate MAX30100.h.

**Start server:**

```bash
uvicorn bp_api.main:app --host 0.0.0.0 --port 8000
```

**Debug:** `#define DEBUG_SERIAL 1` prints ~10 Hz status on USB Serial including `ppg_overflows`.

### 13.9 Integration test procedure (recommended)

1. Build demo or real model: `python scripts/build_demo_model.py --out artifacts` (or train).
2. Start API: `uvicorn bp_api.main:app --host 0.0.0.0 --port 8000`.
3. Verify: `curl http://127.0.0.1:8000/health`.
4. Flash ESP32 with correct `WS_HOST` (PC LAN IP).
5. Open Serial Monitor at 921600 if `DEBUG_SERIAL 1`; confirm `ppg_overflows` stays near zero.
6. Watch server logs for `pred` JSON every ~8 s after connect.
7. Optional: set `WS_USER_ID` to dashboard Auth UUID; confirm Supabase rows appear.

### 13.10 Timing and latency

| Parameter | Value |
|-----------|-------|
| ECG sample rate | 250 Hz (`WS_FS_HZ`) |
| PPG hardware rate | 50 Hz (held to 250 Hz stream) |
| IMU effective rate | ~62.5 Hz |
| Samples per 8 s window | 2000 |
| Time to first `pred` | ~8 s + processing |
| WebSocket port | **8000** (uvicorn), not Next.js 3000 |

### 13.11 Network requirements

- ESP32 and PC on the **same LAN** (or routed port forward).
- Windows firewall must allow inbound TCP **8000**.
- Use `0.0.0.0` bind on uvicorn so LAN clients can connect.

---

## 14. Database (Supabase)

### 14.1 Schema overview

Three tables in `public` schema:

#### `devices`

| Column | Type | Description |
|--------|------|-------------|
| id | uuid PK | |
| user_id | uuid FK → auth.users | Owner |
| device_id | text | Logical device name |
| label | text | Optional display name |
| created_at | timestamptz | |

Unique: `(user_id, device_id)`

#### `sessions`

| Column | Type | Description |
|--------|------|-------------|
| id | uuid PK | |
| user_id | uuid FK | |
| device_id | text | |
| started_at | timestamptz | |
| ended_at | timestamptz | Optional |
| notes | text | |

#### `telemetry_windows` (primary data table)

| Column | Type | Description |
|--------|------|-------------|
| id | uuid PK | |
| user_id | uuid FK | Required for RLS |
| session_id | uuid FK | Optional |
| device_id | text | |
| ts_ms_start | bigint | Window start (ms) |
| fs_hz | int | Sampling rate |
| window_s | real | Window duration |
| schema_names | jsonb | Feature names used |
| features | jsonb | Feature vector array |
| sbp_pred | real | Predicted SBP |
| dbp_pred | real | Predicted DBP |
| sbp_std | real | Optional uncertainty |
| dbp_std | real | Optional uncertainty |
| ecg, ppg, accel, gyro | jsonb | Optional raw waveforms |
| created_at | timestamptz | Insert time |

**Indexes:** `(user_id, created_at DESC)`, `(device_id, created_at DESC)`, `(session_id, created_at DESC)`.

### 14.2 Row Level Security (RLS)

All tables have RLS **enabled**. Policies allow users to `SELECT/INSERT/UPDATE/DELETE` only rows where `auth.uid() = user_id`.

**Backend insert:** FastAPI uses **service role key**, which bypasses RLS — must only run server-side, never expose to browser.

**Dashboard read:** Uses **anon key** + user JWT — subject to RLS.

### 14.3 Applying schema

```bash
# Option A: Supabase SQL Editor — paste supabase/schema.sql
# Option B: Supabase CLI migration
supabase db push
```

Migration file: `supabase/migrations/20260508073947_init_schema.sql` (identical content to `schema.sql`).

### 14.4 Insert path from API

`_supabase_insert_telemetry` POSTs to:

```text
{SUPABASE_URL}/rest/v1/telemetry_windows
```

Headers: `apikey`, `Authorization: Bearer <service_role_key>`, `Prefer: return=minimal`.

---

## 15. Dashboards

### 15.1 Dash dashboard (`bp_dashboard/app.py`)

**Purpose:** Offline/demo analysis with CSV upload — no Supabase required.

**Run:**

```bash
python -m bp_dashboard.app
# Opens http://127.0.0.1:8050
```

**Modes:**

| Mode | CSV requirements |
|------|------------------|
| Actual | Columns `sbp`, `dbp`; optional `t` |
| Predict | Column `features` (JSON arrays) OR `f0`, `f1`, … |

**Environment:** `BP_API_URL` (default `http://127.0.0.1:8000`)

**Features:** Plotly line chart, SBP threshold alert (default 140 mmHg).

### 15.2 Next.js dashboard (`dashboard/`)

**Purpose:** Production-style UI — Supabase Auth, live feed, history.

**Run:**

```bash
cd dashboard
cp .env.local.example .env.local   # if example exists; else create from root .env.example
npm install
npm run dev
# http://localhost:3000
```

**Pages:**

| Route | File | Function |
|-------|------|----------|
| `/` | `src/app/page.tsx` | Sign-in, live KPI, table (50 rows), Supabase Realtime + WS fallback |
| `/history` | `src/app/history/page.tsx` | Last 500 windows, device filter |

**Modes:** User (curated row count) vs Detailed (shows row IDs).

**Missing file:** Create `dashboard/src/lib/supabaseClient.ts`:

```typescript
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const supabase: SupabaseClient | null =
  url && anon ? createClient(url, anon) : null;

export function supabaseEnvMissing(): boolean {
  return !url || !anon;
}
```

### 15.3 Live data paths (Next.js)

1. **Supabase Realtime** — `postgres_changes` on `INSERT` to `telemetry_windows`.
2. **WebSocket fallback** — `ws://127.0.0.1:8000/ws/dashboard` from FastAPI broadcast.

Both require user to be signed in (`session` non-null).

---

## 16. Environment configuration

### 16.1 Root `.env.example`

```env
BP_MODEL_PATH=artifacts/model.joblib
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY
```

### 16.2 Recommended layout

| File | Used by |
|------|---------|
| `.env.local` (repo root) | FastAPI via dotenv |
| `dashboard/.env.local` | Next.js (`NEXT_PUBLIC_*` only) |

**Never commit** real keys. `.gitignore` excludes `.env`, `.env.*` except `.env.example`.

---

## 17. Installation and setup

### 17.1 Prerequisites

- Python 3.10+ recommended
- Node.js 18+ (for Next.js dashboard)
- Git
- Optional: Supabase account, ESP32 toolchain

### 17.2 Python environment

```bash
cd finalproj_ml
python -m venv .venv

# Windows
.venv\Scripts\activate
# Linux/macOS
source .venv/bin/activate

pip install -r requirements.txt
```

**Windows note:** Project avoids `supabase` Python package; uses raw REST to prevent MSVC build tool requirements.

### 17.3 Train or copy artifacts

Either train (Section 10) or use `artifacts_physionet/` as template:

```bash
cp artifacts_physionet/model.joblib artifacts/model.joblib  # if model.joblib exists locally
```

(`model.joblib` is gitignored — you must train or obtain the binary.)

### 17.4 Supabase project

1. Create project at [supabase.com](https://supabase.com).
2. Run `supabase/schema.sql` in SQL Editor.
3. Enable Email auth (or provider of choice).
4. Copy URL, anon key, service role key to env files.
5. Optional: enable Realtime for `telemetry_windows`.

---

## 18. Running the full system

### 18.1 Terminal checklist (demo day)

```bash
# Terminal 1 — API
export BP_MODEL_PATH=artifacts/model.joblib
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...
uvicorn bp_api.main:app --reload --host 0.0.0.0 --port 8000

# Terminal 2 — Next.js
cd dashboard && npm run dev

# Terminal 3 — Replay OR ESP32
python scripts/replay_physionet_over_ws.py \
  --dataset-root data/pulse-transit-time-ppg \
  --record s1_walk \
  --user-id <paste from dashboard Copy button>
```

### 18.2 Verification

1. `GET http://127.0.0.1:8000/health` → `{"ok": true, "n_features": 10, "supabase": true}`
2. Sign in on dashboard → copy `user_id`
3. Run replay with that `user_id`
4. Live table updates within seconds

---

## 19. Evaluation metrics and reported results

### 19.1 Metrics computed

| Metric | Formula | Interpretation |
|--------|---------|----------------|
| MAE | `mean(|y - ŷ|)` | Average absolute error (mmHg) |
| RMSE | `sqrt(mean((y - ŷ)²))` | Penalizes large errors |

Computed **separately** for SBP and DBP.

### 19.2 Benchmark context (literature)

Cuffless BP papers often report:

- MAE 5–15 mmHg depending on dataset, protocol, and calibration.
- ISO 81060-2 requires mean error ≤ 5 mmHg and SD ≤ 8 mmHg for **validated cuff devices** — cuffless wearables in research typically do not meet clinical validation without per-user calibration.

**This MVP** achieves ~5.7 mmHg DBP MAE on PhysioNet hold-out but ~12 mmHg SBP MAE — suitable for **proof-of-concept**, not clinical diagnosis.

---

## 20. Security and privacy

| Topic | Implementation |
|-------|----------------|
| Authentication | Supabase Auth (email/password in dashboard) |
| Authorization | RLS on all tables |
| Service role | Server-only; full DB access |
| Anon key | Safe in browser; limited by RLS |
| Health data | Treat `telemetry_windows` as sensitive PHI |
| Transport | Use HTTPS/WSS in production |
| `user_id` in WebSocket | Currently client-supplied — **spoofing possible** without device auth token |

**Recommendation for production:** Validate JWT on WebSocket connect; map `sub` claim to `user_id` server-side.

---

## 21. Known limitations and risks

1. **Not clinically validated** — predictions are research estimates only.
2. **Subject leakage** — default random split inflates metrics; use `--group-by-subject`.
3. **Two feature pipelines** — PhysioNet vs generic `features.py` produce different feature sets; model must match ingest path.
4. **PWV proxy** — not true pulse wave velocity without arterial length.
5. **Simple motion handling** — no NLMS; poor performance under vigorous motion.
6. **Label noise** — PhysioNet uses mean of start/end BP per record, not beat-level ground truth.
7. **API schema contract** — client must send selected features in correct order.
8. **Missing Next.js supabase client file** — must be added manually (Section 15.2).
9. **SBP harder than DBP** — consistent with literature and current metrics.
10. **No online learning** — model is static after training.

---

## 22. Future work

| Priority | Item |
|----------|------|
| High | Per-subject calibration (offset scaling) |
| High | JWT-validated WebSocket ingest |
| Medium | NLMS motion artifact cancellation |
| Medium | Patient-grouped cross-validation reporting |
| Medium | Export full 12/16-D → selected feature mapping in API |
| Low | PCG / FSR features from Dataset 1 (if Kaggle loader restored) |
| Low | ONNX/TFLite export for on-device inference |
| Low | Separate SBP/DBP models or weighted loss |

---

## 23. Troubleshooting

### 23.1 Software / API

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ModuleNotFoundError: bp_pipeline` | PYTHONPATH | Run from repo root: `python -m bp_pipeline.train` or `PYTHONPATH=.` |
| `Failed to load model artifact` | Missing `model.joblib` | Train model or set `BP_MODEL_PATH` |
| `Expected N features, got M` | Schema mismatch | Match `feature_schema.json` length and order |
| Dashboard empty | Wrong `user_id` | Use UUID from signed-in user; same in replay |
| Supabase insert fails | RLS / missing key | Use service role on server; include `user_id` |
| `buffered_n` stuck low | `fs_hz` mismatch | Firmware 250 Hz must match `?fs_hz=250` |
| `buffered_n` never reaches `needed_n` | Stream too slow or disconnected WS | Check `[ws] connected` on Serial; verify `WS_HOST` IP |
| Next.js build error | Missing `@/lib/supabaseClient` | Add file from Section 15.2 |
| `non-finite feature values` | No R-peaks / PPG peaks in window | Reposition electrodes; reduce motion; lengthen `window_s` |
| `schema mismatch` | PhysioNet-trained model + generic features | Retrain or use consistent extractor path |

### 23.2 ESP32 / hardware

| Symptom | Cause | Fix |
|---------|-------|-----|
| Flat `ir`/`red` | FIFO overflow (old sketch) or finger off sensor | Flash `esp32_bp_stream`; keep finger still on MAX30100 |
| `ppg_overflows` increasing | Main loop still starved | Reduce `DEBUG_SERIAL`; check WiFi signal; do not block loop |
| `[ws] disconnected` loop | Wrong IP/port/firewall | `WS_HOST` = PC LAN IP; allow port 8000; run uvicorn `--host 0.0.0.0` |
| WiFi OK, no WS | Wrong path or server down | Path must start with `/ws/esp32?...` |
| Predictions every ~80 s not 8 s | ~25 Hz effective rate | Old firmware; use 250 Hz build |
| Jittery BP | Motion / poor ECG | Tighten electrodes; sit still during 8 s window |
| ECG stuck | Negative ADC dropout | Server holds last value; check analog front-end bias |

### 23.3 ML quality

| Symptom | Cause | Fix |
|---------|-------|-----|
| BP always ~same | Model underfitting or bad window | Check `metrics.json`; verify peaks in raw data |
| Large errors vs cuff | No calibration, domain shift | Expected for MVP; discuss limitations in thesis |
| Train great, live poor | Subject leakage in training | Retrain with `--group-by-subject` |

---

## Appendix A — Feature reference

### A.1 Generic pipeline (`DEFAULT_FEATURES`)

See [Section 9.2.1](#921-default-feature-schema-16-features).

### A.2 PhysioNet pipeline

| Feature | Unit / type | Computation summary |
|---------|-------------|---------------------|
| `rr_mean_s` | seconds | Mean of diff(R_peaks)/fs |
| `rr_std_s` | seconds | Std of RR intervals |
| `hr_mean_bpm` | bpm | 60 / rr_mean_s |
| `ptt_xcorr_s` | seconds | Cross-correlation lag distal vs proximal PPG |
| `ppg_distal_std` | a.u. | Std of filtered distal PPG |
| `ppg_prox_std` | a.u. | Std of filtered proximal PPG |
| `acc_rms` | a.u. | RMS of accel magnitude |
| `gyro_rms` | a.u. | RMS of gyro |
| `lc_1_mean` | a.u. | Mean load cell 1 |
| `lc_2_mean` | a.u. | Mean load cell 2 |

---

## Appendix B — API reference

### B.1 `GET /health`

**Response 200:**

```json
{
  "ok": true,
  "n_features": 10,
  "supabase": true
}
```

### B.2 `POST /predict`

**Request:**

```json
{
  "features": [1.2, 3.4, 0.05, 0.12, 0.03, 0.8, 0.1, 0.2, 0.15, 0.9]
}
```

**Response 200:**

```json
{
  "sbp": 118.4,
  "dbp": 76.2,
  "sbp_std": 2.1,
  "dbp_std": 1.3,
  "schema_names": ["gyro_rms", "..."]
}
```

**Errors:** 400 — wrong length, non-finite features after imputation.

### B.3 `POST /predict_batch`

**Request:**

```json
{
  "features": [
    [1.2, 3.4, ...],
    [1.1, 3.2, ...]
  ]
}
```

**Response:**

```json
{
  "sbp": [118.4, 119.0],
  "dbp": [76.2, 75.8],
  "schema_names": ["..."]
}
```

---

## Appendix C — CLI reference

### C.1 `python -m bp_pipeline.train`

Documented in [Section 10.2](#102-cli-arguments).

### C.2 `python scripts/download_physionet_ptt_ppg.py`

| Flag | Description |
|------|-------------|
| `--out` | Required output directory |
| `--overwrite` | Re-download existing files |
| `--csv-only` | Only CSV folder |
| `--wfdb-only` | Only WFDB records |

### C.3 `python scripts/replay_physionet_over_ws.py`

| Flag | Default | Description |
|------|---------|-------------|
| `--dataset-root` | required | WFDB root |
| `--record` | s1_walk | Record name |
| `--ppg-channel` | pleth_2 | PPG signal name |
| `--ws-url` | ws://127.0.0.1:8000/ws/ingest | Target WebSocket |
| `--device-id` | sim-physionet | Device identifier |
| `--user-id` | — | Supabase UUID |
| `--window-s` | 8.0 | Must match server |
| `--hop-s` | 1.0 | Chunk period |
| `--realtime` | false | Sleep between chunks |
| `--persist-raw` | false | Store waveforms in DB |

---

## Appendix D — File-by-file reference

| File | Responsibility |
|------|----------------|
| `bp_pipeline/preprocess.py` | Digital filters, motion mask, PPG peaks, PhysioNet PPG filter |
| `bp_pipeline/features.py` | R-peak, PTT series, full feature vector, `FeatureSchema` |
| `bp_pipeline/dataset.py` | CSV → (X, y) for custom datasets |
| `bp_pipeline/physionet_ptt_ppg.py` | PhysioNet load, windowing, alternate features |
| `bp_pipeline/train.py` | Training CLI, stacking model, metrics, artifacts |
| `bp_api/main.py` | FastAPI app, WebSockets, Supabase insert, buffering |
| `bp_dashboard/app.py` | Dash CSV UI |
| `dashboard/src/app/page.tsx` | Live dashboard React page |
| `dashboard/src/app/history/page.tsx` | History table |
| `dashboard/src/app/globals.css` | Dark theme design tokens |
| `supabase/schema.sql` | DDL + RLS |
| `scripts/replay_physionet_over_ws.py` | WFDB → WebSocket simulator |
| `scripts/download_physionet_ptt_ppg.py` | Dataset downloader |
| `docs/ESP32_WS_PROTOCOL.md` | Ingest WebSocket summary |
| `requirements.txt` | Python deps |
| `.env.example` | Env template |
| `artifacts_physionet/metrics.json` | Example evaluation results |
| `artifacts_physionet/feature_schema.json` | Example selected features |

---

## Appendix E — Glossary

| Term | Definition |
|------|------------|
| **SBP** | Systolic blood pressure — peak arterial pressure during ventricular ejection (mmHg) |
| **DBP** | Diastolic blood pressure — minimum pressure before next beat (mmHg) |
| **PPG** | Photoplethysmography — optical measure of blood volume changes |
| **ECG** | Electrocardiogram — electrical activity of the heart |
| **PTT** | Pulse transit time — delay between proximal and distal pulse events |
| **PWV** | Pulse wave velocity — speed of pressure wave along artery |
| **HRV** | Heart rate variability — beat-to-beat variation |
| **RMSSD** | Root mean square of successive RR differences |
| **RLS** | Row Level Security — Postgres per-row access policies |
| **WFDB** | Waveform Database format (PhysioNet standard) |
| **IMU** | Inertial measurement unit (accel + gyro) |
| **MVP** | Minimum viable product |

---

## Document history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | May 2026 | Initial comprehensive documentation |
| 1.1 | May 2026 | Expanded API, firmware, WebSocket, and system architecture details |
| 1.2 | May 2026 | Added deeper narrative on architecture, datasets, pipeline, training, inference, and ESP32 firmware |
| 1.3 | May 2026 | Reframed Section 4 as a formal project methodology chapter with research design, data method, model method, deployment method, testing, and reproducibility controls |
| 1.4 | May 2026 | Polished title page, contents, wording, and report-style presentation |

---

*This document describes the `finalproj_ml` repository as of the codebase snapshot used to generate it. Section 4 can be adapted directly as the methodology chapter of the final-year report; the later sections provide implementation evidence, commands, and technical appendices.*
