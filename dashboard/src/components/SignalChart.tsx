"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// ─── public types ────────────────────────────────────────────────────────────

export type SeriesData = {
  values: number[];
  color: string;
  label: string;
};

type CrosshairPos = { svgX: number; sampleIdx: number };

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

// ─── crosshair overlay (rendered inside the SVG) ─────────────────────────────

function CrosshairOverlay({
  pos, allSeries, fs, unit,
  minV, maxV, height,
}: {
  pos: CrosshairPos;
  allSeries: SeriesData[];
  fs: number; unit: string;
  minV: number; maxV: number;
  height: number;
}) {
  const yT = PAD_Y;
  const yB = height - PAD_Y;
  const rng = Math.max(maxV - minV, 1e-9);

  // Collect values at this sample index
  const vals = allSeries.map(s => {
    const idx = Math.max(0, Math.min(s.values.length - 1, pos.sampleIdx));
    return s.values[idx] ?? null;
  });

  // Build tooltip lines
  const tSec = (pos.sampleIdx / Math.max(fs, 1)).toFixed(3);
  const multi = allSeries.length > 1;
  const lines: { text: string; color: string }[] = [
    { text: `t = ${tSec} s`, color: "oklch(72% 0.03 252)" },
    ...allSeries.map((s, i) => ({
      text: `${multi ? s.label + ": " : ""}${vals[i] != null ? fmt(vals[i]!) : "—"} ${unit}`,
      color: s.color,
    })),
  ];

  const lineH = 16, padV = 7, padH = 10;
  const maxChars = Math.max(...lines.map(l => l.text.length));
  const boxW = maxChars * 6.8 + padH * 2;
  const boxH = lines.length * lineH + padV * 2;
  const flip = pos.svgX > SVG_W * 0.62;
  const tx = flip ? pos.svgX - 10 - boxW : pos.svgX + 10;
  const ty = Math.max(yT + 2, Math.min(yB - boxH - 2, yT + 6));

  return (
    <g style={{ pointerEvents: "none" }}>
      {/* vertical hair */}
      <line x1={pos.svgX} y1={yT} x2={pos.svgX} y2={yB}
        stroke="var(--ink)" strokeWidth={1} strokeDasharray="4 3" opacity={0.55} />

      {/* dots at each series value */}
      {allSeries.map((s, i) => {
        const v = vals[i];
        if (v == null) return null;
        const cy = yT + (yB - yT) * (1 - (v - minV) / rng);
        return (
          <circle key={i}
            cx={pos.svgX} cy={Math.max(yT, Math.min(yB, cy))}
            r={4} fill={s.color} stroke="white" strokeWidth={1.5} />
        );
      })}

      {/* tooltip box */}
      <rect x={tx} y={ty} width={boxW} height={boxH}
        fill="var(--ink)" opacity={0.9} rx={6} />
      {lines.map((l, i) => (
        <text key={i}
          x={tx + padH} y={ty + padV + (i + 1) * lineH - 3}
          fill={l.color} fontSize={11}
          fontFamily="Cascadia Code, Consolas, monospace">
          {l.text}
        </text>
      ))}
    </g>
  );
}

// ─── inner SVG (shared between compact + modal) ───────────────────────────────

interface ChartCoreProps {
  allSeries: SeriesData[];
  unit: string;
  fs: number;
  height: number;
  vStart: number;
  vEnd: number;
  isZoomed: boolean;
  showHint?: boolean;
  svgRef: React.RefObject<SVGSVGElement>;
  handlers: Record<string, (e: never) => void>;
  crosshair?: CrosshairPos | null;
}

