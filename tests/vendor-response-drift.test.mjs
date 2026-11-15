import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import * as delegated from '../dist/src/delegated-native.js';
import {redditAudienceRoutes, redditReadRoutes} from '../dist/src/reddit-extensions.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// r25-hotfix item 2 (5.8b and error 16 of the live checks of 2026-11-15): Reddit added `ugc_addon_default_on` to the answer
// of GET_AD_ACCOUNT, and AMCP refused the whole answer because its pinned schema closes /data. A provider adding a
// response field is not a contract break. A read now tolerates properties its pinned response schema does not declare and
// names them (paths and names, never values); every other deviation is refused as before, requests stay as strict as they
// were, and the checks of reviewed writes are unchanged. The bodies are synthetic and follow Reddit's published v3 schema.
const actor = {tenantId: 'vendor-drift', userId: 'operator', role: 'reader'};
const connection = {
  id: '00000000-0000-4000-8000-0000000000a1',
  tenantId: actor.tenantId,
  gateway: 'reddit_native_action',
  accounts: ['a2_111'],
  enabled: true,
  label: 'Synthetic',
  scopes: ['adsread'],
  userAgent: 'server:amcp-tests:1 (synthetic)',
};
const account = {id: 'a2_111', name: 'Synthetic account', admin_approval: 'VALID', type: 'SELF_SERVE'};
const campaign = {id: 'c1', name: 'Synthetic campaign', configured_status: 'PAUSED', objective: 'CLICKS'};
const noPages = {next_url: null, previous_url: null};

function reddit(body, status = 200) {
  const store = new Store(':memory:', Buffer.alloc(32, 21).toString('base64'));
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async () => Response.json(body, {status}),
      async () => {},
    ),
  );
  return {
    store,
    call: (tool, input) => service.call(tool, input, actor),
    read: (operation, args) => service.call('reddit_native_action', {operation, arguments: args}, actor),
  };
}
const getAccount = f => f.read('reddit_account_ops', {action: 'GET_AD_ACCOUNT', account_id: 'a2_111'});
const listCampaigns = f => f.read('reddit_campaign_ops', {action: 'LIST_CAMPAIGNS', account_id: 'a2_111'});
const compiler = new delegated.DelegatedNativeCompiler();
const vendorMethod = action =>
  compiler.data.routes.find(route => route.gateway === 'reddit_native_action' && route.action === action).vendorMethod;
const redditPlan = (operation, action) => ({gateway: 'reddit_native_action', action: operation + '/' + action});
const accountPlan = redditPlan('reddit_account_ops', 'GET_AD_ACCOUNT');

test('a Reddit account read whose answer adds a property its pinned schema does not declare succeeds and names it', async t => {
  const added = {...account, ugc_addon_default_on: true, other_new_field: 'SENTINEL-VALUE-ONE'};
  const f = reddit({data: added});
  t.after(() => f.store.close());
  const r = await getAccount(f);
  assert.equal(r.success, true, JSON.stringify(r.error));
  // Reddit's answer is returned as Reddit sent it, the new fields included.
  assert.deepEqual(r.data.data, {data: added});
  assert.deepEqual(r.data.vendor_schema_drift, {
    vendor_method: 'Get Ad Account',
    unexpected: [{path: '/data', properties: ['other_new_field', 'ugc_addon_default_on']}],
  });
  assert.doesNotMatch(JSON.stringify(r.data.vendor_schema_drift), /SENTINEL-VALUE-ONE/);
  // The audit trail keeps the drift beside the call: names and places, and no value.
  const completed = f.store
    .audit(actor.tenantId)
    .map(row => JSON.parse(row.event))
    .find(event => event.event === 'request_completed');
  assert.deepEqual(completed.outcome.vendor_schema_drift, r.data.vendor_schema_drift);
  assert.doesNotMatch(JSON.stringify(completed), /SENTINEL-VALUE-ONE/);
});

