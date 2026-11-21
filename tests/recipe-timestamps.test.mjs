// R2.5 field3 fix round, package r25-field3-recipes (the lead's review S3-4, from the live checks of M4a): the schedule inputs of the recipes have a declared
// format and one reader. Every timestamp check required seconds and an offset, so "2026-11-22T10:00" and "2026-11-22T10:00:00" were refused with no
// word on why (Meta's and Snapchat's refusals did not even name the field), while `recipe_context` said nothing of the format. Four copies of the check
// (Snapchat, TikTok, LinkedIn, Meta) and two of the date check (the Search recipes, Performance Max) are one reader now. Synthetic briefs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeDateInput, recipeTimestamp, recipeTimestampInput} from '../dist/src/recipe-values.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {pinBeforeTiktokCutoff} from './helpers/tiktok-cutoff-clock.mjs';
import {recipeBriefs} from './fixtures/recipe-briefs.mjs';

const stamp = recipeTimestampInput,
  day = recipeDateInput;
const invalidAs = (fn, field, type, format, message) =>
  assert.throws(
    fn,
    e =>
      assertRefused(e, 'RECIPE_DATE_INVALID') &&
      JSON.stringify(Object.keys(e.details).sort()) === JSON.stringify(['field', 'format', 'received_type']) &&
      e.details.field === field &&
      e.details.received_type === type &&
      e.details.format === format &&
      (message === undefined || e.message === message),
  );
const wrongTypes = [
  [5, 'number'],
  [true, 'boolean'],
  [null, 'null'],
  [[], 'array'],
  [{}, 'object'],
];

test('the two specs say their type and their format, and a caller cannot change them', () => {
  assert.deepEqual({...stamp}, {type: 'timestamp', format: 'YYYY-MM-DDTHH:MM:SS±HH:MM'});
  assert.deepEqual({...day}, {type: 'date', format: 'YYYY-MM-DD'});
  assert.ok(Object.isFrozen(stamp) && Object.isFrozen(day));
});

test('a timestamp is RFC 3339 with seconds and an offset: Z, an offset and up to three digits of fraction name the instant, and the text is kept', () => {
  const read = given => recipeTimestamp({t: given}, 't', stamp);
  assert.deepEqual(read('2026-11-22T10:00:00Z'), {value: '2026-11-22T10:00:00Z', time: Date.UTC(2026, 10, 22, 10)});
  assert.equal(read('2026-11-22T10:00:00+03:00').time, Date.UTC(2026, 10, 22, 7));
  assert.equal(read('2026-11-22T10:00:00-05:30').time, Date.UTC(2026, 10, 22, 15, 30));
  assert.equal(read('2026-11-22T10:00:00.250Z').time, Date.UTC(2026, 10, 22, 10, 0, 0, 250));
  assert.equal(read('2028-02-29T23:59:59Z').value, '2028-02-29T23:59:59Z', 'a leap day');
});

test('a timestamp that lacks seconds or an offset, or names no real instant, is RECIPE_DATE_INVALID naming the field, the type received and the format', () => {
  for (const given of [
    '2026-11-22T10:00', // no seconds, no offset: the case of the live check
    '2026-11-22T10:00:00', // no offset
    '2026-11-22T10:00+03:00', // no seconds
    '2026-11-22 10:00:00Z',
    '2026-11-22T24:00:00Z',
    '2026-11-22T10:60:00Z',
    '2026-11-22T10:00:60Z',
    '2026-02-30T10:00:00Z',
    '2027-02-29T10:00:00Z',
    '2026-11-22T10:00:00.1234Z',
    '2026-11-22T10:00:00+3:00',
    ' 2026-11-22T10:00:00Z',
    '2026-11-22T10:00:00Z ',
    '22-11-2026T10:00:00Z',
    '2026-11-22',
    'tomorrow',
  ])
    invalidAs(
      () => recipeTimestamp({t: given}, 't', stamp),
      't',
      'string',
      stamp.format,
      'Use a valid timestamp with an explicit UTC offset.',
    );
  for (const [given, type] of wrongTypes)
    invalidAs(() => recipeTimestamp({t: given}, 't', stamp), 't', type, stamp.format);
});

test('a date is YYYY-MM-DD, a day that exists, and a refusal says the format', () => {
  const read = given => recipeTimestamp({d: given}, 'd', day);
  assert.deepEqual(read('2026-11-22'), {value: '2026-11-22', time: Date.UTC(2026, 10, 22)});
  assert.equal(read('2028-02-29').value, '2028-02-29');
  for (const given of [
    '2026-11-22T10:00:00Z',
    '2026-13-01',
    '2026-02-30',
    '2027-02-29',
    '22-11-2026',
    '2026-1-5',
    '2026-11-22 ',
    '20261122',
  ])
    invalidAs(
      () => read(given),
      'd',
      'string',
      day.format,
      'Use valid YYYY-MM-DD dates in the advertising account timezone.',
    );
  for (const [given, type] of wrongTypes) invalidAs(() => read(given), 'd', type, day.format);
});

test('left out or blank is no input when the input is optional, and required when it is not', () => {
  for (const spec of [stamp, day]) {
    assert.equal(recipeTimestamp({}, 'k', spec, true), undefined);
    assert.equal(recipeTimestamp({k: ''}, 'k', spec, true), undefined);
    for (const brief of [{}, {k: ''}])
      assert.throws(
        () => recipeTimestamp(brief, 'k', spec),
        e => assertRefused(e, 'RECIPE_INPUT_REQUIRED') && JSON.stringify(e.details.missing_fields) === '["k"]',
      );
  }
});

