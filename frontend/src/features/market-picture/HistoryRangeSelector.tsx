import { useId, type ChangeEvent, type KeyboardEvent } from "react";
import { normalizeHistoryRange, type HistoryRange } from "./history-range.mjs";

function utcValue(time: number | undefined) {
  if (time === undefined) return "Unavailable";
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? `${time} ms since epoch` : date.toISOString();
}

function utcDateTime(time: number | undefined) {
  if (time === undefined) return undefined;
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Native range handles for selecting a view inside already projected chart history. */
export function HistoryRangeSelector({
  times,
  range,
  onChange,
}: {
  /** Ascending unique plotted timestamps, including explicit null-gap sentinels. */
  times: number[];
  /** Null keeps the full retained window visible. */
  range: HistoryRange | null;
  onChange: (range: HistoryRange | null) => void;
}) {
  const id = useId();
  const normalized = normalizeHistoryRange(times, range);
  const start = normalized?.start ?? 0;
  const end = normalized?.end ?? Math.max(0, times.length - 1);
  const startTime = utcValue(times[start]);
  const endTime = utcValue(times[end]);
  const disabled = times.length < 2;
  const full = normalized === null || (start === 0 && end === times.length - 1);
  const status = times.length === 0
    ? "No plotted timestamps are available."
    : `${full ? "Full retained interval" : "Selected interval"} · ${end - start + 1} of ${times.length} plotted timestamps · bounds in UTC.`;

  const changeStart = (event: ChangeEvent<HTMLInputElement>) => {
    const requested = Number(event.currentTarget.value);
    const next = Math.min(end, requested);
    onChange({ start: next, end });
  };
  const changeEnd = (event: ChangeEvent<HTMLInputElement>) => {
    const requested = Number(event.currentTarget.value);
    const next = Math.max(start, requested);
    onChange({ start, end: next });
  };
  const resetOnEscape = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onChange(null);
    }
  };

  return <fieldset className="mp-history-range">
    <legend>Chart time range</legend>
    <p id={`${id}-instructions`} className="sr-only">Drag either handle or use its arrow keys; Home and End move to the bounds. Escape resets the full retained interval.</p>
    <div className="mp-history-range__controls">
      <label>
        <span className="mp-history-range__label">Chart range start <span className="mp-history-range__bound">From <time dateTime={utcDateTime(times[start])}>{startTime}</time></span></span>
        <input
          type="range"
          aria-label="Chart range start"
          aria-describedby={`${id}-instructions`}
          aria-valuetext={startTime}
          min={0}
          max={Math.max(0, times.length - 1)}
          step={1}
          value={start}
          disabled={disabled}
          onChange={changeStart}
          onKeyDown={resetOnEscape}
        />
      </label>
      <label>
        <span className="mp-history-range__label">Chart range end <span className="mp-history-range__bound">To <time dateTime={utcDateTime(times[end])}>{endTime}</time></span></span>
        <input
          type="range"
          aria-label="Chart range end"
          aria-describedby={`${id}-instructions`}
          aria-valuetext={endTime}
          min={0}
          max={Math.max(0, times.length - 1)}
          step={1}
          value={end}
          disabled={disabled}
          onChange={changeEnd}
          onKeyDown={resetOnEscape}
        />
      </label>
    </div>
    <div className="mp-history-range__footer">
      <p className="mp-history-range__status" role="status">{status}</p>
      <button type="button" disabled={disabled} onClick={() => onChange(null)}>Reset range</button>
    </div>
  </fieldset>;
}
