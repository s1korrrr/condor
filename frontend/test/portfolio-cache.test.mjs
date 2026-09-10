import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { clearPortfolioAccountCache } from '../src/features/portfolio/cache.ts';
test('connection replacement removes every cached range for that server only',async()=>{
 const client=new QueryClient();
 for(const range of ['1D','1W','ALL'])client.setQueryData(['portfolio-analytics','local',range],{scope:'old'});
 client.setQueryData(['portfolio-analytics','other','1W'],{scope:'other'});
 await clearPortfolioAccountCache(client,'local');
 assert.equal(client.getQueryData(['portfolio-analytics','local','ALL']),undefined);
 assert.equal(client.getQueryData(['portfolio-analytics','local','1D']),undefined);
 assert.deepEqual(client.getQueryData(['portfolio-analytics','other','1W']),{scope:'other'});
});
