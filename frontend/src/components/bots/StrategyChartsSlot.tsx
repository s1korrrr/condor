import { lazy, Suspense, useEffect, useRef, type ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import { COMPOSITE_CHARTS_ANCHOR, strategyChartsAnchor } from '@/features/bots/chart-links';

type StrategyChartsProps = { bot?: string; bots?: string[]; composite?: boolean; server?: string | null; pair?: string | null; view?: string | null };

/** The charts come from the optional monitoring workspace; this build resolves `@workspace-monitoring` to its own export
 *  (or the public stub). A workspace build that predates StrategyCharts leaves the slot empty rather than failing the page. */
const Absent: ComponentType<StrategyChartsProps> = () => null;
const StrategyCharts = lazy(async () => {
  const module = await import('@workspace-monitoring') as { StrategyCharts?: ComponentType<StrategyChartsProps> };
  return { default: module.StrategyCharts ?? Absent };
});

/** One bot's strategy charts, or the fleet composite when `bots` is given. A `?bot=&pair=&view=` query for this bot
 *  is forwarded and scrolls the section into view. */
export function StrategyChartsSlot({ bot, bots, server }: { bot?: string; bots?: string[]; server: string | null }) {
  const [params] = useSearchParams();
  const ref = useRef<HTMLElement>(null);
  const focused = bot !== undefined && params.get('bot') === bot;
  const pair = focused ? params.get('pair') : null;
  const view = focused ? params.get('view') : null;
  useEffect(() => {
    if (!focused || !pair) return;
    // The page above the charts is still loading when the link lands, so settle on the section after layout moves.
    const go = () => ref.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    const timers = [0, 600, 1500, 3500].map(delay => window.setTimeout(go, delay));
    return () => timers.forEach(window.clearTimeout);
  }, [focused, pair]);
  const composite = bot === undefined;
  return <section ref={ref} id={composite ? COMPOSITE_CHARTS_ANCHOR : strategyChartsAnchor(bot)} className="q-strategy-charts" aria-label={composite ? 'Fleet strategy charts' : `${bot} strategy charts`}>
    <Suspense fallback={<p className="q-empty" role="status">Loading strategy charts…</p>}>
      {composite ? <StrategyCharts composite bots={bots} server={server} /> : <StrategyCharts bot={bot} server={server} pair={pair} view={view} />}
    </Suspense>
  </section>;
}
