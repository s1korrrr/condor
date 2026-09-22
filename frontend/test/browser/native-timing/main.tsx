import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { NativeEntryControls } from '../../../src/components/bots/NativeEntryControls';
import { useCandleStore } from '../../../src/hooks/useCandleStore';
import { candleStore } from '../../../src/lib/candle-store';
import type { CondorWebSocket } from '../../../src/lib/websocket';

// Actual React component and QueryClient, with only clock and external data controlled.
let clock = 1900000000000;
Date.now = () => clock;
const client = new QueryClient({ defaultOptions: { queries: {
  staleTime: Infinity, retry: false, refetchOnMount: false, refetchOnWindowFocus: false,
} } });
const statusKey = ['native-entry-status', 'fixture', 'v2'];
const payload = (command = '', paused = false) => ({ status: 'success', command_allowed: true,
  verified_at: clock / 1000 - 120, data: { bot_name: 'v2', bot_status: 'running',
    controllers: [{ controller_id: 'synthetic', entry_paused: paused,
      last_command_id: command, updated_at: clock / 1000 - 120 }] } });
client.setQueryData(statusKey, payload());
const root = createRoot(document.getElementById('root')!);
let onMessage: (channel: string, payload: unknown) => void = () => {};
let onDisconnect = () => {};
candleStore.attachWs({ onMessage: fn => { onMessage = fn; return () => {}; },
  onConnect: () => () => {}, onDisconnect: fn => { onDisconnect = fn; return () => {}; },
  subscribe() {}, unsubscribe() {},
} as unknown as CondorWebSocket);
export function CandleProbe() {
  const [pair, setPair] = useState('BTC-USDC');
  const view = useCandleStore('fixture', 'okx', pair, '1m');
  return <section aria-label="Candle receipt fixture">
    <button id="switch-market" onClick={() => setPair('ETH-USDC')}>Select ETH fixture</button>
    <p id="candle-view">{pair} · {view.candles.at(-1)?.close ?? 'empty'} · {view.isStale ? 'stale' : 'current'}</p>
  </section>;
}
root.render(<QueryClientProvider client={client}><NativeEntryControls server="fixture" botName="v2" /><CandleProbe /></QueryClientProvider>);
const results: string[] = [];
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 60));
const buttonsEnabled = () => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Entry controls for v2"] button')];
  return buttons.length === 3 && buttons.every(button => !button.disabled);
};
function check(value: boolean, name: string) { results.push(`${value ? 'PASS' : 'FAIL'} ${name}`); }
async function run() {
  await settle();
  check(buttonsEnabled(), 'initial server-skewed receipt enables controls');
  clock += 20;
  client.setQueryData(statusKey, payload());
  await settle();
  check(buttonsEnabled(), 'fresh query receipt between timer ticks stays enabled');
  clock += 20;
  client.setQueryData(['native-entry-session', 'fixture', 'v2'], {
    command: { id: 'synthetic-command', action: 'pause' }, message: 'Awaiting fixture receipt',
  });
  client.setQueryData(statusKey, payload('synthetic-command', true));
  await settle();
  check(buttonsEnabled() && document.getElementById('root')!.textContent!.includes('Matching command ID'),
    'matching native receipt acknowledges between ticks despite server skew');
  clock += 16000;
  await new Promise(resolve => setTimeout(resolve, 1100));
  check(!buttonsEnabled(), 'timer still expires stale local receipts');
  client.setQueryData(statusKey, payload('synthetic-command', true));
  await settle();
  check(buttonsEnabled(), 'new current response recovers stale controls');
  const channel = 'candles:fixture:okx:BTC-USDC:1m';
  const bar = (close: number) => ({ timestamp: 1800000000, open: 100, high: 110, low: 90, close, volume: 1 });
  const candleView = () => document.getElementById('candle-view')!.textContent!;
  onMessage(channel, { type: 'candles', kind: 'history', data: [bar(100)] });
  await settle();
  check(candleView().includes('100 · stale'), 'history is rendered without current freshness');
  onMessage(channel, { type: 'candles', kind: 'live', source: 'rest', data: [bar(103)] });
  await settle();
  check(candleView().includes('103 · current'), 'current polled batch revises open bar in actual hook');
  onDisconnect();
  await settle();
  check(candleView().includes('103 · stale'), 'transport disconnect immediately expires hook receipt');
  onMessage(channel, { type: 'candles', kind: 'history', data: [bar(103)] });
  await settle();
  check(candleView().includes('103 · stale'), 'reconnect snapshot cannot restore freshness');
  document.getElementById('switch-market')!.click();
  await settle();
  check(candleView().includes('ETH-USDC · empty · stale'), 'market switch cannot display prior identity');
  onMessage(channel, { type: 'candle_update', candle: bar(104) });
  await settle();
  check(candleView().includes('ETH-USDC · empty · stale'), 'late old-market update cannot populate selected identity');
  onMessage('candles:fixture:okx:ETH-USDC:1m', { type: 'candles', kind: 'live', source: 'gecko', receipt_max_age_ms: 120000, data: [bar(105)] });
  await settle();
  check(candleView().includes('ETH-USDC · 105 · current'), 'Gecko current batch recovers selected identity');
  document.getElementById('results')!.textContent = results.join('\n');
  document.body.dataset.result = results.every(line => line.startsWith('PASS')) ? 'PASS' : 'FAIL';
}
void run();