// The schedule of each recipe: the input, its type, and what the recipe's own sentences say of an end that does not follow its start.
const schedules = {
  google_search: ['date', ['start_date', 'end_date']],
  google_search_clicks: ['date', ['start_date', 'end_date']],
  google_search_conversions: ['date', ['start_date', 'end_date']],
  google_search_target_cpa: ['date', ['start_date', 'end_date']],
  google_search_conversion_value: ['date', ['start_date', 'end_date']],
  google_search_target_roas: ['date', ['start_date', 'end_date']],
  google_performance_max: ['date', ['start_date', 'end_date']],
  microsoft_search: ['date', ['start_date', 'end_date']],
  meta_website_traffic: ['timestamp', ['start_time', 'end_time']],
  meta_website_sales: ['timestamp', ['start_time', 'end_time']],
  meta_website_leads: ['timestamp', ['start_time', 'end_time']],
  snapchat_website_traffic: ['timestamp', ['start_time', 'end_time']],
  snapchat_lead_generation: ['timestamp', ['start_time', 'end_time']],
  linkedin_lead_generation: ['timestamp', ['start_time', 'end_time']],
  tiktok_website_traffic: ['timestamp', ['start_time', 'end_time']],
  tiktok_website_conversions: ['timestamp', ['start_time', 'end_time']],
  tiktok_search_traffic: ['timestamp', ['start_time', 'end_time']],
  tiktok_smart_plus_website_traffic: ['timestamp', ['start_time']],
  tiktok_smart_plus_website_conversions: ['timestamp', ['start_time']],
  tiktok_smart_plus_search_website: ['timestamp', ['start_time']],
};

test('every recipe declares the schedule it takes, as the one spec of its kind, and names it as an input', () => {
  assert.deepEqual(Object.keys(schedules).sort(), campaignRecipes.map(r => r.id).sort());
  for (const definition of campaignRecipes) {
    const [type, keys] = schedules[definition.id],
      declared = Object.entries(definition.inputs)
        .filter(([, spec]) => spec.type === 'timestamp' || spec.type === 'date')
        .map(([key]) => key);
    assert.deepEqual(declared, keys, definition.id);
    for (const key of keys) {
      assert.equal(definition.inputs[key].type, type, definition.id + '.' + key);
      assert.equal(
        definition.inputs[key].format,
        type === 'date' ? day.format : stamp.format,
        definition.id + '.' + key,
      );
      assert.ok(
        [...definition.required, ...(definition.optional ?? [])].includes(key),
        definition.id + ' names ' + key,
      );
    }
  }
});

test('a schedule that is not in the format is refused with the field, the type and the format, in every recipe, and Meta and Snapchat name the field now', t => {
  pinBeforeTiktokCutoff(t);
  for (const [id, [type, keys]] of Object.entries(schedules)) {
    const format = type === 'date' ? day.format : stamp.format;
    for (const key of keys)
      for (const given of type === 'date'
        ? ['2026-11-22T10:00:00Z', '22-11-2026']
        : ['2026-11-22T10:00', '2026-11-22T10:00:00', '2026-11-22T10:00+03:00']) {
        const brief = {...recipeBriefs[id], [key]: given, ...(id.startsWith('google_search') ? {atomic: false} : {})};
        invalidAs(() => campaignRecipe(id, brief), key, 'string', format);
      }
  }
});

test('an end that does not follow its start is refused naming the end, and an end left blank is none', t => {
  pinBeforeTiktokCutoff(t);
  const wrong = {
    date: [
      ['2026-12-01', '2026-11-30'],
      ['2026-12-01', '2026-10-01'],
    ],
    timestamp: [
      ['2026-11-22T10:00:00+03:00', '2026-11-22T10:00:00+03:00'],
      ['2026-11-22T10:00:00+03:00', '2026-11-22T06:00:00Z'],
      ['2026-11-22T10:00:00+03:00', '2026-11-21T10:00:00+03:00'],
    ],
  };
  const later = {
    date: ['2026-12-01', '2027-01-01'],
    timestamp: ['2026-11-22T10:00:00+03:00', '2026-11-23T10:00:00+03:00'],
  };
  for (const [id, [type, keys]] of Object.entries(schedules)) {
    if (keys.length < 2) continue;
    const [startKey, endKey] = keys,
      plain = id.startsWith('google_search') ? {atomic: false} : {};
    for (const [start, end] of wrong[type]) {
      // A date may be equal to its start ("on or after"); an instant may not.
      if (type === 'date' && start === end) continue;
      assert.throws(
        () => campaignRecipe(id, {...recipeBriefs[id], ...plain, [startKey]: start, [endKey]: end}),
        e => assertRefused(e, 'RECIPE_DATE_INVALID') && e.details.field === endKey,
        id + ' ' + start + ' ' + end,
      );
    }
    const [start, end] = later[type];
    assert.ok(campaignRecipe(id, {...recipeBriefs[id], ...plain, [startKey]: start, [endKey]: end}).steps.length, id);
    assert.ok(
      campaignRecipe(id, {...recipeBriefs[id], ...plain, [startKey]: start, [endKey]: ''}).steps.length,
      id + ' blank end',
    );
  }
  // A date that equals its start is allowed: the end is on or after it.
  assert.ok(
    campaignRecipe('google_performance_max', {
      ...recipeBriefs.google_performance_max,
      start_date: '2026-12-01',
      end_date: '2026-12-01',
    }).steps.length,
  );
});
