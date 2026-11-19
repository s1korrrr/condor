import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { frontendModules } from './helpers/frontend-module.mjs';

const overrides = Object.fromEntries([
  '@/components/bots/AggregatedPnlChart', '@/components/bots/ControllerBrowser',
  '@/components/bots/DeployBotDialog', '@/components/bots/PnlSparkline',
  '@/hooks/useWebSocket', '@/hooks/useRates',
].map(name => [name, {}]));
const { paperMoneyTiles } = frontendModules(overrides).load('pages/tabs/ActiveBotsTab.tsx');
const money = JSON.parse(readFileSync(new URL('./fixtures/money-gap-restart.json', import.meta.url)));

test('Today cannot show pre-gap equity after a realized-only sample', () => {
  const tiles = paperMoneyTiles({ complete: false, now: money.now_ms, money });
  assert.notEqual(tiles[3].value, '—', 'post-gap realized value is available');
  assert.equal(tiles[2].value, '—', tiles[2].note);
  assert.equal(tiles[2].note, 'Latest Money sample has no equity');
});

const [snapshot, walletRead, accountingRead] = ['status', 'wallet', 'accounting'].map(section =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url))));
const now = snapshot.generated_at_ms;
const day = Math.floor(now / 86_400_000) * 86_400_000;
const equityAt = now - 15_000;
const daily = {
  day, samples: 2, gaps: 0, valid: 2, equity_valid: 2,
  first_at_ms: day, last_at_ms: equityAt, equity_first_at_ms: day, equity_last_at_ms: equityAt,
  equity_start: '200000', equity_end: '199988', equity_change: '-12',
};
const steadyMoney = {
  range: '7d', now_ms: now, daily: [daily], rows: [
    { bot: 'v5', at_ms: day, unit: 'USDC', equity: daily.equity_start },
    { bot: 'v5', at_ms: equityAt, unit: 'USDC', equity: daily.equity_end },
  ],
};

function steadyToday(money) {
  const tiles = paperMoneyTiles({ complete: true, now, snapshot, walletRead, accountingRead, money });
  assert.equal(tiles[0].exact, walletRead.data.equity_quote);
  assert.equal(tiles[3].exact, accountingRead.data.program.realized_pnl_quote);
  assert.match(tiles[0].note, /^As of /);
  assert.match(tiles[3].note, /^As of /);
  return tiles[2];
}

test('Today keeps Money provenance with a complete fresh owner snapshot', () => {
  const today = steadyToday(steadyMoney);
  assert.equal(today.value, '−12.00 USDC');
  assert.equal(today.exact, '-12');
  assert.ok(today.note.startsWith(`Money sample · As of ${new Date(equityAt).toISOString().replace('T', ' ')} · 15s ago`), today.note);
});

test('Today explains a newer Money gap with a complete fresh owner snapshot', () => {
  const today = steadyToday({ ...steadyMoney,
    rows: [...steadyMoney.rows, { bot: 'v5', at_ms: now, gap: 'owner_unavailable' }],
    daily: [{ ...daily, samples: 3, gaps: 1 }],
  });
  assert.equal(today.value, '—');
  assert.equal(today.note, 'Money sample gap · Owner unavailable');
});
