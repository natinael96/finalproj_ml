/*
 * ESP32 multi-sensor streamer for finalproj_ml bp_api
 *
 * Endpoint: ws://<WS_HOST>:<WS_PORT>/ws/esp32?device_id=...&fs_hz=250
 * One JSON object per sample (see bp_api/main.py Esp32Sample).
 *
 * Libraries (Arduino Library Manager):
 *   - MAX30100lib by oxullo (use setLedsPulseWidth; remove MAX3010x_Sensor_Library if duplicate)
 *   - Adafruit MPU6050 + Adafruit Unified Sensor
 *   - WebSockets by Markus Sattler (Links2004)
 *
 * Copy config.example.h -> config.h and edit WiFi / WS_HOST.
 */

#include <Wire.h>
#include "MAX30100.h"
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include "time.h"
#include "esp_timer.h"

#if __has_include("config.h")
#include "config.h"
#else
#error "Copy config.example.h to config.h and set WiFi / WebSocket host."
#endif

#ifndef WS_FS_HZ
#define WS_FS_HZ 250
#endif

#ifndef DEBUG_SERIAL
#define DEBUG_SERIAL 0
#endif

// ============================= Timing =============================
static const int SAMPLE_RATE_HZ = WS_FS_HZ;
static const int64_t SAMPLE_PERIOD_US = 1000000LL / SAMPLE_RATE_HZ;
static const int MPU_EVERY_N_SAMPLES = 4;  // IMU at SAMPLE_RATE_HZ / N

// ============================= Pins =============================
#define ECG_PIN 34
#define SDA_PIN 21
#define SCL_PIN 22

// ============================= MAX30100 =============================
MAX30100 ppgSensor;

static const float PPG_ALPHA = 0.90f;
static const uint16_t PPG_MIN_RAW = 100;

volatile uint32_t ppgIrFiltered = 0;
volatile uint32_t ppgRedFiltered = 0;
volatile uint32_t ppgDrainOverflows = 0;

// ============================= MPU6050 =============================
Adafruit_MPU6050 mpu;
sensors_event_t accelEvent;
sensors_event_t gyroEvent;
sensors_event_t tempEvent;

float imuAx = 0.0f;
float imuAy = 0.0f;
float imuAz = 0.0f;
float imuGx = 0.0f;
float imuGy = 0.0f;
float imuGz = 0.0f;

// ============================= ECG =============================
int ecgRaw = 0;

// ============================= WiFi / WebSocket =============================
WebSocketsClient webSocket;
char wsPath[320];

time_t bootEpoch = 0;
unsigned long bootMillis = 0;

unsigned long lastWsReconnectAttempt = 0;
static const unsigned long WS_RECONNECT_MS = 5000;

uint32_t samplesSent = 0;
uint32_t wsSendFailures = 0;

// ============================= PPG FIFO service =============================
void ppgDrainOnce() {
  ppgSensor.update();

  uint16_t ir = 0;
  uint16_t red = 0;
  int drained = 0;

  while (ppgSensor.getRawValues(&ir, &red)) {
    drained++;
    if (ir > PPG_MIN_RAW && red > PPG_MIN_RAW) {
      float irF = (PPG_ALPHA * (float)ppgIrFiltered) + ((1.0f - PPG_ALPHA) * (float)ir);
      float redF = (PPG_ALPHA * (float)ppgRedFiltered) + ((1.0f - PPG_ALPHA) * (float)red);
      ppgIrFiltered = (uint32_t)irF;
      ppgRedFiltered = (uint32_t)redF;
    }
  }

  // FIFO depth is small; draining >8 in one pass means the main loop was starved
  if (drained > 8) {
    ppgDrainOverflows++;
  }
}

void ppgDrainTask(void* /*param*/) {
  for (;;) {
    ppgDrainOnce();
    vTaskDelay(pdMS_TO_TICKS(2));  // 500 Hz service >> 50 Hz PPG sample rate
  }
}

