import test from 'node:test';
import assert from 'node:assert/strict';
import {capitalDestination} from '../src/lib/capital-route.ts';

test('legacy overview retains source, bot, period and hash',()=>{
  const url=new URL(capitalDestination('?bot=ok_rsi&source=main&period=1W','#history'),'https://example.test');
  assert.equal(url.pathname,'/capital');
  assert.equal(url.searchParams.get('bot'),'ok_rsi');
  assert.equal(url.searchParams.get('source'),'main');
  assert.equal(url.searchParams.get('period'),'1W');
  assert.equal(url.hash,'#history');
});
test('legacy portfolio selects holdings without dropping context or duplicating view',()=>{
  const url=new URL(capitalDestination('?bot=main&view=old&view=other','#asset','holdings'),'https://example.test');
  assert.deepEqual(url.searchParams.getAll('view'),['holdings']);
  assert.equal(url.searchParams.get('bot'),'main');
  assert.equal(url.hash,'#asset');
  assert.equal(capitalDestination(''),'/capital');
});
