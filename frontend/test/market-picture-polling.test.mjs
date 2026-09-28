import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';
import * as model from '../src/features/market-picture/model.mjs';

// Execute the real hook/effects with a deterministic clock and deferred network.
// Real React mounting, DOM focus and layout are covered by the browser smoke.
function harness(t) {
  const original = {setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,document:globalThis.document};
  const timers = new Map(), listeners = new Map(), calls = [], slots = [], pending = [];
  let timerId = 0, index = 0, args = ['v2','24h','BTC'];
  const changed = (a,b) => !a || b.some((v,i)=>!Object.is(v,a[i]));
  const react = {
    useState(initial) {
      const i=index++; if(!(i in slots)) slots[i]=typeof initial==='function'?initial():initial;
      return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];
    },
    useRef(initial) {const i=index++; return slots[i]??=( {current:initial} );},
    useCallback(value,deps) {const i=index++;if(changed(slots[i]?.deps,deps))slots[i]={deps,value};return slots[i].value;},
    useEffect(create,deps) {
      const i=index++; if(changed(slots[i]?.deps,deps))pending.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:create()};});
    },
  };
  const document={hidden:false,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  globalThis.document=document;
  globalThis.setTimeout=(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;};
  globalThis.clearTimeout=id=>timers.delete(id);
  const fetchBundle=(...params)=>new Promise((resolve,reject)=>calls.push({params,resolve,reject}));
  const modules=frontendModules({'react':react,'./source':{fetchBundle},'./model.mjs':model});
  const hook=modules.load('features/market-picture/useMarketPicture.ts').useMarketPicture;
  const render=(next=args)=>{args=next;index=0;const value=hook(...args);pending.splice(0).forEach(fn=>fn());return value;};
  const unmount=()=>slots.forEach(slot=>slot?.cleanup?.());
  t.after(()=>{unmount();Object.assign(globalThis,original);});
  return {render,calls,timers,listeners,document,unmount,
    tick:()=>{const [id,timer]=timers.entries().next().value??[];if(timer){timers.delete(id);timer.fn();}},
    visibility:hidden=>{document.hidden=hidden;listeners.get('visibilitychange')?.();},
  };
}
const settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
const bundle=(sequence=1)=>({frame:{stream_id:'test-stream',epoch:'epoch',sequence,snapshot_id:String(sequence).repeat(64),payload_digest:String(sequence+1).repeat(64),available_at_ms:1000+sequence,cutoff_ms:1000,expires_at_ms:2000},history:[],correlations:[],events:[],components:{},faults:{},eventCursor:null,etag:`"${sequence}"`});

test('one scheduler serializes reads and revalidates the last committed bundle',async t=>{
  const h=harness(t);h.render();assert.equal(h.calls.length,1);assert.equal(h.timers.size,0);
  h.visibility(false);assert.equal(h.calls.length,1);
  h.calls[0].resolve(bundle());await settle();assert.equal(h.render().data.frame.sequence,1);
  assert.equal(h.timers.size,1);h.tick();assert.equal(h.calls.length,2);
  assert.equal(h.calls[1].params[4].frame.sequence,1);
  h.calls[1].resolve(bundle(2));await settle();assert.equal(h.render().data.frame.sequence,2);
});
test('visibility aborts in-flight requests and late responses cannot commit',async t=>{
  const h=harness(t);h.render();h.visibility(true);
  assert.equal(h.calls[0].params[3].aborted,true);
  h.calls[0].resolve(bundle());await settle();assert.equal(h.render().data,null);assert.equal(h.timers.size,0);
  h.visibility(false);assert.equal(h.calls.length,2);
});
test('freeze pins all panels and changes read the same snapshot without polling latest',async t=>{
  const h=harness(t);h.render();h.calls[0].resolve(bundle());await settle();
  h.render().toggleFreeze();h.render();assert.equal(h.timers.size,0);
  assert.equal(h.calls[1].params[5],bundle().frame.snapshot_id);
  h.calls[1].resolve(bundle());await settle();assert.equal(h.render().frozen,true);assert.equal(h.timers.size,0);
  h.render(['v2','7d','ETH']);assert.equal(h.calls[2].params[5],bundle().frame.snapshot_id);
  h.calls[2].resolve(bundle());await settle();h.render().toggleFreeze();h.render();
  assert.equal(h.calls[3].params[5],undefined);
});
test('option changes cancel old reads and cannot overwrite newer components',async t=>{
  const h=harness(t);h.render();h.render(['v2','7d','BTC']);
  assert.equal(h.calls[0].params[3].aborted,true);
  h.calls[1].resolve(bundle(2));await settle();h.calls[0].resolve(bundle(1));await settle();
  assert.equal(h.render().data.frame.sequence,2);
});
test('unmount cancels polling and replay, leaving no document listeners',async t=>{
  const h=harness(t);const view=h.render();const replay=view.replay('a'.repeat(64));
  assert.equal(h.calls.length,2);h.unmount();assert.equal(h.listeners.size,0);
  assert.ok(h.calls.every(call=>call.params[3].aborted));
  h.calls.forEach(call=>call.resolve(bundle()));await replay;await settle();assert.equal(h.timers.size,0);
});
