import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';

const {load}=frontendModules();
const {tooltipPlacement,stepIndex}=load('features/quant-ops/kit/heat-strip.ts');
const {HeatStrip}=load('features/quant-ops/kit/HeatStrip.tsx');

test('tooltip prefers above the cell and stays inside the viewport',()=>{
  const view={width:400,height:600};
  const a=tooltipPlacement({left:200,right:206,top:300,bottom:322},{width:200,height:80},view);
  assert.equal(a.side,'top');assert.equal(a.top,300-8-80);assert.equal(a.left,103);
  const edge=tooltipPlacement({left:0,right:6,top:300,bottom:322},{width:200,height:80},view);
  assert.equal(edge.left,8);
  const right=tooltipPlacement({left:394,right:400,top:300,bottom:322},{width:200,height:80},view);
  assert.equal(right.left,192);
  const low=tooltipPlacement({left:200,right:206,top:20,bottom:42},{width:200,height:80},view);
  assert.equal(low.side,'bottom');assert.equal(low.top,50);
});

test('keyboard navigation moves back in time to the right and clamps',()=>{
  assert.equal(stepIndex('ArrowRight',0,5),1);assert.equal(stepIndex('ArrowRight',4,5),4);
  assert.equal(stepIndex('ArrowLeft',0,5),0);assert.equal(stepIndex('ArrowLeft',3,5),2);
  assert.equal(stepIndex('End',1,5),4);assert.equal(stepIndex('Home',3,5),0);
  assert.equal(stepIndex('PageDown',2,50),12);assert.equal(stepIndex('x',2,5),null);assert.equal(stepIndex('ArrowRight',0,0),null);
});

test('strip renders one cell per entry, newest first, with one tab stop and a text label',()=>{
  const cells=[{key:'0',color:'red',label:'newest'},{key:'1',color:'green',label:'older'},{key:'2',color:'x',empty:true,label:'gap'}];
  const html=renderToStaticMarkup(React.createElement(HeatStrip,{cells,ariaLabel:'API',renderTooltip:()=>null}));
  assert.equal((html.match(/<i /g)||[]).length,3);
  assert.ok(html.indexOf('background:red')<html.indexOf('background:green'));
  assert.equal((html.match(/tabindex="0"/g)||[]).length,1);
  assert.match(html,/aria-label="API\. Newest on the left/);
  assert.match(html,/data-empty/);
});

test('the live region exists only while a cell is shown, so idle strips add no empty status regions',async()=>{
  const cells=[{key:'0',color:'red',label:'newest'},{key:'1',color:'green',label:'older'}];
  const idle=renderToStaticMarkup(React.createElement(HeatStrip,{cells,ariaLabel:'API',renderTooltip:()=>null}));
  assert.equal((idle.match(/role="status"/g)||[]).length,0,'an idle strip must not render a status region');
  assert.doesNotMatch(idle,/aria-describedby/);
  const {Window}=await import('happy-dom');
  const browser=new Window({url:'https://fixture.invalid/'});
  for(const name of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver']) Object.defineProperty(globalThis,name,{value:name==='window'?browser:browser[name],configurable:true});
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const {createRoot}=await import('react-dom/client');
  const container=document.createElement('div');document.body.append(container);
  const root=createRoot(container);
  try{
    await React.act(async()=>{root.render(React.createElement(HeatStrip,{cells,ariaLabel:'API',renderTooltip:()=>null}));});
    assert.equal(container.querySelectorAll('[role=status]').length,0);
    const strip=container.querySelector('[role=group]');
    await React.act(async()=>{strip.focus();});
    const regions=[...container.querySelectorAll('[role=status]')];
    assert.equal(regions.length,1,'a shown cell has one status region');
    assert.equal(regions[0].textContent,'newest');
    assert.equal(strip.getAttribute('aria-describedby'),regions[0].id);
  }finally{await React.act(async()=>root.unmount());container.remove();await browser.happyDOM.close();}
});
