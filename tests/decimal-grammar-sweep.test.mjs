// QA-02 property sweep (hand-rolled, no dependency) of the provider decimal grammar (src/provider-decimal.ts, owner
// decision D10: nine places, half to even). Provider fakes used to send only the implementation's preferred grammar;
// this sweep feeds what vendor contracts declare instead: JSON doubles in their shortest round-trip text (long
// fractions, exponent form), long decimal strings and exact ties. The oracle is an independent string-arithmetic
// rounding, not the production BigInt code. Malformed values are refused by name, never accepted or crashed on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProviderDecimal, providerDecimalText} from '../dist/src/provider-decimal.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {providerDoubles} from './helpers/contract-fakes.mjs';

/** Nine-place half-to-even rounding of a decimal text by digit-string arithmetic. */
export function referenceNine(text) {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  assert.ok(m, 'reference grammar: ' + text);
  let digits = m[1] + (m[2] ?? ''),
    point = m[1].length + Number(m[3] ?? 0);
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const whole = digits.slice(0, point) || '0',
    fraction = digits.slice(point),
    rest = fraction.slice(9);
  let scaled = BigInt(whole + fraction.slice(0, 9).padEnd(9, '0'));
  const rounded = /[1-9]/.test(rest);
  if (rounded && (rest[0] > '5' || (rest[0] === '5' && (/[1-9]/.test(rest.slice(1)) || scaled % 2n === 1n))))
    scaled += 1n;
  return {scaled, rounded};
}

/** Deterministic values: doubles with long fractions, exponent forms, exact ties and long decimal strings. */
function* sweepValues() {
  yield* providerDoubles.map(v => v.value);
  for (let i = 1; i <= 400; i++) {
    yield i / 7;
    yield i / 3;
    yield i / 1e9;
    yield i * 1e-12;
    yield 1 / i;
    yield Math.PI * i * 1000;
    yield (i * 0.1 + 0.2) / 10;
    // Exact ties at the tenth place, after an even and an odd ninth digit.
    yield i + '.00000000' + (i % 10) + '5';
    yield String(i) + '.' + '1'.repeat(25);
    yield i + 'e-' + ((i % 15) + 1);
  }
}

test('provider values round half to even at nine places exactly as digit arithmetic does, in every form', () => {
  let n = 0;
  for (const value of sweepValues()) {
    n++;
    const text = String(value);
    assert.deepEqual(parseProviderDecimal(value, {field: 'conversions'}), referenceNine(text), text);
  }
  assert.ok(n >= 4000, 'values swept: ' + n);
});

test('the shared double generator states the nine-place value each provider double must give', () => {
  for (const {value, nine, rounded} of providerDoubles) {
    const parsed = parseProviderDecimal(value, {field: 'conversions'});
    assert.equal(parsed.scaled, BigInt(nine.replace('.', '')), String(value));
    assert.equal(parsed.rounded, rounded, String(value));
  }
});

test('display-only values keep the exact provider text of exponent forms', () => {
  assert.equal(providerDecimalText(1e-7, {field: 'frequency'}), '0.0000001');
  assert.equal(providerDecimalText('2.5e3', {field: 'reach'}), '2500');
  assert.equal(providerDecimalText(0.1 + 0.2, {field: 'frequency'}), '0.30000000000000004');
});

test('malformed and negative provider values are refused by name, never accepted', () => {
  const malformed = [-1, -1e-7, NaN, Infinity, '-0.5', '1e', '.5', '1.', '+1', ' 1', '0x10', '1,5', '1e1234', '', null];
  for (const value of malformed)
    assertRefused(
      (() => {
        try {
          return {success: true, data: parseProviderDecimal(value, {field: 'conversions'})};
        } catch (e) {
          return e;
        }
      })(),
      'REPORT_SHAPE_CHANGED',
    );
  assertRefused(
    (() => {
      try {
        return {success: true, data: parseProviderDecimal(2 ** 60, {field: 'impressions'})};
      } catch (e) {
        return e;
      }
    })(),
    'METRIC_PRECISION_LOSS',
  );
});
