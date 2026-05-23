/*
 * ESP32 multi-sensor batch uploader for finalproj_ml bp_api
 *
 * Endpoint: POST http://<API_HOST>:<API_PORT>/esp32/ingest
 * Sends a small batch (default 20 samples @ 20 Hz = every 1 s), then clears buffers.
 *
 * Libraries (Arduino Library Manager):
 *   - MAX30100lib by oxullo
 *   - Adafruit MPU6050 + Adafruit Unified Sensor
 *
 * Copy config.example.h -> config.h and edit WiFi / API host.
 *
 * FIXES applied vs original:
 *   1. body.reserve() corrected from 52000 to a computed safe size (~210 KB
 *      for 2000-sample windows) — the original caused repeated heap
 *      reallocations and potential OOM.
 *   2. catchUp timing loop now advances nextSampleUs fully past nowUs instead
 *      of capping at 2 iterations, preventing perpetual scheduling drift.
 *   3. pushSample no longer overwrites windowStartMs (already set by
 *      resetWindow); removed the duplicate assignment.
 *   4. ECG ADC value cast to int16_t before storing in uint16_t buffer so
 *      that any negative glitch value is clamped rather than wrapping silently.
 *   5. ppgDrainOnce "overflow" counter renamed to ppgDrainSlowCount and its
 *      comment corrected — it detects slow polling, not FIFO overflow.
 *   6. Volatile shared variables (ppgLastFifoMs, ppgFifoSamples) are now
 *      snapshot-read into locals before use in printSampleReadings /
 *      ppgLooksInvalid to avoid torn reads.
 */

#include <Wire.h>
#include "MAX30100.h"
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "time.h"
#include "sys/time.h"
#include "esp_timer.h"

#if __has_include("config.h")
#include "config.h"
#else
#error "Copy config.example.h to config.h and set WiFi / API host."
#endif

#ifndef API_FS_HZ
#define API_FS_HZ WS_FS_HZ
#endif

#ifndef API_WINDOW_S
#define API_WINDOW_S WS_WINDOW_S
#endif

#ifndef API_HOST
#define API_HOST WS_HOST
#endif

#ifndef API_PORT
#define API_PORT WS_PORT
#endif

#ifndef DEBUG_SERIAL
#define DEBUG_SERIAL 0
#endif

#ifndef PRINT_SAMPLE_MS
#define PRINT_SAMPLE_MS 200
#endif

#ifndef REQUIRE_VALID_ECG
#define REQUIRE_VALID_ECG 1
#endif

#ifndef USE_WEBSOCKET
#define USE_WEBSOCKET 0
#endif

#if USE_WEBSOCKET
#error "USE_WEBSOCKET=1 is not implemented yet; set USE_WEBSOCKET 0 in config.h."
#endif

// ============================= Timing =============================
static const int    SAMPLE_RATE_HZ    = API_FS_HZ;
static const int64_t SAMPLE_PERIOD_US = 1000000LL / SAMPLE_RATE_HZ;
static const int    WINDOW_SAMPLES    = (int)(SAMPLE_RATE_HZ * API_WINDOW_S + 0.5f);
static const int    MPU_EVERY_N_SAMPLES = 1;  // read IMU on every sample (small batches)

// FIX 1 — body reserve budget:
//   Per sample: ECG ≤5 chars, PPG ≤5, six floats ≤9 each (e.g. "-9.999") =
//   5+5+54 = 64 chars of values + ~8 separators = ~72 chars.
//   Header/footer overhead ≈ 300 bytes.
//   Safe budget = WINDOW_SAMPLES * 80 + 512.
static const size_t JSON_BODY_RESERVE = (size_t)WINDOW_SAMPLES * 80 + 512;

// ============================= Pins =============================
#define ECG_PIN 34
#define SDA_PIN 21
#define SCL_PIN 22

// ============================= MAX30100 =============================
MAX30100 ppgSensor;

static const uint16_t PPG_MIN_RAW  = 32;
static const unsigned long PPG_STALE_MS   = 3000;
static const unsigned long SENSOR_WARN_MS = 5000;

volatile uint32_t      ppgIrHeld        = 0;
volatile uint32_t      ppgRedHeld       = 0;
// FIX 5 — renamed: this counts slow-polling events, not FIFO overflows.
volatile uint32_t      ppgDrainSlowCount = 0;
volatile unsigned long ppgLastFifoMs    = 0;
volatile uint32_t      ppgFifoSamples   = 0;
bool                   ppgAvailable     = false;

