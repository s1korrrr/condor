import { useEffect, useRef, useState } from "react";
import { SparkChart } from "@/features/quant-ops/kit/charts";
import type { SeriesPoint } from "@/features/quant-ops/kit/series";
import { FEATURE_GROUPS, featureRows, featureText, type FeatureRow } from "./market-model.mjs";

const KEEP = 240; // 240 packets ≈ 2 hours at the workspace's 30-second read
type Features = Parameters<typeof featureRows>[0];

/**
 * Every feature in the current V5 market-context packet, grouped, with a trend of the values this browser has
 * seen since the page opened. The owner publishes no feature history, so the trend is labelled as page-local.
 */
export function V5MarketFeatures({ features, cutoffMs }: { features: Features; cutoffMs: number | null }) {
  const history = useRef(new Map<string, SeriesPoint[]>());
  const lastCutoff = useRef<number | null>(null);
  const [, setVersion] = useState(0);
  const [group, setGroup] = useState<string>("All");
  const [open, setOpen] = useState<string | null>(null);
  const rows = featureRows(features);
  useEffect(() => {
    if (cutoffMs == null || cutoffMs === lastCutoff.current) return;
    lastCutoff.current = cutoffMs;
    for (const row of featureRows(features)) {
      if (row.numeric == null || row.status !== "QUALIFIED") continue;
      const points = history.current.get(row.id) ?? [];
      points.push({ time: cutoffMs, value: row.numeric });
      history.current.set(row.id, points.slice(-KEEP));
    }
    setVersion(version => version + 1);
  }, [features, cutoffMs]);
  if (!rows.length) return <p className="v5m-hint">The feed packet carries no features. No market reading is inferred.</p>;
  const groups = FEATURE_GROUPS.filter(name => rows.some(row => row.group === name));
  const shown = group === "All" ? rows : rows.filter(row => row.group === group);
  const pressure = rows.find(row => row.id === "spot.pressure_original_1m");
  return <div className="v5m-features">
    <div className="v5m-feature-bar">
      <div role="group" aria-label="Feature group" className="v5m-seg">{["All", ...groups].map(name => <button key={name} type="button" aria-pressed={group === name} onClick={() => setGroup(name)}>{name}<small>{name === "All" ? rows.length : rows.filter(row => row.group === name).length}</small></button>)}</div>
      {pressure?.numeric != null && <PressureGauge value={pressure.numeric} />}
    </div>
    <div className="v5m-feature-grid">{shown.map(row => <FeatureTile key={row.id} row={row} points={history.current.get(row.id) ?? []} open={open === row.id} onToggle={() => setOpen(open === row.id ? null : row.id)} />)}</div>
    <p className="v5m-hint">Trends show the values this page has read since it opened (one point per feed packet), not stored history. Click a feature for its id, unit and state.</p>
  </div>;
}

function FeatureTile({ row, points, open, onToggle }: { row: FeatureRow; points: SeriesPoint[]; open: boolean; onToggle: () => void }) {
  const qualified = row.status === "QUALIFIED";
  return <button type="button" className={`v5m-feature${qualified ? "" : " is-unqualified"}${open ? " is-open" : ""}`} aria-expanded={open} onClick={onToggle} title={`${row.id} · ${row.unit} · ${row.status}`}>
    <span className="v5m-feature-label">{row.label}</span>
    <strong>{qualified ? row.text : row.status.toLowerCase().replaceAll("_", " ")}</strong>
    {points.length >= 2 ? <SparkChart points={points} height={26} format={value => featureText(value, row.unit)} ariaLabel={`${row.label} since this page opened`} /> : <span className="v5m-feature-wait">{qualified ? "trend after the next packets" : "no value"}</span>}
    {open && <span className="v5m-feature-meta">{row.id} · unit {row.unit || "none"} · {row.status.toLowerCase()} · {points.length} reading{points.length === 1 ? "" : "s"} on this page</span>}
  </button>;
}

/** Spot pressure on its owner scale (−3 … +3): where the five coins' one-minute moves net out. */
function PressureGauge({ value }: { value: number }) {
  const share = Math.min(1, Math.max(0, (value + 3) / 6));
  return <div className="v5m-pressure" title="Spot pressure, owner scale −3 (all coins falling) to +3 (all rising), last minute">
    <span>Spot pressure</span>
    <div><i style={{ left: `${share * 100}%` }} /></div>
    <small><span>−3 selling</span><b>{value > 0 ? "+" : ""}{value.toFixed(2)}</b><span>buying +3</span></small>
  </div>;
}