// ============================= WiFi =============================
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
    if (getLocalTime(&timeinfo, 1000)) {
      time(&bootEpoch);
      bootMillis = millis();
      return;
    }
  }

  bootEpoch = 0;
  bootMillis = millis();
}

void buildWsPath() {
  char userPart[96] = "";
  char sessionPart[96] = "";

#if defined(WS_USER_ID)
  if (WS_USER_ID[0] != '\0') {
    snprintf(userPart, sizeof(userPart), "&user_id=%s", WS_USER_ID);
  }
#endif
#if defined(WS_SESSION_ID)
  if (WS_SESSION_ID[0] != '\0') {
    snprintf(sessionPart, sizeof(sessionPart), "&session_id=%s", WS_SESSION_ID);
  }
#endif

  snprintf(
      wsPath,
      sizeof(wsPath),
      "/ws/esp32?device_id=%s&fs_hz=%d&window_s=%.1f%s%s",
      WS_DEVICE_ID,
      WS_FS_HZ,
      WS_WINDOW_S,
      userPart,
      sessionPart);
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("[ws] disconnected");
      break;
    case WStype_CONNECTED:
      Serial.print("[ws] connected ");
      Serial.println((const char*)payload);
      break;
    case WStype_TEXT:
#if DEBUG_SERIAL
      Serial.print("[ws] ");
      Serial.write(payload, length);
      Serial.println();
#else
      (void)payload;
      (void)length;
#endif
      break;
    default:
      break;
  }
}

void connectWebSocket() {
  webSocket.disconnect();
  webSocket.onEvent(webSocketEvent);
  webSocket.begin(WS_HOST, WS_PORT, wsPath);
}

void serviceNetwork() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    return;
  }

  webSocket.loop();

  if (!webSocket.isConnected()) {
    const unsigned long now = millis();
    if (now - lastWsReconnectAttempt >= WS_RECONNECT_MS) {
      lastWsReconnectAttempt = now;
      connectWebSocket();
    }
  }
}

// ============================= Sampling =============================
int readEcgRaw() {
  // Light averaging — keep well under 4 ms budget at 250 Hz
  return (analogRead(ECG_PIN) + analogRead(ECG_PIN)) / 2;
}

void readImu() {
  if (!mpu.getEvent(&accelEvent, &gyroEvent, &tempEvent)) {
    return;
  }
  imuAx = accelEvent.acceleration.x;
  imuAy = accelEvent.acceleration.y;
  imuAz = accelEvent.acceleration.z;
  imuGx = gyroEvent.gyro.x;
  imuGy = gyroEvent.gyro.y;
  imuGz = gyroEvent.gyro.z;
}

bool sendSampleWs(uint32_t tUs, int ecg, uint32_t ir, uint32_t red) {
  char buf[220];
  const int n = snprintf(
      buf,
      sizeof(buf),
      "{\"t\":%lu,\"ecg\":%d,\"ir\":%lu,\"red\":%lu,"
      "\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,"
      "\"gx\":%.3f,\"gy\":%.3f,\"gz\":%.3f}",
      (unsigned long)tUs,
      ecg,
      (unsigned long)ir,
      (unsigned long)red,
      imuAx,
      imuAy,
      imuAz,
      imuGx,
      imuGy,
      imuGz);

  if (n <= 0 || n >= (int)sizeof(buf)) {
    return false;
  }
  return webSocket.sendTXT(buf);
}

