import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {metaPrefix} from '../dist/src/meta-version.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {metaService, registry} from './helpers/meta-service.mjs';

// r25-fr-meta-reads, A5 (the owner's friction report of 2026-11-26): there was no Meta change history. A search of the actions for
// "activities" found nothing, `amcp_workspace change_history` is Google Ads only, and the owner could not confirm why two catalog
// campaigns dropped to almost no spend. The ad account's activity read (GET act_<id>/activities) is a native read now.
// Who made a change is personal data in this code base (PRV-07: Google's user_email is never requested, Reddit's members are
// projected out), so the read never asks for it and never returns it. The model is pinned from Meta's public SDK
// (tests/fixtures/meta-activities-sdk-v26.json). Synthetic IDs, names and events only.
const gateway = 'meta_native_action',
  action = 'meta_ad_account_id_activities_get',
  evidence = JSON.parse(readFileSync('tests/fixtures/meta-activities-sdk-v26.json', 'utf8')),
  changes = JSON.parse(readFileSync('tests/fixtures/meta-sdk-changes-v26.json', 'utf8')),
  window = {since: '2026-11-15', until: '2026-11-20'};
const budget = {
  event_time: '2026-11-18T09:14:02+0000',
  date_time_in_timezone: '11/18/2026 at 12:14 PM',
  event_type: 'update_campaign_budget',
  translated_event_type: 'Campaign budget updated',
  object_id: '6001',
  object_name: 'Synthetic catalog campaign',
  object_type: 'CAMPAIGN',
  extra_data: '{"old_value":{"daily_budget":5000},"new_value":{"daily_budget":2000}}',
  application_id: '77',
  application_name: 'Ads Manager',
  tool: 'ads_manager',
  actor_id: '9001',
  actor_name: 'Synthetic Person One',
  internal_flag: 'not in the SDK model',
};
const role = {
  ...budget,
  event_time: '2026-11-18T10:00:00+0000',
  event_type: 'ad_account_add_user_to_role',
  translated_event_type: 'User added to a role',
  object_id: '9002',
  object_name: 'Synthetic Person Two',
  object_type: 'USER',
  extra_data: '{"role":"ADVERTISER"}',
};
const pages = {
  '': {
    data: [budget, role],
    paging: {cursors: {before: 'B0', after: 'C1'}, next: 'https://graph.example/next?after=C1'},
  },
  C1: {
    data: [{...budget, event_time: '2026-11-17T08:00:00+0000', object_id: '6002'}],
    paging: {cursors: {before: 'B1', after: 'C2'}},
  },
};
const answer = url =>
  url.pathname.endsWith('/activities')
    ? Response.json(pages[url.searchParams.get('after') ?? ''] ?? {data: []})
    : Response.json({error: {message: 'Unexpected synthetic route ' + url.pathname, code: 100}}, {status: 400});
const read = (f, input = {}) => f.call({action, account_id: '123', query: {...window}, ...input});
const people = ['actor_id', 'actor_name'];

test('the read is found by a search for "activities" or "history", described, and a native read of the ledger; the listing is still the capture', async t => {
  const f = metaService(t),
    listed = await f.call({action: 'LIST_ACTIONS', search: 'activities'});
  assert.equal(listed.success, true, JSON.stringify(listed.error));
  assert.equal(listed.data.actions[0].name, action);
  assert.equal(listed.data.total, 1);
  const history = await f.call({action: 'LIST_ACTIONS', search: 'history', limit: 50});
  assert.ok(
    history.data.actions.some(a => a.name === action),
    'history finds it by its description',
  );
  const described = await f.call({action: 'DESCRIBE_ACTION', target_action: action});
  assert.equal(described.success, true, JSON.stringify(described.error));
  assert.equal(described.data.method, 'GET');
  assert.equal(described.data.path, metaPrefix + 'act_{ad_account_id}/activities');
  assert.equal(described.data.read_only, true);
  // The captured catalog is the naming denominator: it did not grow, and a listing without a search replays it to the byte.
  assert.equal(
    registry.catalogs.get(gateway).actions.length,
    registry.data.catalogs.find(c => c.gateway === gateway).actions.length,
  );
  const plain = await f.call({action: 'LIST_ACTIONS', limit: 1});
  assert.equal(plain.data.total, registry.catalogs.get(gateway).actions.length);
  assert.ok(!registry.catalogs.get(gateway).actions.some(a => a.name === action));
  const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === action);
  assert.equal(row?.status, 'native_read');
  assert.equal(f.requests.length, 0);
});

