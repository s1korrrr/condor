import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { FLEET_FILLS_ANCHOR } from '@/features/bots/chart-links';
import { fleetFillBotName, pairFilterFromDraft, projectFleetFills, type FleetFillsView as FleetFillsModel } from '@/features/bots/fleet-fills-model';
import { fleetFillColumns } from './fleet-fills-columns';
import { DataTable } from '@/features/quant-ops/kit/DataTable';
import { PanelFrame } from '@/features/quant-ops/primitives';
import { NO_FLEET_FILL_FILTERS, useFleetFills, type FleetFillsFilters } from '@/features/quant-ops/use-fleet-fills';
import { displayBotName } from '@/features/trading-visuals/sources';
import type { FleetFillItem, FleetFillSide } from '@/lib/fleet-fills';

/** Panel id of the composite feed (spec appendix A numbering continues after B39). */
export const FLEET_FILLS_PANEL_ID = 'B40';

export type FleetFillsBotOption = { bot: string; label: string };

/** Presentational half: everything it shows is in `view` and the filter props, so it renders the same on the server. */
export function FleetFillsView({ view, filters, botOptions, pairDraft, onToggleBot, onSide, onPairDraft, onReset, onLoadMore, loadingMore = false, updating = false }: {
  view: FleetFillsModel; filters: FleetFillsFilters; botOptions: FleetFillsBotOption[]; pairDraft: string;
  onToggleBot: (bot: string) => void; onSide: (side: FleetFillSide | null) => void; onPairDraft: (pair: string) => void; onReset: () => void;
  onLoadMore: () => void; loadingMore?: boolean; updating?: boolean;
}) {
  const active = filters.bots.length > 0 || filters.side !== null || filters.pair !== null || pairDraft !== '';
  const pairInvalid = !pairFilterFromDraft(pairDraft).valid;
  return <PanelFrame panelId={FLEET_FILLS_PANEL_ID} title="Fleet fills" state={view.state}
    scopeLabel={`Every bot · newest first${view.matched === null || view.missing ? '' : ` · ${view.rows.length} of ${view.matched} matching loaded`}`}
    actions={updating ? <span className="q-muted" role="status">Updating…</span> : undefined}>
    <div className="q-chip-row" role="group" aria-label="Fleet fills filters">
      {botOptions.map(option => <button key={option.bot} type="button" className="q-chip" aria-pressed={filters.bots.includes(option.bot)} onClick={() => onToggleBot(option.bot)} title={`Show only ${option.label} fills (select several to combine)`}>{option.label}</button>)}
      <select aria-label="Side filter" value={filters.side ?? ''} onChange={event => onSide(event.target.value === 'buy' || event.target.value === 'sell' ? event.target.value : null)}>
        <option value="">Buy and sell</option>
        <option value="buy">Buys</option>
        <option value="sell">Sells</option>
      </select>
      <input className="q-search" value={pairDraft} onChange={event => onPairDraft(event.target.value)} placeholder="Pair, e.g. BNB-USDC" aria-label="Pair filter" aria-invalid={pairInvalid || undefined} title={pairInvalid ? 'Use BASE-QUOTE, for example BNB-USDC' : 'Filter by pair (BASE-QUOTE)'} />
      {active && <button type="button" className="q-chip" onClick={onReset}>Reset</button>}
    </div>
    {view.notices.map(notice => <p key={notice} className="q-notice" role="status">{notice}</p>)}
    {view.missing
      ? <p className="q-empty" role="status" data-fleet-fills="unavailable">{view.emptyText}</p>
      : <DataTable<FleetFillItem> label="Fleet fills" rowId={row => row.id} rows={view.rows} columns={fleetFillColumns} initialSort={{ id: 'time', desc: true }} pageSize={Number.MAX_SAFE_INTEGER} maxHeight={440} dense exportName="fleet-fills.csv" emptyText={view.emptyText} />}
    {(view.hasMore || loadingMore) && <div className="q-chip-row"><button type="button" className="q-chip" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? 'Loading older fills…' : 'Load more fills'}</button></div>}
    {view.footnote && <p className="q-muted q-footnote" role="note">{view.footnote}</p>}
  </PanelFrame>;
}

/** B40: the server's merged fills feed for every bot, with server-side bot, side and pair filters and cursor paging. */
export function FleetFillsPanel({ server, bots }: { server: string | null; bots: readonly string[] }) {
  const [filters, setFilters] = useState<FleetFillsFilters>(NO_FLEET_FILL_FILTERS);
  const [pairDraft, setPairDraft] = useState('');
  const query = useFleetFills(server, filters);
  const hash = useLocation().hash;
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hash !== `#${FLEET_FILLS_ANCHOR}`) return;
    // The page above is still loading when a link lands here, so settle on the panel after layout moves.
    const go = () => anchor.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    const timers = [0, 600, 1500].map(delay => window.setTimeout(go, delay));
    return () => timers.forEach(window.clearTimeout);
  }, [hash]);
  const pages = query.data?.pages;
  const view = useMemo(() => projectFleetFills({ pages, error: query.error, pending: query.isPending, filtered: filters.bots.length > 0 || filters.side !== null || filters.pair !== null }), [pages, query.error, query.isPending, filters]);
  const options = useMemo<FleetFillsBotOption[]>(() => {
    const known = new Map<string, string>();
    for (const bot of pages?.[0]?.bots ?? []) known.set(bot.bot, `${bot.generation ? `${bot.generation} ` : ''}${fleetFillBotName(bot)}`);
    return [...new Set([...bots, ...filters.bots, ...known.keys()])].map(bot => ({ bot, label: known.get(bot) ?? displayBotName(bot) }));
  }, [bots, filters.bots, pages]);
  return <div id={FLEET_FILLS_ANCHOR} ref={anchor}>
    <FleetFillsView view={view} filters={filters} botOptions={options} pairDraft={pairDraft}
      onToggleBot={bot => setFilters(current => ({ ...current, bots: current.bots.includes(bot) ? current.bots.filter(item => item !== bot) : [...current.bots, bot] }))}
      onSide={side => setFilters(current => ({ ...current, side }))}
      onPairDraft={draft => { setPairDraft(draft); const { pair, valid } = pairFilterFromDraft(draft); if (valid) setFilters(current => ({ ...current, pair })); }}
      onReset={() => { setFilters(NO_FLEET_FILL_FILTERS); setPairDraft(''); }}
      onLoadMore={() => void query.fetchNextPage()} loadingMore={query.isFetchingNextPage} updating={query.isPlaceholderData} />
  </div>;
}
