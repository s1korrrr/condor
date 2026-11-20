import assert from 'node:assert/strict';

test('percentage titles keep exact terminating decimals and round non-terminating results', () => {
  assert.equal(format.decimalPercentChange('199057.11379198655820', '200000').exact, '−0.4714431040067209%');
  assert.equal(format.rationalPercent(1000n, 100n).exact, '10%');
  assert.equal(format.rationalPercent(12100n, 288n).exact, '≈ 42.0139 % (rounded)');
});

test('live wallet equity percentage title rounds without a result fraction', () => {
  const result = format.decimalPercentChange('199087.83518689085820', '199197.63587918115820');
  assert.equal(result.exact, '≈ −0.0551 % (rounded)');
  assert.doesNotMatch(result.exact, /\//);
  assert.equal(result.value, '-0.06');
});

test('100 over 288 percent rounds to 0.3472 independently of tile precision', () => {
  for (const digits of [0, 2, 12]) {
    assert.equal(format.rationalPercent(100n, 288n, digits).exact, '≈ 0.3472 % (rounded)');
  }
});

test('tiny non-terminating negative percentage titles have no minus after rounding to zero', () => {
  const result = format.rationalPercent(-1n, 300000n);
  assert.equal(result.exact, '≈ 0 % (rounded)');
  assert.doesNotMatch(result.exact, /[−-]/);
  assert.equal(result.direction, -1);
});

test('huge non-terminating percentages round without floating-point conversion', () => {
  const scale = 10n ** 400n;
  assert.equal(format.rationalPercent(50n * scale + 1n, 3n * scale + 1n).exact, '≈ 16.6667 % (rounded)');
  assert.equal(format.rationalPercent(-(50n * scale + 1n), 3n * scale + 1n).exact, '≈ −16.6667 % (rounded)');
});

test('four-place rounding distinguishes huge fractions immediately below and above a half', () => {
  const denominator = 30000000000000000000000000000000000000003n;
  const below = denominator * 12345n / 100000n;
  assert.equal(format.rationalPercent(below, denominator).exact, '≈ 0.1234 % (rounded)');
  assert.equal(format.rationalPercent(below + 1n, denominator).exact, '≈ 0.1235 % (rounded)');
  assert.equal(format.rationalPercent(-below, denominator).exact, '≈ −0.1234 % (rounded)');
  assert.equal(format.rationalPercent(-(below + 1n), denominator).exact, '≈ −0.1235 % (rounded)');
});

test('non-terminating percentage rounding carries into the whole number', () => {
  assert.equal(format.rationalPercent(299999n, 300000n).exact, '≈ 1.0000 % (rounded)');
});
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as format from '../src/v5/format.mjs';
import { age, coin, count, fixed, pct, pnl, price, quantity, signed, usdc, utc, utcMin, when } from '../src/v5/format.mjs';

const M = '−';
const base = Date.UTC(2026, 10, 14, 11, 34, 22);

test('owner display preserves the original value and uses the rounded sign for every kind', () => {
  for (const [kind, value, options, text, tone] of [
    ['usdc', '-0.004', {}, '0.00 USDC', 'zero'],
    ['signed', '-0.004', {}, '0.00', 'zero'],
    ['pnl', '-0.004', {}, '0.00', 'zero'],
    ['pct', '-0.0001', {}, '0.00%', 'zero'],
    ['bps', '-0.004', {}, '0.00 bps', 'zero'],
    ['price', '1e-8', {}, '0.0000', 'zero'],
    ['coin', '-0.00000001', {unit:'BNB'}, '0 BNB', 'zero'],
    ['signed', '-1.234', {}, '−1.23', 'down'],
    ['signed', '1.234', {}, '+1.23', 'up'],
  ]) assert.deepEqual(format.ownerDisplay(value, kind, options), {text, exact:value, tone});
  assert.deepEqual(format.ownerDisplay(null, 'usdc'), {text:'—', exact:null, tone:'none'});
});

test('owner hover titles keep exact owner text up to 12 decimal places and round longer Decimal quotients', () => {
  // Live Helm daily_loss_use, a 28-digit Decimal quotient (install-9 phone check, 2026-11-16).
  assert.equal(format.ownerTitle('34.41737209677040000000000001'), '≈ 34.41737209677 (rounded)');
  assert.equal(format.ownerDisplay('34.41737209677040000000000001', 'usdc', {unit:''}).exact, '≈ 34.41737209677 (rounded)');
  assert.equal(format.ownerTitle('-31.82088632877040000000000001'), '≈ −31.82088632877 (rounded)');
  assert.equal(format.ownerTitle('0.0000000000004'), '≈ 0 (rounded)');
  // Rounding is half away from zero with carry, never truncation (Sol R1).
  assert.equal(format.ownerTitle('1.0000000000005'), '≈ 1.000000000001 (rounded)');
  assert.equal(format.ownerTitle('-1.0000000000005'), '≈ −1.000000000001 (rounded)');
  assert.equal(format.ownerTitle('1.00000000000049'), '≈ 1 (rounded)');
  assert.equal(format.ownerTitle('9.9999999999995'), '≈ 10 (rounded)');
  assert.equal(format.ownerTitle('-0.0000000000004'), '≈ 0 (rounded)');
  assert.equal(format.ownerTitle('4.9e-19'), '≈ 0 (rounded)');
  assert.equal(format.ownerTitle(4.9e-19), '≈ 0 (rounded)');
  assert.equal(format.ownerTitle('0'), '0');
  assert.equal(format.ownerTitle(0), '0');
  // Exact owner text stays exact: trailing zeros do not count, exponent text expands to its digits.
  for (const value of ['0.1358703289900', '641.78', '0.123456789012', '1e-8', '200000', '-0.004'])
    assert.equal(format.ownerTitle(value), value);
  assert.equal(format.ownerTitle(null), null);
  assert.equal(format.ownerTitle('not a number'), null);
});

test('tiny values round to normal places without negative zero', () => {
  assert.equal(coin('-0.00000001', 'BNB'), '0 BNB');
  assert.equal(usdc('-0.00000001'), '0.00 USDC');
  assert.equal(fixed('-0.00000001'), '0.00');
  assert.deepEqual(pnl('-0.00000001'), {text:'0.00',tone:'zero'});
  assert.equal(usdc('-0.004'), '0.00 USDC');
  assert.equal(coin('0.0000039', 'BNB'), '0.000004 BNB');
  assert.equal(price('1.234567890123e-20'), '0.0000');
});

test('axis ticks preserve ordinary values and bound tiny values', () => {
  assert.equal(format.axis(199330.7), '199,330.70');
  assert.equal(format.axis(199330.7, 2, true), '+199,330.70');
  assert.equal(format.axis(12345.6, 2, true), '+12,345.60');
  assert.equal(format.axis(99999.99, 2, true), '+99,999.99');
  assert.equal(format.axis(-35.52, 2, true), '−35.52');
  assert.equal(format.axis(1e-30), '0.00');
  assert.equal(format.axis(-0.004), '0.00');
  assert.equal(format.axis(1234.5), '1,234.50');
  assert.equal(format.axis(1234.5, 2, true), '+1,234.50');
  assert.equal(format.axis(1e30), '—');
  assert.equal(format.axis(0), '0');
  assert.equal(fixed('1e-30'), '0.00');
});

test('ordinary axis ticks match the existing text formatter', () => {
  for (const value of [-99999.99, -35.52, -0.1, 0.1, 12.345, 12345.6, 199330.7, 200000, 1e9]) {
    for (const digits of [1, 2, 4]) {
      assert.equal(format.axis(value, digits), fixed(value, digits));
      assert.equal(format.axis(value, digits, true), signed(value, digits));
    }
  }
});

test('Money and Market use bounded ticks but retain full tooltip formatters', () => {
  const money = readFileSync(new URL('../src/v5/V5Money.tsx', import.meta.url), 'utf8');
  const market = readFileSync(new URL('../src/v5/V5Market.tsx', import.meta.url), 'utf8');
  assert.match(money, /leftFormat=\{value => fixed\(value\)\} leftTickFormat=\{value => axis\(value\)\}/);
  assert.match(money, /leftFormat=\{value => signed\(value\)\} leftTickFormat=\{value => axis\(value, 2, true\)\}/);
  assert.match(market, /leftFormat=\{value => pct\(value\)\} leftTickFormat=\{value => `\$\{axis\(value, 2, true\)\}%`\}/);
  assert.match(market, /leftFormat=\{value => `\$\{signed\(value, 1\)\} bp`\} leftTickFormat=\{value => `\$\{axis\(value, 1, true\)\} bp`\}/);
});

test('usdc: 2 decimals, separators, unit once, true minus; numbers and decimal strings alike', () => {
  assert.equal(usdc(199330.7), '199,330.70 USDC');
  assert.equal(usdc('199330.7'), '199,330.70 USDC');
  assert.equal(usdc(-669.3), `${M}669.30 USDC`);
  assert.equal(usdc('1234567.005'), '1,234,567.01 USDC');
  assert.equal(usdc(1.005), '1.01 USDC');
  assert.equal(usdc(200000, ''), '200,000.00');
  assert.equal(usdc(5, 'EUR'), '5.00 EUR');
});

test('strings are rounded by string arithmetic and stay exact beyond float precision', () => {
  assert.equal(fixed('12345678901234567890.125', 2), '12,345,678,901,234,567,890.13');
  assert.equal(fixed('12345678901234567890.124', 2), '12,345,678,901,234,567,890.12');
  assert.equal(fixed('0.995', 2), '1.00');
  assert.equal(fixed('199340.689300000000000001', 2), '199,340.69');
  assert.equal(fixed('-12345678901234567890.5', 0), `${M}12,345,678,901,234,567,891`);
  assert.equal(fixed('7', 2), '7.00');
  assert.equal(fixed('.5', 1), '0.5');
});

test('true zero and tiny values that round to zero have no sign', () => {
  assert.equal(fixed(0), '0.00');
  assert.equal(fixed(-0), '0.00');
  assert.equal(fixed(-0.001), '0.00');
  assert.equal(fixed('-0.004'), '0.00');
  assert.equal(fixed('0.000000000000000000000000000001'), '0.00');
  assert.equal(usdc(-0.001), '0.00 USDC');
  assert.equal(signed(-0.001), '0.00');
  assert.equal(signed('0.00001'), '0.00');
  assert.equal(price('0.00001'), '0.0000');
  assert.equal(pct(-0.001), '0.00%');
  assert.deepEqual(pnl(-0), { text: '0.00', tone: 'zero' });
  assert.deepEqual(pnl(-0.004), { text: '0.00', tone: 'zero' });
  assert.deepEqual(pnl('0.00001'), { text: '0.00', tone: 'zero' });
  assert.deepEqual(pnl('0.000'), { text: '0.00', tone: 'zero' });
});

test('each rounding helper rounds small positive and negative values', () => {
  assert.equal(fixed('0.004321'), '0.00');
  assert.equal(fixed('-0.004321'), '0.00');
  assert.equal(signed('0.004321'), '0.00');
  assert.equal(signed('-0.004321'), '0.00');
  assert.equal(usdc('0.004'), '0.00 USDC');
  assert.equal(usdc('-0.004'), '0.00 USDC');
  assert.deepEqual(pnl('0.004'), {text:'0.00',tone:'zero'});
  assert.deepEqual(pnl('-0.004'), {text:'0.00',tone:'zero'});
  assert.equal(price('0.00001'), '0.0000');
  assert.equal(price('-0.00001'), '0.0000');
  assert.equal(fixed('1e-31'), '0.00');
  assert.equal(fixed('-1e-31'), '0.00');
  assert.equal(signed('1e-30'), '0.00');
  assert.equal(usdc('-1e-30'), '0.00 USDC');
  assert.deepEqual(pnl('-1e-30'), {text:'0.00',tone:'zero'});
  assert.equal(price('1e-30'), '0.0000');
});

test('sub-30-place values round to zero for every rounding helper', () => {
  for (const value of ['4.99e-31', '-4.99e-31', '5e-31', '-5e-31', '9.99e-31', '-9.99e-31']) {
    assert.equal(fixed(value), '0.00');
    assert.equal(signed(value), '0.00');
    assert.equal(usdc(value), '0.00 USDC');
    assert.deepEqual(pnl(value), { text: '0.00', tone: 'zero' });
    assert.equal(price(value), '0.0000');
    assert.equal(pct(value), '0.00%');
  }
});

test('unknown is a dash, never 0', () => {
  for (const unknown of [null, undefined, NaN, Infinity, '', ' ', 'abc', '1,5', {}, []]) {
    assert.equal(fixed(unknown), '—');
    assert.equal(usdc(unknown), '—');
    assert.equal(signed(unknown), '—');
    assert.equal(price(unknown), '—');
    assert.equal(coin(unknown, 'BTC'), '—');
    assert.equal(pct(unknown), '—');
    assert.equal(count(unknown), '—');
    assert.deepEqual(pnl(unknown), { text: '—', tone: 'none' });
  }
});

test('pnl: sign, arrow and a true minus; tone follows the displayed value', () => {
  assert.deepEqual(pnl(114.14), { text: '▲ +114.14', tone: 'up' });
  assert.deepEqual(pnl(-669.3), { text: `▼ ${M}669.30`, tone: 'down' });
  assert.deepEqual(pnl('-669.30'), { text: `▼ ${M}669.30`, tone: 'down' });
  assert.deepEqual(pnl(1234.5), { text: '▲ +1,234.50', tone: 'up' });
  assert.deepEqual(pnl(0), { text: '0.00', tone: 'zero' });
  assert.equal(pnl(-0.4, 0).tone, 'zero');
  assert.equal(pnl(0.006).text, '▲ +0.01');
});

test('price: 0 decimals from 1,000, 2 from 10, 4 below 10', () => {
  assert.equal(price(67128.4), '67,128');
  assert.equal(price(1000), '1,000');
  assert.equal(price(616.48), '616.48');
  assert.equal(price(10), '10.00');
  assert.equal(price(0.98789), '0.9879');
  assert.equal(price('0.98789'), '0.9879');
  assert.equal(price(2.5), '2.5000');
});

test('coin: 6 significant digits at most, trailing zeros removed, no 18 decimals', () => {
  assert.equal(coin('0.016245819000000000', 'BTC'), '0.016246 BTC');
  assert.equal(coin('1390.563200000000000000', 'XRP'), '1,390.56 XRP');
  assert.equal(coin(1390.5632, 'XRP'), '1,390.56 XRP');
  assert.equal(coin('2.50000', 'ETH'), '2.5 ETH');
  assert.equal(coin('100.000000', 'SOL'), '100 SOL');
  assert.equal(coin(1234567.891, 'XRP'), '1,234,568 XRP');
  assert.equal(coin('0.00000049'), '0');
  assert.equal(coin('-0.5', 'BTC'), `${M}0.5 BTC`);
  assert.equal(coin(0), '0');
  assert.equal(coin(1.5), '1.5');
});

test('quantity: coin() digits, but a non-zero amount is never shown as 0, never in exponent form', () => {
  // Trailing zeros removed, 6 significant digits from 1 up, 6 decimals below 1 (the same as coin()).
  assert.equal(quantity('0.016245819000000000', 'BTC'), '0.016246 BTC');
  assert.equal(quantity('0.016200000000000000', 'BTC'), '0.0162 BTC');
  assert.equal(quantity('1390.563200000000000000', 'XRP'), '1,390.56 XRP');
  assert.equal(quantity('100.000000', 'SOL'), '100 SOL');
  assert.equal(quantity('2.50000'), '2.5');
  // Large values keep every integer digit.
  assert.equal(quantity('1234567.891', 'XRP'), '1,234,568 XRP');
  assert.equal(quantity('98765432100.5', 'DOGE'), '98,765,432,101 DOGE');
  // Tiny values keep three significant digits within 8 decimals, in plain digits.
  assert.equal(quantity('0.00000001', 'BTC'), '0.00000001 BTC');
  assert.equal(quantity('0.00000049', 'BTC'), '0.00000049 BTC');
  assert.equal(quantity('0.0000012345678', 'BTC'), '0.00000123 BTC');
  assert.equal(quantity('0.0000016', 'BNB'), '0.0000016 BNB');
  assert.equal(quantity('0.00123456'), '0.001235');
  // Under 0.00000001 it is bounded, never 0 and never more than 8 decimals.
  assert.equal(quantity('0.000000007317', 'BTC'), '< 0.00000001 BTC');
  assert.equal(quantity('0.000000000000000001', 'BNB'), '< 0.00000001 BNB');
  assert.equal(quantity('0.00000000000000000049', 'BTC'), '< 0.00000001 BTC');
  assert.equal(quantity(4.9e-19, 'BTC'), '< 0.00000001 BTC');
  assert.equal(quantity('4.9e-7'), '0.00000049');
  // Rounding up to a whole number stays a whole number.
  assert.equal(quantity('0.9999996'), '1');
  // Negative uses the true minus, and a non-zero negative is never "-0".
  assert.equal(quantity('-0.5', 'BTC'), `${M}0.5 BTC`);
  assert.equal(quantity('-0.00000001', 'BTC'), `${M}0.00000001 BTC`);
  assert.equal(quantity('-0.000000000001', 'BTC'), `> ${M}0.00000001 BTC`);
  assert.equal(quantity('-1390.5632', 'XRP'), `${M}1,390.56 XRP`);
  // Zero is 0 in any spelling; unknown is a dash, never 0.
  assert.equal(quantity('0.000000000000000000', 'BTC'), '0 BTC');
  assert.equal(quantity(0), '0');
  assert.equal(quantity(null), '—');
  assert.equal(quantity('not a number', 'BTC'), '—');
  // coin() is unchanged: dust below 6 decimals stays "0" there.
  assert.equal(coin('0.00000049'), '0');
});

test('quantity owner display carries the exact owner decimal for the hover title', () => {
  assert.deepEqual(format.ownerDisplay('0.016245819000000000', 'quantity', { unit: 'BTC' }), { text: '0.016246 BTC', exact: '0.016245819000000000', tone: 'up' });
  assert.deepEqual(format.ownerDisplay('0.00000001', 'quantity', { unit: 'BTC' }), { text: '0.00000001 BTC', exact: '0.00000001', tone: 'up' });
  assert.deepEqual(format.ownerDisplay('0.000000007317', 'quantity', { unit: 'BTC' }), { text: '< 0.00000001 BTC', exact: '0.000000007317', tone: 'up' });
  assert.equal(format.ownerDisplay('0.016245819', 'quantity', { unit: 'BTC' }).exact, '0.016245819');
  assert.equal(format.ownerDisplay('34.41737209677040000000000001', 'quantity', { unit: 'SOL' }).exact, '≈ 34.41737209677 (rounded)');
  assert.deepEqual(format.ownerDisplay(null, 'quantity', { unit: 'BTC' }), { text: '—', exact: null, tone: 'none' });
});

test('quantity hover title is exact up to 12 fractional places and approximate above, down to "≈ 0 (rounded)"', () => {
  assert.equal(format.ownerTitleText('0.016245819000000000'), '0.016245819000000000');
  assert.equal(format.ownerTitleText('0.000000007317'), '0.000000007317');
  assert.equal(format.ownerTitleText('0.0000000000005'), '≈ 0.000000000001 (rounded)');
  assert.equal(format.ownerTitleText('0.00000000000049'), '≈ 0 (rounded)');
  assert.equal(format.ownerDisplay('-0.00000000000049', 'quantity', { unit: 'BTC' }).exact, '≈ 0 (rounded)');
  assert.equal(quantity('-0.00000000000049', 'BTC'), `> ${M}0.00000001 BTC`);
});

test('pct: signed with a true minus and a single percent sign; count: integers with separators', () => {
  assert.equal(pct(1.4512), '+1.45%');
  assert.equal(pct(-1.45), `${M}1.45%`);
  assert.equal(pct(0), '0.00%');
  assert.equal(pct(-9.23, 1), `${M}9.2%`);
  assert.equal(pct('12.345'), '+12.35%');
  assert.equal(signed(2.34, 1), '+2.3');
  assert.equal(signed(-3.04, 1), `${M}3.0`);
  assert.equal(count(200000), '200,000');
  assert.equal(count('1234567'), '1,234,567');
  assert.equal(count(0), '0');
  assert.equal(count(2.6), '3');
});

test('utc: "14 Nov 11:34:22 UTC", the year only when it is not the current UTC year', () => {
  const now = base + 24_000;
  assert.equal(utc(base, now), '14 Nov 11:34:22 UTC');
  assert.equal(utcMin(base, now), '14 Nov 11:34 UTC');
  assert.equal(utc(Date.UTC(2025, 11, 1, 0, 5, 9), now), '1 Dec 2025 00:05:09 UTC');
  assert.equal(utcMin(Date.UTC(2025, 11, 1, 0, 5, 9), now), '1 Dec 2025 00:05 UTC');
  assert.equal(utc(Date.UTC(2026, 0, 31, 23, 59, 59), now), '31 Jan 23:59:59 UTC');
});

test('times that are not representable are null, so callers keep their own words', () => {
  for (const bad of [null, undefined, NaN, Infinity, '2026-11-14', 9e15, {}]) {
    assert.equal(utc(bad, base), null);
    assert.equal(utcMin(bad, base), null);
    assert.equal(when(bad, base), null);
  }
});

test('age: s under 2 min, min under 2 h, then h and min, then d and h', () => {
  assert.equal(age(0), '0 s');
  assert.equal(age(24), '24 s');
  assert.equal(age(119.9), '119 s');
  assert.equal(age(120), '2 min');
  assert.equal(age(180), '3 min');
  assert.equal(age(7199), '119 min');
  assert.equal(age(7200), '2 h');
  assert.equal(age(11_400), '3 h 10 min');
  assert.equal(age(172_799), '47 h 59 min');
  assert.equal(age(172_800), '2 d');
  assert.equal(age(3 * 86_400 + 19 * 3600), '3 d 19 h');
  assert.equal(age(-5), '0 s');
  assert.equal(age(null), '—');
  assert.equal(age(NaN), '—');
  assert.equal(age('24'), '—');
});

test('when: time and age together', () => {
  assert.equal(when(base, base + 24_000), '14 Nov 11:34:22 UTC · 24 s ago');
  assert.equal(when(base, base + 11_400_000), '14 Nov 11:34:22 UTC · 3 h 10 min ago');
});

test('exact decimals through exponent text, dust and price buckets (Sol R1)', () => {
  // Exponent text is expanded as digits, never through a float.
  assert.equal(fixed('1.004999999999999999999999999999e0'), '1.00');
  assert.equal(fixed('1.005e0'), '1.01');
  assert.equal(fixed('1.5e3'), '1,500.00');
  assert.equal(fixed('1e999'), '—');
  assert.equal(coin('0.00000000000000000049', 'BTC'), '0 BTC');
  assert.equal(coin('0.000000000000000999', 'BTC'), '0 BTC');
  assert.equal(coin('0.016245819000000000', 'BTC'), '0.016246 BTC');
  // The price bucket comes from the integer digits exactly.
  assert.equal(price('999.999999999999999999999999999999'), '1,000.00');
  assert.equal(price('1000'), '1,000');
  assert.equal(price('606.0664533048061761145551148'), '606.07');
  // Owner decimal strings stay exact all the way to the display (Money passes the strings, not Number()).
  assert.equal(pnl('1.004999999999999999999999999999').text, '▲ +1.00');
  assert.equal(fixed('36.35232624569440000000000003'), '36.35');
});

test('numbers and the same decimal strings format identically, including exponent-form dust (Sol R2)', () => {
  for (const [number, text] of [[4.9e-21, '4.9e-21'], [1.234e-19, '1.234e-19'], [-3.5e-7, '-3.5e-7'], [0.016245819, '0.016245819'], [1390.5632, '1390.5632']]) {
    assert.equal(coin(number, 'BTC'), coin(text, 'BTC'), String(number));
  }
  assert.equal(coin(4.9e-21, 'BTC'), '0 BTC');
  assert.equal(coin(1.234e-19, 'BTC'), '0 BTC');
  assert.equal(fixed(-3.5e-7, 8), '−0.00000035');
});
