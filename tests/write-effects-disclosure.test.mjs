import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {writeEffects, effectReasons} from '../dist/src/write-effects.js';
import {SNAP, campaignStep, createPlan, fixture as snapFixture} from '../dist/tests/snapchat-plan-fixture.js';

/**
 * WRT-05 Stage B: a Meta DELETE of an ACTIVE campaign used to return no reason and the plain approval text, with only
 * request.destructive: true; a GTM publish had no disclosure either. Prepare now names deletions, live publishes and
 * stopped delivery in `effects` and in execute_requirements, with the target and its current status, and ordinary
 * writes are unchanged.
 */
const registry = new Registry(),
  actor = {tenantId: 'effects', userId: 'writer', role: 'operator'},
  admin = {...actor, role: 'admin'};
function service(gateway, read) {
  const store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'c',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  store.rememberResource({id: 'c', tenantId: actor.tenantId, gateway}, '123', '111');
  let writes = 0;
  const s = new MirrorService(
    registry,
    store,
    new NativeTransport(async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (init.method !== 'GET' && !path.endsWith('/googleAds:search')) {
        writes++;
        return Response.json({success: true});
      }
      return Response.json(read(path, String(init.body ?? '')));
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const prepare = args =>
    s.call(
      'amcp_write',
      {action: 'prepare', gateway, connection_id: 'c', arguments: {account_id: '123', ...args}},
      actor,
    );
  return {store, prepare, writes: () => writes, close: () => store.close()};
}
const metaRead = status => path =>
  path.endsWith('/act_123')
    ? {id: 'act_123', account_status: 1, currency: 'USD'}
    : {id: '111', name: 'Spring launch', status};
const googleRead = status => (_path, body) =>
  body.includes('FROM customer')
    ? {results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}]}
    : {results: [{campaign: {resourceName: 'customers/123/campaigns/111', name: 'Brand', status}}]};
const google = 'google_ads_v23_campaign_mutate_campaigns';

test('a Meta DELETE of an ACTIVE campaign discloses its effects and names the campaign and status', async () => {
  const f = service('meta_native_action', metaRead('ACTIVE'));
  try {
    const r = await f.prepare({action: 'meta_campaign_delete', path_params: {campaign_id: '111'}});
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    const effects = {destructive: true, irreversible: true, publishes_live: false, stops_delivery: true};
    assert.deepEqual(r.data.effects, effects);
    assert.deepEqual(r.data.execute_requirements.effects, effects);
    const reasons = r.data.execute_requirements.reasons.filter(x => x.effect);
    assert.deepEqual(
      reasons.map(x => x.effect),
      ['destructive', 'stops_delivery'],
    );
    assert.match(reasons[0].reason, /"Spring launch" \(111\) \(current status: ACTIVE\)\. It cannot be undone/);
    assert.deepEqual(reasons[0].target, {id: '111', name: 'Spring launch', status: 'ACTIVE'});
    assert.match(r.data.execute_requirements.user_approval, /deletes or removes, cannot be undone/);
    assert.equal(f.writes(), 0);
  } finally {
    f.close();
  }
});

test('a Google remove is destructive and a pause of an enabled campaign stops delivery', async () => {
  const removal = service('google_ads_native_action', googleRead('ENABLED'));
  try {
    const r = await removal.prepare({action: google, payload: {operations: [{remove: 'customers/123/campaigns/111'}]}});
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.equal(r.data.effects.destructive, true);
    assert.equal(r.data.effects.stops_delivery, true);
    const pause = await removal.prepare({
      action: google,
      payload: {
        operations: [{update: {resource_name: 'customers/123/campaigns/111', status: 'PAUSED'}, update_mask: 'status'}],
      },
    });
    assert.equal(pause.success, true, JSON.stringify(pause).slice(0, 800));
    assert.deepEqual(pause.data.effects, {
      destructive: false,
      irreversible: false,
      publishes_live: false,
      stops_delivery: true,
    });
    assert.match(
      pause.data.execute_requirements.reasons.find(x => x.effect === 'stops_delivery').reason,
      /current status: ENABLED\): status becomes PAUSED/,
    );
  } finally {
    removal.close();
  }
  // Pausing what is already paused stops nothing.
  const paused = service('google_ads_native_action', googleRead('PAUSED'));
  try {
    const r = await paused.prepare({
      action: google,
      payload: {
        operations: [{update: {resource_name: 'customers/123/campaigns/111', status: 'PAUSED'}, update_mask: 'status'}],
      },
    });
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.equal(r.data.effects, undefined);
  } finally {
    paused.close();
  }
});

