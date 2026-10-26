import { displayBotName, isPaperBot } from '@/features/trading-visuals/sources';
import type { BotHoldings } from '@/lib/fleet-holdings';

/**
 * Fleet aggregates on the Bots page: per-symbol inventory, the exposure heatmap and the order lifecycle
 * counts. They sum LIVE bots only: a paper bot (a `paper` token in its id, the same rule as the server's
 * `fleet_identity.is_paper`) keeps its own card but never adds to a fleet figure. The paper bots left out
 * are returned so the page can say so. Inventory comes only from each bot's `fleet-holdings.v1` entry.
 */

type Lot = { pair: string | null; ageSeconds: number | null };
export type InventoryReads = {
  bot: string;
  /** The bot's fleet holdings entry; null (or `unavailable`) leaves the fleet inventory total unknown. */
  holdings: BotHoldings | null;
  cycles: { inventoryAge: { lots: readonly Lot[] } } | null;
  execution: { funnel: readonly { stage: string; count: number }[] } | null;
};

export type InventoryRow = { positions: number; units: number; value: number | null; oldest: number | null };

export type FleetAggregates = {
  /** Paper bot ids left out of every aggregate below. */
  paper: string[];
  /** One row per base asset, largest marked value first. `value` is null when any position lacks a mark. */
  inventory: [string, InventoryRow][];
  /** Sum of the rows' values; null when any row lacks one or any live bot's inventory is unavailable or incomplete. */
  inventoryTotal: number | null;
  /** Heatmap cells: one per live bot and pair. */
  heatCells: { row: string; column: string; value: number | null }[];
  assets: string[];
  /** Lifetime order lifecycle counts summed per stage. */
  funnel: { stage: string; count: number }[];
};

/** Splits reads by the shared paper rule. */
export function splitPaper<T extends { bot: string }>(items: readonly T[]): { live: T[]; paper: T[] } {
  const live: T[] = [], paper: T[] = [];
  for (const item of items) (isPaperBot(item.bot) ? paper : live).push(item);
  return { live, paper };
}

/** `+2 paper bots, not counted` (empty when there is none). */
export function paperNote(count: number): string {
  return count > 0 ? `+${count} paper bot${count === 1 ? '' : 's'}, not counted` : '';
}

export function projectFleetAggregates(fleet: readonly InventoryReads[]): FleetAggregates {
  const { live, paper } = splitPaper(fleet);
  const admitted = (reads: InventoryReads) => reads.holdings && reads.holdings.entry.state !== 'unavailable' ? reads.holdings.entry : null;
  const pairsOf = (reads: InventoryReads) => admitted(reads)?.pairs ?? [];
  const assets = [...new Set(live.flatMap(reads => pairsOf(reads).map(pair => pair.base_asset)))].sort();
  const heatCells = live.flatMap(reads => pairsOf(reads).map(pair => ({ row: displayBotName(reads.bot), column: pair.base_asset, value: pair.marked_value_quote == null ? null : Number(pair.marked_value_quote) })));
  const totals = new Map<string, number>();
  for (const reads of live) for (const stage of reads.execution?.funnel ?? []) totals.set(stage.stage, (totals.get(stage.stage) ?? 0) + stage.count);
  const funnel = [...totals.entries()].map(([stage, count]) => ({ stage, count }));
  const byAsset = new Map<string, InventoryRow>();
  for (const reads of live) {
    for (const pair of pairsOf(reads)) {
      if (pair.units == null || Number(pair.units) <= 0) continue;
      const asset = pair.base_asset;
      const entry = byAsset.get(asset) ?? { positions: 0, units: 0, value: 0, oldest: null };
      entry.positions += 1;
      entry.units += Number(pair.units);
      entry.value = entry.value == null || pair.marked_value_quote == null ? null : entry.value + Number(pair.marked_value_quote);
      const lot = reads.cycles?.inventoryAge.lots.filter(item => item.pair === pair.pair).map(item => item.ageSeconds ?? 0).sort((a, b) => b - a)[0] ?? null;
      entry.oldest = lot == null ? entry.oldest : Math.max(entry.oldest ?? 0, lot);
      byAsset.set(asset, entry);
    }
  }
  const inventory = [...byAsset.entries()].sort(([, a], [, b]) => (b.value ?? 0) - (a.value ?? 0));
  // An unread, unavailable or incomplete live bot could hold any asset: the fleet total is unknown, never a partial sum.
  const everyBotValued = live.every(reads => admitted(reads)?.value_complete === true);
  const inventoryTotal = everyBotValued && inventory.every(([, row]) => row.value != null) ? inventory.reduce((total, [, row]) => total + (row.value ?? 0), 0) : null;
  return { paper: paper.map(reads => reads.bot), inventory, inventoryTotal, heatCells, assets, funnel };
}
