#!/usr/bin/env python3
"""
Validate ESP32 firmware timing from evidence files (no hardware required).

Inputs (pick one):
  --serial-log PATH   USB capture with [sample] t=<us> lines (PRINT_SAMPLE_MS throttle)
  --batches-json PATH JSON array of esp32_raw_batches rows:
                        { "ts_ms_start": int, "sample_count": int, "created_at": "ISO" }

Example:
  python scripts/validate_firmware_timing.py --batches-json batches_export.json
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from datetime import datetime
from typing import Any, List, Optional, Sequence, Tuple


def _parse_iso_ms(s: str) -> Optional[int]:
    if not s:
        return None
    try:
        # Supabase often returns ...Z or +00:00
        t = s.replace("Z", "+00:00")
        return int(datetime.fromisoformat(t).timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def analyze_serial_log(text: str, expected_print_ms: float = 200.0) -> dict[str, Any]:
    """Inter-arrival of throttled [sample] lines (~PRINT_SAMPLE_MS, not raw 20 Hz)."""
    pat = re.compile(r"\[sample\]\s+t=(\d+)")
    times_us = [int(m.group(1)) for m in pat.finditer(text)]
    if len(times_us) < 3:
        return {
            "ok": False,
            "error": "Need at least 3 [sample] lines in serial log",
            "n_lines": len(times_us),
        }

    # esp_timer wraps; use deltas only when monotonic
    deltas_ms: List[float] = []
    for i in range(1, len(times_us)):
        d_us = times_us[i] - times_us[i - 1]
        if d_us < 0:
            d_us += 2**32
        deltas_ms.append(d_us / 1000.0)

    med = statistics.median(deltas_ms)
    tol = expected_print_ms * 0.35
    within = sum(1 for d in deltas_ms if abs(d - expected_print_ms) <= tol)
    return {
        "ok": within >= max(1, int(0.8 * len(deltas_ms))),
        "kind": "serial_print_interval",
        "n_lines": len(times_us),
        "n_intervals": len(deltas_ms),
        "expected_ms": expected_print_ms,
        "median_ms": round(med, 2),
        "mean_ms": round(statistics.mean(deltas_ms), 2),
        "stdev_ms": round(statistics.pstdev(deltas_ms), 2) if len(deltas_ms) > 1 else 0.0,
        "within_tolerance_pct": round(100.0 * within / len(deltas_ms), 1),
        "note": "Serial lines are throttled; use --batches-json for true 1 Hz POST cadence.",
    }


def _deltas_ms(ts: Sequence[int]) -> List[float]:
    out: List[float] = []
    for i in range(1, len(ts)):
        out.append(float(ts[i] - ts[i - 1]))
    return out


def analyze_batches(rows: List[dict[str, Any]], expected_hz: float = 20.0) -> dict[str, Any]:
    if not rows:
        return {"ok": False, "error": "Empty batch list"}

    rows = sorted(rows, key=lambda r: int(r.get("ts_ms_start") or 0))
    expected_interval_ms = 1000.0 * float(rows[0].get("window_s") or (1.0 / expected_hz))
    if rows[0].get("window_s") is None and rows[0].get("fs_hz"):
        fs = float(rows[0]["fs_hz"])
        n = int(rows[0].get("sample_count") or 20)
        expected_interval_ms = 1000.0 * n / fs if fs > 0 else 1000.0

    ts_starts = [int(r["ts_ms_start"]) for r in rows if r.get("ts_ms_start") is not None]
    counts = [int(r.get("sample_count") or len(r.get("ecg") or [])) for r in rows]

    if len(ts_starts) < 3:
        return {"ok": False, "error": "Need at least 3 batches with ts_ms_start", "n_batches": len(rows)}

    deltas = _deltas_ms(ts_starts)
    med = statistics.median(deltas)
    tol = expected_interval_ms * 0.15
    cadence_ok = sum(1 for d in deltas if abs(d - expected_interval_ms) <= tol)
    count_ok = sum(1 for c in counts if c == counts[0])
    expected_n = counts[0] if counts else 20

    created: List[int] = []
    for r in rows:
        ms = _parse_iso_ms(str(r.get("created_at") or ""))
        if ms is not None:
            created.append(ms)
    server_deltas: Optional[List[float]] = None
    server_med: Optional[float] = None
    if len(created) >= 3:
        server_deltas = _deltas_ms(created)
        server_med = statistics.median(server_deltas)

    return {
        "ok": (
            cadence_ok >= max(1, int(0.85 * len(deltas)))
            and count_ok >= max(1, int(0.95 * len(counts)))
            and expected_n >= 1
        ),
        "kind": "http_batch_cadence",
        "n_batches": len(rows),
        "expected_samples_per_batch": expected_n,
        "samples_match_pct": round(100.0 * count_ok / len(counts), 1),
        "expected_interval_ms": round(expected_interval_ms, 1),
        "ts_ms_start_median_delta_ms": round(med, 2),
        "ts_ms_start_mean_delta_ms": round(statistics.mean(deltas), 2),
        "cadence_within_15pct_pct": round(100.0 * cadence_ok / len(deltas), 1),
        "server_created_median_delta_ms": round(server_med, 2) if server_med is not None else None,
        "cycles_to_2000_samples": round(2000 / expected_n, 0) if expected_n else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--serial-log", type=str, help="Path to serial capture .txt")
    ap.add_argument("--batches-json", type=str, help="JSON array of batch rows")
    ap.add_argument("--expected-print-ms", type=float, default=200.0)
    args = ap.parse_args()

    if not args.serial_log and not args.batches_json:
        ap.print_help()
        print("\nProvide --serial-log and/or --batches-json.", file=sys.stderr)
        return 2

    results: List[dict[str, Any]] = []

    if args.serial_log:
        text = open(args.serial_log, encoding="utf-8", errors="replace").read()
        results.append(analyze_serial_log(text, expected_print_ms=args.expected_print_ms))

    if args.batches_json:
        rows = json.load(open(args.batches_json, encoding="utf-8"))
        if isinstance(rows, dict) and "rows" in rows:
            rows = rows["rows"]
        results.append(analyze_batches(rows))

    print(json.dumps(results, indent=2))
    ok = all(r.get("ok") for r in results)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
