export type TradingVisualsSource = { bot: string; server: string };
export type ServerAlias = { name: string; host?: string; port?: number };

const V1_DISPLAY: Record<string, string> = {
  ok_rsi: 'Main',
  ok_rsi_sui_sell_only: 'SUI · Sell only',
  rsi_v5: 'RSI v5',
};

/** V1 nicknames stay; a registered V2 id is shown as itself. */
export function displayBotName(bot: string): string {
  return V1_DISPLAY[bot] ?? bot;
}

const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function parseTradingVisualsSources(payload: unknown): TradingVisualsSource[] {
  if (!payload || typeof payload !== 'object' || !('sources' in payload) || !Array.isArray(payload.sources)) {
    throw new Error('Trading Visuals source list is invalid');
  }
  const seen = new Set<string>();
  return payload.sources.map((source: unknown) => {
    if (!source || typeof source !== 'object' || !('bot' in source) || !('server' in source)) {
      throw new Error('Trading Visuals source identity is invalid or duplicated');
    }
    const bot = String(source.bot);
    const server = source.server;
    if (!BOT_ID.test(bot) || typeof server !== 'string' || !server.trim() || seen.has(bot)) {
      throw new Error('Trading Visuals source identity is invalid or duplicated');
    }
    seen.add(bot);
    return { bot, server };
  });
}

/** Paper identities stay on the roster. They never feed live Capital. */
export function isPaperBot(bot: string): boolean {
  return /(?:^|[_-])paper(?:[_-]|$)/i.test(bot);
}

function endpointKey(host?: string, port?: number): string | null {
  if (!host || typeof port !== 'number' || !Number.isFinite(port)) return null;
  return `${host.trim().toLowerCase()}:${port}`;
}

/** Exact name, or the same loopback host:port under a second Condor server identity. */
export function sourceMatchesServer(source: TradingVisualsSource, selected: string | null, servers: ServerAlias[] = []): boolean {
  if (!selected) return true;
  if (source.server === selected) return true;
  const selectedKey = endpointKey(servers.find(row => row.name === selected)?.host, servers.find(row => row.name === selected)?.port);
  const sourceKey = endpointKey(servers.find(row => row.name === source.server)?.host, servers.find(row => row.name === source.server)?.port);
  return selectedKey != null && selectedKey === sourceKey;
}

export function sourcesForServer(sources: TradingVisualsSource[], selected: string | null, servers: ServerAlias[] = []): TradingVisualsSource[] {
  return sources.filter(source => sourceMatchesServer(source, selected, servers));
}

/** A generic entry follows the selected account server; an explicit bot never falls back. */
export function selectTradingVisualsSource(sources: TradingVisualsSource[], requestedBot: string | null, server: string | null, servers: ServerAlias[] = []) {
  const scoped = sourcesForServer(sources, server, servers);
  return requestedBot ? sources.find(source => source.bot === requestedBot)
    : scoped.find(source => source.server === server) ?? scoped[0] ?? sources[0];
}