test('deleting a campaign that is already paused deletes but does not claim to stop delivery', async () => {
  const f = service('meta_native_action', metaRead('PAUSED'));
  try {
    const r = await f.prepare({action: 'meta_campaign_delete', path_params: {campaign_id: '111'}});
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.deepEqual(r.data.effects, {
      destructive: true,
      irreversible: true,
      publishes_live: false,
      stops_delivery: false,
    });
    assert.deepEqual(
      r.data.execute_requirements.reasons.filter(x => x.effect).map(x => x.effect),
      ['destructive'],
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.close();
  }
});

test('a request for several entities is named by its count, and a paused first target hides no stop', () => {
  const plan = {
    gateway: 'google_ads_native_action',
    method: 'POST',
    path: '/v23/customers/123/campaigns:mutate',
    action: google,
    query: {},
    headers: {},
    warnings: [],
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    body: {
      operations: ['1', '2'].map(id => ({
        update: {resource_name: 'customers/123/campaigns/' + id, status: 'PAUSED'},
        update_mask: 'status',
      })),
    },
  };
  // The first campaign read is already paused; the second is not, so the request still stops delivery.
  const state = [
    {
      results: [
        {campaign: {resourceName: 'customers/123/campaigns/1', name: 'Brand', status: 'PAUSED'}},
        {campaign: {resourceName: 'customers/123/campaigns/2', name: 'Generic', status: 'ENABLED'}},
      ],
    },
  ];
  const effects = writeEffects(plan, state);
  assert.equal(effects?.stops_delivery, true);
  const [reason] = effectReasons(plan, state, effects);
  assert.equal(reason.effect, 'stops_delivery');
  assert.match(reason.reason, /^This stops delivery of 2 resources \(POST \/v23\/customers\/123\/campaigns:mutate\)/);
  assert.equal(reason.target, undefined, 'no single target is named for several');
});

// Package r25-m3-live, F5 (the lead's live run of 2026-11-20): the destructive reason of a route B tree edit said "This deletes or removes 4
// resources" for one remove and three creates, and "2" for one and one: it counted every operation of the request, creates included. It counts
// the removals, and says what else the same request does. A request that is no list of operations, and a request whose only operation removes,
// are named as before.
const mutate = (operations, path = '/v25/customers/123/adGroupCriteria:mutate') => ({
  gateway: 'google_ads_native_action',
  method: 'POST',
  path,
  action: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
  query: {},
  headers: {},
  warnings: [],
  readOnly: false,
  destructive: true,
  requiresConfirmation: true,
  body: {operations},
});
const node = n => 'customers/123/adGroupCriteria/55~' + n;
const create = n => ({
  create: {resource_name: node('-' + n), ad_group: 'customers/123/adGroups/55', listing_group: {type: 'UNIT'}},
});
const destructiveReason = plan =>
  effectReasons(plan, [], writeEffects(plan, [])).find(r => r.effect === 'destructive').reason;

test('the destructive reason counts only the removals of a request, and names what else the same request does (r25-m3-live, F5)', () => {
  const where = '(POST /v25/customers/123/adGroupCriteria:mutate)';
  // One removal and three creates (a unit becomes a subdivision with two units): one resource is removed, not four.
  assert.equal(
    destructiveReason(mutate([{remove: node(4)}, create(1), create(2), create(3)])),
    'This deletes or removes 1 resource ' + where + ', and the same request creates 3. It cannot be undone.',
  );
  // One removal and one create: one, not two.
  assert.equal(
    destructiveReason(mutate([{remove: node(4)}, create(1)])),
    'This deletes or removes 1 resource ' + where + ', and the same request creates 1. It cannot be undone.',
  );
  // Two removals, a create and an update: two removals, and both of the others are said.
  assert.equal(
    destructiveReason(
      mutate([
        {remove: node(4)},
        {remove: node(5)},
        create(1),
        {update: {resource_name: node(6), cpc_bid_micros: '1'}, update_mask: 'cpc_bid_micros'},
      ]),
    ),
    'This deletes or removes 2 resources ' +
      where +
      ', and the same request creates 1 and updates 1. It cannot be undone.',
  );
  // Removals only: the count of the operations, as it always was.
  assert.equal(
    destructiveReason(mutate([{remove: node(4)}, {remove: node(5)}])),
    'This deletes or removes 2 resources ' + where + '. It cannot be undone.',
  );
  // A deletion that is no `remove` operation (a status of REMOVED, a delete by value) keeps the count of the request's operations: none of
  // them can be told from the deletion, and a count of removals would say none.
  const byStatus = mutate([
    {update: {resource_name: node(4), status: 'REMOVED'}, update_mask: 'status'},
    {update: {resource_name: node(5), status: 'REMOVED'}, update_mask: 'status'},
  ]);
  assert.match(destructiveReason(byStatus), /^This deletes or removes 2 resources /);
  // The other two reasons of a request are named as before: the stops and the publishes count what they always counted.
  const stops = mutate(
    [
      {update: {resource_name: 'customers/123/campaigns/1', status: 'PAUSED'}, update_mask: 'status'},
      {update: {resource_name: 'customers/123/campaigns/2', status: 'PAUSED'}, update_mask: 'status'},
    ],
    '/v25/customers/123/campaigns:mutate',
  );
  assert.match(
    effectReasons({...stops, destructive: false}, [], writeEffects({...stops, destructive: false}, [])).find(
      r => r.effect === 'stops_delivery',
    ).reason,
    /^This stops delivery of 2 resources \(POST \/v25\/customers\/123\/campaigns:mutate\)/,
  );
});

test('a plain Google removal, one operation, is named by its target and status as before (r25-m3-live, F5)', async () => {
  const f = service('google_ads_native_action', googleRead('ENABLED'));
  try {
    const r = await f.prepare({action: google, payload: {operations: [{remove: 'customers/123/campaigns/111'}]}});
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    const reason = r.data.execute_requirements.reasons.find(x => x.effect === 'destructive');
    assert.equal(
      reason.reason,
      'This deletes or removes "Brand" (customers/123/campaigns/111) (current status: ENABLED). It cannot be undone.',
    );
    assert.deepEqual(reason.target, {id: 'customers/123/campaigns/111', name: 'Brand', status: 'ENABLED'});
  } finally {
    f.close();
  }
});
test('a TikTok status DISABLE stops delivery and a DELETE is destructive and stops delivery', () => {
  // Regression: the status routes moved to the tiktok_entity_status family (WRT-02) and lost both disclosures.
  const plan = status => ({
    gateway: 'tiktok_native_action',
    method: 'POST',
    path: '/v1.3/campaign/status/update/',
    action: 'tiktok_campaign_status_update',
    accountId: '123',
    query: {},
    headers: {},
    warnings: [],
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    body: {advertiser_id: '123', campaign_ids: ['111'], operation_status: status},
  });
  const serving = [{data: {list: [{campaign_id: '111', campaign_name: 'Brand', operation_status: 'ENABLE'}]}}];
  assert.deepEqual(writeEffects(plan('DISABLE'), serving), {
    destructive: false,
    irreversible: false,
    publishes_live: false,
    stops_delivery: true,
  });
  assert.deepEqual(writeEffects(plan('DELETE'), serving), {
    destructive: true,
    irreversible: true,
    publishes_live: false,
    stops_delivery: true,
  });
  const reasons = effectReasons(plan('DISABLE'), serving, writeEffects(plan('DISABLE'), serving));
  assert.match(reasons.find(r => r.effect === 'stops_delivery').reason, /operation_status becomes DISABLE/);
  // An ENABLE starts delivery: it carries none of these effects.
  assert.equal(writeEffects(plan('ENABLE'), serving), undefined);
});

// R2.5 field3, package r25-field3-livefix, item 3: a TikTok status route lists the IDs it acts on, so the effects are decided over every one of them,
// not over the first record the review read, and the reason counts and names each.
test('a TikTok status change of several campaigns is decided over every one of them, and its reasons count and name each', () => {
  const plan = (status, ids) => ({
    gateway: 'tiktok_native_action',
    method: 'POST',
    path: '/v1.3/campaign/status/update/',
    action: 'tiktok_campaign_status_update',
    accountId: '123',
    query: {},
    headers: {},
    warnings: [],
    readOnly: false,
    destructive: status === 'DELETE',
    requiresConfirmation: true,
    body: {advertiser_id: '123', campaign_ids: ids, operation_status: status},
  });
  const row = (id, name, operation_status) => ({campaign_id: id, campaign_name: name, operation_status});
  // The first record read is paused already; the second serves. Deciding from the first would say a pause stops nothing.
  const mixed = [{data: {list: [row('111', 'Brand', 'DISABLE'), row('112', 'Sale', 'ENABLE')]}}];
  assert.equal(writeEffects(plan('DISABLE', ['111', '112']), mixed)?.stops_delivery, true);
  const reasons = effectReasons(
    plan('DISABLE', ['111', '112']),
    mixed,
    writeEffects(plan('DISABLE', ['111', '112']), mixed),
  );
  assert.equal(
    reasons.find(r => r.effect === 'stops_delivery').reason,
    'This stops delivery of 2 campaigns: "Brand" (111), "Sale" (112): operation_status becomes DISABLE.',
  );
  // Every one already paused: nothing stops.
  const idle = [{data: {list: [row('111', 'Brand', 'DISABLE'), row('113', 'Old', 'DISABLE')]}}];
  assert.equal(writeEffects(plan('DISABLE', ['111', '113']), idle), undefined);
  // A deletion of several names each of them (more than ten are cut, and the rest counted), and is destructive whatever the first one says.
  const ids = Array.from({length: 12}, (_, i) => String(200 + i)),
    many = [{data: {list: ids.map(id => row(id, 'Campaign ' + id, 'DISABLE'))}}],
    del = effectReasons(plan('DELETE', ids), many, writeEffects(plan('DELETE', ids), many)).find(
      r => r.effect === 'destructive',
    );
  assert.match(del.reason, /^This deletes or removes 12 campaigns: "Campaign 200" \(200\), "Campaign 201" \(201\)/);
  assert.match(del.reason, /"Campaign 209" \(209\), and 2 more\. It cannot be undone\.$/);
  // One campaign keeps its own words and its current status.
  const single = [{data: {list: [row('111', 'Brand', 'ENABLE')]}}];
  assert.equal(
    effectReasons(plan('DELETE', ['111']), single, writeEffects(plan('DELETE', ['111']), single)).find(
      r => r.effect === 'destructive',
    ).reason,
    'This deletes or removes campaign "Brand" (111) (current status: ENABLE). It cannot be undone.',
  );
});
// R2.5 field3, package r25-field3-livefix, item 3 (the live check LV-31): "This deletes or removes <the advertiser's name>". The first record a review
// reads is most often the account's own, and the reason named it as what was deleted. The account's record (the one with a currency) and what it holds
// are passed over, as the summary has always done; a write to the account itself still names it.
test('a deletion names the record it deletes, never the account the review read first', () => {
  const account = {advertiser_id: '123', name: 'Synthetic advertiser', currency: 'USD', status: 'STATUS_ENABLE'};
  const plan = {
    gateway: 'tiktok_native_action',
    method: 'POST',
    path: '/v1.3/dmp/custom_audience/delete/',
    action: 'tiktok_dmp_custom_audience_delete',
    accountId: '123',
    query: {},
    headers: {},
    warnings: [],
    readOnly: false,
    destructive: true,
    requiresConfirmation: true,
    body: {advertiser_id: '123', custom_audience_ids: ['9']},
  };
  const state = [{data: {list: [account]}}, {data: {list: [{id: '9', name: 'Past buyers', status: 'ACTIVE'}]}}];
  const reason = effectReasons(plan, state, writeEffects(plan, state)).find(r => r.effect === 'destructive');
  assert.match(
    reason.reason,
    /^This deletes or removes "Past buyers" \(9\) \(current status: ACTIVE\)\. It cannot be undone\.$/,
  );
  assert.doesNotMatch(reason.reason, /Synthetic advertiser|STATUS_ENABLE/);
  assert.deepEqual(reason.target, {id: '9', name: 'Past buyers', status: 'ACTIVE'});
  // Several of them are counted by the route's own list, and the account is no more one of them than before.
  const several = {...plan, body: {advertiser_id: '123', custom_audience_ids: ['9', '10']}};
  assert.match(
    effectReasons(several, state, writeEffects(several, state)).find(r => r.effect === 'destructive').reason,
    /^This deletes or removes 2 resources \(POST \/v1\.3\/dmp\/custom_audience\/delete\/\)\. It cannot be undone\.$/,
  );
});
test('an ordinary write keeps its plain review: no effects and no effect reasons', async () => {
  const f = service('meta_native_action', metaRead('PAUSED'));
  try {
    const r = await f.prepare({
      action: 'meta_campaign_update',
      path_params: {campaign_id: '111'},
      payload: {name: 'B'},
    });
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.equal(Object.hasOwn(r.data, 'effects'), false);
    assert.equal(Object.hasOwn(r.data.execute_requirements, 'effects'), false);
    assert.deepEqual(r.data.execute_requirements.reasons, []);
    assert.equal(r.data.execute_requirements.user_approval, 'Execute after the user approves this review.');
  } finally {
    f.close();
  }
});

test('GTM version publishing, sitemap submission and Business Profile links publish live', () => {
  const plan = (gateway, method, path, extra = {}) => ({
    gateway,
    method,
    path,
    action: 'synthetic',
    query: {},
    body: {},
    headers: {},
    warnings: [],
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    ...extra,
  });
  for (const p of [
    plan('gtm_native_action', 'POST', '/tagmanager/v2/accounts/1/containers/2/versions/3:publish'),
    plan('google_search_console_native_action', 'PUT', '/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/x'),
    plan('google_business_native_action', 'POST', '/v1/locations/12/placeActionLinks', {
      origin: 'https://mybusinessplaceactions.googleapis.com',
    }),
  ]) {
    const effects = writeEffects(p);
    assert.equal(effects?.publishes_live, true, p.path);
    assert.equal(effects.destructive, false);
    assert.match(effectReasons(p, [], effects)[0].reason, /publishes .* live/);
  }
  assert.equal(
    writeEffects(plan('gtm_native_action', 'PUT', '/tagmanager/v2/accounts/1/containers/2/workspaces/3/tags/4')),
    undefined,
  );
});

test('a plan step that deletes carries the disclosure in its next_call', async () => {
  const f = snapFixture();
  try {
    f.squads.set('old1', {id: 'old1', name: 'Old squad', campaign_id: 'camp-old', status: 'ACTIVE'});
    for (const resource of ['adsquads/old1', 'old1'])
      f.store.rememberResource({id: SNAP, tenantId: 'snap-plan', gateway: 'snapchat_native_action'}, 'acct1', resource);
    const step = {
      ...campaignStep('remove'),
      arguments: {action: 'snapchat_adsquad_delete', path_params: {ad_squad_id: 'old1'}},
    };
    const id = (await createPlan(f, [step])).data.id;
    const prepared = await f.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 1500));
    assert.ok(prepared.data.execute_requirements, JSON.stringify(prepared.data).slice(0, 2500));
    assert.equal(prepared.data.execute_requirements.effects.destructive, true);
    const disclose = prepared.data.next_call.disclose;
    assert.deepEqual(
      disclose.map(x => x.effect),
      ['destructive', 'stops_delivery'],
    );
    assert.match(disclose[0].reason, /"Old squad" \(old1\) \(current status: ACTIVE\)/);
    const approval = await f.call('amcp_campaign', {action: 'approve', id});
    assert.deepEqual(approval.data.approval.effects, [{step_id: 'remove', destructive: true, irreversible: true}]);
    assert.deepEqual(approval.data.next_call.disclose, approval.data.approval.effects);
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});

