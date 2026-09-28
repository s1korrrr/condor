import type { ReactNode } from "react";
import { metricText, metricTitle, type DisplayMetric } from "./presentation";

export function Panel({
  id,
  title,
  detail,
  actions,
  className = "",
  children,
}: {
  id: string;
  title: string;
  detail?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={`mp-panel ${className}`}
      aria-labelledby={`${id}-title`}
    >
      <header className="mp-panel-heading">
        <h2 id={`${id}-title`}>{title}</h2>
        {detail && <span className="mp-panel-detail">{detail}</span>}
        <div className="mp-panel-actions">{actions}</div>
      </header>
      {children}
    </section>
  );
}
export function Empty({
  children = "No qualified observations in this frame.",
}: {
  children?: ReactNode;
}) {
  return (
    <div className="mp-empty">
      <span className="mp-empty-cross" aria-hidden="true">
        ＋
      </span>
      <p>{children}</p>
    </div>
  );
}
export function Metric({
  metric,
  digits = 1,
  signed = false,
  className = "",
}: {
  metric?: DisplayMetric;
  digits?: number;
  signed?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`mp-number ${className}`}
      title={metric ? metricTitle(metric) : "No qualified source observation"}
      data-missing={metric?.value == null || undefined}
    >
      {metricText(metric, digits, signed)}
    </span>
  );
}
export function Sparkline({
  values,
  color = "var(--mp-positive)",
  label,
}: {
  values: Array<number | null>;
  color?: string;
  label: string;
}) {
  const valid = values.filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  if (valid.length < 2)
    return (
      <span
        className="mp-sparkline-empty"
        title={`${label}: history unavailable`}
      >
        History unavailable
      </span>
    );
  const low = Math.min(...valid),
    high = Math.max(...valid),
    range = high - low || 1;
  let path = "",
    gap = true;
  values.forEach((value, index) => {
    if (value === null) {
      gap = true;
      return;
    }
    const x = 2 + (index / Math.max(1, values.length - 1)) * 156;
    const y = 25 - ((value - low) / range) * 22;
    path += `${gap ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)} `;
    gap = false;
  });
  return (
    <svg
      viewBox="0 0 160 28"
      className="mp-sparkline"
      role="img"
      aria-label={label}
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.7"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
export function Quality({
  valid,
  expected,
}: {
  valid: number;
  expected: number;
}) {
  return (
    <span className="mp-coverage" data-partial={valid < expected || undefined}>
      {valid}/{expected} valid
    </span>
  );
}
export function Time({ value }: { value: number }) {
  return (
    <time
      dateTime={new Date(value).toISOString()}
      title={new Date(value).toISOString()}
    >
      {new Date(value).toLocaleTimeString("en-GB", {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
}

export function Delta({ metric }: { metric?: DisplayMetric }) {
  return (
    <small
      className={
        metric?.value == null
          ? "mp-muted mp-delta"
          : metric.value < 0
            ? "mp-down mp-delta"
            : "mp-up mp-delta"
      }
      title={
        metric
          ? metricTitle(metric)
          : "A retained observation with the same definition and common cohort is required."
      }
    >
      {metric?.value == null
        ? "1h comparison unavailable"
        : `${metricText(metric, 1, true)} · 1h`}
    </small>
  );
}
