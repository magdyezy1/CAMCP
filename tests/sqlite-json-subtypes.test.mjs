import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {configurationScope, reportRunRow, savedQuery, workbookScheduleRow} from '../dist/src/workbook-repository.js';
import {assetUsage} from '../dist/src/media-library-repository.js';
import {operationsFeedRows} from '../dist/src/operations-feed-repository.js';

/**
 * Package sqlite354 (Node 24.22.3 bundles SQLite 3.54.1). Up to SQLite 3.53 a JSON value that a scalar subquery returned
 * kept its JSON subtype when an enclosing JSON function received it: json_array((SELECT json_group_array(..))) gave
 * [[..]]. From 3.54 it does not, and the same SQL gives ["[..]"], a string, so every statement that nests the result of a
 * scalar subquery wraps it in json(..) (json() keeps the subtype on both). These tests run each such statement on the
 * SQLite of the running Node and read its nested values back: an array or an object where a string would be wrong.
 * Their expectations are the values SQLite 3.53.3 gave before the change, which is what the code that reads them expects.
 */
const tenant = 'json-subtypes';
const fixture = t => {
  const store = new Store(':memory:', Buffer.alloc(32, 54).toString('base64'));
  t.after(() => store.close());
  return store;
};
const version = store => store.sql().prepare('SELECT sqlite_version() AS v').get().v;
/** A retained query configuration whose provider arguments sit in the wrapper's `arguments` (the usual saved form). */
const wrapped = (gateway, args) => ({gateway, arguments: {operation: 'synthetic_operation', arguments: args}});
const scope = (store, config) => JSON.parse(configurationScope(store, config).metadata);

test('the resource selectors of a retained configuration are nested arrays of {kind, value} objects', t => {
  const store = fixture(t),
    property = [{kind: 'property', value: 'properties/100'}];
  for (const [name, config, expected] of [
    ['GA4 property', wrapped('ga4_native_action', {property: 'properties/100', request: {}}), [property]],
    ['GA4 params.property', wrapped('ga4_native_action', {params: {property: 'properties/100'}}), [property]],
    ['GA4 request.property', wrapped('ga4_native_action', {request: {property: 'properties/100'}}), [property]],
    [
      'GA4 name and parent',
      wrapped('ga4_native_action', {name: 'properties/100/reportTasks/t', parent: 'properties/100'}),
      [
        [
          {kind: 'resource', value: 'properties/100/reportTasks/t'},
          {kind: 'resource', value: 'properties/100'},
        ],
      ],
    ],
    [
      'GA4 property that is not text',
      wrapped('ga4_native_action', {property: 100}),
      [[{kind: 'property', value: {invalid: true}}]],
    ],
    [
      'Search Console siteUrl',
      wrapped('google_search_console_native_action', {siteUrl: 'sc-domain:example.com'}),
      [[{kind: 'site', value: 'sc-domain:example.com'}]],
    ],
    [
      'Tag Manager accountId and path',
      wrapped('gtm_native_action', {accountId: '100', path: 'accounts/100/containers/9'}),
      [
        [
          {kind: 'account', value: '100'},
          {kind: 'resource', value: 'accounts/100/containers/9'},
        ],
      ],
    ],
    [
      'Business Profile accountId and locationId',
      wrapped('google_business_native_action', {accountId: '100', locationId: '5'}),
      [
        [
          {kind: 'account', value: '100'},
          {kind: 'location', value: '5'},
        ],
      ],
    ],
    [
      'Reddit account_id',
      wrapped('reddit_native_action', {account_id: 't2_abc'}),
      [[{kind: 'account', value: 't2_abc'}]],
    ],
    [
      'Reddit params.ad_account_id',
      wrapped('reddit_native_action', {params: {ad_account_id: 't2_abc'}}),
      [[{kind: 'account', value: 't2_abc'}]],
    ],
    // A provider with no resource selectors projects none: the array is empty, not a string.
    ['a provider without selectors', wrapped('meta_native_action', {account_id: 'act_1'}), []],
  ]) {
    const anchors = scope(store, config).resource_account_anchors;
    assert.ok(Array.isArray(anchors), `${name}: an array on SQLite ${version(store)}, got ${typeof anchors}`);
    assert.deepEqual(anchors, expected, `${name} on SQLite ${version(store)}`);
  }
});

