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
test('float-math numbers lose binary noise while exact strings are untouched', () => {
  assert.equal(formatDecimal(0.0314 * 85123.45, 18), '2,672.87633');
  assert.equal(formatDecimal(2.6725602399999997, 18), '2.67256024');
  assert.equal(formatDecimal(0.1 + 0.2, 18), '0.30');
  assert.equal(formatSigned(-(0.1 + 0.2), 18), '-0.30');
  // Strings carry exact owner decimals and keep every digit.
  assert.equal(formatDecimal('2.6725602399999997', 18), '2.6725602399999997');
  assert.equal(formatDecimal(1e-7), '0.0000001');
  assert.equal(formatDecimal(Number.NaN), 'Unavailable');
});
test('portfolio formatValue is locale-independent and never rounds a small change to -0.00', () => {
  const { formatValue } = load('features/portfolio/format.ts');
  assert.equal(formatValue(1234.5), '1,234.50');
  assert.equal(formatValue(-0.004), '-0.004');
  assert.equal(formatValue(0.1 + 0.2), '0.30');
  assert.equal(formatValue(null), 'Unavailable');
  assert.equal(formatValue(Number.NaN), 'Unavailable');
});
