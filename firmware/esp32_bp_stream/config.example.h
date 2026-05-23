#pragma once

// Copy this file to `config.h` in the same folder (config.h is gitignored).

#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// PC running: uvicorn bp_api.main:app --host 0.0.0.0 --port 8088
// API_PORT must match uvicorn --port (e.g. 8000 or 8088)
#define API_HOST "192.168.1.100"
#define API_PORT 8088

#define WS_DEVICE_ID "esp32-001"
// Batch upload: N samples every INTERVAL ms (default 10 @ 1 Hz = 10 samples/s)
#define WS_FS_HZ 10
#define WS_WINDOW_S 1.0f

// User/session for Supabase are set on the server (.env BP_DEFAULT_USER_ID), not on ESP32.

// Optional — match BP_API_KEY on the server if set
#define API_KEY ""

// Set 1 to use WebSocket streaming (legacy); 0 = HTTP POST /esp32/ingest every 8 s
#define USE_WEBSOCKET 0

// NTP (East Africa Time = UTC+3)
#define NTP_SERVER "pool.ntp.org"
#define GMT_OFFSET_SEC (3 * 3600)
#define DAYLIGHT_OFFSET_SEC 0

#define DEBUG_SERIAL 0
#define PRINT_SAMPLE_MS 200
#define REQUIRE_VALID_ECG 0
