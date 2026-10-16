import test from 'node:test';
import assert from 'node:assert/strict';
import {frontendModules} from './helpers/frontend-module.mjs';

const {load}=frontendModules();
const {niceTicks,axisFormatter,valueExtent,axisScale}=load('features/quant-ops/kit/series.ts');

test('axis ticks round outward to 1, 2, 2.5 or 5 steps and never clip the data',()=>{
  const benchmark=niceTicks(1.16,4.422);
  assert.deepEqual(benchmark.ticks,[1,2,3,4,5],'uneven +1.160..+4.422 ticks become whole percents');
  const cost=niceTicks(0,13.3);
  assert.deepEqual(cost.ticks,[0,5,10,15]);
  const tiny=niceTicks(-2.49e-4,1.38e-4);
  assert.equal(tiny.step,1e-4);
  assert.deepEqual(tiny.ticks,[-3e-4,-2e-4,-1e-4,0,1e-4,2e-4],'tiny magnitudes keep exact decimal ticks without float noise');
  for(const [low,high] of [[1.16,4.422],[0,13.3],[-2.49e-4,1.38e-4],[-0.138,-0.094],[7,7],[-1e9,3e9]]){
    const {ticks}=niceTicks(low,high);
    assert.ok(ticks[0]<=low&&ticks.at(-1)>=high,`[${low}, ${high}] stays inside the axis`);
    assert.ok(ticks.length>=2&&ticks.length<=8,`${ticks.length} ticks`);
    assert.ok(ticks.every(tick=>!Object.is(tick,-0)),'no negative zero tick');
  }
  assert.deepEqual(niceTicks(0,1,5,true).ticks,[0,1],'integer axes never show fractional ticks');
  assert.equal(niceTicks(Number.NaN,1),null);
  assert.equal(niceTicks(2,1),null);
});

test('axis labels share one precision per axis and keep the sign rule',()=>{
  const percent=axisFormatter(niceTicks(1.16,4.422).step,true);
  assert.deepEqual([1,2,0,-3].map(percent),['+1','+2','0','-3']);
  const quarter=axisFormatter(niceTicks(0,0.9).step);
  assert.deepEqual([0,0.25,0.5].map(quarter),['0.00','0.25','0.50'],'one decimal count for the whole axis');
  const tiny=axisFormatter(1e-4,true);
  assert.deepEqual([-3e-4,0,1e-4].map(tiny),['-3e-4','0','+1e-4'],'tiny steps use one compact exponent form');
  assert.equal(axisFormatter(2.5e-4,true)(5e-4),'+5.0e-4');
  assert.equal(axisFormatter(500_000)(1_500_000),'1.5M','large axes are compact');
});

test('rounded axes start from the unpadded extent, so a drawdown never shows a band above zero',()=>{
  const drawdown=[{id:'d',label:'Drawdown',color:'r',points:[{time:0,value:-0.0137},{time:1,value:0},{time:2,value:null}]}];
  assert.deepEqual(valueExtent(drawdown,true),[-0.0137,0]);
  assert.equal(niceTicks(...valueExtent(drawdown,true)).ticks.at(-1),0,'the zero ceiling stays the top tick');
  assert.equal(valueExtent([{id:'e',label:'E',color:'b',points:[{time:0,value:null}]}]),null);
});

test('tiny axes share one written multiplier instead of repeating exponents',()=>{
  const scale=axisScale(niceTicks(-2.49e-4,1.38e-4).step,true);
  assert.equal(scale.multiplier,'×10⁻⁴');
  assert.deepEqual([-3e-4,-1e-4,0,2e-4].map(scale.format),['-3','-1','0','+2']);
  const quarter=axisScale(2.5e-5,true);
  assert.equal(quarter.multiplier,'×10⁻⁵');
  assert.equal(quarter.format(7.5e-5),'+7.5');
  const ordinary=axisScale(0.5,true);
  assert.equal(ordinary.multiplier,null);
  assert.equal(ordinary.format(1.5),'+1.5');
});

test('the shared multiplier follows the largest tick, so a narrow band away from zero stays readable',()=>{
  const band=niceTicks(1.7622e-3,1.7978e-3);
  const scale=axisScale(band.step,true,band.ticks);
  assert.equal(scale.multiplier,'×10⁻³');
  assert.equal(scale.format(band.ticks[0]),'+1.76');
  const symmetric=niceTicks(-2.49e-4,1.38e-4);
  assert.equal(axisScale(symmetric.step,true,symmetric.ticks).multiplier,'×10⁻⁴','a band around zero keeps the step exponent');
});

test('multi-day axes tick at UTC midnights, so date labels never repeat',()=>{
  const {dayTicks}=load('features/quant-ops/kit/series.ts');
  const start=Date.UTC(2026,9,1,0,0), day=86_400_000;
  const five=dayTicks([start+5*3_600_000,start+119*3_600_000]);
  assert.deepEqual(five,[1,2,3,4].map(index=>start+index*day),'one tick per UTC day inside the range');
  assert.deepEqual(dayTicks([start,start+119*3_600_000]),[1,2,3,4].map(index=>start+index*day),'a midnight on the plot edge is left out so its label is not cut');
  const month=dayTicks([start+5*3_600_000,start+30*day]);
  assert.ok(month.length<=7&&month.length>=4,`${month.length} ticks`);
  assert.ok(month.every(tick=>tick%day===0),'every tick is a UTC midnight');
  assert.ok(month[0]>=start+5*3_600_000&&month.at(-1)<=start+30*day,'ticks stay inside the domain');
  const stride=month[1]-month[0];
  assert.ok(month.every((tick,index)=>index===0||tick-month[index-1]===stride),'one whole-day stride');
});