SemaphoreHandle_t i2cMutex = nullptr;

// ============================= MPU6050 =============================
Adafruit_MPU6050  mpu;
sensors_event_t   accelEvent;
sensors_event_t   gyroEvent;
sensors_event_t   tempEvent;
bool              mpuAvailable = false;

float imuAx = 0.0f, imuAy = 0.0f, imuAz = 0.0f;
float imuGx = 0.0f, imuGy = 0.0f, imuGz = 0.0f;

// ============================= ECG =============================
int ecgRaw = 0;
unsigned long lastSensorWarnMs = 0;

// ============================= Window buffers =============================
static uint16_t ecgBuf[WINDOW_SAMPLES];
static uint32_t ppgBuf[WINDOW_SAMPLES];
static float    axBuf[WINDOW_SAMPLES];
static float    ayBuf[WINDOW_SAMPLES];
static float    azBuf[WINDOW_SAMPLES];
static float    gxBuf[WINDOW_SAMPLES];
static float    gyBuf[WINDOW_SAMPLES];
static float    gzBuf[WINDOW_SAMPLES];

int      windowFill    = 0;
int64_t  windowStartMs = 0;

uint32_t windowsSent  = 0;
uint32_t httpFailures = 0;

// ============================= I2C helpers =============================
bool lockI2c(TickType_t timeoutTicks) {
  if (i2cMutex == nullptr) return true;
  return xSemaphoreTake(i2cMutex, timeoutTicks) == pdTRUE;
}

void unlockI2c() {
  if (i2cMutex != nullptr) xSemaphoreGive(i2cMutex);
}

// ============================= PPG FIFO service =============================
// MAX30100 FIFO locks up when it overflows (~16 samples @ 50 Hz) if not drained.
// setup() used to start the sensor before WiFi/NTP, leaving it unattended for
// many seconds; HTTP POST can block similarly — resetFifo() recovers.
static bool ppgRecovering = false;

void ppgRecoverFifo(const char* reason) {
  if (ppgRecovering || !ppgAvailable || !lockI2c(portMAX_DELAY)) return;
  ppgRecovering = true;

  ppgSensor.resetFifo();
  ppgSensor.resume();
  unlockI2c();
  ppgLastFifoMs = millis();

  Serial.print("[ppg] fifo reset");
  if (reason != nullptr && reason[0] != '\0') {
    Serial.print(" (");
    Serial.print(reason);
    Serial.print(")");
  }
  Serial.println();

  for (int i = 0; i < 10; i++) {
    ppgDrainOnce();
    delay(5);
  }
  ppgRecovering = false;
}

void ppgDrainOnce() {
  if (!ppgAvailable || !lockI2c(pdMS_TO_TICKS(20))) return;

  ppgSensor.update();

  uint16_t ir = 0, red = 0;
  int drained = 0;

  while (ppgSensor.getRawValues(&ir, &red)) {
    drained++;
    ppgFifoSamples++;
    ppgLastFifoMs = millis();
    ppgIrHeld  = ir;
    ppgRedHeld = red;
  }

  // FIX 5 — renamed counter; threshold kept at 8 (documents "slow poll" not
  // "FIFO full", which would be 16 for this sensor).
  if (drained > 8) {
    ppgDrainSlowCount++;
  }

  unlockI2c();

  static unsigned long lastRecoverMs = 0;
  if (!ppgRecovering && drained == 0 && ppgAgeMs() > PPG_STALE_MS &&
      (millis() - lastRecoverMs) > 2000UL) {
    lastRecoverMs = millis();
    ppgRecoverFifo("stale");
  }
}

