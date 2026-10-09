import test from 'node:test';
import assert from 'node:assert/strict';
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
