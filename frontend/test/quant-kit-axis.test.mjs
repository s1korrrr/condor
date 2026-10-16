import test from 'node:test';
import assert from 'node:assert/strict';
import {frontendModules} from './helpers/frontend-module.mjs';

const {load}=frontendModules();
const {niceTicks,axisFormatter,valueExtent,axisScale,ratioPercentTick}=load('features/quant-ops/kit/series.ts');

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

test('ranges narrower than float precision terminate and stay readable (external watchdog)',()=>{
  const run=inChild(`console.log(JSON.stringify([[1000,1000.0000000000001],[1e15,1e15+0.125],[-5e300,-5e300],[0,Number.MIN_VALUE],[1e-300,2e-300]].map(([a,b])=>[a,b,kit.niceTicks(a,b)])));`);
  assert.equal(run.signal,null,`child was killed by the watchdog: ${run.signal}`);
  assert.equal(run.status,0,run.stderr);
  for(const [low,high,nice] of JSON.parse(run.stdout)){
    assert.ok(nice&&nice.ticks.length>=2&&nice.ticks.length<=50&&nice.ticks[0]<=low&&nice.ticks.at(-1)>=high,`[${low}, ${high}]`);
    assert.equal(new Set(nice.ticks).size,nice.ticks.length,'ticks are distinct');
  }
  assert.ok(JSON.parse(run.stdout)[0][2].step>=1,'a range flat relative to its magnitude gets the flat-series band');
});

test('drawdown percent ticks keep distinct labels for tiny ranges',()=>{
  const {ticks,step}=niceTicks(-0.0005,0);
  const labels=ticks.map(tick=>ratioPercentTick(tick,step));
  assert.equal(new Set(labels).size,labels.length,`distinct labels: ${labels.join(', ')}`);
  assert.deepEqual(labels,['-0.06%','-0.04%','-0.02%','0.00%'],'the old one-decimal formatter printed -0.1%, -0.0%, -0.0%, 0.0%');
  assert.equal(ratioPercentTick(-0.01,0.005),'-1.0%');
  assert.equal(ratioPercentTick(0,0.005),'0.0%');
});

// A synchronous infinite loop cannot be pre-empted by node:test timeouts, so extreme inputs run in a
// child process under an external watchdog.
import {spawnSync} from 'node:child_process';
const helperUrl=new URL('./helpers/frontend-module.mjs',import.meta.url).href;
function inChild(body){
  const code=`const {frontendModules}=await import(${JSON.stringify(helperUrl)});const kit=frontendModules().load('features/quant-ops/kit/series.ts');${body}`;
  return spawnSync(process.execPath,['--input-type=module','-e',code],{timeout:5000,encoding:'utf8'});
}

test('extreme numeric and time ranges terminate (external watchdog)',()=>{
  const run=inChild(`
    const out=[];
    for(const [a,b] of [[1000,1000.0000000000001],[0,Number.MIN_VALUE],[1e-300,2e-300],[-1.7e308,1.7e308],[1e308,1.0000000000000002e308]]) out.push(kit.niceTicks(a,b));
    out.push(kit.dayTicks([1e308,1.0000000000000002e308]),kit.dayTicks([-8.64e15,8.64e15]),kit.dayTicks([0,8.64e15]));
    console.log(JSON.stringify(out));`);
  assert.equal(run.signal,null,`child was killed by the watchdog: ${run.signal}`);
  assert.equal(run.status,0,run.stderr);
  const [narrow,underflow,tiny,overflow,huge,dayHuge,dayAll,dayHalf]=JSON.parse(run.stdout);
  assert.deepEqual(narrow.ticks,[990,995,1000,1005,1010]);
  assert.ok(underflow&&underflow.ticks[0]<=0&&underflow.ticks.at(-1)>=Number.MIN_VALUE,'an underflowing span gets the flat band instead of no axis');
  assert.ok(tiny&&tiny.ticks.length>=2);
  assert.equal(overflow,null,'a span that overflows has no rounded axis');
  assert.ok(huge&&huge.ticks.length>=2);
  assert.deepEqual(dayHuge,[],'timestamps outside the Date range get no day ticks');
  assert.ok(dayAll.length>=2&&dayAll.length<=8&&dayHalf.length>=2&&dayHalf.length<=8);
});

test('time series outside the Date range are rejected as invalid timestamps',()=>{
  const {projectTimeSeries}=load('features/quant-ops/kit/series.ts');
  assert.match(projectTimeSeries([{id:'x',label:'X',color:'r',points:[{time:1e308,value:1},{time:1.0000000000000002e308,value:2}]}]).invalid,/timestamps are invalid/);
  assert.equal(projectTimeSeries([{id:'x',label:'X',color:'r',points:[{time:8.64e15,value:1}]}]).invalid,null,'the last valid Date is accepted');
});

test('large axes stay distinct: compact labels only for steps of a thousand or more',()=>{
  const {ticks,step}=niceTicks(100000,100001);
  const labels=ticks.map(axisFormatter(step));
  assert.equal(new Set(labels).size,labels.length,labels.join(', '));
  assert.equal(axisFormatter(0.25)(100000.25),'100,000.25');
  assert.equal(axisFormatter(5000)(1_500_000),'1.5M');
});

test('time-series axes keep a small margin where data sits exactly on an outer tick',()=>{
  const {roundedAxis}=load('features/quant-ops/kit/series.ts');
  const zeroFloor=roundedAxis([0,40],{margin:true});
  assert.deepEqual(zeroFloor.ticks,[0,10,20,30,40]);
  assert.ok(zeroFloor.domain[0]<0&&zeroFloor.domain[1]>40,'a recorded zero no longer lies on the x-axis baseline');
  const inside=roundedAxis([1.16,4.422],{margin:true});
  assert.deepEqual(inside.domain,[1,5],'no margin when the data stays inside the outer ticks');
  assert.deepEqual(roundedAxis([0,40]).domain,[0,40],'bars keep their zero baseline flush');
  assert.equal(roundedAxis(null),null);
});