function ChartCore({ allSeries, unit, fs, height, vStart, vEnd, isZoomed, showHint, svgRef, handlers, crosshair }: ChartCoreProps) {
  const multi = allSeries.length > 1;

  const decimated = allSeries.map((s) => {
    const end = Math.max(0, Math.min(s.values.length, vEnd));
    const start = Math.max(0, Math.min(s.values.length - 1, vStart));
    const pts = s.values.length > 0 ? decimate(s.values, start, end, multi ? 900 : 1400) : [];
    return { ...s, pts };
  });

  let gMin = Infinity, gMax = -Infinity;
  for (const d of decimated) {
    if (!d.pts.length) continue;
    const mn = arrMin(d.pts, 0, d.pts.length);
    const mx = arrMax(d.pts, 0, d.pts.length);
    if (mn < gMin) gMin = mn;
    if (mx > gMax) gMax = mx;
  }
  const rng = Math.max(gMax - gMin, 1e-9);
  const minV = gMin - rng * 0.06;
  const maxV = gMax + rng * 0.06;
  const midV = (minV + maxV) / 2;

  const tS = vStart / Math.max(fs, 1);
  const tE = vEnd / Math.max(fs, 1);
  const yT = PAD_Y, yM = PAD_Y + (height - PAD_Y * 2) / 2, yB = height - PAD_Y;

  return (
    <>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SVG_W} ${height + 20}`}
        className="signalChartSvg"
        style={{ height, cursor: crosshair !== undefined ? "crosshair" : "crosshair", touchAction: "none" }}
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
        <text x={10} y={height / 2} className="axisLabel" textAnchor="middle"
          transform={`rotate(-90,10,${height / 2})`}>{unit}</text>

        {/* x labels */}
        <text x={PAD_X} y={height + 16} className="axisLabel">{tS.toFixed(2)} s</text>
        <text x={SVG_W - 2} y={height + 16} className="axisLabel" textAnchor="end">{tE.toFixed(2)} s</text>

        {/* waveforms */}
        {decimated.map((d, i) => (
          d.pts.length > 0 && (
            <polyline key={i}
              points={buildPolyline(d.pts, SVG_W, height, minV, maxV, PAD_X, PAD_Y)}
              fill="none" stroke={d.color}
              strokeWidth={multi ? 1.4 : (isZoomed ? 1.8 : 1.5)}
              strokeLinecap="round" strokeLinejoin="round"
              opacity={multi ? 0.82 : 1}
            />
          )
        ))}

        {/* crosshair */}
        {crosshair && (
          <CrosshairOverlay
            pos={crosshair} allSeries={allSeries} fs={fs} unit={unit}
            minV={minV} maxV={maxV} height={height}
          />
        )}

        {showHint && !isZoomed && !crosshair && allSeries[0]?.values.length > 50 && (
          <text x={SVG_W - 4} y={yT + 14} className="axisLabel" textAnchor="end"
            style={{ opacity: 0.38, fontSize: 11 }}>
            scroll · drag · dbl-click reset
          </text>
        )}
      </svg>

      {/* legend */}
      {multi && (
        <div className="signalLegend">
          {allSeries.filter(s => s.values.length > 0).map((s, i) => (
            <span key={i} className="signalLegendItem">
              <span className="signalLegendSwatch" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

// ─── modal chart ─────────────────────────────────────────────────────────────

function ModalChart({
  allSeries, label, unit, fs, onClose,
}: {
  allSeries: SeriesData[]; label: string; unit: string; fs: number; onClose: () => void;
}) {
  const totalSamples = allSeries.length > 0
    ? Math.min(...allSeries.filter(s => s.values.length > 0).map(s => s.values.length))
    : 0;
  const view = useViewState(totalSamples);
  const [crosshairOn, setCrosshairOn] = useState(false);
  const [crosshairPos, setCrosshairPos] = useState<CrosshairPos | null>(null);

  const isZoomed = view.vStart > 0 || view.vEnd < totalSamples;
  const viewSpan = view.vEnd - view.vStart;
  const firstColor = allSeries[0]?.color ?? "var(--accent)";
  const rangeLeft = totalSamples ? (view.vStart / totalSamples) * 100 : 0;
  const rangeWidth = totalSamples ? (viewSpan / totalSamples) * 100 : 100;

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Crosshair mouse tracking
  const handleMouseMove = useCallback((ev: React.MouseEvent<SVGSVGElement>) => {
    if (!crosshairOn) return;
    const rect = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
    const svgX = ((ev.clientX - rect.left) / rect.width) * SVG_W;
    if (svgX < PAD_X || svgX > SVG_W) { setCrosshairPos(null); return; }
    const frac = (svgX - PAD_X) / (SVG_W - PAD_X);
    const raw = view.vStart + frac * (view.vEnd - view.vStart);
    const sampleIdx = Math.max(view.vStart, Math.min(view.vEnd - 1, Math.round(raw)));
    // Snap X to exact sample grid position
    const snappedFrac = (sampleIdx - view.vStart) / Math.max(view.vEnd - view.vStart - 1, 1);
    const snappedX = PAD_X + snappedFrac * (SVG_W - PAD_X);
    setCrosshairPos({ svgX: snappedX, sampleIdx });
  }, [crosshairOn, view.vStart, view.vEnd]);

  const handleMouseLeave = useCallback(() => setCrosshairPos(null), []);

  // Merge crosshair mouse handlers into existing handlers
  const modalHandlers = {
    ...view.handlers,
    onMouseMove: handleMouseMove,
    onMouseLeave: handleMouseLeave,
  };

  return createPortal(
    <div className="signalModalBackdrop"
      onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div className="signalModalBox">
        {/* header */}
        <div className="signalModalHeader">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="signalChartLabel" style={{ fontSize: 13 }}>{label}</span>
            <span className="signalChartMeta">
              {allSeries.length > 1
                ? `${allSeries.length} cycles · ${totalSamples.toLocaleString()} samples aligned`
                : isZoomed
                ? `${(view.vStart / Math.max(fs, 1)).toFixed(2)} s – ${(view.vEnd / Math.max(fs, 1)).toFixed(2)} s`
                : `${totalSamples.toLocaleString()} samples · ${(totalSamples / Math.max(fs, 1)).toFixed(1)} s · ${fs} Hz`}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {/* crosshair toggle */}
            <button
              className={`btn btnTiny${crosshairOn ? " btnPrimary" : ""}`}
              type="button"
              title="Toggle value crosshair"
              onClick={() => { setCrosshairOn(v => !v); setCrosshairPos(null); }}
            >
              {crosshairOn ? "⊕ Values on" : "⊕ Values"}
            </button>
            {isZoomed && (
              <button className="btn btnTiny" type="button" onClick={view.reset}>Reset zoom</button>
            )}
            <button className="btn btnTiny" type="button" onClick={onClose}
              style={{ fontSize: 16, lineHeight: 1, padding: "4px 10px" }} aria-label="Close">✕</button>
          </div>
        </div>

        {/* chart */}
        <div style={{ padding: "0 4px" }}>
          <ChartCore
            allSeries={allSeries} unit={unit} fs={fs} height={420}
            vStart={view.vStart} vEnd={view.vEnd} isZoomed={isZoomed}
            svgRef={view.svgRef} handlers={modalHandlers as Record<string, (e: never) => void>}
            crosshair={crosshairOn ? crosshairPos : null}
            showHint
          />
        </div>

        {/* horizontal scroll slider */}
        {isZoomed && (
          <div className="signalScrollRow">
            <span className="signalChartMeta" style={{ whiteSpace: "nowrap" }}>{rangeLeft.toFixed(0)}%</span>
            <input type="range" className="signalScrollSlider"
              min={0} max={Math.max(0, totalSamples - viewSpan)} step={1} value={view.vStart}
              onChange={(ev) => view.panTo(parseInt(ev.target.value))}
              aria-label="Scroll through signal" />
            <span className="signalChartMeta" style={{ whiteSpace: "nowrap" }}>
              {(rangeLeft + rangeWidth).toFixed(0)}%
            </span>
          </div>
        )}

        {isZoomed && (
          <div className="signalRangeBar">
            <div className="signalRangeThumb"
              style={{ left: `${rangeLeft}%`, width: `${rangeWidth}%`, background: firstColor }} />
          </div>
        )}

        <div className="signalModalFooter">
          <span className="signalChartMeta" style={{ fontSize: 11 }}>
            {crosshairOn
              ? "Hover over the chart to read values · click ⊕ Values to turn off"
              : "Scroll to zoom · drag to pan · double-click to reset · Esc to close"}
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── public component ────────────────────────────────────────────────────────

export function SignalChart({
  values = [],
  label,
  unit,
  color = "var(--accent)",
  fs,
  height = 160,
  series,
}: {
  values?: number[];
  label: string;
  unit: string;
  color?: string;
  fs: number;
  height?: number;
  series?: SeriesData[];
}) {
  const allSeries: SeriesData[] = series ?? [{ values, color, label }];
  const totalSamples = allSeries.length > 0
    ? Math.min(...allSeries.filter(s => s.values.length > 0).map(s => s.values.length))
    : 0;

  const view = useViewState(totalSamples);
  const [isExpanded, setIsExpanded] = useState(false);
  const isZoomed = view.vStart > 0 || view.vEnd < totalSamples;
  const viewSpan = view.vEnd - view.vStart;
  const firstColor = allSeries[0]?.color ?? color;
  const multi = allSeries.length > 1;
  const rangeLeft = totalSamples ? (view.vStart / totalSamples) * 100 : 0;
  const rangeWidth = totalSamples ? (viewSpan / totalSamples) * 100 : 100;

  const handleExpandClick = useCallback(() => setIsExpanded(true), []);

  if (totalSamples === 0 && allSeries.every(s => s.values.length === 0)) {
    return (
      <div className="chartEmpty" style={{ minHeight: height }}>
        <strong>No {label} data</strong>
        <span>Waiting for sensor samples…</span>
      </div>
    );
  }

  const durationS = totalSamples / Math.max(fs, 1);
  const tStart = view.vStart / Math.max(fs, 1);
  const tEnd = view.vEnd / Math.max(fs, 1);

  return (
    <div className="signalChartWrap">
      {/* header */}
      <div className="signalChartHeader">
        <span className="signalChartLabel">{label}</span>
        <span className="signalChartMeta">
          {multi
            ? `${allSeries.length} cycles · ${totalSamples.toLocaleString()} samples aligned`
            : isZoomed
            ? `${tStart.toFixed(2)} s – ${tEnd.toFixed(2)} s  ·  ${viewSpan.toLocaleString()} / ${totalSamples.toLocaleString()} samples`
            : `${totalSamples.toLocaleString()} samples · ${durationS.toFixed(1)} s · ${fs} Hz`}
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {isZoomed && !multi && (
            <button className="btn btnTiny" type="button" onClick={view.reset}>Reset zoom</button>
          )}
          <button className="btn btnTiny signalExpandBtn" type="button"
            onClick={handleExpandClick} title="Expand to inspect values" aria-label="Open full-screen chart">⤢</button>
        </div>
      </div>

      {/* compact chart — click to expand */}
      <div className="signalChartClickable" onClick={(ev) => {
        const tag = (ev.target as HTMLElement).tagName;
        if (tag !== "BUTTON" && !view.didMove.current) setIsExpanded(true);
      }}>
        <ChartCore
          allSeries={allSeries} unit={unit} fs={fs} height={height}
          vStart={view.vStart} vEnd={view.vEnd} isZoomed={isZoomed}
          svgRef={view.svgRef} handlers={view.handlers}
        />
      </div>

      {/* scroll slider */}
      {isZoomed && !multi && (
        <div className="signalScrollRow">
          <input type="range" className="signalScrollSlider"
            min={0} max={Math.max(0, totalSamples - viewSpan)} step={1} value={view.vStart}
            onChange={(ev) => view.panTo(parseInt(ev.target.value))}
            aria-label="Scroll through signal" />
        </div>
      )}

      {/* range bar */}
      {isZoomed && !multi && (
        <div className="signalRangeBar">
          <div className="signalRangeThumb"
            style={{ left: `${rangeLeft}%`, width: `${rangeWidth}%`, background: firstColor }} />
        </div>
      )}

      {/* modal */}
      {isExpanded && (
        <ModalChart
          allSeries={allSeries} label={label} unit={unit} fs={fs}
          onClose={() => setIsExpanded(false)}
        />
      )}
    </div>
  );
}
