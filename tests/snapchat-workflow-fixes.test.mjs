import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ScopeGuard} from '../dist/src/scope.js';
import {projectResponse} from '../dist/src/projection.js';
import {accountCurrency, accountTimezone} from '../dist/src/workspace.js';

/**
 * Regressions from a live Snapchat campaign clone (2026-09-25): null plan currency, ad squad read-back that
 * could never verify, prepare/execute ownership race, stalled independent steps, late pixel rejection,
 * dropped result_fields records and unclear execute/step errors. The synthetic API mirrors live behaviour:
 * GET never returns placement_v2, and records are wrapped as {adsquads:[{sub_request_status,adsquad}]}.
 */
const SNAP = '11111111-1111-4111-8111-111111111111',
  OTHER = '22222222-2222-4222-8222-222222222222';
const actor = {tenantId: 'snap-fix', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 77).toString('base64'),
  gateway = 'snapchat_native_action';
function fixture({echoPlacement = true, pixels = ['pixel-own'], currency = 'USD', readName = c => c.name} = {}) {
  const store = new Store(':memory:', key);
  const connection = {
    id: SNAP,
    tenantId: actor.tenantId,
    gateway,
    accounts: ['acct1'],
    writeAccounts: ['acct1'],
    enabled: true,
    label: 'Synthetic Snap',
    scopes: [],
  };
  store.putConnection(admin, connection, {accessToken: 'synthetic'});
  store.putConnection(admin, {...connection, id: OTHER, label: 'Other'}, {accessToken: 'other'});
  const campaigns = new Map(),
    squads = new Map(),
    writes = [];
  let requestId = 0;
  const ok = (kind, rows) =>
    Response.json({
      request_status: 'SUCCESS',
      request_id: 'r' + ++requestId,
      paging: {},
      [kind]: rows.map(r => ({sub_request_status: 'SUCCESS', [kind.slice(0, -1)]: r})),
    });
  const missing = () => Response.json({request_status: 'ERROR', debug_message: 'Not found'}, {status: 404});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const path = new URL(String(raw)).pathname,
      method = init.method ?? 'GET';
    let m;
    if (method === 'GET' && path === '/v1/adaccounts/acct1')
      return ok('adaccounts', [{id: 'acct1', name: 'Synthetic', currency, timezone: 'Asia/Riyadh'}]);
    if (method === 'GET' && path === '/v1/adaccounts/acct1/pixels')
      return ok(
        'pixels',
        pixels.map(id => ({id, name: 'Pixel'})),
      );
    if (method === 'POST' && path === '/v1/adaccounts/acct1/campaigns') {
      writes.push(method + ' ' + path);
      return ok(
        'campaigns',
        JSON.parse(init.body).campaigns.map(c => {
          const row = {...c, id: 'camp' + (campaigns.size + 1), ad_account_id: 'acct1'};
          campaigns.set(row.id, row);
          return row;
        }),
      );
    }
    if (method === 'GET' && (m = /^\/v1\/campaigns\/([^/]+)$/.exec(path))) {
      const c = campaigns.get(m[1]);
      return c ? ok('campaigns', [{...c, name: readName(c)}]) : missing();
    }
    if (method === 'GET' && (m = /^\/v1\/campaigns\/([^/]+)\/adsquads$/.exec(path)))
      return ok(
        'adsquads',
        [...squads.values()]
          .filter(s => s.campaign_id === m[1])
          .map(({placement_v2, ...s}) => ({...s, placement: 'UNSUPPORTED'})),
      );
    if (method === 'POST' && (m = /^\/v1\/campaigns\/([^/]+)\/adsquads$/.exec(path))) {
      writes.push(method + ' ' + path);
      return ok(
        'adsquads',
        JSON.parse(init.body).adsquads.map(a => {
          const row = {...a, id: 'squad' + (squads.size + 1), campaign_id: m[1]};
          squads.set(row.id, row);
          const echoed = {...row};
          if (!echoPlacement) delete echoed.placement_v2;
          return echoed;
        }),
      );
    }
    if (method === 'GET' && (m = /^\/v1\/adsquads\/([^/]+)$/.exec(path))) {
      const s = squads.get(m[1]);
      if (!s) return missing();
      const {placement_v2, ...read} = s;
      return ok('adsquads', [{...read, placement: 'UNSUPPORTED'}]);
    }
    throw new Error('Unexpected Snapchat request ' + method + ' ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  return {store, service, connection, writes, call: (tool, input) => service.call(tool, input, actor)};
}
const campaignBody = (name = 'Clone') => ({
  name,
  ad_account_id: 'acct1',
  status: 'PAUSED',
  start_time: '2026-10-01T00:00:00.000Z',
  buy_model: 'AUCTION',
  objective_v2_properties: {objective_v2_type: 'LEADS'},
});
const squadBody = (campaign, extra = {}) => ({
  campaign_id: campaign,
  name: 'Squad',
  type: 'SNAP_ADS',
  status: 'PAUSED',
  targeting: {geos: [{country_code: 'sa', operation: 'INCLUDE'}]},
  placement_v2: {config: 'AUTOMATIC'},
  billing_event: 'IMPRESSION',
  bid_strategy: 'AUTO_BID',
  daily_budget_micro: 20000000,
  optimization_goal: 'PIXEL_SIGNUP',
  pixel_id: 'pixel-own',
  ...extra,
});
const campaignRef = {$ref: 'campaign#/data/campaigns/0/campaign/id'};
const step = (id, args, extra = {}) => ({
  id,
  kind: 'write',
  gateway,
  connection_id: SNAP,
  account_id: 'acct1',
  arguments: args,
  ...extra,
});
const campaignStep = (id = 'campaign', name = 'Clone', extra = {}) =>
  step(id, {action: 'snapchat_campaign_create', payload: {campaigns: [campaignBody(name)]}}, extra);
const squadStep = (extra = {}, squad = {}) =>
  step(
    'squad',
    {
      action: 'snapchat_adsquad_create',
      path_params: {campaign_id: campaignRef},
      payload: {adsquads: [squadBody(campaignRef, squad)]},
    },
    {depends_on: ['campaign'], ...extra},
  );
const plan = (f, steps) =>
  f.call('amcp_campaign', {action: 'create', name: 'Snapchat clone', brief: 'Synthetic regression plan', steps});
async function runAll(f, id) {
  for (let i = 0; i < 12; i++) {
    const prepared = await f.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    if (!prepared.data.review) return prepared.data;
    // The synthetic user approves each reviewed step, including any spending acknowledgement the review asks for.
    const call = {...prepared.data.next_call.arguments, ...prepared.data.next_call.add_after_user_approval};
    const executed = await f.call('amcp_campaign', call);
    assert.equal(executed.success, true, JSON.stringify(executed));
    if (executed.data.state === 'complete') return executed.data;
  }
  throw new Error('Plan did not settle');
}

test('Snapchat plan preflight resolves the nested account currency instead of null', async () => {
  const f = fixture();
  try {
    const ready = await plan(f, [campaignStep('campaign', 'Clone', {expected_currency: 'USD'})]);
    assert.equal(ready.success, true, JSON.stringify(ready));
    const checked = await f.call('amcp_campaign', {action: 'preflight', id: ready.data.id});
    assert.equal(checked.data.preflight.status, 'ready', JSON.stringify(checked.data.preflight));
    const wrong = await plan(f, [campaignStep('campaign', 'Clone', {expected_currency: 'EUR'})]);
    const blocked = await f.call('amcp_campaign', {action: 'preflight', id: wrong.data.id}),
      error = blocked.data.missing_requirements[0].error;
    assert.equal(error.code, 'RECIPE_CURRENCY_MISMATCH');
    assert.deepEqual(error.details, {expected_currency: 'EUR', actual_currency: 'USD'});
    assert.equal(f.writes.length, 0);
    const live = await f.call('amcp_workspace', {
      action: 'check',
      connection_id: SNAP,
      account_id: 'acct1',
      live: true,
    });
    assert.equal(live.success, true, JSON.stringify(live));
    assert.deepEqual(live.data.account, {currency: 'USD', timezone: 'Asia/Riyadh'});
  } finally {
    f.store.close();
  }
});

test('account metadata reader unwraps every provider envelope the same way', () => {
  for (const [gw, data, currency, timezone] of [
    [gateway, {adaccounts: [{adaccount: {currency: 'USD', timezone: 'Asia/Riyadh'}}]}, 'USD', 'Asia/Riyadh'],
    [
      'tiktok_native_action',
      {code: 0, data: {list: [{currency: 'SAR', timezone: 'Asia/Riyadh'}]}},
      'SAR',
      'Asia/Riyadh',
    ],
    ['reddit_native_action', {data: {currency: 'EUR', time_zone_id: 'x'}}, 'EUR', null],
    [
      'google_ads_native_action',
      {results: [{customer: {currencyCode: 'JPY', timeZone: 'Asia/Tokyo'}}]},
      'JPY',
      'Asia/Tokyo',
    ],
    ['meta_native_action', {currency: 'GBP', timezone_name: 'Europe/London'}, 'GBP', 'Europe/London'],
    [
      'microsoft_ads_native_action',
      {Account: {CurrencyCode: 'CAD', TimeZone: 'EasternTimeUSCanada'}},
      'CAD',
      'EasternTimeUSCanada',
    ],
    [gateway, {request_status: 'ERROR'}, null, null],
  ]) {
    assert.equal(accountCurrency(gw, data), currency, gw);
    assert.equal(accountTimezone(gw, data), timezone, gw);
  }
});

test('preflight rejects an ad squad pixel the Snapchat account does not own before any write', async () => {
  const f = fixture();
  try {
    const foreign = await plan(f, [campaignStep(), squadStep({}, {pixel_id: 'pixel-shared-elsewhere'})]);
    const blocked = await f.call('amcp_campaign', {action: 'preflight', id: foreign.data.id});
    assert.equal(blocked.data.blocked, true);
    const error = blocked.data.missing_requirements.find(r => r.step === 'squad').error;
    assert.equal(error.code, 'SNAPCHAT_PIXEL_NOT_OWNED');
    assert.deepEqual(error.details, {pixel_ids: ['pixel-shared-elsewhere'], owned_pixel_ids: ['pixel-own']});
    const owned = await plan(f, [campaignStep(), squadStep()]);
    assert.equal(
      (await f.call('amcp_campaign', {action: 'preflight', id: owned.data.id})).data.preflight.status,
      'ready',
    );
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a Snapchat campaign and ad squad plan completes: placement_v2 is verified from the write acknowledgment', async () => {
  const f = fixture();
  try {
    const created = await plan(f, [
      campaignStep('campaign', 'Clone', {expected_currency: 'USD'}),
      squadStep({expected_currency: 'USD'}),
    ]);
    assert.equal(created.success, true, JSON.stringify(created));
    const done = await runAll(f, created.data.id);
    assert.equal(done.state, 'complete');
    const squad = (await f.call('amcp_campaign', {action: 'get', id: created.data.id, step_id: 'squad'})).data.step;
    assert.equal(squad.status, 'verified');
    const check = squad.verification.checks[0];
    assert.deepEqual(check.acknowledged_fields, ['placement_v2']);
    assert.ok(!check.checked_fields.includes('placement_v2'));
    assert.equal(check.unacknowledged_fields, undefined);
    assert.deepEqual(f.writes, ['POST /v1/adaccounts/acct1/campaigns', 'POST /v1/campaigns/camp1/adsquads']);
  } finally {
    f.store.close();
  }
});

test('an ad squad whose write response does not echo placement_v2 stays inconclusive', async () => {
  const f = fixture({echoPlacement: false});
  try {
    const created = await plan(f, [campaignStep(), squadStep()]);
    await runAll(f, created.data.id);
    const squad = (await f.call('amcp_campaign', {action: 'get', id: created.data.id, step_id: 'squad'})).data.step;
    assert.equal(squad.status, 'verifying');
    const check = squad.verification.checks[0];
    assert.equal(check.status, 'inconclusive');
    assert.equal(check.code, 'VERIFICATION_INCONCLUSIVE');
    assert.deepEqual(check.unacknowledged_fields, ['/placement_v2']);
    assert.deepEqual(check.changed_fields, []);
  } finally {
    f.store.close();
  }
});

test('an inconclusive step no longer stalls independent steps, but its dependants still wait', async () => {
  const f = fixture({readName: c => (c.name === 'Alpha' ? 'Alpha (edited elsewhere)' : c.name)});
  try {
    const created = await plan(f, [campaignStep('campaign', 'Alpha'), squadStep(), campaignStep('beta', 'Beta')]);
    const settled = await runAll(f, created.data.id);
    assert.notEqual(settled.state, 'complete');
    const run = (await f.call('amcp_campaign', {action: 'get', id: created.data.id})).data,
      status = Object.fromEntries(run.steps.map(s => [s.id, s.status]));
    // The name disagrees the same way on every read, so the campaign settles as a mismatch awaiting the user (S5).
    // It still holds only its dependant: the independent campaign ran.
    assert.deepEqual(status, {campaign: 'mismatch', squad: 'pending', beta: 'verified'});
    assert.deepEqual(f.writes, ['POST /v1/adaccounts/acct1/campaigns', 'POST /v1/adaccounts/acct1/campaigns']);
  } finally {
    f.store.close();
  }
});

test('prepare re-confirms a Snapchat parent owner and renews ownership through the review window', async () => {
  const f = fixture();
  try {
    const expiry = resource =>
      f.store.db.prepare('SELECT expires_at FROM resource_ownership WHERE resource=?').get(resource).expires_at;
    const age = (resource, at) =>
      f.store.db.prepare('UPDATE resource_ownership SET expires_at=? WHERE resource=?').run(at, resource);
    const campaign = await f.call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: SNAP,
      arguments: {action: 'snapchat_campaign_create', account_id: 'acct1', payload: {campaigns: [campaignBody()]}},
    });
    assert.equal(campaign.success, true, JSON.stringify(campaign));
    assert.equal(
      (
        await f.call('amcp_write', {
          action: 'execute',
          review_id: campaign.data.review_id,
          idempotency_key: campaign.data.review_id,
          confirmed: true,
        })
      ).success,
      true,
    );
    age('campaigns/camp1', Date.now() + 1000);
    const squad = await f.call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: SNAP,
      arguments: {
        action: 'snapchat_adsquad_create',
        account_id: 'acct1',
        path_params: {campaign_id: 'camp1'},
        payload: {adsquads: [squadBody('camp1')]},
      },
    });
    // The observation had 1s left (the live failure: prepare at +4m53s, execute at +5m05s). Prepare's own
    // campaign read names ad_account_id, so ownership now lasts as long as the review itself.
    assert.equal(squad.success, true, JSON.stringify(squad));
    assert.ok(
      expiry('campaigns/camp1') >= Date.parse(squad.data.expires_at) - 5000,
      'the campaign read renewed ownership for the review window',
    );
    const id = squad.data.review_id,
      execute = extra =>
        f.call('amcp_write', {
          action: 'execute',
          review_id: id,
          idempotency_key: id,
          confirmed: true,
          spend_change_confirmed: true,
          ...extra,
        });
    assert.equal((await execute({connection_id: OTHER})).error.code, 'INVALID_ARGUMENT');
    assert.match((await execute({arguments: {}})).error.message, /frozen at prepare/);
    assert.equal(f.writes.length, 1);
    const done = await execute({gateway, connection_id: SNAP});
    assert.equal(done.success, true, JSON.stringify(done));
    assert.deepEqual(f.writes, ['POST /v1/adaccounts/acct1/campaigns', 'POST /v1/campaigns/camp1/adsquads']);
    // Re-provisioning still clears every observation, and no read can revive it: authorize() runs before the read.
    f.store.putConnection(admin, f.connection, {accessToken: 'synthetic'});
    const again = await f.call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: SNAP,
      arguments: {
        action: 'snapchat_adsquad_create',
        account_id: 'acct1',
        path_params: {campaign_id: 'camp1'},
        payload: {adsquads: [squadBody('camp1')]},
      },
    });
    assert.equal(again.error.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal(f.writes.length, 2);
  } finally {
    f.store.close();
  }
});

