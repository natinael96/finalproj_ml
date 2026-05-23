#pragma once

// Copy this file to `config.h` in the same folder (config.h is gitignored).

#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// PC running: uvicorn bp_api.main:app --host 0.0.0.0 --port 8088
// API_PORT must match uvicorn --port (e.g. 8000 or 8088)
#define API_HOST "192.168.1.100"
#define API_PORT 8088

#define WS_DEVICE_ID "esp32-001"
// Friendly name shown on the dashboard (can be renamed there too).
#define DEVICE_NAME "My ESP32"
// Batch upload: 20 samples every 1 s → fs_hz=20, window_s=1.0
#define WS_FS_HZ 20
#define WS_WINDOW_S 1.0f

// User/session for Supabase are set on the server (.env BP_DEFAULT_USER_ID), not on ESP32.

// Optional — match BP_API_KEY on the server if set
#define API_KEY ""

// Set 1 to use WebSocket streaming (legacy); 0 = HTTP POST /esp32/ingest every 1 s
#define USE_WEBSOCKET 0

// NTP (East Africa Time = UTC+3)
#define NTP_SERVER "pool.ntp.org"
#define GMT_OFFSET_SEC (3 * 3600)
#define DAYLIGHT_OFFSET_SEC 0

#define DEBUG_SERIAL 0
#define PRINT_SAMPLE_MS 200
#define REQUIRE_VALID_ECG 0
