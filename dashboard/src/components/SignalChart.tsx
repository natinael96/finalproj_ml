"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ─── helpers ────────────────────────────────────────────────────────────────

function arrMinRange(a: number[], s: number, e: number) {
  let m = a[s];
  for (let i = s + 1; i < e; i++) if (a[i] < m) m = a[i];
  return m;
}
function arrMaxRange(a: number[], s: number, e: number) {
  let m = a[s];
  for (let i = s + 1; i < e; i++) if (a[i] > m) m = a[i];
  return m;
}

/** Min-max decimation — preserves spike peaks at high compression ratios. */
function decimate(values: number[], start: number, end: number, maxPts: number): number[] {
  const n = end - start;
  if (n <= maxPts) return values.slice(start, end);
  const bucketSize = Math.ceil(n / (maxPts / 2));
  const result: number[] = [];
  for (let i = start; i < end; i += bucketSize) {
    const bEnd = Math.min(i + bucketSize, end);
    let mn = values[i];
    let mx = values[i];
    for (let j = i + 1; j < bEnd; j++) {
      if (values[j] < mn) mn = values[j];
      if (values[j] > mx) mx = values[j];
    }
    result.push(mn, mx);
  }
  return result;
}

function buildPolyline(
  pts: number[],
  W: number, H: number,
  minV: number, maxV: number,
  padX: number, padY: number
): string {
  if (pts.length === 0) return "";
  const span = Math.max(maxV - minV, 1e-9);
  const w = W - padX;
  const h = H - padY * 2;
  return pts
    .map((v, i) => {
      const x = padX + (i / Math.max(pts.length - 1, 1)) * w;
      const y = padY + h - ((v - minV) / span) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function fmt(n: number) {
  return Math.abs(n) >= 1000
    ? n.toFixed(0)
    : Math.abs(n) >= 100
    ? n.toFixed(0)
    : Math.abs(n) >= 10
    ? n.toFixed(1)
    : n.toFixed(2);
}

const MIN_SPAN = 10;
const PAD_X = 56;
const PAD_Y = 12;
const SVG_W = 720;

// ─── component ──────────────────────────────────────────────────────────────

export function SignalChart({
  values,
  label,
  unit,
  color,
  fs,
  height = 160,
}: {
  values: number[];
  label: string;
  unit: string;
  color: string;
  fs: number;
  height?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [vStart, setVStart] = useState(0);
  const [vEnd, setVEnd] = useState(values.length);

  // drag state (not React state — no re-render mid-drag)
  const dragging = useRef(false);
  const dragOriginX = useRef(0);
  const dragOriginView = useRef<[number, number]>([0, 0]);

  // Reset view whenever the data array changes length
  useEffect(() => {
    setVStart(0);
    setVEnd(values.length);
  }, [values.length]);

  // ── helpers that read rendered size ──────────────────────────────────────
  const chartPixelWidth = () =>
    (svgRef.current?.getBoundingClientRect().width ?? SVG_W) - PAD_X;

  const clampView = (s: number, e: number): [number, number] => {
    const span = Math.max(MIN_SPAN, e - s);
    let ns = Math.round(s);
    let ne = Math.round(ns + span);
    if (ns < 0) { ns = 0; ne = span; }
    if (ne > values.length) { ne = values.length; ns = Math.max(0, ne - span); }
    return [ns, ne];
  };

  // ── wheel zoom ────────────────────────────────────────────────────────────
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cursorFrac = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left - PAD_X) / chartPixelWidth())
      );
      const span = vEnd - vStart;
      const factor = e.deltaY > 0 ? 1.35 : 1 / 1.35;
      const newSpan = Math.max(MIN_SPAN, Math.min(values.length, span * factor));
      const center = vStart + span * cursorFrac;
      const [ns, ne] = clampView(center - newSpan * cursorFrac, center - newSpan * cursorFrac + newSpan);
      setVStart(ns);
      setVEnd(ne);
    },
    [vStart, vEnd, values.length] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── drag pan ──────────────────────────────────────────────────────────────
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true;
      dragOriginX.current = e.clientX;
      dragOriginView.current = [vStart, vEnd];
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    [vStart, vEnd]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const pxDelta = e.clientX - dragOriginX.current;
      const span = dragOriginView.current[1] - dragOriginView.current[0];
      const sampleDelta = Math.round(-(pxDelta / chartPixelWidth()) * span);
      const [ns, ne] = clampView(
        dragOriginView.current[0] + sampleDelta,
        dragOriginView.current[1] + sampleDelta
      );
      setVStart(ns);
      setVEnd(ne);
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // ── double-click reset ────────────────────────────────────────────────────
  const handleDoubleClick = useCallback(() => {
    setVStart(0);
    setVEnd(values.length);
  }, [values.length]);

  // ── empty state ───────────────────────────────────────────────────────────
  if (values.length === 0) {
    return (
      <div className="chartEmpty" style={{ minHeight: height }}>
        <strong>No {label} data</strong>
        <span>Waiting for sensor samples…</span>
      </div>
    );
  }

  // ── compute visible slice ─────────────────────────────────────────────────
  const s = Math.max(0, Math.min(vStart, values.length - 1));
  const e = Math.max(s + 1, Math.min(vEnd, values.length));
  const pts = decimate(values, s, e, 1400);

  const rawMin = arrMinRange(pts, 0, pts.length);
  const rawMax = arrMaxRange(pts, 0, pts.length);
  const span = Math.max(rawMax - rawMin, 1e-9);
  const minV = rawMin - span * 0.06;
  const maxV = rawMax + span * 0.06;
  const midV = (minV + maxV) / 2;

  const tStart = s / Math.max(fs, 1);
  const tEnd = e / Math.max(fs, 1);
  const durationS = values.length / Math.max(fs, 1);
  const isZoomed = s > 0 || e < values.length;

  // range indicator (mini-scrollbar)
  const rangeLeft = (s / values.length) * 100;
  const rangeWidth = ((e - s) / values.length) * 100;

  const yTop = PAD_Y;
  const yMid = PAD_Y + (height - PAD_Y * 2) / 2;
  const yBot = height - PAD_Y;

  return (
    <div className="signalChartWrap">
      {/* header */}
      <div className="signalChartHeader">
        <span className="signalChartLabel">{label}</span>
        <span className="signalChartMeta">
          {isZoomed
            ? `${tStart.toFixed(2)} s – ${tEnd.toFixed(2)} s  ·  ${(e - s).toLocaleString()} / ${values.length.toLocaleString()} samples`
            : `${values.length.toLocaleString()} samples · ${durationS.toFixed(1)} s · ${fs} Hz`}
        </span>
        {isZoomed && (
          <button
            className="btn btnTiny"
            type="button"
            style={{ padding: "3px 8px", fontSize: 11 }}
            onClick={handleDoubleClick}
          >
            Reset zoom
          </button>
        )}
      </div>

      {/* chart */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SVG_W} ${height + 18}`}
        className="signalChartSvg"
        style={{ height, cursor: dragging.current ? "grabbing" : "crosshair", touchAction: "none" }}
        role="img"
        aria-label={`${label} waveform`}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      >
        {/* grid */}
        <line x1={PAD_X} y1={yTop} x2={SVG_W} y2={yTop} className="signalGridLine" />
        <line x1={PAD_X} y1={yMid} x2={SVG_W} y2={yMid} className="signalGridLine signalGridMid" />
        <line x1={PAD_X} y1={yBot} x2={SVG_W} y2={yBot} className="signalGridLine" />
        <line x1={PAD_X} y1={yTop} x2={PAD_X} y2={yBot} className="signalGridLine" />

        {/* Y labels */}
        <text x={PAD_X - 5} y={yTop + 4} className="axisLabel" textAnchor="end">{fmt(maxV)}</text>
        <text x={PAD_X - 5} y={yMid + 4} className="axisLabel" textAnchor="end">{fmt(midV)}</text>
        <text x={PAD_X - 5} y={yBot + 4} className="axisLabel" textAnchor="end">{fmt(minV)}</text>

        {/* unit */}
        <text x={10} y={height / 2} className="axisLabel" textAnchor="middle"
          transform={`rotate(-90,10,${height / 2})`}>{unit}</text>

        {/* X labels */}
        <text x={PAD_X} y={height + 14} className="axisLabel">{tStart.toFixed(2)} s</text>
        <text x={SVG_W - 2} y={height + 14} className="axisLabel" textAnchor="end">{tEnd.toFixed(2)} s</text>

        {/* waveform */}
        <polyline
          points={buildPolyline(pts, SVG_W, height, minV, maxV, PAD_X, PAD_Y)}
          fill="none"
          stroke={color}
          strokeWidth={isZoomed ? 1.8 : 1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* zoom hint (first render only) */}
        {!isZoomed && values.length > 50 && (
          <text x={SVG_W - 4} y={yTop + 14} className="axisLabel" textAnchor="end" style={{ opacity: 0.45 }}>
            scroll to zoom · drag to pan · dbl-click to reset
          </text>
        )}
      </svg>

      {/* range indicator bar */}
      {isZoomed && (
        <div className="signalRangeBar" title={`Viewing ${rangeLeft.toFixed(0)}% – ${(rangeLeft + rangeWidth).toFixed(0)}% of signal`}>
          <div
            className="signalRangeThumb"
            style={{ left: `${rangeLeft}%`, width: `${rangeWidth}%`, background: color }}
          />
        </div>
      )}
    </div>
  );
}
