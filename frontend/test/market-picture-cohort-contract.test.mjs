import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { digest, projectFrame, validateFrame } from '../src/features/market-picture/contract.mjs';
import { projectHistory } from '../src/features/market-picture/stored.mjs';
import { historyComparisons } from '../src/features/market-picture/history-comparisons.mjs';

const read = name => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/market-picture.cohort-history.${name}.fixture.json`, import.meta.url)));
async function seal(frame) {
  delete frame.payload_digest; delete frame.snapshot_id;
  frame.snapshot_id = await digest(frame); frame.payload_digest = await digest(frame);
  return frame;
}

test('native compact owner cells and full-cohort medians pass unchanged into the history comparison', async () => {
  const raw = await validateFrame(read('frame'), { allowFixture: true });
  const frame = projectFrame(raw), points = projectHistory(read('response'), frame);
  for (const h of ['5', '15', '60', '1440']) {
    const row = raw.contribution_summaries.find(item => String(item.horizon_minutes) === h);
    const owner = raw.market_metrics[row.median_return_ref.metric_id];
    assert.equal(frame.contributions[h].medianReturn.original, owner.value);
    assert.equal(points.at(-1).contributions[h].medianReturn, Number(owner.value));
  }
  const velocity = frame.breadthTrajectory.find(row => row.horizon === 15 && row.interval === 15).velocity;
  assert.equal(velocity.unit, 'index_points_per_minute');
  const chart = historyComparisons(points, '15', '15', 'velocity');
  assert.equal(chart.unit, 'pressure/minute');
  assert.equal(chart.series[0].points.at(-1).value, velocity.value);
  const returns = historyComparisons(points, '15', '15', 'returns');
  assert.equal(returns.series[2].points.at(-1).value, frame.contributions['15'].medianReturn.value);
  assert.equal(returns.series[0].points.at(-1).value, frame.assets.find(asset => asset.symbol === 'BTC').returns['15'].value);
});

test('median reference cannot borrow another horizon or a partial start cohort', async () => {
  for (const change of [
    frame => { frame.contribution_summaries[0].start_cohort_available = false; },
    frame => { frame.contribution_summaries[0].valid_count--; },
    frame => { frame.contribution_summaries[0].median_return_ref = frame.contribution_summaries[1].median_return_ref; },
  ]) {
    const frame = read('frame'); change(frame);
    await assert.rejects(validateFrame(await seal(frame), { allowFixture: true }), /Median requires/);
  }
});

test('old immutable frame without median refs stays readable with an unavailable comparison', async () => {
  const raw = read('frame');
  for (const row of raw.contribution_summaries) delete row.median_return_ref;
  const frame = projectFrame(await validateFrame(await seal(raw), { allowFixture: true }));
  assert.equal(frame.contributions['15'].medianReturn.value, null);
  assert.equal(frame.contributions['15'].medianReturn.status, 'UNAVAILABLE');
});
