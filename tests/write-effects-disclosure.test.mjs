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
