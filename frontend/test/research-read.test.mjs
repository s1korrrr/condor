import test from 'node:test';
import assert from 'node:assert/strict';
import { readResearch } from '../src/features/research/read.ts';

const envelope = {data:{items:[]},source:{owner:'research_os',server:'native',fetched_at:'2026-09-08T20:00:00Z',read_only:true}};

test('research reader binds source and passes caller cancellation', async()=>{
  const controller=new AbortController();
  const read=readResearch(async(path,init)=>{
    assert.match(path,/server=native/);
    assert.equal(init.cache,'no-store');
    controller.abort();
    assert.equal(init.signal.aborted,true);
    throw init.signal.reason;
  });
  await assert.rejects(read('nodes','native',{},controller.signal),{name:'AbortError'});
});

test('research reader resolves valid source and rejects source mismatch', async()=>{
  const read=readResearch(async()=>new Response(JSON.stringify(envelope)));
  assert.deepEqual(await read('overview','native',{},new AbortController().signal),envelope);
  await assert.rejects(read('overview','other',{},new AbortController().signal),/identity/);
});

test('research reader bounds an unresponsive request and reports timeout', async()=>{
  const read=readResearch((_path,init)=>new Promise((_resolve,reject)=>{
    init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
  }),20);
  const keepAlive=setTimeout(()=>{},100);
  try {await assert.rejects(read('overview','native',{},new AbortController().signal),/timed out/);}
  finally {clearTimeout(keepAlive);}
});
