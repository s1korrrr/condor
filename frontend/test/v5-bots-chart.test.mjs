import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tradeMarkers } from '../src/v5/bots-chart-model.mjs';

test('trades are filtered by pair and range, counted by side, and gaps have no marker', () => {
  const fills = [
    {trading_pair:'BNB-USDC', side:'BUY', event_at_ms:61000, price:'10', quantity:'2'},
    {trading_pair:'BNB-USDC', side:'SELL', event_at_ms:121000, price:'11', quantity:'1'},
    {trading_pair:'BTC-USDC', side:'BUY', event_at_ms:61000},
    {trading_pair:'BNB-USDC', side:'BUY', event_at_ms:180000},
  ];
  const result = tradeMarkers(fills, 'BNB-USDC', 60, 120, [[60,null,null,null,null,null,1],[120,null,null,null,null,null,0]]);
  assert.equal(result.entries, 1);
  assert.equal(result.exits, 1);
  assert.deepEqual(result.markers, [{time:60,event_at_ms:61000,side:'BUY',price:'10',quantity:'2'}]);
});

test('all retained trades contribute without another global cutoff', () => {
  const fills = Array.from({length: 501}, (_, index) => ({trading_pair:'BNB-USDC', side:'BUY', event_at_ms:60000 + index}));
  assert.equal(tradeMarkers(fills, 'BNB-USDC', 60, 60, [[60,null,null,null,null,null,1]]).entries, 501);
});

test('sell markers retain the owner amount and price at the final minute boundary', () => {
  const fills = [{trading_pair:'BNB-USDC', side:'SELL', event_at_ms:179999, quantity:'0.100000000000000000000000000001', price:'123.45'}];
  assert.deepEqual(tradeMarkers(fills, 'BNB-USDC', 60, 120, [[120,null,null,null,null,null,1]]), {
    entries:0, exits:1, markers:[{time:120,event_at_ms:179999,side:'SELL',quantity:'0.100000000000000000000000000001',price:'123.45'}],
  });
});
