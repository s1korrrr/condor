import test from 'node:test';
import assert from 'node:assert/strict';
import {frontendModules} from './helpers/frontend-module.mjs';

test('authorization close stops reconnecting and expires only the socket session',()=>{
 const priorWindow=globalThis.window,priorSocket=globalThis.WebSocket;
 const opened=[],expired=[];let revision=7;
 class Socket {constructor(){opened.push(this);}close(){} }
 globalThis.window={location:{protocol:'https:',host:'fixture.invalid'}};
 globalThis.WebSocket=Socket;
 const {load}=frontendModules({'./auth-session':{sessionRevision:()=>revision,expireSession:(...args)=>expired.push(args)}});
 try {
  const {CondorWebSocket}=load('lib/websocket.ts');
  for(const code of [4001,4003]){
   const ws=new CondorWebSocket('session-a');ws.connect();
   const socket=opened.at(-1);socket.onclose({code});
   assert.equal(ws.shouldConnect,false);
  }
  assert.deepEqual(expired,[['session-a',7],['session-a',7]]);
  const ws=new CondorWebSocket('session-a'),frames=[];
  ws.onMessage((...frame)=>frames.push(frame));ws.connect();
  opened.at(-1).onmessage({data:JSON.stringify({channel:'bots:owner',data:{},ts:1})});
  assert.equal(frames.length,1);
  revision++;
  opened.at(-1).onmessage({data:JSON.stringify({channel:'bots:owner',data:{},ts:2})});
  assert.equal(frames.length,1);
  ws.disconnect();
 } finally {globalThis.window=priorWindow;globalThis.WebSocket=priorSocket;}
});
