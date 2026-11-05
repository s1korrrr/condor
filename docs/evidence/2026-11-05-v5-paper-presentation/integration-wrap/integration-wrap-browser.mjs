import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
const {chromium}=createRequire(import.meta.url)('/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/browser/node_modules/playwright-core');
const scratch='/home/rsi/dev/rsibot/.workspace/scratch/condor-task2-20261105';
const flag='/home/rsi/dev/rsibot/.workspace/scratch/r3/LIVE_STEP_ACTIVE';
const checkFlag=()=>{if(fs.existsSync(flag))throw Object.assign(new Error('NOT RUN: LIVE STEP'),{exitCode:75});};
const out=path.join(scratch,'integration-wrap-captures');fs.mkdirSync(out,{recursive:true});
checkFlag();
const server=await createServer({configFile:path.join(scratch,'integration-wrap-vite.mts'),configLoader:'runner'});
let browser;
try {
 await server.listen();
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const repo=path.join(scratch,'integration');
 const files=['frontend/src/v5/components/PaperWorkspace.tsx','frontend/src/v5/components/PaperWorkspace.css','frontend/test/v5-paper-presentation.test.mjs','frontend/test/browser/paper-presentation.tsx','frontend/test/ui-baseline-findings.test.mjs','frontend/src/components/bots/fleet-strip.css'];
 const manifest={integration_base:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),browser:browser.version(),source_sha256:Object.fromEntries(files.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex')])),captures:[]};
 for(const theme of ['dark','light','colorblind'])for(const width of [390,768,1440]){
  checkFlag();
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce',deviceScaleFactor:1,timezoneId:'UTC'});
  const page=await context.newPage();const errors=[],requests=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))requests.push(new URL(r.url()).pathname);});
  await page.goto(`http://127.0.0.1:29498/test/browser/paper-presentation.html?state=fresh&longIds=1&pageWrapper=none&theme=${theme}`,{waitUntil:'networkidle',timeout:30000});
  await page.getByText('Closed one-minute price series',{exact:true}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
  await page.getByText('Inspect owner sections',{exact:true}).click();
  const checks=await page.evaluate(()=>{
    const root=document.querySelector('[data-paper-workspace]');const style=getComputedStyle(root);
    const headings=[...root.querySelectorAll('.paper-fleet h3')].filter(el=>el.textContent.startsWith('modular_spot_'));
    const outside=headings.filter(el=>{
      const box=el.closest('.paper-fleet').getBoundingClientRect();const range=document.createRange();range.selectNodeContents(el);
      return [...range.getClientRects()].some(rect=>rect.left<box.left-1||rect.right>box.right+1);
    }).map(el=>el.textContent);
    return {width:innerWidth,theme:document.documentElement.dataset.theme,page_wrapper:!!root.closest('.v5-paper-bots'),wrap:style.overflowWrap,margin:style.marginBlock,padding:style.paddingBlock,overflow:document.documentElement.scrollWidth>innerWidth,long_heading_count:headings.length,min_id_length:Math.min(...headings.map(el=>el.textContent.length)),outside,heading_wrap:headings.map(el=>getComputedStyle(el).overflowWrap),running_animations:document.getAnimations().filter(a=>a.playState==='running').length};
  });
  assert.equal(checks.page_wrapper,false);assert.equal(checks.wrap,'anywhere');assert.equal(parseFloat(checks.margin),0);assert.equal(parseFloat(checks.padding),0);
  assert.equal(checks.overflow,false);assert.ok(checks.long_heading_count>0);assert.equal(checks.min_id_length,128);assert.equal(await page.locator('.v5-error-panel').count(),0);assert.deepEqual(checks.outside,[]);
  assert.ok(checks.heading_wrap.every(value=>value==='anywhere'));assert.equal(checks.running_animations,0);assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  const file=`integration-long-ids-${theme}-${width}.png`;await page.screenshot({path:path.join(out,file),fullPage:true});
  manifest.captures.push({file,...checks,errors,api_requests:requests,sha256:createHash('sha256').update(fs.readFileSync(path.join(out,file))).digest('hex')});
  await context.close();console.log(`${file}: PASS`);
 }
 fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(`CAPTURES=${manifest.captures.length} PASS`);
} catch(error){if(error.exitCode===75){console.error(error.message);process.exitCode=75;}else throw error;} finally {await browser?.close();await server.close();}
