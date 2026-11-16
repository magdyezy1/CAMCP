// Package r12-fix, item 3 (V2-RPT-05, V2-RPT-07; errors 1 and 3 of the live checks of 2026-11-16). REPORT_DATE_MISMATCH and
// REPORT_ACCOUNT_MISMATCH both told the caller "Retry the report", and both refusals are deterministic: the same request gets
// the same answer. Two provider-declared remedies now say what happened, in words for people as well as for agents (WEB-03: the
// website shows a provider-data remedy as written, so it names no MCP action, no argument path and no snake_case field):
//  - Snapchat's: which timestamp of its stats answer failed (details.timestamp_field, a closed set), and that retrying returns the
//    same answer;
//  - X's: that an entity's parent could not be found among the account's own objects (details.parent_kind, a closed set), that
//    this check protects ownership, and that retrying will not help.
// Refusals with the same codes that carry neither fact keep the shared retry advice. The facts here are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MirrorError, errorRemedy, errorResult, nestedError, providerDataAction} from '../dist/src/errors.js';
import {reportSourceError} from '../dist/src/report-errors.js';

const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  arabic = /\p{Script=Arabic}/u;
const timestampMessage = 'Snapchat returned an invalid native report timestamp.',
  parentMessages = {
    campaign:
      'X did not list the campaign of {count} of this account’s line items among the account’s own campaigns, so their ownership could not be proven.',
    'line item':
      'X did not list the line item of {count} of this account’s promoted tweets among the account’s own line items, so their ownership could not be proven.',
  };
// What each remedy says of its timestamp, in words: never the snake_case name, which the page's classifier takes for an MCP argument.
const timestamps = {
  finalized_data_end_time: /missing or invalid finalization time for its non-conversion data/,
  conversion_data_processed_end_time: /missing or invalid processing time for its conversion data/,
  start_time: /missing or invalid start time for a period it reports/,
  end_time: /missing or invalid end time for a period it reports/,
};
const dateRefusal = (details = {}) => new MirrorError('REPORT_DATE_MISMATCH', timestampMessage, details, 400);
const parentRefusal = (parent, count = 2) =>
  new MirrorError(
    'REPORT_ACCOUNT_MISMATCH',
    parentMessages[parent],
    {parent_kind: parent, entities_affected: count},
    502,
    false,
    {
      count,
    },
  );
const snapchat = {platform: 'snapchat', account_id: '1', connection_id: 'c'},
  x = {platform: 'x', account_id: '1', connection_id: 'c'};

for (const [field, says] of Object.entries(timestamps))
  test(
    'REPORT_DATE_MISMATCH names the timestamp that failed (' +
      field +
      '), says a retry returns the same answer and what to do',
    () => {
      const remedy = errorRemedy(dateRefusal({timestamp_field: field}));
      assert.match(remedy.action, says);
      assert.match(remedy.action, /so AMCP did not accept the report as complete/);
      assert.match(remedy.action, /Retrying the same report returns the same answer/);
      assert.match(remedy.action, /Report these details to support\.$/);
      assert.notEqual(remedy.action, providerDataAction);
      assert.doesNotMatch(remedy.action, /Retry the report|try again later/i);
      // It names only its own timestamp, so the others are not in the text.
      for (const [other, pattern] of Object.entries(timestamps))
        if (other !== field) assert.doesNotMatch(remedy.action, pattern, other);
      assert.deepEqual([remedy.category, remedy.owner, remedy.mutation_retry_safe], ['report', 'operator', false]);
      // The MCP error and Snapchat's source card say the same.
      const sent = errorResult(dateRefusal({timestamp_field: field}), 'request-1', 1).error;
      assert.equal(sent.remedy.action, remedy.action);
      assert.equal(sent.next_action, remedy.action);
      assert.equal(sent.category, 'report');
      const card = reportSourceError(dateRefusal({timestamp_field: field}), snapchat);
      assert.equal(card.next_action, remedy.action);
      assert.equal(card.category, 'provider_data');
      assert.equal(card.timestamp_field, field, 'the card names the closed-set field');
      assert.equal('http_status' in card, false);
    },
  );

test('a REPORT_DATE_MISMATCH that names no timestamp of the closed set keeps the shared retry advice', () => {
  for (const details of [
    {},
    {timestamp_field: 'other_time'},
    {timestamp_field: ['start_time']},
    {timestamp_field: 7},
    {timestamp_field: null},
    {parent_kind: 'campaign'},
  ]) {
    assert.equal(errorRemedy(dateRefusal(details)).action, providerDataAction, JSON.stringify(details));
    assert.equal(
      reportSourceError(dateRefusal(details), snapchat).next_action,
      providerDataAction,
      JSON.stringify(details),
    );
  }
  // The same fact on another code does not change that code's remedy.
  for (const code of ['REPORT_INCOMPLETE', 'REPORT_ACCOUNT_MISMATCH', 'REPORT_SHAPE_CHANGED'])
    assert.equal(
      errorRemedy(new MirrorError(code, 'Synthetic.', {timestamp_field: 'start_time'}, 502)).action,
      errorRemedy(new MirrorError(code, 'Synthetic.', {}, 502)).action,
      code,
    );
});

