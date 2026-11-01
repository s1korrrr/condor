import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const {distHashes,verifyDist} = await import(pathToFileURL(path.resolve('frontend/tooling/check-v5-reproducibility.mjs')));
const output = `${process.env.S}/revision2-seed-dist`;
const manifestPath = 'frontend/v5-reviewed-build.json';
const old = JSON.parse(fs.readFileSync('docs/evidence/2026-11-01-v5-settings-render-loop/revision2-reviewed-build-before.json','utf8'));
assert.throws(() => verifyDist(output,old),/V5 dist differs from the reviewed manifest/);
console.log('Old manifest rejects: V5 dist differs from the reviewed manifest');
const files = distHashes(output);
assert.equal(Object.keys(files).length,35);
const entries = Object.keys(files).filter(file => /^assets\/v5-[^.]+\.js$/.test(file));
assert.equal(entries.length,1);
const entry = entries[0];
const manifest = {entry,entrySha256:files[entry],files};
fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(verifyDist(output,manifest)));
