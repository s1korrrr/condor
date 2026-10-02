/** Strategy charts live on the Bots page. These links focus the chart for one bot and optionally one pair. */
export function botChartsHref(bot: string, pair?: string | null, view?: string | null, record?: string | null): string {
  const params = new URLSearchParams({ bot });
  if (pair) params.set('pair', pair);
  if (view) params.set('view', view);
  if (record) params.set('record', record);
  return `/bots?${params.toString()}#strategy-charts-${encodeURIComponent(bot)}`;
}

/** Anchor id of one bot's chart section, and of the fleet composite. */
export const strategyChartsAnchor = (bot: string): string => `strategy-charts-${encodeURIComponent(bot)}`;
export const COMPOSITE_CHARTS_ANCHOR = 'strategy-charts-fleet';
