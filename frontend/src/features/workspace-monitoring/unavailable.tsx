import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

function WorkspaceUnavailable({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="space-y-6">
    <h1 className="text-2xl font-semibold">{title}</h1>
    <section role="status" className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-3">
      <h2 className="text-lg font-semibold">Monitoring workspace unavailable</h2>
      <p className="text-sm text-[var(--color-text-muted)]">This installation does not include the optional monitoring workspace. Connected account balances and bot details remain available in their dedicated views.</p>
      {children}
      <nav className="flex gap-4 text-sm text-[var(--color-primary)]" aria-label="Available monitoring views"><Link to="/portfolio">Open Portfolio</Link><Link to="/bots">Open Bots</Link></nav>
    </section>
  </div>;
}

type PaperReadProps = { presentation?: 'paper'; paperReadUrl?: string; paperHistoryReadUrl?: string; paperAccountingReadUrl?: string };
type OverviewProps = PaperReadProps & { accountPresentation?: { description: string; unavailable: string; valuationNote: string; registryUnavailable?: string } };
/** Same props as the workspace Overview; the unavailable stub renders without them. */
export const Overview: (props: OverviewProps) => ReactNode = () => <WorkspaceUnavailable title="Overview" />;
export function TradingVisuals() { return <WorkspaceUnavailable title="Trading Visuals" />; }

export function Operations(_props: PaperReadProps) { return <WorkspaceUnavailable title="Operations" />; }

/** The backtest catalog needs the optional workspace. The viewer page itself is served by the backend at `/tradepad`. */
export function Tradepad(_props: PaperReadProps) {
  return <WorkspaceUnavailable title="Tradepad">
    <p className="text-sm text-[var(--color-text-muted)]">The backtest catalog, its filters and research links are part of that workspace. When this server publishes a Tradepad viewer, it opens on its own page: <a className="text-[var(--color-primary)]" href="/tradepad">Open the Tradepad viewer</a>.</p>
  </WorkspaceUnavailable>;
}

/** Props of the optional workspace's strategy charts. `bot` mounts one bot's charts; `composite` with `bots` combines
 *  every strategy. `pair` and `view` focus a pair or chart view (the Bots page forwards its `?pair=&view=` query). */
export type StrategyChartsProps = { bot?: string; bots?: string[]; composite?: boolean; server?: string | null; pair?: string | null; view?: string | null; records?: boolean };

export function StrategyCharts({ bot, composite }: StrategyChartsProps) {
  return <p role="status" className="text-sm text-[var(--color-text-muted)]">{composite ? 'Fleet strategy charts' : `Strategy charts for ${bot ?? 'this bot'}`} need the optional monitoring workspace, which this installation does not include.</p>;
}