test('an answer that matches its pinned schema reports no drift', async t => {
  const f = reddit({data: account});
  t.after(() => f.store.close());
  const r = await getAccount(f);
  assert.equal(r.success, true, JSON.stringify(r.error));
  assert.equal('vendor_schema_drift' in r.data, false);
});

test('properties added at any depth are found once per place, whatever the number of rows', async t => {
  const f = reddit({
    new_root_field: 'SENTINEL-ROOT',
    data: [
      {
        ...campaign,
        new_row_field: 'SENTINEL-A',
        skadnetwork_metadata: {status: 'ENABLED', new_nested_field: 'SENTINEL-N'},
      },
      {...campaign, id: 'c2', new_row_field: 'SENTINEL-B', also_new: 1},
    ],
    pagination: {...noPages, new_pagination_field: 'SENTINEL-P'},
  });
  t.after(() => f.store.close());
  const r = await listCampaigns(f);
  assert.equal(r.success, true, JSON.stringify(r.error));
  assert.deepEqual(r.data.vendor_schema_drift, {
    vendor_method: vendorMethod('LIST_CAMPAIGNS'),
    // A row's index is not part of the place: every row of /data is one place.
    unexpected: [
      {path: '/', properties: ['new_root_field']},
      {path: '/data/*', properties: ['also_new', 'new_row_field']},
      {path: '/data/*/skadnetwork_metadata', properties: ['new_nested_field']},
      {path: '/pagination', properties: ['new_pagination_field']},
    ],
  });
  assert.doesNotMatch(JSON.stringify(r.data.vendor_schema_drift), /SENTINEL/);
});

// What must still be refused: a known property of the wrong type or value, a required property missing, an undocumented
// status. The refusal names the real mismatch (never the added property) and says what to do.
for (const [label, body, status, read, expected] of [
  ['an enum value that is not documented', {data: {...account, type: 'NOT_A_TYPE'}}, 200, getAccount, 'enum'],
  ['a known property of the wrong type', {data: {...account, pixel_partner_preferences: 'x'}}, 200, getAccount, 'type'],
  ['a required property that is missing', {data: [campaign]}, 200, listCampaigns, 'required'],
  ['an undocumented status', {data: account}, 202, getAccount, undefined],
]) {
  test('a Reddit read is still refused for ' + label, async t => {
    const f = reddit(body, status);
    t.after(() => f.store.close());
    const r = await read(f);
    assertRefused(r, 'UPSTREAM_RESPONSE_INVALID');
    assert.equal(typeof r.error.details.vendor_method, 'string');
    if (expected)
      assert.ok(
        r.error.details.errors.some(error => error.keyword === expected),
        JSON.stringify(r.error.details),
      );
    else assert.equal(r.error.details.status, status);
    // The schema errors quote the provider, so they stay labelled untrusted, as before; a bare status quotes nothing.
    assert.deepEqual(r.meta.untrusted_paths, expected ? ['error.details.errors'] : undefined);
  });
}

test('an added property never hides a real mismatch, and the refusal does not name it', async t => {
  const f = reddit({data: {...account, type: 'NOT_A_TYPE', ugc_addon_default_on: true}});
  t.after(() => f.store.close());
  const r = await getAccount(f);
  assertRefused(r, 'UPSTREAM_RESPONSE_INVALID');
  const keywords = r.error.details.errors.map(error => error.keyword);
  assert.ok(keywords.includes('enum'), keywords.join());
  assert.equal(keywords.includes('additionalProperties'), false, 'the added property is not a mismatch');
});

