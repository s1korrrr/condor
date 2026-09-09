import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';
const code=ts.transpileModule(fs.readFileSync(new URL('../src/features/research/research-document-read.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {readResearchDocument}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const signal=new AbortController().signal;
test('source download writes each chunk to the selected file without buffering a Blob',async()=>{
 const written=[];const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2]));c.enqueue(new Uint8Array([3,4,5]));c.close();}}),{headers:{'content-type':'application/x-ndjson','content-length':'5'}});
 const result=await readResearchDocument(async()=>response,'/api/v1/research/document',signal,{maximumBytes:1e10,write:async chunk=>written.push([...chunk])});
 assert.deepEqual(written,[[1,2],[3,4,5]]);assert.equal(result.blob,null);assert.equal(result.bytes,5);assert.equal(result.mime,'application/x-ndjson');
});
test('preview rejects a declared oversized source before consuming bytes',async()=>{
 const response=new Response('too large',{headers:{'content-length':'99'}});
 await assert.rejects(readResearchDocument(async()=>response,'/doc',signal,{maximumBytes:5}),/too large/);
});
test('unknown-length response stops at preview limit and incomplete known-length responses fail visibly',async()=>{
 await assert.rejects(readResearchDocument(async()=>new Response('abcdef'),'/doc',signal,{maximumBytes:5}),/exceeded/);
 await assert.rejects(readResearchDocument(async()=>new Response('abc',{headers:{'content-length':'4'}}),'/doc',signal,{maximumBytes:10}),/incomplete/);
});
test('source access failures expose owner error and never return an empty successful preview',async()=>{
 await assert.rejects(readResearchDocument(async()=>Response.json({detail:'Source revision changed'},{status:409}),'/doc',signal,{maximumBytes:10}),/Source revision changed/);
});
test('plain source preview retains bytes and detected media type',async()=>{
 const result=await readResearchDocument(async()=>new Response('<script>source only</script>',{headers:{'content-type':'text/plain; charset=utf-8'}}),'/doc',signal,{maximumBytes:100});
 assert.equal(await result.blob.text(),'<script>source only</script>');assert.equal(result.mime,'text/plain');
});
