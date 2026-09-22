export type TradingVisualsSource = { bot: string; server: string };

export function parseTradingVisualsSources(payload: unknown): TradingVisualsSource[] {
  if (!payload || typeof payload !== 'object' || !('sources' in payload) || !Array.isArray(payload.sources)) {
    throw new Error('Trading Visuals source list is invalid');
  }
  const seen = new Set<string>();
  return payload.sources.map((source: unknown) => {
    if (!source || typeof source !== 'object' || !('bot' in source) || !('server' in source) ||
        (typeof source.bot !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(source.bot)) || typeof source.server !== 'string' || !source.server.trim() || seen.has(String(source.bot))) {
      throw new Error('Trading Visuals source identity is invalid or duplicated');
    }
    seen.add(String(source.bot));
    return { bot: source.bot as TradingVisualsSource['bot'], server: source.server };
  });
}

/** A generic entry follows the selected account server; an explicit bot never falls back. */
export function selectTradingVisualsSource(sources: TradingVisualsSource[], requestedBot: string | null, server: string | null) {
  return requestedBot ? sources.find(source => source.bot === requestedBot)
    : sources.find(source => source.server === server) ?? sources[0];
}
