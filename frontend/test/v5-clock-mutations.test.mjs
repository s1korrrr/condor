import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

for (const [mutant,file,pattern,failure] of [
  ['never-clear','v5-clock-session.test.mjs','render reads share','cache must not freeze time across turns'],
  ['raw-now','v5-route-render-loop.test.mjs','real V5 routes','Maximum update depth exceeded'],
]) test(`clock mutation ${mutant} fails the real regression by name`, () => {
  const env = {...process.env,V5_CLOCK_MUTANT:mutant};
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath,['--test','--test-reporter=tap',`--test-name-pattern=${pattern}`,fileURLToPath(new URL(file,import.meta.url))],{
    env,encoding:'utf8',timeout:120000,maxBuffer:8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status,0,'mutated source must fail, not pass');
  assert.ok(result.stdout.includes(failure),`expected named failure ${failure}: ${result.stdout}\n${result.stderr}`);
  if (mutant === 'raw-now') assert.match(result.stdout,/not ok 1 - \/settings/,'Settings must reproduce the loop');
});