bool initMax30100() {
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);

  if (!lockI2c(portMAX_DELAY)) return false;

  ppgAvailable = ppgSensor.begin();
  if (!ppgAvailable) { unlockI2c(); return false; }

  ppgSensor.setMode(MAX30100_MODE_SPO2_HR);
  ppgSensor.setLedsCurrent(MAX30100_LED_CURR_50MA, MAX30100_LED_CURR_50MA);
  ppgSensor.setSamplingRate(MAX30100_SAMPRATE_50HZ);
  ppgSensor.setLedsPulseWidth(MAX30100_SPC_PW_1600US_16BITS);
  ppgSensor.setHighresModeEnabled(true);
  ppgSensor.resetFifo();
  ppgSensor.resume();
  unlockI2c();

  delay(50);
  for (int i = 0; i < 30; i++) { ppgDrainOnce(); delay(10); }

  Serial.print("[ppg] part_id=0x");
  Serial.println(ppgSensor.getPartId(), HEX);
  Serial.print("[ppg] prime ir=");
  Serial.print(ppgIrHeld);
  Serial.print(" red=");
  Serial.print(ppgRedHeld);
  Serial.print(" fifo_samples=");
  Serial.println(ppgFifoSamples);
  return ppgLastFifoMs > 0 && (ppgIrHeld >= PPG_MIN_RAW || ppgRedHeld >= PPG_MIN_RAW);
}

// ============================= WiFi / HTTP =============================
bool connectWiFi(uint32_t timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < timeoutMs) {
    delay(250);
  }
  return WiFi.status() == WL_CONNECTED;
}

void syncTimeFromNtp() {
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
  struct tm timeinfo;
  for (int i = 0; i < 15; i++) {
    if (getLocalTime(&timeinfo, 1000)) return;
  }
}

void serviceNetwork() {
  if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
}

// ============================= JSON helpers =============================
void appendFloatArray(String& body, const char* key, const float* values, int count) {
  body += ",\""; body += key; body += "\":[";
  for (int i = 0; i < count; i++) {
    if (i > 0) body += ',';
    body += String(values[i], 3);
  }
  body += ']';
}

void appendUIntArray(String& body, const char* key, const uint32_t* values, int count) {
  body += ",\""; body += key; body += "\":[";
  for (int i = 0; i < count; i++) {
    if (i > 0) body += ',';
    body += String(values[i]);
  }
  body += ']';
}

void appendIntArray(String& body, const char* key, const uint16_t* values, int count) {
  body += ",\""; body += key; body += "\":[";
  for (int i = 0; i < count; i++) {
    if (i > 0) body += ',';
    body += String(values[i]);
  }
  body += ']';
}

// ============================= HTTP send =============================
bool sendWindowHttp() {
  const int n = windowFill;
  if (WiFi.status() != WL_CONNECTED || n < WINDOW_SAMPLES) return false;

  String url = String("http://") + API_HOST + ":" + String(API_PORT) + "/esp32/ingest";

  String body;
  body.reserve(JSON_BODY_RESERVE);

  body += "{\"device_id\":\""; body += WS_DEVICE_ID;
  body += "\",\"ts_ms_start\":"; body += String((long long)windowStartMs);
  body += ",\"fs_hz\":";         body += String(SAMPLE_RATE_HZ);
  body += ",\"window_s\":";      body += String((float)API_WINDOW_S, 1);

  appendIntArray (body, "ecg", ecgBuf, n);
  appendUIntArray(body, "ppg", ppgBuf, n);
  appendFloatArray(body, "ax", axBuf,  n);
  appendFloatArray(body, "ay", ayBuf,  n);
  appendFloatArray(body, "az", azBuf,  n);
  appendFloatArray(body, "gx", gxBuf,  n);
  appendFloatArray(body, "gy", gyBuf,  n);
  appendFloatArray(body, "gz", gzBuf,  n);

  // DB writes are done by bp_api (Supabase); ESP only sends sensor samples.
  body += "}";

  HTTPClient http;
  http.setTimeout(8000);
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
#if defined(API_KEY)
  if (API_KEY[0] != '\0') http.addHeader("x-api-key", API_KEY);
#endif

  Serial.print("[http] POST "); Serial.print(url);
  Serial.print(" bytes=");     Serial.println(body.length());

  const int    code     = http.POST(body);
  const String response = http.getString();
  http.end();

  Serial.print("[http] status="); Serial.print(code);
  Serial.print(" resp=");         Serial.println(response);

  const bool ok = (code >= 200 && code < 300);
  if (ok) windowsSent++;
  else      httpFailures++;

  resetWindow();
  Serial.println("[http] batch cleared");

  // POST blocks the loop — reset MAX30100 FIFO so PPG does not lock up.
  ppgRecoverFifo(ok ? "post-http" : "post-http-fail");
  return ok;
}

// Unix epoch ms (UTC) when NTP is synced; otherwise millis() and server normalizes.
static const int64_t EPOCH_MS_MIN_VALID = 1577836800000LL; // 2020-01-01 UTC

