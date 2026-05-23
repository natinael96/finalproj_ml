"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// ─── maths helpers ───────────────────────────────────────────────────────────

function arrMin(a: number[], s: number, e: number) {
  let m = a[s];
  for (let i = s + 1; i < e; i++) if (a[i] < m) m = a[i];
  return m;
}
function arrMax(a: number[], s: number, e: number) {
  let m = a[s];
  for (let i = s + 1; i < e; i++) if (a[i] > m) m = a[i];
  return m;
}

/** Min-max decimation — preserves transient peaks at high compression. */
function decimate(values: number[], start: number, end: number, maxPts: number): number[] {
  const n = end - start;
  if (n <= maxPts) return values.slice(start, end);
  const bs = Math.ceil(n / (maxPts / 2));
  const out: number[] = [];
  for (let i = start; i < end; i += bs) {
    const be = Math.min(i + bs, end);
    let mn = values[i], mx = values[i];
    for (let j = i + 1; j < be; j++) {
      if (values[j] < mn) mn = values[j];
      if (values[j] > mx) mx = values[j];
    }
    out.push(mn, mx);
  }
  return out;
}

function buildPolyline(
  pts: number[], W: number, H: number,
  minV: number, maxV: number, padX: number, padY: number,
): string {
  if (!pts.length) return "";
  const span = Math.max(maxV - minV, 1e-9);
  const w = W - padX, h = H - padY * 2;
  return pts
    .map((v, i) => {
      const x = padX + (i / Math.max(pts.length - 1, 1)) * w;
      const y = padY + h - ((v - minV) / span) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function fmt(n: number) {
  return Math.abs(n) >= 1000 ? n.toFixed(0)
    : Math.abs(n) >= 100 ? n.toFixed(0)
    : Math.abs(n) >= 10 ? n.toFixed(1)
    : n.toFixed(2);
}

const MIN_SPAN = 10;
const PAD_X = 56;
const PAD_Y = 14;
const SVG_W = 720;

// ─── zoom / pan hook ─────────────────────────────────────────────────────────

function useViewState(totalSamples: number) {
  const [vStart, setVStart] = useState(0);
  const [vEnd, setVEnd] = useState(totalSamples);
  const svgRef = useRef<SVGSVGElement>(null) as React.RefObject<SVGSVGElement>;
  const dragging = useRef(false);
  const didMove = useRef(false);
  const dragOriginX = useRef(0);
  const dragOriginView = useRef<[number, number]>([0, 0]);

  useEffect(() => { setVStart(0); setVEnd(totalSamples); }, [totalSamples]);

  const pxW = () => (svgRef.current?.getBoundingClientRect().width ?? SVG_W) - PAD_X;

  const clamp = (s: number, e: number): [number, number] => {
    const span = Math.max(MIN_SPAN, Math.round(e - s));
    let ns = Math.round(s), ne = ns + span;
    if (ns < 0) { ns = 0; ne = span; }
    if (ne > totalSamples) { ne = totalSamples; ns = Math.max(0, ne - span); }
    return [ns, ne];
  };

  const handleWheel = useCallback((ev: React.WheelEvent) => {
    ev.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left - PAD_X) / pxW()));
    const span = vEnd - vStart;
    const factor = ev.deltaY > 0 ? 1.35 : 1 / 1.35;
    const newSpan = Math.max(MIN_SPAN, Math.min(totalSamples, span * factor));
    const center = vStart + span * frac;
    const [ns, ne] = clamp(center - newSpan * frac, center - newSpan * frac + newSpan);
    setVStart(ns); setVEnd(ne);
  }, [vStart, vEnd, totalSamples]); // eslint-disable-line

  const handlePointerDown = useCallback((ev: React.PointerEvent) => {
    dragging.current = true; didMove.current = false;
    dragOriginX.current = ev.clientX;
    dragOriginView.current = [vStart, vEnd];
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
  }, [vStart, vEnd]);

  const handlePointerMove = useCallback((ev: React.PointerEvent) => {
    if (!dragging.current) return;
    const delta = ev.clientX - dragOriginX.current;
    if (Math.abs(delta) > 4) didMove.current = true;
    const span = dragOriginView.current[1] - dragOriginView.current[0];
    const sd = Math.round(-(delta / pxW()) * span);
    const [ns, ne] = clamp(dragOriginView.current[0] + sd, dragOriginView.current[1] + sd);
    setVStart(ns); setVEnd(ne);
  }, []); // eslint-disable-line

  const handlePointerUp = useCallback(() => { dragging.current = false; }, []);

  const handleDoubleClick = useCallback(() => { setVStart(0); setVEnd(totalSamples); }, [totalSamples]);

  const panTo = useCallback((newStart: number) => {
    const span = vEnd - vStart;
    const [ns, ne] = clamp(newStart, newStart + span);
    setVStart(ns); setVEnd(ne);
  }, [vStart, vEnd]); // eslint-disable-line

  const reset = useCallback(() => { setVStart(0); setVEnd(totalSamples); }, [totalSamples]);

  return {
    vStart, vEnd, svgRef, didMove, panTo, reset,
    handlers: {
      onWheel: handleWheel,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerLeave: handlePointerUp,
      onDoubleClick: handleDoubleClick,
    },
  };
}

