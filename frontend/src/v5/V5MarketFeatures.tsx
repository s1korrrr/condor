import { useState } from "react";
import { FEATURE_GROUPS, featureRows, type FeatureRow } from "./market-model.mjs";

type Features = Parameters<typeof featureRows>[0];

/** Every feature in the current V5 market-context packet, grouped; an unqualified value shows its state, not a number. */
export function V5MarketFeatures({ features }: { features: Features }) {
  const [group, setGroup] = useState<string>("All");
  const [open, setOpen] = useState<string | null>(null);
  const rows = featureRows(features);
  if (!rows.length) return <p className="v5m-hint">The feed packet carries no features. No market reading is inferred.</p>;
  const groups = FEATURE_GROUPS.filter(name => rows.some(row => row.group === name));
  const shown = group === "All" ? rows : rows.filter(row => row.group === group);
  return <div className="v5m-features">
    <div role="group" aria-label="Feature group" className="v5m-seg">{["All", ...groups].map(name => <button key={name} type="button" aria-pressed={group === name} onClick={() => setGroup(name)}>{name}<small>{name === "All" ? rows.length : rows.filter(row => row.group === name).length}</small></button>)}</div>
    <div className="v5m-feature-grid">{shown.map(row => <FeatureTile key={row.id} row={row} open={open === row.id} onToggle={() => setOpen(open === row.id ? null : row.id)} />)}</div>
    <p className="v5m-hint">Values from the current feed packet only; the owner publishes no feature history. Click a feature for its id, unit and state.</p>
  </div>;
}

function FeatureTile({ row, open, onToggle }: { row: FeatureRow; open: boolean; onToggle: () => void }) {
  const qualified = row.status === "QUALIFIED";
  return <button type="button" className={`v5m-feature${qualified ? "" : " is-unqualified"}${open ? " is-open" : ""}`} aria-expanded={open} onClick={onToggle} title={`${row.id} · ${row.unit} · ${row.status}`}>
    <span className="v5m-feature-label">{row.label}</span>
    <strong>{qualified ? row.text : row.status.toLowerCase().replaceAll("_", " ")}</strong>
    {open && <span className="v5m-feature-meta">{row.id} · unit {row.unit || "none"} · {row.status.toLowerCase()}</span>}
  </button>;
}
