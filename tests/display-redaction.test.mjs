import test from 'node:test';
import assert from 'node:assert/strict';
import {redactCredentialShapes, redactCredentialShapesWithPaths} from '../dist/src/security.js';
import {scrubPeople} from '../dist/src/personal-data.js';

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

// The second check of 2026-11-26 (S3-A): a number an ad dials is ad content the approver must be able to check, and the display showed it before this package
// (a call asset, a call extension, a call to action, a creative's phone, a WhatsApp number); a number in a person's data is not, and stays hidden.
test('a number an ad dials is shown whole, byte for byte as the display showed it before: a call asset, an extension, a call to action, a creative, WhatsApp', () => {
  for (const request of [
    {operations: [{create: {callAsset: {phoneNumber: '+1 650 555 0100', countryCode: 'US'}}}]},
    {operations: [{create: {call_asset: {phone_number: '(650) 555-0100', country_code: 'US'}}}]},
    {operations: [{create: {business_message_asset: {whatsapp_info: {phone_number: '+16505550100'}}}}]},
    {AdExtensions: [{Type: 'CallAdExtension', PhoneNumber: '+16505550100', CountryCode: 'US'}]},
    {creatives: [{ad_name: 'A', call_to_action_id: '1', phone_number: '0501234567', phone_region_code: 'SA'}]},
    {object_story_spec: {link_data: {call_to_action: {type: 'CALL_NOW', value: {link: 'tel:+16505550100'}}}}},
    {promoted_object: {page_id: '1', whatsapp_number: '+16505550100'}},
  ]) {
    const out = shown(request);
    assert.deepEqual(out.value, request, JSON.stringify(request));
    assert.deepEqual(out.redacted, []);
    assert.equal(JSON.stringify(out.value), JSON.stringify(redactCredentialShapes(request)), 'the display as it was');
  }
});

test('a number in a person’s data stays hidden: a customer list, a lead field, a people field, also where an asset holds them', () => {
  for (const request of [
    {customers: [{phone: '+15551234567'}]},
    {lead: {phone: '0501234567'}},
    {leads: [{phone_number: '050 123 4567'}]},
    {user_identifiers: [{phone_number: '(050) 123-4567'}]},
    {people: {rows: [{mobile: '0501234567'}]}},
    {asset: {lead_form: {answers: {phone: '0501234567'}}}},
    {creative: {contact_phone: '0501234567'}},
  ]) {
    const out = shown(request);
    assert.ok(!/[0-9]/.test(JSON.stringify(out.value)), JSON.stringify(out.value));
    assert.equal(out.redacted.length, 1, JSON.stringify(out.redacted));
  }
});

test('what the people scrub keeps of an ad’s number: scrubPeople given a scope leaves the number an ad dials, and nothing else of a person', () => {
  const ad = {operations: [{create: {callAsset: {phoneNumber: '+16505550100'}}}]},
    person = {lead: {note: 'call +16505550100', mail: 'a@b.co'}},
    mixed = {creative: {phone: '+16505550100', mail: 'a@b.co', hash: 'a'.repeat(64)}};
  assert.deepEqual(scrubPeople(ad, new Set(), 0), ad, 'a number an ad dials is kept');
  assert.equal(
    scrubPeople(ad).operations[0].create.callAsset.phoneNumber,
    '[personal data]',
    'without a scope, as always',
  );
  assert.deepEqual(scrubPeople(person, new Set(), 0), {lead: {note: 'call [personal data]', mail: '[personal data]'}});
  assert.deepEqual(scrubPeople(mixed, new Set(), 0), {
    creative: {phone: '+16505550100', mail: '[personal data]', hash: '[personal data]'},
  });
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