test('the encoded body identifiers of a retained configuration are four nested arrays, one per body location', t => {
  const store = fixture(t);
  for (const [gateway, field] of [
    ['dv360_native_action', 'advertiserId'],
    ['linkedin_native_action', 'account_id'],
    ['x_ads_native_action', 'account_id'],
  ]) {
    const encoded = body => JSON.stringify(body);
    for (const [name, args, expected] of [
      ['payload', {payload: encoded({[field]: '100', private: 'x'})}, [['100'], [], [], []]],
      ['body', {body: encoded({[field]: '100'})}, [[], ['100'], [], []]],
      ['params.payload', {params: {payload: encoded({[field]: '100'})}}, [[], [], ['100'], []]],
      ['params.body', {params: {body: encoded({[field]: '100'})}}, [[], [], [], ['100']]],
      // Repeated keys are all projected, so a conflict cannot hide behind first-key or last-key parsing.
      [
        'a repeated key and a second location',
        {payload: `{"${field}":"100","${field}":"200"}`, body: encoded({[field]: '300'})},
        [['100', '200'], ['300'], [], []],
      ],
      ['a value that is not text', {payload: encoded({[field]: 100})}, [[{invalid: true}], [], [], []]],
      ['a null value', {payload: encoded({[field]: null})}, [[null], [], [], []]],
      ['no body at all', {}, [[], [], [], []]],
    ]) {
      const anchors = scope(store, {gateway, arguments: {action: 'synthetic_read', ...args}}).encoded_account_anchors;
      assert.ok(Array.isArray(anchors), `${gateway} ${name}: an array on SQLite ${version(store)}`);
      for (const group of anchors)
        assert.ok(Array.isArray(group), `${gateway} ${name}: each location is an array on SQLite ${version(store)}`);
      assert.deepEqual(anchors, expected, `${gateway} ${name} on SQLite ${version(store)}`);
    }
  }
});

test('a saved query, a report run and a workbook schedule carry the same nested scope', t => {
  const store = fixture(t),
    config = wrapped('ga4_native_action', {property: 'properties/100', request: {}}),
    run = store.enqueue(tenant, 'report', {query_name: 'Run', query_config: config, query_id: 'q1'});
  store.putDocument(tenant, 'reporting_query', 'q1', {name: 'Saved', query_config: config, updated_at: 5});
  store.putDocument(tenant, 'reporting_schedule', 's1', {
    name: 'Daily',
    schedule_config: {query_id: 'q1'},
    is_active: true,
    schedule_kind: 'daily',
    timezone: 'UTC',
  });
  for (const [name, row] of [
    ['the saved query', savedQuery(store, tenant, 'q1')],
    ['the report run', reportRunRow(store, tenant, run)],
    ['the workbook schedule', workbookScheduleRow(store, tenant, 's1')],
  ]) {
    assert.ok(row, name);
    assert.deepEqual(
      JSON.parse(row.metadata).resource_account_anchors,
      [[{kind: 'property', value: 'properties/100'}]],
      `${name} on SQLite ${version(store)}`,
    );
  }
});

/** One plan: a media step that uploads the asset `asset-1`, and a later step that refers to the upload's result. */
const planWithMedia = {
  user_id: 'u1',
  name: 'Plan',
  steps: [
    {
      id: 's1',
      kind: 'media',
      status: 'verified',
      gateway: 'meta_native_action',
      account_id: 'act_1',
      connection_id: 'c1',
      review_id: 'asset-1',
      arguments: {platform: 'meta', action: 'upload'},
      result: {created_id: 'img-1', media_id: 'img-1'},
    },
    {
      id: 's2',
      kind: 'campaign',
      status: 'verified',
      gateway: 'meta_native_action',
      account_id: 'act_1',
      connection_id: 'c1',
      arguments: {image: {$ref: 's1#/result/media_id'}},
      result: {},
      verification: {verified_resources: [{resource_id: 'cmp-9'}]},
    },
  ],
};

test('the creative library usage rows nest each step’s references and resources as arrays', t => {
  const store = fixture(t);
  store.putDocument(tenant, 'campaign_run', 'plan-1', planWithMedia);
  const rows = assetUsage(store, tenant, '', 'asset-1', undefined);
  assert.equal(rows.length, 1);
  const steps = JSON.parse(rows[0].steps);
  assert.ok(Array.isArray(steps), 'the steps are an array');
  assert.deepEqual(
    steps.map(({id, references, resources}) => ({id, references, resources})),
    [
      {id: 's1', references: [], resources: ['img-1', 'img-1']},
      {id: 's2', references: ['s1#/result/media_id'], resources: ['cmp-9']},
    ],
    `on SQLite ${version(store)}`,
  );
});

test('the Operations feed nests a plan’s scopes as an array of objects', t => {
  const store = fixture(t);
  store.putDocument(tenant, 'campaign_run', 'plan-1', planWithMedia);
  const rows = operationsFeedRows(store, tenant, Date.now(), 'campaign_run', null);
  assert.equal(rows.length, 1);
  const scopes = JSON.parse(rows[0].metadata).scopes;
  assert.ok(Array.isArray(scopes), `the scopes are an array on SQLite ${version(store)}, got ${typeof scopes}`);
  assert.deepEqual(scopes, [
    {gateway: 'meta_native_action', connection_id: 'c1', account_id: 'act_1'},
    {gateway: 'meta_native_action', connection_id: 'c1', account_id: 'act_1'},
  ]);
});

test('json() keeps the JSON subtype of a scalar subquery’s result, which the nesting statements rely on', t => {
  const store = fixture(t),
    db = store.sql();
  assert.equal(
    db.prepare('SELECT json_array(json((SELECT json_group_array(value) FROM json_each(?)))) AS nested').get('[1,2]')
      .nested,
    '[[1,2]]',
    `json() around a scalar subquery on SQLite ${version(store)}`,
  );
  assert.equal(
    db.prepare("SELECT json_object('k', json((SELECT json_object('a', 1)))) AS nested").get().nested,
    '{"k":{"a":1}}',
  );
});