test('the website names the effects and the target in both languages, with provider values literal', () => {
  const context = createContext({
    document: {addEventListener() {}},
    $: () => undefined,
    Object,
    JSON,
    String,
    Number,
    Math,
    Map,
    Array,
    Date,
    encodeURIComponent,
    esc: value => String(value ?? ''),
    badge: String,
    date: String,
    blank: String,
    recordDetails: () => '',
    workspaceBind: () => {},
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/campaign-workflows.js', 'utf8')).runInContext(context);
  context.review = {
    expires_at: new Date(Date.now() + 60000).toISOString(),
    request: {method: 'DELETE'},
    effects: {destructive: true, irreversible: true, publishes_live: false, stops_delivery: true},
    execute_requirements: {
      confirmed: true,
      reasons: [
        {
          effect: 'destructive',
          reason: 'This deletes or removes "Spring launch" (111) (current status: ACTIVE). It cannot be undone.',
          target: {id: '111', name: 'Spring launch', status: 'ACTIVE'},
        },
      ],
    },
  };
  const english = new Script('readableReview(review, "Execute")').runInContext(context);
  assert.match(
    english,
    /Effects that need attention:<\/strong> Deletes or removes · Cannot be undone · Stops delivery/,
  );
  assert.match(
    english,
    /Target: <bdi dir="auto">Spring launch \(111\)<\/bdi> · Current status: <bdi dir="ltr">ACTIVE<\/bdi>/,
  );
  // A plain review shows no effect line.
  context.plain = {expires_at: context.review.expires_at, request: {}, execute_requirements: {confirmed: true}};
  assert.doesNotMatch(new Script('readableReview(plain, "Execute")').runInContext(context), /Effects that need/);
  context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  new Script('uiMessages = new Map(Object.entries(catalog))').runInContext(context);
  const arabic = new Script('readableReview(review, "Execute")').runInContext(context);
  for (const label of ['Effects that need attention:', 'Deletes or removes', 'Cannot be undone', 'Target:'])
    assert.ok(arabic.includes(context.catalog[label]), label);
  assert.doesNotMatch(arabic, /Effects that need attention|Current status:/);
  // Provider values stay literal.
  assert.match(arabic, /<bdi dir="auto">Spring launch \(111\)<\/bdi>/);
  assert.match(arabic, /<bdi dir="ltr">ACTIVE<\/bdi>/);
});