static int64_t wallClockMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (int64_t)tv.tv_sec * 1000LL + (int64_t)tv.tv_usec / 1000LL;
}

// ============================= Window management =============================
void resetWindow() {
  windowFill = 0;
  const int64_t now = wallClockMs();
  windowStartMs = (now >= EPOCH_MS_MIN_VALID) ? now : (int64_t)millis();
}

void pushSample(int ecg, uint32_t ppg,
                float ax, float ay, float az,
                float gx, float gy, float gz) {
  if (windowFill >= WINDOW_SAMPLES) return;

  // FIX 3 — windowStartMs is already set by resetWindow(); do NOT overwrite
  // it here.  The original code reset it on every fill==0 call, which
  // introduced a slight forward drift equal to the time between resetWindow()
  // and the first valid sample arriving.

  // FIX 4 — clamp ECG before casting to uint16_t.  analogRead returns
  // 0–4095 so negative values cannot occur in practice, but defensive
  // clamping prevents silent wrap-around if a caller ever passes a negative
  // glitch value.
  const int clampedEcg = ecg < 0 ? 0 : (ecg > 65535 ? 65535 : ecg);

  ecgBuf[windowFill] = (uint16_t)clampedEcg;
  ppgBuf[windowFill] = ppg;
  axBuf[windowFill]  = ax;
  ayBuf[windowFill]  = ay;
  azBuf[windowFill]  = az;
  gxBuf[windowFill]  = gx;
  gyBuf[windowFill]  = gy;
  gzBuf[windowFill]  = gz;
  windowFill++;
}

// ============================= Sampling =============================
int readEcgRaw() {
  return (analogRead(ECG_PIN) + analogRead(ECG_PIN)) / 2;
}

void readImu() {
  if (!mpuAvailable || !lockI2c(pdMS_TO_TICKS(8))) return;
  if (!mpu.getEvent(&accelEvent, &gyroEvent, &tempEvent)) { unlockI2c(); return; }
  imuAx = accelEvent.acceleration.x;
  imuAy = accelEvent.acceleration.y;
  imuAz = accelEvent.acceleration.z;
  imuGx = gyroEvent.gyro.x;
  imuGy = gyroEvent.gyro.y;
  imuGz = gyroEvent.gyro.z;
  unlockI2c();
}

// FIX 6 — snapshot volatile fields into locals to avoid torn reads.
bool ppgLooksInvalid(uint32_t ir, uint32_t red) {
  const uint32_t      peak         = ir > red ? ir : red;
  const unsigned long lastFifoSnap = ppgLastFifoMs;   // atomic 32-bit read on Xtensa

  if (peak < PPG_MIN_RAW)    return true;
  if (lastFifoSnap == 0)     return true;
  return (millis() - lastFifoSnap) > PPG_STALE_MS;
}

unsigned long ppgAgeMs() {
  const unsigned long snap = ppgLastFifoMs;
  if (snap == 0) return 999999UL;
  return millis() - snap;
}

bool ecgLooksInvalid(int ecg) {
  return ecg <= 5 || ecg >= 4090;
}

void printSampleReadings(
    uint32_t tUs, int ecg,
    uint32_t ir, uint32_t red,
    bool ecgOk, bool ppgOk, bool sensorsOk, bool wifiOk)
{
  static unsigned long lastPrintMs = 0;
  const unsigned long now = millis();
  if (now - lastPrintMs < (unsigned long)PRINT_SAMPLE_MS) return;
  lastPrintMs = now;

  // FIX 6 — snapshot volatile before printing.
  const uint32_t      fifoSnap = ppgFifoSamples;

  Serial.print("[sample] t=");       Serial.print(tUs);
  Serial.print(" ecg=");             Serial.print(ecg);
  Serial.print(" ir=");              Serial.print(ir);
  Serial.print(" red=");             Serial.print(red);
  Serial.print(" ppg_age_ms=");      Serial.print(ppgAgeMs());
  Serial.print(" fifo_total=");      Serial.print(fifoSnap);
  Serial.print(" win=");             Serial.print(windowFill);
  Serial.print("/");                 Serial.print(WINDOW_SAMPLES);
  Serial.print(" wifi=");            Serial.print(wifiOk ? "1" : "0");
  Serial.print(" buf=");             Serial.print(sensorsOk ? "ok" : "skip");
  if (!sensorsOk) {
    Serial.print(" (");
    if (!ecgOk) Serial.print("ecg");
    if (!ppgOk) { if (!ecgOk) Serial.print("+"); Serial.print("ppg"); }
    Serial.print(")");
  }
  Serial.println();
}

