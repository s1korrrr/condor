import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { paperCoherentRead, paperSectionError } from '../src/v5/policy.ts';

const [python, apiSource, fixtures, scratch, baselinePolicy, sampleText = '30'] = process.argv.slice(2);
assert(baselinePolicy, 'Usage: benchmark-v5-paper.mjs PYTHON API73_SOURCE FIXTURES SCRATCH BASELINE_POLICY [SAMPLES]');
const samples = Number(sampleText);
assert(Number.isSafeInteger(samples) && samples >= 20);
const baseline = await import(pathToFileURL(baselinePolicy));
const bridge = spawn(python, [fileURLToPath(new URL('./benchmark-v5-paper-bridge.py', import.meta.url)), apiSource, fixtures, scratch], {stdio:['pipe','pipe','inherit']});
let nextId = 0;
const pending = new Map();
let ready;
const initialized = new Promise(resolve => {ready = resolve;});
createInterface({input:bridge.stdout}).on('line', line => {
  const result = JSON.parse(line);
  if (result.ready) ready(result);
  else { const resolve = pending.get(result.id); pending.delete(result.id); resolve(result); }
});
bridge.on('exit', code => { if (code) { console.error(`API73 bridge exited ${code}`); process.exitCode = 1; } });
const metadata = await initialized;
const sections = {
  bots:['wallet','positions','fills','executors','risk','decisions','history','accounting'],
  readiness:['wallet','positions','executors','risk'],
  settings:['wallet','positions','executors','risk'],
  capital:['wallet','history','accounting'],
};
let active = 0, peak = 0;
async function read(path, section) {
  active++; peak = Math.max(peak, active);
  const id = ++nextId;
  const response = await new Promise(resolve => {pending.set(id, resolve); bridge.stdin.write(JSON.stringify({id,path}) + '\n');});
  active--;
  if (response.status !== 200) throw Object.assign(new Error(JSON.stringify(response.body)), {status:response.status});
  assert.equal(response.body.section, section);
  assert.equal(paperSectionError(response.body), null, section);
  return response.body;
}
const results = [];
try {
  for (const [page, names] of Object.entries(sections)) {
    const descriptor = names.map(section => ({section, path:`/v1/paper/${section}`, paginate:['positions','fills','executors','history'].includes(section)}));
    const measured = {};
    let expected;
    for (const [label, loader] of [['before',baseline.paperCoherentRead],['after',paperCoherentRead]]) {
      const timings = []; peak = 0;
      for (let sample = -1; sample < samples; sample++) {
        const started = performance.now();
        const reads = await loader('/v1/paper/status', descriptor, read);
        const shape = reads;
        expected ??= shape;
        assert.deepEqual(shape, expected, `${page} correctness parity`);
        if (sample >= 0) timings.push((performance.now() - started) / 1000);
      }
      timings.sort((left,right) => left-right);
      measured[label] = {p50_s:timings[Math.floor(samples / 2)],p95_s:timings[Math.ceil(samples * .95)-1],samples,peak};
    }
    results.push({page,...measured});
  }
  console.log(JSON.stringify({api_head:'5a24d9c25158f9740b846bdbdc4ad79a53e2af55',metadata,transport:'in-process TestClient through stdio; no injected delay; one warmup per page/loader; retained immutable fixture snapshot',results}, null, 2));
} finally {bridge.stdin.end();}
