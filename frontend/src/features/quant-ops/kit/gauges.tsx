import type { ReactNode } from 'react';
import { CHART } from './series';
import './gauges.css';

/**
 * Compact ring (donut) gauge for one share of a population, for example "2 of 5 above EMA21".
 * The ring sweeps `ratio` of the circle; hovering or focusing it opens a tooltip with the full
 * definition. Pass `onClick` to make the whole tile a button.
 */
export function RingGauge({ ratio, label, valueText, note, tip, color = CHART.positive, onClick, active, delta }: {
  ratio: number; label: string; valueText: string; note?: ReactNode; tip?: ReactNode; color?: string;
  onClick?: () => void; active?: boolean; delta?: { text: string; tone?: 'positive' | 'negative' | 'neutral' } | null;
}) {
  const share = Math.min(1, Math.max(0, ratio));
  const radius = 34, circumference = 2 * Math.PI * radius;
  const Tag = onClick ? 'button' : 'div';
  return <Tag className="q-ring" {...(onClick ? { type: 'button', onClick, 'aria-pressed': active } : {})} aria-label={`${label}: ${valueText}`}>
    <span className="q-ring__plot">
      <svg viewBox="0 0 80 80" role="img" aria-label={`${label} ${valueText}`}>
        <circle className="q-ring__track" cx="40" cy="40" r={radius} />
        <circle cx="40" cy="40" r={radius} fill="none" stroke={color} strokeWidth="8" strokeLinecap={share > 0 && share < 1 ? 'round' : 'butt'}
          strokeDasharray={`${share * circumference} ${circumference}`} transform="rotate(-90 40 40)" />
      </svg>
      <strong>{valueText}</strong>
    </span>
    <span className="q-ring__label">{label}</span>
    {note && <small className="q-ring__note">{note}</small>}
    {delta && <small className="q-ring__delta" data-tone={delta.tone ?? 'neutral'}>{delta.text}</small>}
    {tip && <span className="q-ring__tip q-tooltip" role="tooltip">{tip}</span>}
  </Tag>;
}