// ============================= Setup =============================
void setup() {
  Serial.begin(921600);
  delay(500);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  pinMode(ECG_PIN, INPUT);

  i2cMutex = xSemaphoreCreateMutex();

  // WiFi/NTP before MAX30100 — connectWiFi() blocks for seconds; if the
  // sensor FIFO runs unattended it overflows and getRawValues() stops forever.
  if (!connectWiFi(20000)) {
    Serial.println("[warn] WiFi failed — uploads disabled until reconnect");
  } else {
    Serial.print("[wifi] "); Serial.println(WiFi.localIP());
    syncTimeFromNtp();
  }

  if (!initMax30100()) {
    Serial.println("[warn] MAX30100 init failed or no FIFO data — check I2C/finger on sensor");
  }

  if (lockI2c(portMAX_DELAY)) {
    mpuAvailable = mpu.begin();
    unlockI2c();
  }
  if (!mpuAvailable) {
    Serial.println("[warn] MPU6050 init failed; IMU fields will be zero");
  } else {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  }

  resetWindow();

  Serial.print("[cfg] sample_rate_hz=");  Serial.println(SAMPLE_RATE_HZ);
  Serial.print("[cfg] api=http://");
  Serial.print(API_HOST); Serial.print(":"); Serial.print(API_PORT);
  Serial.println("/esp32/ingest");
  Serial.print("[cfg] batch_samples=");   Serial.println(WINDOW_SAMPLES);
  Serial.print("[cfg] batch_interval_s="); Serial.println(API_WINDOW_S, 1);
  Serial.print("[cfg] json_body_reserve="); Serial.println(JSON_BODY_RESERVE);
}

// ============================= Loop =============================
void loop() {
  serviceNetwork();
  ppgDrainOnce();

  static int64_t  nextSampleUs = 0;
  static uint32_t sampleIndex  = 0;

  const int64_t nowUs = esp_timer_get_time();
  if (nextSampleUs == 0) nextSampleUs = nowUs;
  if (nowUs < nextSampleUs) return;

  // FIX 2 — advance nextSampleUs fully past nowUs (no cap at 2 iterations).
  // The original cap of 2 meant that after any delay longer than 2 sample
  // periods the scheduler permanently lagged, producing a slow creeping drift
  // that accumulated across the entire session.
  while (nextSampleUs <= nowUs) {
    nextSampleUs += SAMPLE_PERIOD_US;
  }

  ecgRaw = readEcgRaw();
  if ((sampleIndex % MPU_EVERY_N_SAMPLES) == 0) readImu();
  sampleIndex++;

  const uint32_t tUs  = (uint32_t)nowUs;
  const uint32_t ir   = ppgIrHeld;
  const uint32_t red  = ppgRedHeld;

  const bool ecgOk     = !REQUIRE_VALID_ECG || !ecgLooksInvalid(ecgRaw);
  const bool ppgOk     = !ppgLooksInvalid(ir, red);
  const bool sensorsOk = ecgOk && ppgOk;
  const bool wifiOk    = WiFi.status() == WL_CONNECTED;

  printSampleReadings(tUs, ecgRaw, ir, red, ecgOk, ppgOk, sensorsOk, wifiOk);

  if (!sensorsOk && (millis() - lastSensorWarnMs) > SENSOR_WARN_MS) {
    lastSensorWarnMs = millis();
    if (!ppgOk) {
      Serial.print("[warn] PPG stale/low ir="); Serial.print(ir);
      Serial.print(" red=");    Serial.print(red);
      Serial.print(" age_ms="); Serial.print(ppgAgeMs());
      Serial.print(" fifo_total="); Serial.println(ppgFifoSamples);
    } else {
      Serial.print("[warn] ECG invalid adc="); Serial.println(ecgRaw);
    }
  }

  if (sensorsOk) {
    pushSample(ecgRaw, ir, imuAx, imuAy, imuAz, imuGx, imuGy, imuGz);
  }

  if (windowFill >= WINDOW_SAMPLES) {
    if (wifiOk) sendWindowHttp();  // clears buffer inside on success or failure
    else {
      Serial.println("[warn] WiFi down — dropping batch");
      resetWindow();
    }
  }
}