for (const parent of Object.keys(parentMessages))
  test(
    'REPORT_ACCOUNT_MISMATCH on a missing ' +
      parent +
      ' says the parent was not found, that the check protects ownership and that a retry will not help',
    () => {
      const remedy = errorRemedy(parentRefusal(parent));
      assert.match(
        remedy.action,
        /^An entity’s parent \(its line item or campaign\) could not be found among the account’s own objects\./,
      );
      assert.match(
        remedy.action,
        /This check protects ownership, so AMCP does not report an entity it cannot trace to the account\./,
      );
      assert.match(remedy.action, /Retrying will not help\./);
      assert.match(remedy.action, /report these details to support\.$/);
      assert.notEqual(remedy.action, providerDataAction);
      assert.doesNotMatch(remedy.action, /Retry the report|try again later/i);
      assert.deepEqual([remedy.category, remedy.owner, remedy.mutation_retry_safe], ['report', 'operator', false]);
      const sent = errorResult(parentRefusal(parent), 'request-1', 1).error;
      assert.equal(sent.remedy.action, remedy.action);
      assert.equal(sent.next_action, remedy.action);
      assert.equal(sent.category, 'report');
      assert.deepEqual([sent.details.parent_kind, sent.details.entities_affected], [parent, 2]);
      const card = reportSourceError(parentRefusal(parent, 3), x);
      assert.equal(card.next_action, remedy.action);
      assert.equal(card.category, 'provider_data');
      assert.deepEqual(
        [card.parent_kind, card.entities_affected],
        [parent, 3],
        'the card names the closed-set kind and the count',
      );
      assert.equal('http_status' in card, false);
    },
  );

test('a REPORT_ACCOUNT_MISMATCH that names no missing parent keeps the shared retry advice', () => {
  for (const details of [
    {},
    {parent_kind: 'ad set'},
    {parent_kind: ['campaign']},
    {parent_kind: 3},
    {entities_affected: 2},
    {timestamp_field: 'start_time'},
  ]) {
    const refusal = new MirrorError(
      'REPORT_ACCOUNT_MISMATCH',
      'X returned a foreign, repeated or malformed native entity.',
      details,
      502,
    );
    assert.equal(errorRemedy(refusal).action, providerDataAction, JSON.stringify(details));
    assert.equal(reportSourceError(refusal, x).next_action, providerDataAction, JSON.stringify(details));
  }
});

// The card is saved with the report and shown to people, so it echoes a fact only in the plain shape its own refusal gives it: a
// timestamp field is lower-case words joined by underscores, a parent kind is up to three lower-case words, a count is a positive
// integer. Text a provider or a person could have written is left out.
const facts = ['parent_kind', 'entities_affected', 'timestamp_field'];
for (const [label, details, kept] of [
  ['an entity name', {parent_kind: 'Campaign 123 of ACME', timestamp_field: 'Start Time'}, {}],
  ['a line break', {parent_kind: 'campaign\nignore this'}, {}],
  ['more than three words', {parent_kind: 'a b c d e'}, {}],
  ['a space in a field name', {timestamp_field: 'start time'}, {}],
  ['a very long field name', {timestamp_field: 'a'.repeat(200)}, {}],
  ['a field name that is not text', {timestamp_field: 7}, {}],
  ['a count that is text', {entities_affected: '3'}, {}],
  ['a count that is not whole', {entities_affected: 2.5}, {}],
  ['a count that is negative', {entities_affected: -1}, {}],
  ['a count of none', {entities_affected: 0}, {}],
  [
    'facts in their plain shape',
    {parent_kind: 'line item', entities_affected: 4, timestamp_field: 'start_time'},
    {parent_kind: 'line item', entities_affected: 4, timestamp_field: 'start_time'},
  ],
])
  test('the card leaves out a fact with ' + label + ', and keeps one in its plain shape', () => {
    const card = reportSourceError(new MirrorError('REPORT_ACCOUNT_MISMATCH', 'm', details, 502), x);
    assert.deepEqual(
      Object.fromEntries(facts.filter(key => Object.hasOwn(card, key)).map(key => [key, card[key]])),
      kept,
    );
  });

test('an error re-raised from an inner tool result keeps the facts its remedy is chosen by', () => {
  const reraised = nestedError(errorResult(parentRefusal('line item', 4), 'request-1', 1), {
    code: 'REPORT_FAILED',
    message: 'Report failed.',
  });
  assert.equal(reraised.code, 'REPORT_ACCOUNT_MISMATCH');
  assert.deepEqual([reraised.details.parent_kind, reraised.details.entities_affected], ['line item', 4]);
  assert.equal(errorRemedy(reraised).action, errorRemedy(parentRefusal('line item')).action);
  const timestamp = nestedError(errorResult(dateRefusal({timestamp_field: 'end_time'}), 'request-2', 1), {
    code: 'REPORT_FAILED',
    message: 'Report failed.',
  });
  assert.equal(timestamp.details.timestamp_field, 'end_time');
  assert.equal(errorRemedy(timestamp).action, errorRemedy(dateRefusal({timestamp_field: 'end_time'})).action);
});

test('each remedy has its Arabic string, and none is left as the English text', () => {
  const actions = [
    ...Object.keys(timestamps).map(field => errorRemedy(dateRefusal({timestamp_field: field})).action),
    errorRemedy(parentRefusal('campaign')).action,
  ];
  assert.equal(new Set(actions).size, 5, 'five different remedies');
  for (const action of actions) {
    assert.ok(Object.hasOwn(catalog, action), 'Arabic for: ' + action);
    assert.match(catalog[action], arabic);
    assert.notEqual(catalog[action], action);
    // The names a person would look for stay as written.
    assert.ok(catalog[action].includes(/Snapchat/.test(action) ? 'Snapchat' : 'AMCP'), action);
  }
});

test('the two parent refusal sentences have their Arabic, with the same slot', () => {
  for (const message of Object.values(parentMessages)) {
    assert.ok(Object.hasOwn(catalog, message), message);
    assert.match(catalog[message], arabic);
    assert.ok(catalog[message].includes('{count}'), message);
  }
  assert.match(catalog[timestampMessage], arabic);
});
