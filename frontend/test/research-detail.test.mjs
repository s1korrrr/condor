import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const code=ts.transpileModule(fs.readFileSync(new URL('../src/features/research/research-detail.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {safeSourceUrl,metricValue,archiveMetricsAvailable,documentPath,isolatedDocument,relationshipEvidence}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('source links admit ordinary HTTP(S) without credentials and reject executable, local, protocol-relative and credential URLs',()=>{
 assert.equal(safeSourceUrl('https://arxiv.org/abs/2601.00001'),'https://arxiv.org/abs/2601.00001');
 for(const value of ['javascript:alert(1)','data:text/html,test','file:///secret','//evil.example','https://user:secret@example.com','/etc/passwd','https://example.com/\nsecret',null]) assert.equal(safeSourceUrl(value),null);
});
test('recorded metric display preserves source units and treats empty/nonfinite/boolean values as unavailable',()=>{
 assert.equal(metricValue({value:'0.125',unit:'fraction'}),'12.5%');
 assert.equal(metricValue({value:0,unit:'USDC'}),'0 USDC');
 assert.equal(metricValue({value:3.5,unit:'trades'}),'3.5 trades');
 for(const value of [null,'',true,Infinity,'NaN',{}]) assert.equal(metricValue({value,unit:'fraction'}),'UNAVAILABLE');
});
test('archive metrics are visible only with the recorded frozen-source hash gate',()=>{
 assert.equal(archiveMetricsAvailable({metrics_state:'SOURCE_HASH_MATCHED; NOT_ECONOMIC_ADJUDICATION'}),true);
 assert.equal(archiveMetricsAvailable({metrics_state:'HASH_MISMATCH',recorded_metrics:{economics:{pnl:12}}}),false);
 assert.equal(archiveMetricsAvailable({}),false);
});
test('document request is bound to authenticated endpoint and encodes opaque record reference without accepting destination URLs',()=>{
 assert.equal(documentPath('native-ok-rsi','node','idea:one','source/path'),'/api/v1/research/document?server=native-ok-rsi&scope=node&id=idea%3Aone&ref=source%2Fpath');
 assert.throws(()=>documentPath('native','https://evil','one','r'),/scope/);
 assert.throws(()=>documentPath('','node','one','r'),/identity/);
});
test('active source preview installs restrictive CSP before source markup',()=>{
 const html=isolatedDocument('<script>fetch("https://evil.example")</script>');
 assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('&lt;script&gt;'));
 assert.match(html,/default-src 'none'/);assert.match(html,/connect-src 'none'/);assert.match(html,/form-action 'none'/);assert.match(html,/base-uri 'none'/);
 assert.ok(!html.includes('allow-same-origin'));
});

test('source markup stays inside a nested opaque frame whose trusted parent blocks self-navigation',()=>{
 const html=isolatedDocument('</iframe><script>location.href="https://evil.example"</script>');
 assert.match(html,/frame-src 'none'/);
 assert.match(html,/<iframe title="Source document" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="/);
 assert.ok(!html.includes('<script>'));
 assert.equal((html.match(/<iframe/g)||[]).length,1);
 assert.ok(html.includes('&lt;/iframe&gt;&lt;script&gt;'));
});

test('source fragment navigation is retained inside preview without executable attribute injection',()=>{
 const html=isolatedDocument('<h2 id="evidence">Evidence</h2>', '#evidence');
 assert.match(html,/scrollIntoView/);
 assert.match(html,/getElementById/);
 const hostile=isolatedDocument('<p>Source</p>','</script><script>bad()</script>');
 assert.ok(!hostile.includes('<script>'));
 assert.ok(hostile.includes('\\u003c/script'));
});

 test('relationship evidence preserves direction, verified hashes and distinct historical meaning',()=>{
 const hash='a'.repeat(64);
 const edge={source:'experiment:one',target:'source:two',relation:'references_saved_artifact',provenance:{repair_rule:'exact_reference',sources:[{sha256:hash,path:'/private/source'},{sha256:hash},{sha256:'invalid'}]}};
 const result=relationshipEvidence(edge,'experiment:one');
 assert.equal(result.direction,'Outgoing');
 assert.deepEqual(result.hashes,[hash]);
 assert.equal(result.rule,'exact_reference');
 assert.match(result.meaning,/artifact/);
 assert.equal(relationshipEvidence(edge,'source:two').direction,'Incoming');
 assert.match(relationshipEvidence({...edge,relation:'recorded_in'},'experiment:one').meaning,/membership/);
 assert.match(relationshipEvidence({...edge,relation:'references_historical_idea'},'experiment:one').meaning,/preregistration/);
 assert.equal(relationshipEvidence({...edge,relation:'unknown'},'experiment:one').meaning,null);
 assert.deepEqual(relationshipEvidence({provenance:{sources:[null,3,{}]}},'x').hashes,[]);
});
