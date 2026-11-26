import test from 'node:test';
import assert from 'node:assert/strict';
import {redactCredentialShapes, redactCredentialShapesWithPaths} from '../dist/src/security.js';

/**
 * R2.5 package r25-approval-fields, the review of 2026-11-26 (S3-3): what a person reads and approves hides the opaque credential shapes that no word
 * around them names (a signed token, an AWS access key, a Google refresh token) and a phone number in a phone-named field, which the display of a
 * review's request and before-state, and the rows of an approval, showed whole. The credential view of Ruling 10 (what saved queries and settings are
 * refused for) is not widened. Synthetic values only.
 */
const jwt =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const aws = 'AKIAIOSFODNN7EXAMPLE';
const refresh = '1//0gAbCdEfGhIjKlMnOpQrStUvWxYz-0123456789';
const shown = value => redactCredentialShapesWithPaths(value);

test('a signed token (JWT) in ordinary text is hidden, and its path is listed', () => {
  const out = shown({note: 'use ' + jwt + ' for the call', other: 'plain'});
  assert.equal(out.value.note, 'use [REDACTED] for the call');
  assert.equal(out.value.other, 'plain');
  assert.deepEqual(out.redacted, [{path: '$["note"]'}]);
});

test('an AWS access key id is hidden, in every prefix an access key has', () => {
  for (const key of [aws, 'ASIAIOSFODNN7EXAMPLE'])
    assert.equal(shown({text: 'key ' + key + ' here'}).value.text, 'key [REDACTED] here', key);
});

test('a Google refresh token (1//) is hidden', () => {
  const out = shown({text: refresh, list: ['x ' + refresh]});
  assert.equal(out.value.text, '[REDACTED]');
  assert.equal(out.value.list[0], 'x [REDACTED]');
  assert.deepEqual(out.redacted, [{path: '$["text"]'}, {path: '$["list"][0]'}]);
});

test('a phone number in a phone-named field is hidden, in the local formats and the international one', () => {
  for (const [key, value] of [
    ['phone', '0501234567'],
    ['mobile', '050 123 4567'],
    ['phone_number', '(050) 123-4567'],
    ['phoneNumber', '+966 50 123 4567'],
    ['telephone', '050.123.4567'],
    ['msisdn', 966501234567],
  ]) {
    const out = shown({[key]: value, keep: 'x'});
    assert.equal(out.value[key], '[personal data]', key);
    assert.equal(out.value.keep, 'x');
    assert.deepEqual(out.redacted, [{path: '$["' + key + '"]'}], key);
  }
});

test('what is not a credential or a phone number is shown whole: a word like a prefix, a phone-named field that holds a word, a number in another field', () => {
  const same = {
    campaign: 'AKIA sale and 1//2 offers and eyJ words',
    phone_type: 'MOBILE',
    phone: 'call us',
    mobile: '12345',
    budget: '0501234567',
    nested: {phone_verified: true, tel_count: 3},
  };
  assert.deepEqual(shown(same).value, same);
  assert.deepEqual(shown(same).redacted, []);
});

test('the credential view of saved queries and settings is not widened to them', () => {
  const value = {a: jwt, b: aws, c: refresh, phone: '0501234567'};
  assert.deepEqual(redactCredentialShapes(value), value);
});