test('a request with an added property is refused as before, after a read tolerated one', async t => {
  const f = reddit({data: {...account, ugc_addon_default_on: true}});
  t.after(() => f.store.close());
  assert.equal((await getAccount(f)).success, true);
  const body = {name: 'Preview only', configured_status: 'PAUSED', objective: 'CLICKS'};
  const create = data =>
    f.read('reddit_campaign_ops', {action: 'CREATE_CAMPAIGN', account_id: 'a2_111', payload: {data}});
  const preview = await create(body);
  assert.equal(preview.success, true, JSON.stringify(preview.error));
  assert.equal(preview.data.executed, false);
  assertRefused(await create({...body, not_a_field: 1}), 'INVALID_VENDOR_BODY');
});

test('a Reddit readiness check does not depend on the added property, so it is not why readiness lacked an account read', async t => {
  const f = reddit({data: {...account, ugc_addon_default_on: true}});
  t.after(() => f.store.close());
  // Readiness reads the account itself and checks it names the selected account; it never applies the vendor schema.
  const checked = await f.call('amcp_workspace', {
    action: 'check',
    connection_id: connection.id,
    account_id: 'a2_111',
    live: true,
  });
  assert.equal(checked.success, true, JSON.stringify(checked.error));
  assert.equal(checked.data.live_read, true, JSON.stringify(checked.data.checks));
});

// The compiler's checks, without the service.
test('the check that guards reviewed writes still refuses an added property, and the read check reports it', () => {
  const body = {data: {...account, ugc_addon_default_on: true}};
  assert.throws(
    () => compiler.validateResponse(accountPlan, body, 200),
    error => assertRefused(error, 'UPSTREAM_RESPONSE_INVALID'),
  );
  assert.deepEqual(compiler.validateReadResponse(accountPlan, body, 200), {
    vendor_method: 'Get Ad Account',
    unexpected: [{path: '/data', properties: ['ugc_addon_default_on']}],
  });
  assert.equal(compiler.validateReadResponse(accountPlan, {data: account}, 200), undefined);
});

test('names are clipped, counted and capped, in a fixed order, and no value is ever kept', () => {
  const extras = Object.fromEntries(
    Array.from({length: 60}, (_, i) => ['extra_' + String(i).padStart(2, '0'), 'SENTINEL-' + i]),
  );
  const drift = compiler.validateReadResponse(
    accountPlan,
    {data: {...account, ...extras, ['bad\nname' + 'x'.repeat(200)]: 'SENTINEL-LONG'}},
    200,
  );
  const names = drift.unexpected.flatMap(place => place.properties);
  // 61 names, the first 50 in order kept, the rest counted.
  assert.equal(names.length, 50);
  assert.equal(drift.omitted, 11);
  assert.deepEqual(names, [...names].sort());
  assert.ok(
    names.every(name => name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name)),
    names.join('|'),
  );
  assert.ok(names[0].startsWith('bad namexxx'), names[0]);
  assert.doesNotMatch(JSON.stringify(drift), /SENTINEL/);
});

test('a place in the path that the answer chose (a key of a map, an ID, a person) is never shown', () => {
  // A synthetic route whose answer holds a typed map of closed objects, as a provider's dictionary would: its keys are
  // data, not schema. Only a name that looks like a property name is shown; any other segment is `*`.
  const route = {
    gateway: 'synthetic_native_action',
    operation: 'synthetic_ops',
    action: 'GET_THING',
    vendorMethod: 'Get Thing',
    source: 'synthetic',
    sourceFile: 'synthetic',
    origin: 'https://example.invalid',
    path: '/things',
    method: 'GET',
    readOnly: true,
    parameters: {},
    bodyRequired: false,
    scopes: [],
    evidence: 'synthetic',
    responseSchemas: {
      '200': {
        type: 'object',
        additionalProperties: false,
        properties: {
          events: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              additionalProperties: false,
              properties: {count: {type: 'integer'}},
            },
          },
        },
      },
    },
  };
  const synthetic = new delegated.DelegatedNativeCompiler({
      formatVersion: 1,
      routes: [route],
      gaps: [],
      schemaComponents: {},
    }),
    plan = {gateway: 'synthetic_native_action', action: 'synthetic_ops/GET_THING'};
  const drift = synthetic.validateReadResponse(
    plan,
    {
      events: {
        'Purchase - VIP': {count: 1, new_field: 'SENTINEL'},
        'jane@example.com': {count: 2, new_field: 'SENTINEL'},
        '4242': {count: 3, new_field: 'SENTINEL'},
        ['x'.repeat(100)]: {count: 4, new_field: 'SENTINEL'},
      },
      top_level_new: 1,
    },
    200,
  );
  assert.deepEqual(drift.unexpected, [
    {path: '/', properties: ['top_level_new']},
    {path: '/events/*', properties: ['new_field']},
  ]);
  assert.doesNotMatch(JSON.stringify(drift), /Purchase|VIP|jane|example\.com|4242|xxxx|SENTINEL/);
});