test('a single-entity read refreshes ownership only when Snapchat names the owning account or an owned parent', () => {
  const f = fixture();
  try {
    const guard = new ScopeGuard(new Registry(), f.store),
      expiry = r => f.store.db.prepare('SELECT expires_at FROM resource_ownership WHERE resource=?').get(r)?.expires_at;
    const read = path => ({
      gateway,
      accountId: 'acct1',
      action: 'synthetic_read',
      method: 'GET',
      path,
      query: {},
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'fixture',
      warnings: [],
    });
    const envelope = (kind, row) => ({
      request_status: 'SUCCESS',
      [kind]: [{sub_request_status: 'SUCCESS', [kind.slice(0, -1)]: row}],
    });
    const soon = Date.now() + 1000,
      remember = r => {
        f.store.rememberResource(f.connection, 'acct1', r);
        f.store.db.prepare('UPDATE resource_ownership SET expires_at=? WHERE resource=?').run(soon, r);
      };
    remember('campaigns/foreign');
    guard.observe(
      read('/v1/campaigns/foreign'),
      f.connection,
      envelope('campaigns', {id: 'foreign', ad_account_id: 'another-account'}),
    );
    assert.equal(expiry('campaigns/foreign'), soon);
    remember('campaigns/mine');
    guard.observe(
      read('/v1/campaigns/mine'),
      f.connection,
      envelope('campaigns', {id: 'mine', ad_account_id: 'acct1'}),
    );
    assert.ok(expiry('campaigns/mine') > soon + 200000);
    remember('adsquads/orphan');
    guard.observe(
      read('/v1/adsquads/orphan'),
      f.connection,
      envelope('adsquads', {id: 'orphan', campaign_id: 'unowned'}),
    );
    assert.equal(expiry('adsquads/orphan'), soon);
    remember('adsquads/child');
    guard.observe(read('/v1/adsquads/child'), f.connection, envelope('adsquads', {id: 'child', campaign_id: 'mine'}));
    assert.ok(expiry('adsquads/child') > soon + 200000);
    guard.observe(read('/v1/adaccounts/acct1/pixels'), f.connection, envelope('pixels', {id: 'pixel-own'}));
    assert.ok(expiry('pixels/pixel-own') > Date.now());
  } finally {
    f.store.close();
  }
});

