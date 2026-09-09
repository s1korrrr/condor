import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { RecordedBotStatistics } from '@/lib/native-bot-statistics';

const axis = { fill: 'var(--color-text-muted)', fontSize: 11 };
const buyColor = 'var(--color-green)';
const sellColor = 'var(--color-primary)';
const countColor = 'var(--color-yellow)';
const compact = (value: number) => value !== 0 && Math.abs(value) < 1
  ? value.toLocaleString(undefined, { maximumSignificantDigits: 3 })
  : value.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 2 });
const exact = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 6 });

export function NativeBotActivityCharts({ stats }: { stats: RecordedBotStatistics }) {
  const { activity, quote } = stats;
  const buyVolume = activity.daily.reduce((sum, point) => sum + point.buyVolume, 0);
  const sellVolume = activity.daily.reduce((sum, point) => sum + point.sellVolume, 0);
  const pairVolumes = stats.pairs.filter(pair => pair.fillCount > 0 && pair.volume !== null)
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)).slice(0, 12);
  const pairFees = stats.pairs.filter(pair => pair.fillCount > 0 && pair.fees !== null)
    .sort((a, b) => (b.fees ?? 0) - (a.fees ?? 0)).slice(0, 12);
  const volumeUnavailable = activity.volumeUnavailable === 'mixed_quote_currencies'
    ? 'Volume chart unavailable: quote currencies differ. See each pair’s recorded values below.'
    : 'Volume chart unavailable: some recorded fill volumes are missing or invalid.';

  return <div className="space-y-5">
    <div className="grid min-w-0 gap-5 xl:grid-cols-3">
      <figure className="min-w-0 space-y-3 xl:col-span-2">
        <figcaption className="text-sm font-medium">Recorded fill volume · UTC</figcaption>
        {stats.fillCount === 0 ? <p className="text-sm text-[var(--color-text-muted)]">No recorded fills yet. A volume history will appear after the first fill.</p>
          : activity.volumeUnavailable ? <p className="text-sm text-[var(--color-text-muted)]">{volumeUnavailable}</p> : <>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums">
              <span><span aria-hidden="true" className="mr-2 inline-block h-2 w-2 rounded-sm" style={{ background: buyColor }} />Buy {exact(buyVolume)} {quote}</span>
              <span><span aria-hidden="true" className="mr-2 inline-block h-2 w-2 rounded-sm" style={{ background: sellColor }} />Sell {exact(sellVolume)} {quote}</span>
            </div>
            <div className="h-52 w-full min-w-0" aria-hidden="true">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={activity.daily} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} accessibilityLayer={false}>
                  <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
                  <XAxis dataKey="startDate" tick={axis} tickFormatter={date => String(date).slice(5)} minTickGap={28} axisLine={false} tickLine={false} />
                  <YAxis tick={axis} tickFormatter={compact} width={48} axisLine={false} tickLine={false} />
                  <Bar dataKey="buyVolume" stackId="volume" fill={buyColor} maxBarSize={48} isAnimationActive={false} />
                  <Bar dataKey="sellVolume" stackId="volume" fill={sellColor} maxBarSize={48} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">
              {activity.bucketDays === 1 ? 'Daily totals' : `Totals in ${activity.bucketDays}-day calendar buckets (at most 90 bars)`}, {quote}. {activity.daily[0].startDate} to {activity.daily.at(-1)!.endDate} UTC; first and last days may be partial.
              {' '}{activity.daysWithoutRecordedFills} calendar {activity.daysWithoutRecordedFills === 1 ? 'day has' : 'days have'} no recorded fills. Empty buckets mean no fills in retained records; they do not establish continuous data capture or bot uptime.
            </p>
            <details className="text-xs">
              <summary className="cursor-pointer text-[var(--color-text-muted)]">Exact volume by UTC period</summary>
              <div className="mt-2 max-h-64 overflow-auto">
                <table className="w-full text-left tabular-nums">
                  <caption className="sr-only">Recorded fill volume in {quote}; dates include both UTC days</caption>
                  <thead><tr>{['UTC period', `Buy (${quote})`, `Sell (${quote})`, 'Fills'].map(label => <th key={label} scope="col" className="py-2 pr-4 whitespace-nowrap font-medium">{label}</th>)}</tr></thead>
                  <tbody>{activity.daily.map(point => <tr key={point.startDate} className="border-t border-[var(--color-border)]">
                    <th scope="row" className="py-2 pr-4 whitespace-nowrap font-normal">{point.startDate}{point.endDate !== point.startDate ? ` – ${point.endDate}` : ''}</th>
                    <td className="py-2 pr-4">{exact(point.buyVolume)}</td><td className="py-2 pr-4">{exact(point.sellVolume)}</td><td className="py-2 pr-4">{point.fillCount}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            </details>
          </>}
      </figure>

      <figure className="min-w-0 space-y-3">
        <figcaption className="text-sm font-medium">Recorded order statuses</figcaption>
        {stats.orderCount === 0 ? <p className="text-sm text-[var(--color-text-muted)]">No recorded orders yet.</p> : <>
          <div className="h-52 w-full min-w-0" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={activity.orderStatuses} layout="vertical" margin={{ top: 8, right: 14, bottom: 0, left: 0 }} accessibilityLayer={false}>
                <CartesianGrid horizontal={false} stroke="var(--color-border)" strokeDasharray="3 3" />
                <XAxis type="number" allowDecimals={false} tick={axis} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="status" width={86} tick={axis} axisLine={false} tickLine={false} />
                <Bar dataKey="count" fill={countColor} maxBarSize={26} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <dl className="flex flex-wrap gap-x-4 gap-y-2 text-xs tabular-nums">{activity.orderStatuses.map(item => <div key={item.status} className="flex gap-2"><dt className="capitalize text-[var(--color-text-muted)]">{item.status}</dt><dd>{item.count} ({(item.count / stats.orderCount * 100).toFixed(1)}%)</dd></div>)}</dl>
          <p className="text-xs text-[var(--color-text-muted)]">Latest recorded status for each order across the monitored database history. These counts do not classify trade outcomes.</p>
        </>}
      </figure>
    </div>

    {stats.fillCount > 0 && quote && <div className="grid min-w-0 gap-5 sm:grid-cols-2">
      {([
        { label: 'Filled volume by pair', data: pairVolumes, field: 'volume', color: sellColor, available: stats.volume !== null },
        { label: 'Recorded fill fees by pair', data: pairFees, field: 'fees', color: countColor, available: stats.fees !== null },
      ] as const).map(chart => <figure key={chart.field} className="min-w-0 space-y-2">
        <figcaption className="text-sm font-medium">{chart.label} · {quote}</figcaption>
        {!chart.available ? <p className="text-xs text-[var(--color-text-muted)]">Unavailable: some recorded {chart.field === 'volume' ? 'volumes' : 'fees'} are missing or invalid. See available pair values below.</p> : <>
          <div className="w-full min-w-0" style={{ height: Math.max(108, chart.data.length * 28 + 30) }} aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={chart.data} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 0 }} accessibilityLayer={false}>
                <CartesianGrid horizontal={false} stroke="var(--color-border)" strokeDasharray="3 3" />
                <XAxis type="number" tick={axis} tickFormatter={compact} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="pair" tick={axis} width={90} axisLine={false} tickLine={false} />
                <Bar dataKey={chart.field} fill={chart.color} maxBarSize={18} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">{stats.pairs.filter(pair => pair.fillCount > 0).length > 12 ? 'Largest 12 pairs shown. ' : ''}Each chart has its own scale. Exact values for every pair appear in the table below.</p>
        </>}
      </figure>)}
    </div>}
  </div>;
}
