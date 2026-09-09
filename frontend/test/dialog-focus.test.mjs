import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const module = {exports:{}};
const source = ts.transpileModule(fs.readFileSync(new URL('../src/lib/dialog-focus.ts', import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
new Function('module','exports',source)(module,module.exports);
const {containDialogTab} = module.exports;
function scenario(index, shiftKey=false) {
  let focused=null, prevented=false;
  const nodes=Array.from({length:3},(_,i)=>({tabIndex:0,getClientRects:()=>[{}],matches:()=>false,focus:()=>{focused=i;}}));
  const event={key:'Tab',shiftKey,currentTarget:{querySelectorAll:()=>nodes,ownerDocument:{activeElement:nodes[index]}},preventDefault:()=>{prevented=true;}};
  containDialogTab(event);return {focused,prevented};
}
test('Tab at the final visible stop wraps to the first',()=>assert.deepEqual(scenario(2),{focused:0,prevented:true}));
test('Shift Tab at the first stop wraps to the final stop',()=>assert.deepEqual(scenario(0,true),{focused:2,prevented:true}));
test('interior Tab retains native navigation',()=>assert.deepEqual(scenario(1),{focused:null,prevented:false}));
