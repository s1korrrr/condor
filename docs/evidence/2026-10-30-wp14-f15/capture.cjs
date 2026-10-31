const {chromium} = require('/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/browser/node_modules/playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const assert = require('node:assert/strict');
const checkout = '/home/rsi/dev/rsibot/condor/.worktrees/v5-operations-export-20261029';
const dist = checkout + '/frontend/dist-v5';
const origin = 'https://razer.tailb24ea3.ts.net:27443';
const root = process.env.EVIDENCE_ROOT;
const sha = value => createHash('sha256').update(value).digest('hex');
const routes = [['market','/'],['candles','/market/candles'],['market-evidence','/market/evidence'],['bots','/bots'],['capital','/capital'],['operations','/operations'],['research','/research'],['tradepad','/backtests'],['agents','/agents'],['agent-detail','/agents/decision_reviewer'],['sessions','/sessions'],['settings','/settings'],['readiness','/v5/readiness']];
(async () => {
  assert.ok(root, 'EVIDENCE_ROOT must be a new evidence directory');
  const {assertV5Bundle} = await import(checkout + '/frontend/test/helpers/v5-bundle-proof.mjs');
  const html = await fs.readFile(dist+'/v5.html');
  const entryPath = html.toString().match(/<script[^>]+src="([^"]+\.js)"/)[1];
  const built = {entryPath, entrySha256:sha(await fs.readFile(dist+entryPath)), htmlSha256:sha(html)};
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(root+'/build-identity.json',JSON.stringify(built,null,2)+'\n');
  const browser = await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  const records = [], errors = [];
  const apiReads = [];
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1050},deviceScaleFactor:1,serviceWorkers:'block'});
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
    let loaded = [];
    page.on('pageerror',error=>errors.push({url:page.url(),message:error.message}));
    page.on('response',response=>{
      if (response.url().includes('/api/v5/dashboard/read?')) apiReads.push(response.json().then(body=>({status:response.status(),body})));
      const url = new URL(response.url());
      if (url.origin===origin && url.pathname.startsWith('/assets/') && /\.(js|css)$/.test(url.pathname)) {
        loaded.push(response.body().then(async bytes=>{
          const expected = await fs.readFile(dist+url.pathname);
          assert.equal(sha(bytes),sha(expected),'Loaded asset differs from final build: '+url.pathname);
          return {path:url.pathname,sha256:sha(bytes)};
        }));
      }
    });
    await page.goto(origin+'/bots');
    await page.locator('#v5-session-token').fill('fixture-only-access-'+'x'.repeat(40));
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.waitForURL(origin+'/bots');
    await page.waitForLoadState('networkidle');
    await Promise.all(loaded);
    const states = [...routes.map(row=>[...row,'fresh']),['bots-stale','/bots','stale'],['bots-malformed','/bots','malformed'],['bots-hold','/bots','hold'],['bots-unavailable','/bots','fault'],['settings-unavailable','/settings','fault'],['readiness-unavailable','/v5/readiness','fault'],...['damaged','ingress','anomaly','controls'].map(state=>['bots-'+state,'/bots',state])];
    for (const [name,route,scenario] of states) {
      if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) continue;
      await page.evaluate(async state=>{await fetch('/__fixture/'+state,{method:'POST'});},scenario);
      for (const width of [1440,390]) for (const theme of ['light','dark']) {
        await page.setViewportSize({width,height:1050});
        await page.evaluate(theme=>localStorage.setItem('condor_theme',theme),theme);
        loaded = [];
        const navigation = await page.goto(origin+route);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1600);
        await page.waitForFunction(()=>!Array.from(document.querySelectorAll('[role=status]')).some(el=>/^Loading owner coverage|^Loading recorded candles|^Reading paper service|^Reading native simulated/.test(el.textContent.trim())),null,{timeout:20000});
        const fullHeight = await page.evaluate(()=>Math.max(1050,...Array.from(document.querySelectorAll('main')).map(el=>el.scrollHeight+160)));
        await page.setViewportSize({width,height:Math.min(18000,fullHeight)});
        await page.waitForTimeout(300);
        for (let attempt=0;attempt<3;attempt++) {
          const delta=await page.evaluate(()=>Math.max(0,...Array.from(document.querySelectorAll('main')).map(el=>el.scrollHeight-el.clientHeight)));
          if (!delta) break;
          await page.setViewportSize({width,height:page.viewportSize().height+delta+4});
        }
        const modules = await Promise.all(loaded);
        const served = modules.find(module=>module.path===entryPath);
        const observed = {entryPath:await page.locator('script[type=module][src]').first().getAttribute('src'),entrySha256:served?.sha256,htmlSha256:sha(await navigation.body())};
        assertV5Bundle(built,observed);
        assert.equal(sha(await fs.readFile(dist+'/v5.html')),built.htmlSha256,'Build changed during capture');
        const png = `${root}/${name}-${theme}-${width}.png`;
        await page.screenshot({path:png,fullPage:true});
        const result = await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,text:document.body.innerText,scrollers:Array.from(document.querySelectorAll('main')).map(el=>({height:el.clientHeight,scroll:el.scrollHeight}))}));
        assert.equal(result.document,width,'Document overflow');
        assert.ok(result.scrollers.every(row=>row.scroll===row.height),'Main content clipped');
        if (name==='settings-unavailable') {
          const identity = await page.locator('section.v5-panel').filter({has:page.getByRole('heading',{name:'Paper owner identity',exact:true})}).innerText();
          assert.match(identity,/Paper owner reads\nUnavailable/);
          assert.match(identity,/Heartbeat as of/);
          assert.match(identity,/Heartbeat reason\nPaper process heartbeat is current; owner read health is separate/);
          assert.doesNotMatch(identity,/PAPER_STATUS_FRESH|Source as of|Owner reason/);
        }
        assert.doesNotMatch(result.text,/owner schema invalid|Paper wallet read failed|snapshot does not match its epoch/);
        const reads = await Promise.all(apiReads);
        assert.ok(reads.length >= 5);
        for (const read of reads) { assert.equal(read.status,200); assert.ok(Array.isArray(read.body.capabilities)); }
        records.push({apiReads:reads,name,route,scenario,width,theme,path:png,pngSha256:sha(await fs.readFile(png)),bundle:observed,loadedAssets:modules,...result});
        await fs.writeFile(root+'/screenshot-index.json',JSON.stringify({built,records,errors},null,2)+'\n');
        console.log(`${name} ${theme} ${width} BUNDLE_PASS ${observed.entrySha256}`);
      }
    }
    assert.equal(errors.length,0,'Browser exceptions');
  } finally {await browser.close();}
  console.log(JSON.stringify({captures:records.length,built,errors}));
})().catch(error=>{console.error(error);process.exitCode=1;});
