import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';
const { capitalWindow, parseCapitalPeriod } = frontendModules().load('features/quant-ops/window.ts');
test('exact UTC windows do not silently substitute calendar months', () => {
 const now=Date.parse('2026-03-30T12:00:00Z');
 for (const [period,days] of [['1D',1],['7D',7],['30D',30],['90D',90]]) {
  const window=capitalWindow(period,now); assert.equal(Date.parse(window.end)-Date.parse(window.start),days*86400000);
 }
 assert.equal(capitalWindow('YTD',now).start,'2026-01-01T00:00:00.000Z');
 assert.equal(capitalWindow('ALL',now),undefined);
 assert.throws(()=>capitalWindow('CUSTOM',now,{start:'bad',end:'bad'}));
 assert.throws(()=>capitalWindow('CUSTOM',now,{start:'2026-01-02',end:'2026-01-01'}));
 assert.equal(parseCapitalPeriod('1W'),'7D');
});