test('result_fields keeps every Snapchat ad squad record and projects inside its wrapper', async () => {
  const envelope = {
    request_status: 'SUCCESS',
    request_id: 'r1',
    paging: {},
    adsquads: [
      {sub_request_status: 'SUCCESS', adsquad: {id: 's1', name: 'Squad', status: 'PAUSED', targeting: {geos: []}}},
    ],
  };
  // status is diagnostic metadata that projection always keeps, as for every provider.
  assert.deepEqual(projectResponse(envelope, {fields: ['id', 'name'], compact: false}, gateway).data, {
    request_status: 'SUCCESS',
    request_id: 'r1',
    paging: {},
    adsquads: [{sub_request_status: 'SUCCESS', adsquad: {id: 's1', name: 'Squad', status: 'PAUSED'}}],
  });
  const f = fixture();
  try {
    const created = await plan(f, [campaignStep(), squadStep()]);
    await runAll(f, created.data.id);
    const listed = await f.call(gateway, {
      action: 'snapchat_campaign_adsquads_list',
      connection_id: SNAP,
      account_id: 'acct1',
      path_params: {campaign_id: 'camp1'},
      result_fields: ['id', 'name'],
    });
    assert.equal(listed.success, true, JSON.stringify(listed));
    assert.deepEqual(
      listed.data.data.adsquads.map(r => r.adsquad),
      [{id: 'squad1', name: 'Squad', status: 'PAUSED'}],
    );
  } finally {
    f.store.close();
  }
});

test('plan step errors name the invalid field and the expected step shape', async () => {
  const f = fixture();
  try {
    const probe = await plan(f, [
      {id: 's1', kind: '__probe__', connection_id: SNAP, account_id: 'acct1', arguments: {}},
    ]);
    assert.equal(probe.success, false);
    assert.match(probe.error.message, /kind must be "write" or "media"/);
    assert.match(probe.error.message, /\$ref/);
    const noGateway = await plan(f, [
      {id: 's1', kind: 'write', connection_id: SNAP, account_id: 'acct1', arguments: {}},
    ]);
    assert.match(noGateway.error.message, /a write step needs gateway/);
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 0);
  } finally {
    f.store.close();
  }
});