test('the drifts of the pages of one read merge by place, without repeats', () => {
  const page = (...unexpected) => ({vendor_method: 'Get Thing', unexpected});
  assert.equal(delegated.mergeVendorDrift([]), undefined);
  assert.deepEqual(
    delegated.mergeVendorDrift([
      page({path: '/data/*', properties: ['b', 'a']}),
      {...page({path: '/data/*', properties: ['a', 'c']}, {path: '/', properties: ['z']}), omitted: 2},
      {...page({path: '/', properties: ['z']}), omitted: 1},
    ]),
    {
      vendor_method: 'Get Thing',
      unexpected: [
        {path: '/', properties: ['z']},
        {path: '/data/*', properties: ['a', 'b', 'c']},
      ],
      omitted: 3,
    },
  );
});

test('relaxing a response copies the schema: the pinned data, which request validation shares, never changes', () => {
  const fresh = new delegated.DelegatedNativeCompiler(),
    before = structuredClone(fresh.data);
  fresh.validateReadResponse(accountPlan, {data: {...account, ugc_addon_default_on: true}}, 200);
  fresh.validateReadResponse(
    redditPlan('reddit_campaign_ops', 'LIST_CAMPAIGNS'),
    {new_root_field: 1, data: [], pagination: noPages},
    200,
  );
  assert.deepEqual(fresh.data, before);
  // The first request check built after a relaxed response is as strict as ever.
  assert.throws(
    () =>
      fresh.compile('reddit_native_action', {
        operation: 'reddit_campaign_ops',
        arguments: {
          action: 'CREATE_CAMPAIGN',
          account_id: 'a2_111',
          payload: {data: {name: 'x', configured_status: 'PAUSED', objective: 'CLICKS', not_a_field: 1}},
        },
      }),
    error => assertRefused(error, 'INVALID_VENDOR_BODY'),
  );
});

test('every pinned response schema has a relaxed form that compiles, and an empty answer never crashes the check', () => {
  const routes = [...compiler.data.routes, ...redditReadRoutes(), ...redditAudienceRoutes].filter(
    route => route.responseSchemas,
  );
  assert.ok(routes.length >= 57, 'routes with response schemas: ' + routes.length);
  for (const route of routes)
    for (const status of Object.keys(route.responseSchemas)) {
      const plan = {gateway: route.gateway, action: route.operation + (route.action ? '/' + route.action : '')};
      try {
        compiler.validateReadResponse(plan, {}, Number(status));
      } catch (error) {
        assertRefused(error, 'UPSTREAM_RESPONSE_INVALID');
      }
    }
});

