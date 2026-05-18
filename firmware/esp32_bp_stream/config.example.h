#pragma once

// Copy this file to `config.h` in the same folder (config.h is gitignored).

#define WIFI_SSID "your-wifi-ssid"
#define WIFI_PASSWORD "your-wifi-password"

// PC running: uvicorn bp_api.main:app --host 0.0.0.0 --port 8000
#define WS_HOST "192.168.1.100"
#define WS_PORT 8000

#define WS_DEVICE_ID "esp32-001"
#define WS_FS_HZ 250
#define WS_WINDOW_S 8.0f

// Optional — required for Supabase telemetry insert on the server
#define WS_USER_ID ""
#define WS_SESSION_ID ""

// NTP (East Africa Time = UTC+3)
#define NTP_SERVER "pool.ntp.org"
#define GMT_OFFSET_SEC (3 * 3600)
#define DAYLIGHT_OFFSET_SEC 0

// Set to 1 to print human-readable JSON on Serial at ~10 Hz (debug only)
#define DEBUG_SERIAL 0
