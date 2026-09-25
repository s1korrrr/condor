import { useMemo } from 'react';
import { formatDecimal, formatSigned } from './format';
import { historySeries, type HistoryPoint } from '@/features/portfolio/model';
import { TimeSeriesChart } from './kit/charts';
import { CHART, type ChartSeries } from './kit/series';

type OverlayPoint = { time: number; value: number | null };

/** Observation chart only. Gaps are never interpolated into portfolio returns. Hover shows exact marks.
 * `overlay` (cumulative bot PnL) is drawn on its own secondary scale; `restarts` are owner-change rules. */
export function EquityChart({ points, unit, overlay, overlayLabel, restarts = [], height = 250, maxGapMs }: {
  points: HistoryPoint[]; unit: string; overlay?: OverlayPoint[] | null; overlayLabel?: string; restarts?: number[]; height?: number;
  /** Longest spacing that is still one continuous line; defaults to the one-minute observer cadence. */
  maxGapMs?: number;
}) {
  const series = useMemo(() => historySeries(points, maxGapMs), [points, maxGapMs]);
  const chartSeries = useMemo<ChartSeries[]>(() => {
    const wallet: ChartSeries = { id: 'wallet', label: `Wallet value`, color: CHART.blue, area: true, unit, points: series };
    if (!overlay || series.length < 2) return [wallet];
    const left = series[0].time, right = series[series.length - 1].time;
    const inWindow = overlay.filter(point => point.time >= left && point.time <= right);
    return inWindow.filter(point => point.value !== null).length >= 2
      ? [wallet, { id: 'overlay', label: overlayLabel ?? 'Cumulative bot PnL', color: CHART.cyan, axis: 'secondary', format: value => formatSigned(value), points: inWindow }]
      : [wallet];
  }, [series, overlay, overlayLabel, unit]);
  const known = series.filter(point => point.value !== null);
  if (!known.length) return <div className="q-chart-empty" style={{ minHeight: 220 }}><span className="q-empty-symbol" aria-hidden="true">⌁</span><strong>No valued observations yet</strong><p>Current balances appear above. This chart needs timestamped account history.</p></div>;
  if (series.some((point, index) => !Number.isFinite(point.time) || index > 0 && point.time <= series[index - 1].time)) return <p className="q-empty">Observation timestamps are invalid. History cannot be plotted.</p>;
  const hasOverlay = chartSeries.length > 1;
  return <figure className="q-equity-chart">
    <TimeSeriesChart ariaLabel={`Observed account equity in ${unit}. Hover for exact marks. Missing observations are gaps.`} height={height} series={chartSeries}
      markers={restarts.map(time => ({ time, label: 'Owner restart', color: CHART.warning }))} leftFormat={value => formatDecimal(value)} rightFormat={value => formatSigned(value)} />
    <div className="q-legend">
      <span><i className="q-swatch" style={{ background: 'var(--q-blue)' }} />Wallet value · {unit}</span>
      {hasOverlay && <span><i className="q-swatch" style={{ background: 'var(--q-cyan)' }} />{overlayLabel ?? 'Cumulative bot PnL'} · left scale</span>}
      {restarts.length > 0 && <span><i className="q-swatch" style={{ background: 'var(--q-warning)' }} />Owner restart</span>}
      <span className="q-muted">{known.length} valued marks · hover to inspect</span>
    </div>
    <p className="q-empty">Account value includes deposits, withdrawals and market movement. It is not a profit curve.</p>
  </figure>;
}
