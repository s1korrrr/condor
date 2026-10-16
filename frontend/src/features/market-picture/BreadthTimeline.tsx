import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { TooltipCard } from "@/features/quant-ops/kit/charts";
import { tooltipPlacement } from "@/features/quant-ops/kit/heat-strip";
import { useElementWidth } from "@/features/quant-ops/kit/useElementWidth";
import { HORIZONS, HORIZON_LABELS } from "./model.mjs";
import { breadthTimeline, pressureTone, shareBalance as balance, timelineTicks, type TimelineCell, type TimelineColumn } from "./breadth-timeline.mjs";
import type { HistoryPoint, Horizon } from "./presentation";

const ROW = 20, ROW_GAP = 3, TOP = 18, RIBBON_GAP = 14, RIBBON = 76, AXIS = 20;
const HEAT = HORIZONS.length * (ROW + ROW_GAP) - ROW_GAP;
const RIBBON_TOP = TOP + HEAT + RIBBON_GAP, RIBBON_MID = RIBBON_TOP + RIBBON / 2;
const HEIGHT = RIBBON_TOP + RIBBON + AXIS;

const signed = (value: number, digits = 2) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
const pct = (value: number | null) => value == null ? "—" : `${Math.round(value * 100)}%`;
const label = (horizon: string) => HORIZON_LABELS[HORIZONS.indexOf(horizon)] ?? `${horizon}m`;
const utc = (time: number, withDate: boolean) => new Date(time).toLocaleString("en-GB", {
  timeZone: "UTC", ...(withDate ? { month: "short", day: "numeric" } : {}), hour: "2-digit", minute: "2-digit",
});

function fill(cell: TimelineCell | null) {
  const tone = pressureTone(cell?.pressure);
  if (!tone) return null;
  if (tone.side === "flat") return "color-mix(in srgb, var(--mp-unchanged) 45%, var(--mp-panel))";
  return `color-mix(in srgb, var(--mp-${tone.side === "up" ? "positive" : "negative"}) ${Math.round(18 + 72 * tone.strength)}%, var(--mp-panel))`;
}

/** "14:20 UTC" for one frame, "14:12–14:20 UTC · mean of 3 frames" for a bucket, "as of" for a carried one. */
function when(column: TimelineColumn, withDate: boolean) {
  if (column.time == null) return `${utc(column.start, withDate)} UTC`;
  if (column.gapBefore) return `${utc(column.first ?? column.time, withDate)}${column.frames > 1 ? `–${utc(column.time, false)}` : ""} UTC · after a retained gap${column.frames > 1 ? ` · mean of ${column.frames} frames` : ""}${column.framesBeforeGap ? ` · ${column.framesBeforeGap} earlier frame${column.framesBeforeGap === 1 ? "" : "s"} before the gap not averaged` : ""}`;
  if (column.carried) return `${utc(column.start, withDate)} UTC · latest frame ${utc(column.time, false)}`;
  if (column.frames > 1 && column.first != null) return `${utc(column.first, withDate)}–${utc(column.time, false)} UTC · mean of ${column.frames} frames`;
  return `${utc(column.time, withDate)} UTC`;
}

function describe(column: TimelineColumn, horizon: string, withDate: boolean) {
  if (column.time == null) return `${utc(column.start, withDate)} UTC · retained gap, no observation`;
  const cell = column.cells[horizon];
  return `${when(column, withDate)} · ${label(horizon)} pressure ${cell?.pressure == null ? "unavailable" : signed(cell.pressure)} · ${balance(cell)}`;
}

/**
 * Horizon x time breadth heatmap with an aligned advancing/declining ribbon for the selected horizon.
 * Hover or arrow keys inspect a column; click pins it (and selects the row's horizon); a drag zooms.
 */