#if DEBUG_SERIAL
void printDebugJson(uint32_t tUs, int ecg, uint32_t ir, uint32_t red) {
  static unsigned long lastPrint = 0;
  if (millis() - lastPrint < 100) {
    return;
  }
  lastPrint = millis();

  const time_t currentEpoch = bootEpoch + ((millis() - bootMillis) / 1000);
  struct tm* tmInfo = localtime(&currentEpoch);

  char timeString[32];
  if (tmInfo) {
    snprintf(
        timeString,
        sizeof(timeString),
        "%02d:%02d:%02d.%03lu",
        tmInfo->tm_hour,
        tmInfo->tm_min,
        tmInfo->tm_sec,
        millis() % 1000);
  } else {
    snprintf(timeString, sizeof(timeString), "00:00:00.%03lu", millis() % 1000);
  }

  Serial.print("{\"t_ms\":");
  Serial.print(millis());
  Serial.print(",\"time\":\"");
  Serial.print(timeString);
  Serial.print("\",\"t\":");
  Serial.print(tUs);
  Serial.print(",\"ecg\":");
  Serial.print(ecg);
  Serial.print(",\"ir\":");
  Serial.print(ir);
  Serial.print(",\"red\":");
  Serial.print(red);
  Serial.print(",\"ax\":");
  Serial.print(imuAx, 3);
  Serial.print(",\"ay\":");
  Serial.print(imuAy, 3);
  Serial.print(",\"az\":");
  Serial.print(imuAz, 3);
  Serial.print(",\"gx\":");
  Serial.print(imuGx, 3);
  Serial.print(",\"gy\":");
  Serial.print(imuGy, 3);
  Serial.print(",\"gz\":");
  Serial.print(imuGz, 3);
  Serial.print(",\"ppg_overflows\":");
  Serial.print((unsigned long)ppgDrainOverflows);
  Serial.println("}");
}
#endif

// ============================= Setup =============================
void setup() {
  Serial.begin(921600);
  delay(500);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  pinMode(ECG_PIN, INPUT);

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);

  if (!ppgSensor.begin()) {
    Serial.println("[fatal] MAX30100 init failed");
    while (true) {
      delay(1000);
    }
  }

  ppgSensor.setMode(MAX30100_MODE_SPO2_HR);
  ppgSensor.setLedsCurrent(MAX30100_LED_CURR_27_1MA, MAX30100_LED_CURR_27_1MA);
  ppgSensor.setSamplingRate(MAX30100_SAMPRATE_50HZ);
  ppgSensor.setLedsPulseWidth(MAX30100_SPC_PW_1600US_16BITS);
  ppgSensor.setHighresModeEnabled(true);

  if (!mpu.begin()) {
    Serial.println("[fatal] MPU6050 init failed");
    while (true) {
      delay(1000);
    }
  }

  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);

  buildWsPath();

  if (!connectWiFi(20000)) {
    Serial.println("[warn] WiFi failed — streaming disabled until reconnect");
  } else {
    Serial.print("[wifi] ");
    Serial.println(WiFi.localIP());
    syncTimeFromNtp();
    connectWebSocket();
  }

  xTaskCreatePinnedToCore(ppgDrainTask, "ppgDrain", 4096, nullptr, 2, nullptr, 0);

  Serial.print("[cfg] sample_rate_hz=");
  Serial.print(SAMPLE_RATE_HZ);
  Serial.print(" ws_path=");
  Serial.println(wsPath);
}

// ============================= Loop =============================
void loop() {
  serviceNetwork();

  static int64_t nextSampleUs = 0;
  static uint32_t sampleIndex = 0;

  const int64_t nowUs = esp_timer_get_time();
  if (nextSampleUs == 0) {
    nextSampleUs = nowUs;
  }
  if (nowUs < nextSampleUs) {
    return;
  }

  // Catch up at most 2 ticks if we were blocked by WiFi
  int catchUp = 0;
  while (nowUs >= nextSampleUs && catchUp < 2) {
    nextSampleUs += SAMPLE_PERIOD_US;
    catchUp++;
  }

  ecgRaw = readEcgRaw();

  if ((sampleIndex % MPU_EVERY_N_SAMPLES) == 0) {
    readImu();
  }
  sampleIndex++;

  const uint32_t tUs = (uint32_t)nowUs;
  const uint32_t ir = ppgIrFiltered;
  const uint32_t red = ppgRedFiltered;

  if (webSocket.isConnected()) {
    if (sendSampleWs(tUs, ecgRaw, ir, red)) {
      samplesSent++;
    } else {
      wsSendFailures++;
    }
  }

#if DEBUG_SERIAL
  printDebugJson(tUs, ecgRaw, ir, red);
#endif
}
