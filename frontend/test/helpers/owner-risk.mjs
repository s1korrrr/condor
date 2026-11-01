import fs from 'node:fs';

const fixture = name => JSON.parse(fs.readFileSync(new URL(`../../../tests/fixtures/paper-c1-1e131c74/${name}.json`, import.meta.url))).risk;

export function ownerRisk(name, read) {
  const native = fixture('native-entry-holds');
  const risk = fixture(name);
  return {...read, ...risk, state:'degraded', reason:risk.stale_reason,
    observed_at_ms:read.generated_at_ms, source_at_ms:read.generated_at_ms,
    data:{...native.data, ...risk.data}};
}