export function BreadthTimeline({ samples, horizon, setHorizon, zoom, onZoom, replay }: {
  samples: HistoryPoint[];
  horizon: Horizon;
  setHorizon: (horizon: Horizon) => void;
  zoom: [number, number] | null;
  onZoom: (range: [number, number] | null) => void;
  replay?: (snapshotId: string) => void;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const narrow = width > 0 && width < 560;
  const labelW = 34, readoutW = narrow ? 52 : 92;
  const plotW = Math.max(0, width - labelW - readoutW);
  const maxColumns = plotW > 0 ? Math.max(24, Math.min(180, Math.floor(plotW / 6))) : 160;
  const timeline = useMemo(() => breadthTimeline(samples, HORIZONS, { range: zoom, maxColumns }), [samples, zoom, maxColumns]);
  // The readout is the newest frame in view (not a bucket mean), so it matches the counts beside the chart.
  // The readout is the newest recorded frame inside the visible range, labelled with its own time.
  const latest = useMemo(() => {
    const [start, end] = zoom ?? [-Infinity, Infinity];
    const newest = [...samples].reverse().find((point) => point.time <= end && point.time >= start);
    return { time: newest?.time ?? null, cells: Object.fromEntries(HORIZONS.map((h) => [h, newest?.breadth?.[h] ? { ...newest.breadth[h], valid: newest.valid } : null])) };
  }, [samples, zoom]);
  const columns = timeline.columns;
  const colW = columns.length ? plotW / columns.length : 0;
  const span = timeline.start != null && timeline.end != null ? timeline.end - timeline.start : 0;
  const withDate = span > 36 * 3_600_000;
  const ticks = timeline.start != null && timeline.end != null ? timelineTicks([timeline.start, timeline.end], plotW) : [];
  const x = (time: number) => labelW + ((time - (timeline.start ?? 0)) / (span || 1)) * plotW;

  const [active, setActive] = useState<{ col: number; row: number | null } | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ left: number; right: number; top: number; bottom: number } | null>(null);
  const liveId = useId();
  // Pins are column times, so a refresh or a zoom keeps the same recorded column when it is still visible.
  const [pinnedTime, setPinnedTime] = useState<number | null>(null);
  const pinnedIndex = pinnedTime == null ? null : columns.findIndex((column) => pinnedTime >= column.start && pinnedTime < column.end);
  const pin = pinnedIndex != null && pinnedIndex >= 0 ? pinnedIndex : null;

  // Column indexes only mean something on the grid that produced them; a rebucketed grid drops them.
  const grid = `${timeline.start}/${timeline.bucketMinutes}/${columns.length}`;
  const [gridKey, setGridKey] = useState(grid);
  if (gridKey !== grid) { setGridKey(grid); setDrag(null); setActive(null); }
  const shown = active && active.col < columns.length ? active : null;
  const selectedRow = HORIZONS.indexOf(horizon);

  const locate = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left, py = event.clientY - box.top + TOP;
    const col = Math.min(columns.length - 1, Math.max(0, Math.floor(px / (colW || 1))));
    const row = py >= TOP && py < TOP + HEAT ? Math.min(HORIZONS.length - 1, Math.floor((py - TOP) / (ROW + ROW_GAP))) : null;
    anchor.current = { left: event.clientX - 2, right: event.clientX + 2, top: event.clientY - 6, bottom: event.clientY + 6 };
    return { col, row };
  };
  // A pointer drag needs two columns so a wobbly click still pins; a keyboard selection may be one step.
  const finish = (target: { col: number; row: number | null }, minSpan = 2) => {
    const valid = drag && drag.from < columns.length && drag.to < columns.length;
    const range = valid && Math.abs(drag.to - drag.from) >= minSpan ? [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)] : null;
    setDrag(null);
    if (range) {
      onZoom([columns[range[0]].start, columns[range[1]].end - 1]);
      setActive(null);
      return;
    }
    if (target.row !== null) setHorizon(HORIZONS[target.row] as Horizon);
    const column = columns[target.col];
    if (!column) return;
    setPinnedTime(pin === target.col ? null : column.start);
  };
  const key = (event: KeyboardEvent) => {
    if (!columns.length) return;
    const col = shown?.col ?? columns.length - 1;
    // Keyboard zoom: Shift+arrows extend a selection from the active column, Enter zooms, minus resets.
    if (event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const next = Math.max(0, Math.min(columns.length - 1, (drag?.to ?? col) + (event.key === "ArrowLeft" ? -1 : 1)));
      setDrag({ from: drag?.from ?? col, to: next });
      setActive({ col: next, row: selectedRow });
      return;
    }
    if (event.key === "Enter" && drag) {
      event.preventDefault();
      finish({ col: drag.to, row: null }, 1);
      return;
    }
    if (event.key === "-" && zoom) {
      event.preventDefault();
      onZoom(null);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setActive({ col: Math.max(0, Math.min(columns.length - 1, col + (event.key === "ArrowLeft" ? -1 : 1))), row: selectedRow });
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = Math.max(0, Math.min(HORIZONS.length - 1, selectedRow + (event.key === "ArrowUp" ? -1 : 1)));
      setHorizon(HORIZONS[next] as Horizon);
      setActive({ col, row: next });
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive({ col: event.key === "Home" ? 0 : columns.length - 1, row: selectedRow });
    } else if ((event.key === "Enter" || event.key === " ") && shown) {
      event.preventDefault();
      setPinnedTime(pin === shown.col ? null : columns[shown.col].start);
    } else if (event.key === "Escape") {
      setActive(null); setPinnedTime(null); setDrag(null);
    }
  };

  // Keyboard focus anchors the tooltip on the active column instead of the pointer.
  const svgRef = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!tip || !shown) return;
    let box = anchor.current;
    if (!box && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const left = rect.left + labelW + shown.col * colW;
      box = { left, right: left + colW, top: rect.top + TOP, bottom: rect.top + TOP + HEAT };
    }
    if (!box) return;
    const size = tip.getBoundingClientRect();
    const place = tooltipPlacement(box, { width: size.width, height: size.height }, { width: window.innerWidth, height: window.innerHeight }, 12);
    setTipPos({ left: place.left, top: place.top });
  }, [shown, colW]);

  // The measured wrapper stays mounted in the empty state, so the width is known when history arrives.
  if (!columns.length) return <div className="mp-timeline mp-timeline--empty" ref={ref} role="status">
    <span className="mp-skeleton" style={{ height: 160 }} />
    <p>Recording market history. The timeline fills as frames are stored.</p>
  </div>;

  const pinnedColumn = pin != null ? columns[pin] : null;
  // A hairline between columns only once they are wide enough not to read as a barcode.
  const cellW = Math.max(1, colW - (colW >= 9 ? 1 : 0));
  const tipColumn = shown ? columns[shown.col] : null;
  const ribbonCell = (column: TimelineColumn) => column.cells[horizon];
  const latestSelected = latest.cells[horizon];
  const lastTick = ticks.at(-1);
  // The newest visible frame gets its own tick at its own time, so the axis reaches it without inventing an end.
  const endTick = latest.time != null && timeline.start != null && timeline.end != null && latest.time >= timeline.start && latest.time <= timeline.end &&
    (lastTick == null || x(latest.time) - x(lastTick) > 44) ? latest.time : null;

  return <div className="mp-timeline" ref={ref}>
    <div className="mp-timeline__frame" tabIndex={0} role="group" onKeyDown={key}
      aria-label={`Breadth pressure by horizon over time, ${columns.length} columns of ${timeline.bucketMinutes} minutes. Left and right arrows move in time, up and down change horizon, Enter pins a column. Shift with left or right selects a range and Enter zooms to it; minus resets the zoom. Escape clears.`}
      aria-describedby={liveId} onBlur={() => setActive(null)}>
      {width > 0 && <svg ref={svgRef} width={width} height={HEIGHT} className="mp-timeline__svg" aria-hidden="true">
        {HORIZONS.map((h, row) => {
          const y = TOP + row * (ROW + ROW_GAP);
          const isSelected = h === horizon;
          const value = latest.cells[h];
          return <g key={h} className="mp-timeline__row" data-selected={isSelected || undefined}>
            <rect x={labelW} y={y} width={plotW} height={ROW} rx={3} className="mp-timeline__track" />
            {columns.map((column, col) => {
              const color = fill(column.cells[h]);
              return color ? <rect key={col} x={labelW + col * colW} y={y} width={cellW} height={ROW} fill={color} opacity={column.carried ? 0.82 : 1} /> : null;
            })}
            {isSelected && <rect x={labelW - 1} y={y - 1} width={plotW + 2} height={ROW + 2} rx={3} className="mp-timeline__selected" />}
            <text x={labelW - 8} y={y + ROW / 2} dy="0.35em" textAnchor="end" className="mp-timeline__label">{label(h)}</text>
            <text x={labelW + plotW + 8} y={y + ROW / 2} dy="0.35em" className="mp-timeline__readout"
              data-tone={value?.pressure == null ? undefined : value.pressure > 0 ? "up" : value.pressure < 0 ? "down" : "flat"}>
              {value?.pressure == null ? "—" : signed(value.pressure, 1)}
              {!narrow && value && <tspan className="mp-timeline__counts" dx={6}>{pct(value.positive)}▲ {pct(value.negative)}▼</tspan>}
            </text>
          </g>;
        })}
        <text x={labelW + plotW + 8} y={TOP - 6} className="mp-timeline__counts">{latest.time != null ? `at ${utc(latest.time, false)}` : "no frame"}</text>
        <line x1={labelW} x2={labelW + plotW} y1={RIBBON_MID} y2={RIBBON_MID} className="mp-timeline__zero" />
        <text x={labelW - 8} y={RIBBON_TOP + 10} textAnchor="end" className="mp-timeline__label mp-timeline__label--up">▲</text>
        <text x={labelW - 8} y={RIBBON_TOP + RIBBON - 4} textAnchor="end" className="mp-timeline__label mp-timeline__label--down">▼</text>
        {columns.map((column, col) => {
          const cell = ribbonCell(column);
          if (!cell) return null;
          const up = Math.max(0, Math.min(1, cell.positive ?? 0)) * (RIBBON / 2 - 2);
          const down = Math.max(0, Math.min(1, cell.negative ?? 0)) * (RIBBON / 2 - 2);
          const opacity = column.carried ? 0.45 : 0.72;
          return <g key={col} opacity={opacity}>
            {up > 0 && <rect x={labelW + col * colW} y={RIBBON_MID - up} width={cellW} height={up} className="mp-timeline__up" />}
            {down > 0 && <rect x={labelW + col * colW} y={RIBBON_MID} width={cellW} height={down} className="mp-timeline__down" />}
          </g>;
        })}
        <text x={labelW + plotW + 8} y={RIBBON_TOP + 10} className="mp-timeline__readout" data-tone="up">{pct(latestSelected?.positive ?? null)}</text>
        <text x={labelW + plotW + 8} y={RIBBON_TOP + RIBBON - 4} className="mp-timeline__readout" data-tone="down">{pct(latestSelected?.negative ?? null)}</text>
        {!narrow && <text x={labelW + plotW + 8} y={RIBBON_MID} dy="0.35em" className="mp-timeline__counts">{label(horizon)} share</text>}
        {columns.map((column, col) => column.gapBefore
          ? <g key={`g${col}`} className="mp-timeline__gap"><title>Retained gap before this column</title>
            <line x1={labelW + col * colW - 0.5} x2={labelW + col * colW - 0.5} y1={TOP - 2} y2={RIBBON_TOP + RIBBON + 2} /></g>
          : null)}
        {columns.map((column, col) => column.coverageChanged
          ? <g key={`m${col}`} className="mp-timeline__marker"><title>Coverage or membership changed</title>
            <line x1={labelW + col * colW} x2={labelW + col * colW} y1={TOP - 4} y2={RIBBON_TOP + RIBBON} />
            <path d={`M${labelW + col * colW - 4} ${TOP - 7}h8l-4 5z`} /></g>
          : null)}
        {ticks.map((time) => <g key={time} className="mp-timeline__tick">
          <line x1={x(time)} x2={x(time)} y1={RIBBON_TOP + RIBBON + 1} y2={RIBBON_TOP + RIBBON + 5} />
          <text x={x(time)} y={HEIGHT - 4} textAnchor="middle">{new Date(time).getUTCHours() === 0 && new Date(time).getUTCMinutes() === 0 && withDate
            ? new Date(time).toLocaleDateString("en-GB", { timeZone: "UTC", month: "short", day: "numeric" })
            : utc(time, false)}</text>
        </g>)}
        {endTick != null && <g className="mp-timeline__tick mp-timeline__tick--end">
          <line x1={x(endTick)} x2={x(endTick)} y1={RIBBON_TOP + RIBBON + 1} y2={RIBBON_TOP + RIBBON + 5} />
          <text x={Math.min(x(endTick), labelW + plotW)} y={HEIGHT - 4} textAnchor="end">{utc(endTick, false)}</text>
        </g>}
        {drag && <rect x={labelW + Math.min(drag.from, drag.to) * colW} y={TOP - 2} width={(Math.abs(drag.to - drag.from) + 1) * colW} height={RIBBON_TOP + RIBBON - TOP + 4} className="mp-timeline__brush" />}
        {pinnedColumn && <rect x={labelW + pin! * colW - 1} y={TOP - 3} width={cellW + 2} height={RIBBON_TOP + RIBBON - TOP + 6} rx={2} className="mp-timeline__pin" />}
        {shown && !drag && <rect x={labelW + shown.col * colW - 1} y={TOP - 3} width={cellW + 2} height={RIBBON_TOP + RIBBON - TOP + 6} rx={2} className="mp-timeline__cursor" />}
        <rect x={labelW} y={TOP} width={Math.max(0, plotW)} height={RIBBON_TOP + RIBBON - TOP} fill="transparent" className="mp-timeline__hit"
          style={{ pointerEvents: "all" }}
          onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); const at = locate(event); setDrag({ from: at.col, to: at.col }); setActive(at); }}
          onPointerMove={(event) => { const at = locate(event); setActive(at); if (drag) setDrag({ ...drag, to: at.col }); }}
          onPointerUp={(event) => finish(locate(event))}
          onPointerCancel={() => setDrag(null)}
          onPointerLeave={(event) => { if (event.pointerType !== "touch" && !drag) { setActive(null); anchor.current = null; } }} />
      </svg>}
    </div>
    <span id={liveId} className="sr-only" role="status" aria-live="polite">{tipColumn ? describe(tipColumn, horizon, withDate) : ""}</span>
    {pinnedColumn && <div className="mp-timeline__pinned" role="status">
      <span><b>Pinned</b> {pinnedColumn.time == null ? `${utc(pinnedColumn.start, withDate)} UTC · retained gap` : describe(pinnedColumn, horizon, withDate)}
        {pinnedColumn.valid != null && ` · ${pinnedColumn.valid}/${pinnedColumn.expected} instruments`}</span>
      {replay && pinnedColumn.snapshot && <button type="button" className="mp-text-button" onClick={() => replay(pinnedColumn.snapshot!)}>Open recorded frame</button>}
      <button type="button" className="mp-text-button" onClick={() => setPinnedTime(null)}>Unpin</button>
    </div>}
    {tipColumn && !drag && createPortal(<div ref={tipRef} className="mp-timeline__tip" style={tipPos ? { left: tipPos.left, top: tipPos.top } : { left: 0, top: 0, visibility: "hidden" }}>
      {tipColumn.time == null
        ? <TooltipCard title={`${utc(tipColumn.start, true)} UTC`} rows={[{ key: "gap", label: "Retained gap", color: "var(--mp-unchanged)", value: "no observation" }]} />
        : <TooltipCard
          title={`${when(tipColumn, true)} · ${tipColumn.valid}/${tipColumn.expected} instruments`}
          rows={HORIZONS.map((h) => {
            const cell = tipColumn.cells[h];
            return {
              key: h,
              label: `${label(h)}${h === horizon ? " ●" : ""}`,
              color: fill(cell) ?? "var(--mp-raised)",
              value: cell?.pressure == null ? "—" : signed(cell.pressure),
              tone: cell?.pressure == null || cell.pressure === 0 ? undefined : cell.pressure > 0 ? "q-positive" : "q-negative",
              note: shown?.row === HORIZONS.indexOf(h) || h === horizon ? balance(cell) : undefined,
            };
          })} />}
    </div>, document.body)}
  </div>;
}
