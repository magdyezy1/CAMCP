// Package r25-m0-live (Round 2.5, item 1: error 2 of the live checks of 2026-11-15). A refusal of amcp_reporting
// capture_preset that is about one key of `semantics` names that key, as the agent wrote it, and says what to put there.
// Before this package an empty `semantics` was refused as "Use valid calendar dates in YYYY-MM-DD format." (no field),
// which cost an agent calls it could not have avoided. Nothing here reaches a provider: every refusal below is made
// before the first request, and the transport fails the test if one is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {dateRange} from '../dist/src/workflows.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  arabic = /[؀-ۿ]/u;
const actor = {tenantId: 'synthetic-preset-refusals', userId: 'reader', role: 'admin'};
function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
  t.after(() => store.close());
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      throw new Error('a refused capture sends no provider request');
    }),
  );
  return {
    requests: () => requests,
    refuse: input => service.call('amcp_reporting', {action: 'capture_preset', ...input}, actor),
  };
}

// A closed window long in the past, so the test does not depend on the day it runs.
const closed = {date_from: '2026-01-01', date_to: '2026-01-07'};
const semantics = more => ({
  source_name: 'Synthetic source',
  currency: 'USD',
  timezone: 'Etc/GMT',
  attribution: 'unknown',
  ...closed,
  ...more,
});
// One preset of each family that shares the preset checks, with the arguments its own checks need to get past them.
const families = [
  {preset: 'google_campaign', account_id: '1234567890'},
  {preset: 'meta_campaign', account_id: '100', result_action_type: 'link_click', attribution_windows: ['1d_click']},
  {preset: 'tiktok_campaign', account_id: '100'},
  {
    preset: 'snapchat_campaign',
    account_id: '11111111-1111-4111-8111-111111111111',
    swipe_up_attribution_window: '28_DAY',
    view_attribution_window: '1_DAY',
  },
  {preset: 'linkedin_campaign', account_id: '100'},
];

// ---- Item 1: INVALID_DATE_RANGE names the field and the format ----

test('an empty semantics is refused as INVALID_DATE_RANGE naming semantics.date_from and the format, for every preset family', async t => {
  for (const family of families) {
    const f = fixture(t),
      result = await f.refuse({...family, semantics: {}}),
      label = family.preset;
    assertRefused(result, 'INVALID_DATE_RANGE', {
      message: /^Set semantics\.date_from to a calendar date written YYYY-MM-DD\.$/,
    });
    assert.deepEqual(result.error.details, {field: 'semantics.date_from'}, label);
    assert.equal(f.requests(), 0, label);
  }
});

test('each date of semantics is named by its own key: the one that is missing, empty, mistyped or not a calendar day', async t => {
  const f = fixture(t),
    family = families[2];
  for (const [semanticsInput, field] of [
    [{date_from: '2026-01-01'}, 'semantics.date_to'],
    [{date_to: '2026-01-07'}, 'semantics.date_from'],
    [{date_from: '', date_to: '2026-01-07'}, 'semantics.date_from'],
    [{date_from: '2026-01-01', date_to: '2026-02-30'}, 'semantics.date_to'],
    [{date_from: '2026-1-1', date_to: '2026-01-07'}, 'semantics.date_from'],
    [{date_from: 20260101, date_to: '2026-01-07'}, 'semantics.date_from'],
    [{date_from: '2026-01-01', date_to: null}, 'semantics.date_to'],
  ]) {
    const result = await f.refuse({...family, semantics: semanticsInput});
    assertRefused(result, 'INVALID_DATE_RANGE', {message: new RegExp('^Set ' + field.replace('.', '\\.') + ' to ')});
    assert.deepEqual(result.error.details, {field}, JSON.stringify(semanticsInput));
  }
  // A semantics that is not an object has no dates either, and is refused the same way.
  assertRefused(await f.refuse({...family, semantics: 'later'}), 'INVALID_DATE_RANGE', {
    message: /semantics\.date_from/,
  });
  assert.equal(f.requests(), 0);
});

test('dates that are valid but in the wrong order name both keys, and are still refused (the order check is kept)', async t => {
  const f = fixture(t);
  for (const family of families) {
    const result = await f.refuse({...family, semantics: semantics({date_from: '2026-01-07', date_to: '2026-01-01'})});
    assertRefused(result, 'INVALID_DATE_RANGE', {
      message: /^semantics\.date_from must not be after semantics\.date_to\.$/,
    });
    assert.deepEqual(result.error.details, {field: 'semantics.date_to'}, family.preset);
  }
  assert.equal(f.requests(), 0);
});

test('the Arabic of the date refusals keeps the field and the format, and the English template stays in the error for the website', async t => {
  const f = fixture(t);
  for (const [semanticsInput, template, values] of [
    [{}, 'Set {field} to a calendar date written YYYY-MM-DD.', {field: 'semantics.date_from'}],
    [
      semantics({date_from: '2026-01-07', date_to: '2026-01-01'}),
      '{from} must not be after {to}.',
      {from: 'semantics.date_from', to: 'semantics.date_to'},
    ],
  ]) {
    const result = await f.refuse({...families[2], semantics: semanticsInput});
    assert.deepEqual(result.error.message_localization, {key: template, values});
    assert.ok(Object.hasOwn(catalog, template), 'Arabic for: ' + template);
    assert.match(catalog[template], arabic);
    for (const slot of template.match(/\{[a-z]+\}/g)) assert.ok(catalog[template].includes(slot), slot);
  }
  assert.ok(catalog['Set {field} to a calendar date written YYYY-MM-DD.'].includes('YYYY-MM-DD'));
});

test('a date_range that is not a preset capture keeps the generic date messages, which name no preset field', () => {
  assert.throws(
    () => dateRange({since: '', until: '2026-01-07'}),
    error => assertRefused(error, 'INVALID_DATE_RANGE', {message: /^Use valid calendar dates in YYYY-MM-DD format\.$/}),
  );
  assert.throws(
    () => dateRange({since: '2026-01-07', until: '2026-01-01'}),
    error => assertRefused(error, 'INVALID_DATE_RANGE', {message: /^since must not be after until\.$/}),
  );
});
