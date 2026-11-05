import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const {chromium}=createRequire(import.meta.url)('/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/browser/node_modules/playwright-core');
const scratch='/home/rsi/dev/rsibot/.workspace/scratch/condor-task2-20261105';
const out=path.join(scratch,'captures');fs.mkdirSync(out,{recursive:true});
const fixture=section=>JSON.parse(fs.readFileSync(path.join(scratch,'condor/tests/fixtures/paper-api-final3/native-replay',section+'.json')));
const base='https://razer.tailb24ea3.ts.net:25443/test/browser/paper-presentation.html';
const reduced=[[390,'dark'],[768,'dark'],[1440,'dark'],[1440,'light'],[1440,'colorblind']];
const matrix=[['additive-hold',1440,'dark'],...['dark','light','colorblind'].flatMap(theme=>[390,768,1440].map(width=>['fresh',width,theme])),...['stale','retained-hold'].flatMap(state=>reduced.map(([width,theme])=>[state,width,theme]))];
const manifest={classification:'recorded native replay fixture; no live data or token',source:'condor #98 stacked on #91 e0005086',baseline:'root #652 0b7a65d7; inspected stale-dark-1440 and retained-hold-light-1440',browser:'local system Google Chrome via playwright-core; T3 snapshot timed out twice',captures:[],interactions:[]};
const repo=path.join(scratch,'condor');
manifest.candidate_code_diff_sha256=createHash('sha256').update(execFileSync('git',['diff','--binary','e0005086169bd8b0ea9e1776f616e791d557cb48','--','frontend/src','frontend/test'],{cwd:repo})).digest('hex');
manifest.source_sha256=Object.fromEntries(['frontend/src/pages/tabs/ActiveBotsTab.tsx','frontend/src/v5/components/PaperWorkspace.tsx','frontend/src/v5/components/PaperWorkspace.css','frontend/test/v5-paper-presentation.test.mjs','frontend/test/browser/paper-presentation.tsx','frontend/test/browser/paper-presentation.html'].map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex')]));
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
manifest.browser_version=browser.version();manifest.node_version=process.version;
try {
 for(const [state,width,theme] of matrix){
  if(process.env.CAP_ONLY && process.env.CAP_ONLY!==`${state}:${theme}:${width}`)continue;
  if(fs.existsSync('/home/rsi/dev/rsibot/.workspace/scratch/r3/LIVE_STEP_ACTIVE'))throw Object.assign(new Error('NOT RUN: LIVE STEP flag appeared'),{exitCode:75});
  const context=await browser.newContext({viewport:{width,height:width===390?844:width===768?1024:900},deviceScaleFactor:1,hasTouch:width===390,reducedMotion:'reduce',colorScheme:theme==='light'?'light':'dark',timezoneId:'UTC',acceptDownloads:true});
  const page=await context.newPage();const errors=[],requests=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))requests.push(new URL(r.url()).pathname);});
  await page.goto(`${base}?state=${state}&theme=${theme}`,{waitUntil:'networkidle',timeout:30000});
  await page.getByText(state==='retained-hold'?'Checking owner snapshot':'Closed one-minute price series',{exact:true}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
  const checks=await page.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight},theme:document.documentElement.dataset.theme,overflow:document.documentElement.scrollWidth>innerWidth,animations:document.getAnimations().filter(a=>a.playState==='running').length,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,text:document.body.innerText,disclosure_overflow:[...document.querySelectorAll('.paper-exact')].filter(el=>el.getBoundingClientRect().bottom>el.closest('.q-tile-cell').getBoundingClientRect().bottom+1).map(el=>el.querySelector('summary')?.textContent),clipped_metrics:[...document.querySelectorAll('.q-kpi > strong,.q-kpi-foot small')].filter(el=>el.scrollWidth>el.clientWidth+1||el.scrollHeight>el.clientHeight+1).map(el=>el.textContent),background:getComputedStyle(document.querySelector('[data-panel-id="paper-fleet"]')??document.body).backgroundColor}));
  assert.equal(checks.theme,theme);assert.equal(checks.overflow,false);assert.equal(checks.animations,0);assert.equal(checks.reduced,true);assert.deepEqual(checks.clipped_metrics,[]);assert.deepEqual(checks.disclosure_overflow,[]);
  assert.ok(checks.text.includes('LOCAL VERIFICATION FIXTURES · NOT LIVE DATA'));
  assert.doesNotMatch(checks.text,/\bNaN\b|\bundefined\b|\[object Object\]/);
  if(state==='stale'){assert.ok(checks.text.includes('Stale owner sections'));assert.ok(checks.text.includes('Fresh · heartbeat'));assert.ok(checks.text.includes('Not published'));assert.ok(checks.text.includes('Incomplete or stale owner read'));}
  if(state==='retained-hold'){assert.ok(checks.text.includes('Recorded retained hold fixture'));assert.ok(!checks.text.includes('Wallet equity'));}
  if(state==='additive-hold'){const id=Object.keys(fixture('risk').data.controllers)[0];const aside=page.locator('aside.paper-fleet');const heading=aside.getByRole('heading',{name:id,exact:true});assert.equal(await heading.count(),1);const row=await heading.locator('..').innerText();assert.ok(row.includes('Reported operator pause: Yes'));assert.ok(row.includes('Reported emergency halt: Yes'));manifest.interactions.push({case:'one held controller row with additive pause/emergency evidence',result:'PASS'});}
  if(state==='fresh'){assert.ok(checks.text.includes('SIMULATED ACCOUNT'));const fillTable=page.locator('.q-dt').filter({has:page.getByRole('region',{name:'Paper fills',exact:true})});assert.equal((await fillTable.locator('.q-dt__count').innerText()).trim(),'344 rows');}
  assert.deepEqual(requests,[],'fixture must never call a backend');assert.deepEqual(errors,[],'browser console must be clean');
  const name=`v5-paper-${state}-${theme}-${width}.png`,file=path.join(out,name);
  await page.screenshot({path:file,fullPage:true});
  manifest.captures.push({file:name,state,width,theme,height:await page.evaluate(()=>document.documentElement.scrollHeight),page_overflow_x:checks.overflow,active_animations:checks.animations,reduced_motion:checks.reduced,background:checks.background,clipped_metrics:checks.clipped_metrics,disclosure_overflow:checks.disclosure_overflow,errors,api_requests:requests,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
  if(state==='fresh'&&theme==='dark'&&width===390){const inspect=page.getByText('Inspect owner sections',{exact:true});await inspect.tap();assert.equal(await inspect.evaluate(el=>el.parentElement.open),true);await inspect.tap();assert.equal(await inspect.evaluate(el=>el.parentElement.open),false);manifest.interactions.push({case:'emulated touch section inspection',result:'PASS'});}
  if(state==='fresh'&&theme==='dark'&&width===1440){
   const inspect=page.getByText('Inspect owner sections',{exact:true});await inspect.click();assert.equal(await inspect.evaluate(el=>el.parentElement.open),true);await inspect.press('Enter');assert.equal(await inspect.evaluate(el=>el.parentElement.open),false);assert.equal(await inspect.evaluate(el=>el===document.activeElement),true);
   const exact=page.getByText('Exact Wallet equity',{exact:true});await exact.focus();await exact.press('Space');assert.equal(await exact.evaluate(el=>el.parentElement.open),true);assert.ok(await page.getByText(fixture('wallet').data.equity_quote+' USDC',{exact:true}).isVisible());await exact.press('Enter');
   const table=page.locator('.q-dt').filter({has:page.getByRole('region',{name:'Paper executors',exact:true})});
   const first=fixture('executors').data[0];await table.getByRole('searchbox',{name:'Search Paper executors',exact:true}).fill(first.executor_id);assert.equal(await table.locator('tbody tr').count(),1);
   await table.getByRole('button',{name:'Filters',exact:true}).click();await table.getByRole('textbox',{name:'Filter Pair',exact:true}).fill(first.trading_pair);assert.equal(await table.locator('tbody tr').count(),1);
   const resize=table.getByRole('separator',{name:'Resize Pair',exact:true});const initial=Number(await resize.getAttribute('aria-valuenow'));await resize.focus();await resize.press('ArrowRight');assert.equal(Number(await resize.getAttribute('aria-valuenow')),initial+16);
   const downloadPromise=page.waitForEvent('download');await table.getByRole('button',{name:'Export CSV',exact:true}).click();const download=await downloadPromise;const csvFile=path.join(out,'executors-exact.csv');await download.saveAs(csvFile);const csv=fs.readFileSync(csvFile,'utf8');
   for(const value of [first.executor_id,first.realized_pnl_quote,first.remaining_basis_quote,fixture('status').bot_id,fixture('status').snapshot_id])assert.ok(csv.includes(value),String(value));assert.ok(csv.includes('quantity_unit,quote_unit,fee_unit'));
   manifest.interactions.push({case:'pointer/keyboard exact disclosure, focus retention, search, column filter, keyboard resize, CSV identity',result:'PASS',csv:'executors-exact.csv'});
  }
  await context.close();console.log(`${name} PASS`);
 }
 fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(`CAPTURES=${manifest.captures.length} PASS; INTERACTIONS=${manifest.interactions.length} PASS`);
} finally {await browser.close();}