test('its short name resolves to it with the alias warning, as the other near-miss names do', async t => {
  const f = metaService(t, {answer}),
    out = await f.call({action: 'meta_ad_account_activities_get', account_id: '123', query: window});
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.equal(out.meta.argument_warnings?.[0]?.code, 'ACTION_ALIAS_DEPRECATED');
  assert.equal(out.meta.argument_warnings[0].canonical, action);
  assert.equal(f.requests.at(-1).path, metaPrefix + 'act_123/activities');
});

test('a read sends one GET with an explicit window, the page size and the allowed fields, and returns the changes without their people', async t => {
  const f = metaService(t, {answer}),
    out = await read(f);
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.equal(f.requests.length, 1);
  const sent = f.requests[0];
  assert.equal(sent.method, 'GET');
  assert.equal(sent.path, metaPrefix + 'act_123/activities');
  assert.deepEqual(Object.keys(sent.query).sort(), ['fields', 'limit', 'since', 'until']);
  assert.equal(sent.query.limit, '100');
  assert.equal(sent.query.since, '2026-11-15T00:00:00Z');
  assert.equal(sent.query.until, '2026-11-20T23:59:59Z');
  // Every field is one the SDK model has, and neither field that names the person.
  const asked = sent.query.fields.split(',');
  assert.deepEqual(
    asked.filter(name => !evidence.fields.includes(name)),
    [],
  );
  assert.deepEqual(evidence.fields.filter(name => !asked.includes(name)).sort(), people);
  const body = out.data.data;
  assert.equal(body.data.length, 2);
  assert.deepEqual(body.personal_data, {actor: 'removed'});
  const text = JSON.stringify(out);
  for (const hidden of [
    'Synthetic Person One',
    'Synthetic Person Two',
    '"9001"',
    'actor_id',
    'actor_name',
    'internal_flag',
  ])
    assert.ok(!text.includes(hidden), hidden + ' is in the answer');
  // The change itself, when and by which tool, and that a person made it without who.
  const [first] = body.data;
  assert.equal(first.event_type, 'update_campaign_budget');
  assert.equal(first.translated_event_type, 'Campaign budget updated');
  assert.equal(first.object_name, 'Synthetic catalog campaign');
  assert.equal(first.extra_data, budget.extra_data);
  assert.equal(first.application_name, 'Ads Manager');
  assert.equal(first.event_time, budget.event_time);
  assert.equal(first.changed_by, 'not_shown');
  // A change to who may use the account names that person: its object and details are withheld too.
  const [, access] = body.data;
  assert.equal(access.event_type, 'ad_account_add_user_to_role');
  for (const name of ['object_id', 'object_name', 'extra_data']) assert.equal(access[name], undefined, name);
  assert.equal(access.withheld, 'people');
  assert.equal(access.event_time, role.event_time);
  // The cursor stays for the next page.
  assert.equal(body.paging.cursors.after, 'C1');
});

test('filters that narrow the read are passed on, and a window of datetimes is sent as written', async t => {
  const f = metaService(t, {answer});
  const out = await read(f, {
    query: {
      since: '2026-11-15T21:30:00+02:00',
      until: '2026-11-16T00:00:00Z',
      limit: 50,
      category: 'BUDGET',
      oid: '6001',
      add_children: true,
      after: 'C1',
      fields: 'event_time,event_type,object_id',
    },
  });
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.deepEqual(f.requests[0].query, {
    since: '2026-11-15T21:30:00+02:00',
    until: '2026-11-16T00:00:00Z',
    limit: '50',
    category: 'BUDGET',
    oid: '6001',
    add_children: 'true',
    after: 'C1',
    fields: 'event_time,event_type,object_id',
  });
});

test('aggregated pages follow Meta’s cursor, and an aggregation without a ceiling of ten pages is refused before anything is sent', async t => {
  const f = metaService(t, {answer}),
    out = await read(f, {aggregate_pages: true, max_pages: 3});
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.equal(out.data.pages, 2);
  assert.equal(out.data.data.data.length, 3);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].query.after, 'C1');
  for (const name of ['since', 'until', 'limit', 'fields'])
    assert.equal(f.requests[1].query[name], f.requests[0].query[name], name);
  assert.ok(!JSON.stringify(out).includes('Synthetic Person'));
  const refusals = metaService(t, {answer});
  for (const more of [{aggregate_pages: true}, {aggregate_pages: true, max_pages: 11}, {paginate: true, max_pages: 25}])
    assertRefused(await read(refusals, more), 'INVALID_ARGUMENT');
  assert.equal(refusals.requests.length, 0);
});

