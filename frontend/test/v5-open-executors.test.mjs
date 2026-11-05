import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { paperOpenExecutorCount } from '../src/v5/policy.ts';

// Live 2026-11-05: "Open executors: Not published". The owner executors read is every non-terminal executor plus the
// newest 100 terminal ones (hummingbot strategy_v2/paper_session.py at dc2754c3); it is `partial` with
// stale_reason bounded_terminal_window_see_history_terminal_executors exactly when more than 100 terminal executors
// exist (scripts/meridian_v5_paper_observation.py). That bound covers only terminal rows, so the open set is complete.
const final3 = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/paper-api-final3/executors.json', import.meta.url)));
const now = final3.read_at_ms;
const row = final3.data[0];
const running = {...row, executor_id:'open-1', state:'RUNNING', terminal:false};
const terminal = Array.from({length:100}, (_, index) => ({...row, executor_id:`done-${index}`, state:'TERMINATED', terminal:true}));
const windowed = {...final3, state:'degraded', completeness:'partial', stale_reason:'bounded_terminal_window_see_history_terminal_executors', data:[running, ...terminal]};

test('a terminal-window-bounded executor read still publishes the complete open-executor count', () => {
  assert.equal(paperOpenExecutorCount(windowed, now), 1);
});

test('any other partial, stale, paged or unknown-state executor read publishes no count', () => {
  for (const change of [
    {stale_reason:null}, {stale_reason:'bounded_recent_fills'}, {stale_reason:'some_future_reason'},
    {next_cursor:'more'}, {generated_at_ms:now - 31_000}, {state:'stale', reason:'Owner report expired'},
    {completeness:'unavailable'}, {section:'fills'},
    {data:[{...running, state:'SOMETHING_NEW'}, ...terminal]},
  ]) assert.equal(paperOpenExecutorCount({...windowed, ...change}, now), null, JSON.stringify(change));
});