// Criteo's two campaign write routes are its only routes with response schemas. Its writes keep the strict check; its
// schemas relax like any other when a read asks. Its pinned campaign rows are open, and only the items of `warnings` and
// `errors` are closed, whose `source` is a map of text (a typed map, which stays typed).
const criteoAttributes = {
  name: 'Summer campaign',
  budget: 1000,
  dailyPacing: 25,
  monthlyPacing: 500,
  isAutoDailyPacing: false,
  startDate: '2030-08-01T00:00:00Z',
  endDate: '2030-08-31T23:59:59Z',
  clickAttributionWindow: '30D',
  viewAttributionWindow: '1D',
  clickAttributionScope: 'sameSkuCategory',
  viewAttributionScope: 'sameSku',
  companyName: 'Test advertiser',
  onBehalfCompanyName: null,
};
const criteoRow = {
  id: '457',
  type: 'RetailMediaCampaignV202301',
  attributes: {
    ...criteoAttributes,
    accountId: '123',
    type: 'auction',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};
for (const [action, status] of [
  ['CREATE_CAMPAIGNS_BY_ACCOUNT_ID', 201],
  ['UPDATE_CAMPAIGN_BY_CAMPAIGN_ID', 200],
])
  test('Criteo ' + action + ': the write check is unchanged, and the read check relaxes its schema', () => {
    const plan = {gateway: 'criteo_native_action', action: 'criteo_campaign_ops/' + action},
      warning = {code: 'synthetic-warning', detail: 'Synthetic'},
      refused = error => assertRefused(error, 'UPSTREAM_RESPONSE_INVALID');
    assert.doesNotThrow(() => compiler.validateResponse(plan, {data: criteoRow}, status));
    assert.equal(compiler.validateReadResponse(plan, {data: criteoRow}, status), undefined);
    // An added property where the pinned schema is open is no drift: both checks accept it, as they always did.
    const open = {data: {...criteoRow, new_row_field: 1, attributes: {...criteoRow.attributes, new_attribute: 1}}};
    assert.doesNotThrow(() => compiler.validateResponse(plan, open, status));
    assert.equal(compiler.validateReadResponse(plan, open, status), undefined);
    // Where it is closed (an item of warnings) the write check refuses and the read check names it.
    const added = {data: criteoRow, warnings: [{...warning, new_warning_field: 'SENTINEL-W'}]};
    assert.throws(() => compiler.validateResponse(plan, added, status), refused);
    const drift = compiler.validateReadResponse(plan, added, status);
    assert.deepEqual(drift.unexpected, [{path: '/warnings/*', properties: ['new_warning_field']}]);
    assert.doesNotMatch(JSON.stringify(drift), /SENTINEL/);
    // A typed map stays typed: a source value that is not text is refused by both checks.
    const typed = {data: criteoRow, warnings: [{...warning, source: {pointer: 7}}]};
    assert.throws(() => compiler.validateResponse(plan, typed, status), refused);
    assert.throws(() => compiler.validateReadResponse(plan, typed, status), refused);
    // Real breaks are refused by the read check too: a required property missing, an undocumented status.
    const missing = structuredClone({data: criteoRow});
    delete missing.data.attributes.createdAt;
    assert.throws(() => compiler.validateReadResponse(plan, missing, status), refused);
    assert.throws(() => compiler.validateReadResponse(plan, {}, status), refused);
    assert.throws(() => compiler.validateReadResponse(plan, {data: criteoRow}, status === 201 ? 200 : 201), refused);
  });

test('the other delegated gateways pin no response schema, so their answers pass through the read check untouched', () => {
  const withSchemas = new Set(compiler.data.routes.filter(route => route.responseSchemas).map(route => route.gateway)),
    others = compiler.data.routes.filter(route => !withSchemas.has(route.gateway));
  assert.deepEqual([...withSchemas].sort(), ['criteo_native_action', 'reddit_native_action']);
  assert.deepEqual([...new Set(others.map(route => route.gateway))].sort(), [
    'ga4_native_action',
    'google_business_native_action',
    'google_search_console_native_action',
    'gtm_native_action',
  ]);
  for (const route of compiler.data.routes.filter(route => !route.responseSchemas)) {
    const plan = {gateway: route.gateway, action: route.operation + (route.action ? '/' + route.action : '')};
    assert.equal(compiler.validateReadResponse(plan, {anything: [1, 2], at: {all: null}}, 200), undefined, plan.action);
  }
});