test('a read that cannot be bounded, or that asks for a person, is refused before anything is sent', async t => {
  const f = metaService(t, {answer}),
    invalid = [
      ['no window', {query: {}}],
      ['no start', {query: {until: '2026-11-20'}}],
      ['no end', {query: {since: '2026-11-15'}}],
      ['end before start', {query: {since: '2026-11-20', until: '2026-11-15'}}],
      ['57 days', {query: {since: '2026-10-01', until: '2026-11-27'}}],
      ['not a date', {query: {since: 'last week', until: '2026-11-20'}}],
      ['an impossible date', {query: {since: '2026-02-30', until: '2026-03-02'}}],
      ['limit 0', {query: {...window, limit: 0}}],
      ['limit 101', {query: {...window, limit: 101}}],
      ['limit text', {query: {...window, limit: 'many'}}],
      ['an unknown category', {query: {...window, category: 'PEOPLE'}}],
      ['an object ID that is no ID', {query: {...window, oid: '6001/../x'}}],
      ['a business filter', {query: {...window, business_id: '555'}}],
      ['a data source', {query: {...window, data_source: 'TAO'}}],
      ['an unknown parameter', {query: {...window, colour: 'red'}}],
      ['a field the model lacks', {query: {...window, fields: 'event_type,not_a_field'}}],
      ['a cursor that is no cursor', {query: {...window, after: 'C1&uid=9'}}],
    ];
  for (const [label, input] of invalid) {
    const out = await read(f, input);
    assertRefused(out, 'INVALID_ARGUMENT');
    assert.ok(Array.isArray(out.error.details.allowed) || out.error.details.field, label);
  }
  for (const [label, input] of [
    ['a user filter', {query: {...window, uid: '9001'}}],
    ['the person’s name', {query: {...window, fields: 'actor_name'}}],
    ['the person’s ID among others', {query: {...window, fields: 'event_type,actor_id'}}],
  ])
    assertRefused(await read(f, input), 'PERSONAL_DATA_READ_FORBIDDEN');
  // The account is the call's account, and an account the login does not grant has no connection.
  assertRefused(await read(f, {ad_account_id: 'act_999'}), 'ACCOUNT_SCOPE_MISMATCH');
  const other = await read(f, {account_id: '999'});
  assert.equal(other.success, false);
  assert.notEqual(other.error.code, 'INTERNAL_ERROR');
  assert.equal(f.requests.length, 0, 'nothing was sent');
});

test('an answer that is not a page of changes is refused instead of being shown', async t => {
  for (const body of [{data: 'oops'}, {changes: []}, {data: [null]}, [], {data: [{event_type: 'x'}, 7]}]) {
    const f = metaService(t, {answer: () => Response.json(body)}),
      out = await read(f);
    assertRefused(out, 'UPSTREAM_RESPONSE_INVALID');
    assert.equal(f.requests.length, 1);
  }
});

test('what AMCP sends and returns is within the pinned SDK model, and the SDK files are the ones the tree already hashes', () => {
  const sources = evidence.sources;
  assert.equal(evidence.sdk_tag, changes.to.sdk_tag);
  assert.equal(evidence.api_version, changes.to.api_version);
  assert.match(evidence.checked_at, /^\d{4}-\d{2}-\d{2}$/);
  for (const [name, source] of Object.entries(sources)) {
    assert.ok(
      source.url.startsWith(
        'https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/' + evidence.sdk_tag + '/',
      ),
      name,
    );
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    // The same bytes the other 26.0.2 pins and the v25 to v26 comparison hashed.
    assert.equal(source.sha256, changes.sources[name].to, name);
  }
  assert.equal(
    changes.sources.adactivity.from,
    changes.sources.adactivity.to,
    'the activity row did not change in v26',
  );
  assert.equal(evidence.request.method, 'GET');
  assert.equal(evidence.request.edge, '/activities');
  return import('../dist/src/meta-activities.js').then(code => {
    assert.deepEqual(
      code.metaActivityFields.filter(name => !evidence.fields.includes(name)),
      [],
    );
    assert.deepEqual(evidence.fields.filter(name => !code.metaActivityFields.includes(name)).sort(), people);
    assert.deepEqual(
      code.metaActivityParams.filter(name => !Object.hasOwn(evidence.request.params, name)),
      [],
    );
    assert.deepEqual(code.metaActivityCategories, evidence.enums.Category);
    // The two parameters AMCP never sends: a filter by person, and a business scope it does not resolve.
    assert.ok(Object.hasOwn(evidence.request.params, 'uid') && !code.metaActivityParams.includes('uid'));
    // The events about who may use the account are the SDK's, and no other event type is about a person.
    assert.deepEqual(
      code.metaPeopleEvents.filter(name => !evidence.enums.EventType.includes(name)),
      [],
    );
    assert.deepEqual(
      evidence.enums.EventType.filter(name =>
        /(^|_)(user|users|role|roles|member|members|login|invite)(_|$)/.test(name),
      ).sort(),
      [...code.metaPeopleEvents].sort(),
    );
  });
});
