import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';
const { load } = frontendModules();
const { formatDecimal, formatSigned } = load('features/quant-ops/format.ts');
test('decimal display preserves financial integers beyond Number precision', () => {
  assert.equal(formatDecimal('9007199254740993.12'), '9,007,199,254,740,993.12');
  assert.equal(formatDecimal('1234.995'), '1,235.00');
  assert.equal(formatDecimal('-1234.995'), '-1,235.00');
});
test('tiny holdings and signed PnL do not disappear through rounding', () => {
  assert.equal(formatDecimal('0.0000005224', 8), '0.00000052');
  assert.equal(formatDecimal('0.0000005224'), '0.0000005224');
  assert.equal(formatSigned('-0.0000005224'), '-0.0000005224');
  assert.equal(formatDecimal('5.224e-7'), '0.0000005224');
  assert.equal(formatDecimal('1e-12'), '0.000000000001');
});
test('invalid, nonfinite and zero remain distinct', () => {
  for (const value of [null, undefined, '', 'NaN', 'Infinity', '0x10', '1e9999']) assert.equal(formatDecimal(value), 'Unavailable');
  assert.equal(formatDecimal('0'), '0');
  assert.equal(formatSigned('-0.0'), '0.00');
});
