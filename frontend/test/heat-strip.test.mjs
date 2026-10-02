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