// ─── inner SVG chart (shared between compact + modal) ────────────────────────

interface ChartCoreProps {
  values: number[];
  label: string;
  unit: string;
  color: string;
  fs: number;
  height: number;
  vStart: number;
  vEnd: number;
  isZoomed: boolean;
  showHint?: boolean;
  svgRef: React.RefObject<SVGSVGElement>;
  handlers: Record<string, (e: never) => void>;
}

function ChartCore({
  values, unit, color, fs, height,
  vStart, vEnd, isZoomed, showHint = false,
  svgRef, handlers,
}: ChartCoreProps) {
  const s = Math.max(0, Math.min(vStart, values.length - 1));
  const e = Math.max(s + 1, Math.min(vEnd, values.length));
  const pts = decimate(values, s, e, 1400);

  const rawMin = arrMin(pts, 0, pts.length);
  const rawMax = arrMax(pts, 0, pts.length);
  const rng = Math.max(rawMax - rawMin, 1e-9);
  const minV = rawMin - rng * 0.06;
  const maxV = rawMax + rng * 0.06;
  const midV = (minV + maxV) / 2;

  const tS = s / Math.max(fs, 1);
  const tE = e / Math.max(fs, 1);

  const yT = PAD_Y, yM = PAD_Y + (height - PAD_Y * 2) / 2, yB = height - PAD_Y;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${SVG_W} ${height + 20}`}
      className="signalChartSvg"
      style={{ height, cursor: "crosshair", touchAction: "none" }}
      aria-label={`${unit} waveform`}
      {...handlers}
    >
      {/* grid */}
      <line x1={PAD_X} y1={yT} x2={SVG_W} y2={yT} className="signalGridLine" />
      <line x1={PAD_X} y1={yM} x2={SVG_W} y2={yM} className="signalGridLine signalGridMid" />
      <line x1={PAD_X} y1={yB} x2={SVG_W} y2={yB} className="signalGridLine" />
      <line x1={PAD_X} y1={yT} x2={PAD_X} y2={yB} className="signalGridLine" />

      {/* y labels */}
      <text x={PAD_X - 5} y={yT + 4} className="axisLabel" textAnchor="end">{fmt(maxV)}</text>
      <text x={PAD_X - 5} y={yM + 4} className="axisLabel" textAnchor="end">{fmt(midV)}</text>
      <text x={PAD_X - 5} y={yB + 4} className="axisLabel" textAnchor="end">{fmt(minV)}</text>

      {/* unit rotated */}
      <text x={10} y={height / 2} className="axisLabel" textAnchor="middle"
        transform={`rotate(-90,10,${height / 2})`}>{unit}</text>

      {/* x labels */}
      <text x={PAD_X} y={height + 16} className="axisLabel">{tS.toFixed(2)} s</text>
      <text x={SVG_W - 2} y={height + 16} className="axisLabel" textAnchor="end">{tE.toFixed(2)} s</text>

      {/* waveform */}
      <polyline
        points={buildPolyline(pts, SVG_W, height, minV, maxV, PAD_X, PAD_Y)}
        fill="none" stroke={color}
        strokeWidth={isZoomed ? 1.8 : 1.5}
        strokeLinecap="round" strokeLinejoin="round"
      />

      {showHint && !isZoomed && values.length > 50 && (
        <text x={SVG_W - 4} y={yT + 14} className="axisLabel" textAnchor="end"
          style={{ opacity: 0.38, fontSize: 11 }}>
          scroll · drag · dbl-click reset
        </text>
      )}
    </svg>
  );
}

// ─── modal chart ─────────────────────────────────────────────────────────────

function ModalChart({
  values, label, unit, color, fs,
  onClose,
}: {
  values: number[]; label: string; unit: string; color: string; fs: number;
  onClose: () => void;
}) {
  const view = useViewState(values.length);
  const isZoomed = view.vStart > 0 || view.vEnd < values.length;
  const viewSpan = view.vEnd - view.vStart;

  // Escape to close
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Prevent body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const rangeLeft = (view.vStart / values.length) * 100;
  const rangeWidth = (viewSpan / values.length) * 100;
  const durationS = values.length / Math.max(fs, 1);
  const tStart = view.vStart / Math.max(fs, 1);
  const tEnd = view.vEnd / Math.max(fs, 1);

  return createPortal(
    <div
      className="signalModalBackdrop"
      onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}
    >
      <div className="signalModalBox">
        {/* modal header */}
        <div className="signalModalHeader">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="signalChartLabel" style={{ fontSize: 13 }}>{label}</span>
            <span className="signalChartMeta">
              {isZoomed
                ? `${tStart.toFixed(2)} s – ${tEnd.toFixed(2)} s  ·  ${viewSpan.toLocaleString()} / ${values.length.toLocaleString()} samples`
                : `${values.length.toLocaleString()} samples · ${durationS.toFixed(1)} s · ${fs} Hz`}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {isZoomed && (
              <button className="btn btnTiny" type="button" onClick={view.reset}>
                Reset zoom
              </button>
            )}
            <button
              className="btn btnTiny"
              type="button"
              onClick={onClose}
              style={{ fontSize: 16, lineHeight: 1, padding: "4px 10px" }}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* chart */}
        <div style={{ padding: "0 4px" }}>
          <ChartCore
            values={values} label={label} unit={unit} color={color} fs={fs}
            height={420}
            vStart={view.vStart} vEnd={view.vEnd}
            isZoomed={isZoomed}
            svgRef={view.svgRef}
            handlers={view.handlers}
            showHint
          />
        </div>

        {/* horizontal scroll slider */}
        <div className="signalScrollRow">
          {isZoomed && (
            <>
              <span className="signalChartMeta" style={{ whiteSpace: "nowrap" }}>
                {(rangeLeft).toFixed(0)}%
              </span>
              <input
                type="range"
                className="signalScrollSlider"
                min={0}
                max={Math.max(0, values.length - viewSpan)}
                step={1}
                value={view.vStart}
                onChange={(ev) => view.panTo(parseInt(ev.target.value))}
                aria-label="Scroll through signal"
              />
              <span className="signalChartMeta" style={{ whiteSpace: "nowrap" }}>
                {(rangeLeft + rangeWidth).toFixed(0)}%
              </span>
            </>
          )}
          {!isZoomed && (
            <span className="signalChartMeta" style={{ opacity: 0.55 }}>
              Scroll wheel to zoom in · drag to pan · use the slider when zoomed
            </span>
          )}
        </div>

        {/* range indicator */}
        {isZoomed && (
          <div className="signalRangeBar">
            <div
              className="signalRangeThumb"
              style={{ left: `${rangeLeft}%`, width: `${rangeWidth}%`, background: color }}
            />
          </div>
        )}

        <div className="signalModalFooter">
          <span className="signalChartMeta" style={{ fontSize: 11 }}>
            Scroll wheel to zoom · drag to pan · double-click to reset · Esc to close
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── public component ────────────────────────────────────────────────────────

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
  const view = useViewState(values.length);
  const [isExpanded, setIsExpanded] = useState(false);
  const isZoomed = view.vStart > 0 || view.vEnd < values.length;
  const viewSpan = view.vEnd - view.vStart;

  const rangeLeft = values.length ? (view.vStart / values.length) * 100 : 0;
  const rangeWidth = values.length ? (viewSpan / values.length) * 100 : 100;
  const durationS = values.length / Math.max(fs, 1);
  const tStart = view.vStart / Math.max(fs, 1);
  const tEnd = view.vEnd / Math.max(fs, 1);

  const handleExpandClick = useCallback(() => setIsExpanded(true), []);

  if (values.length === 0) {
    return (
      <div className="chartEmpty" style={{ minHeight: height }}>
        <strong>No {label} data</strong>
        <span>Waiting for sensor samples…</span>
      </div>
    );
  }

  return (
    <div className="signalChartWrap">
      {/* header */}
      <div className="signalChartHeader">
        <span className="signalChartLabel">{label}</span>
        <span className="signalChartMeta">
          {isZoomed
            ? `${tStart.toFixed(2)} s – ${tEnd.toFixed(2)} s  ·  ${viewSpan.toLocaleString()} / ${values.length.toLocaleString()} samples`
            : `${values.length.toLocaleString()} samples · ${durationS.toFixed(1)} s · ${fs} Hz`}
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {isZoomed && (
            <button className="btn btnTiny" type="button" onClick={view.reset}>
              Reset zoom
            </button>
          )}
          <button
            className="btn btnTiny signalExpandBtn"
            type="button"
            onClick={handleExpandClick}
            title="Expand chart"
            aria-label="Open full-screen chart"
          >
            ⤢
          </button>
        </div>
      </div>

      {/* compact chart */}
      <div className="signalChartClickable" onClick={(ev) => {
        // open modal only if click landed directly on the wrapper (not a button child)
        const tag = (ev.target as HTMLElement).tagName;
        if (tag !== "BUTTON" && !view.didMove.current) setIsExpanded(true);
      }}>
        <ChartCore
          values={values} label={label} unit={unit} color={color} fs={fs}
          height={height}
          vStart={view.vStart} vEnd={view.vEnd}
          isZoomed={isZoomed}
          svgRef={view.svgRef}
          handlers={view.handlers}
        />
      </div>

      {/* horizontal scroll (shows when zoomed) */}
      {isZoomed && (
        <div className="signalScrollRow">
          <input
            type="range"
            className="signalScrollSlider"
            min={0}
            max={Math.max(0, values.length - viewSpan)}
            step={1}
            value={view.vStart}
            onChange={(ev) => view.panTo(parseInt(ev.target.value))}
            aria-label="Scroll through signal"
          />
        </div>
      )}

      {/* range indicator */}
      {isZoomed && (
        <div className="signalRangeBar">
          <div
            className="signalRangeThumb"
            style={{ left: `${rangeLeft}%`, width: `${rangeWidth}%`, background: color }}
          />
        </div>
      )}

      {/* modal */}
      {isExpanded && (
        <ModalChart
          values={values} label={label} unit={unit} color={color} fs={fs}
          onClose={() => setIsExpanded(false)}
        />
      )}
    </div>
  );
}
