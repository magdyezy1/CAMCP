import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * LinkedIn A/B tests ("A/B Testing Management API", li-lms-2025-10 to li-lms-2026-09, checked 2026-09-27).
 */
const registry = new Registry(),
  gateway = 'linkedin_native_action';
const actor = {tenantId: 'linkedin-ab-tests', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const actions = {
  create: 'linkedin_rest_ad_experiments_post',
  update: 'linkedin_rest_ad_experiments_ad_experiment_id_post',
  updateAlias: 'linkedin_rest_ad_experiments_experiment_id_post',
  remove: 'linkedin_rest_ad_experiments_ad_experiment_id_delete',
  removeAlias: 'linkedin_rest_ad_experiments_experiment_id_delete',
};
const acct = 'urn:li:sponsoredAccount:507',
  camp = id => 'urn:li:sponsoredCampaign:' + id,
  day = 86400000;
const cell = (id, weight, name = 'Cell ' + id) => ({name, trafficWeight: weight, reference: {campaign: camp(id)}});
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'li',
      tenantId: actor.tenantId,
      gateway,
      enabled: true,
      accounts: ['507'],
      writeAccounts: ['507'],
      scopes: ['rw_ads'],
      label: 'Synthetic LinkedIn',
    },
    {accessToken: 'synthetic'},
  );
  const campaigns = {
    11: {status: 'ACTIVE', campaignGroup: 'urn:li:sponsoredCampaignGroup:1'},
    12: {status: 'PAUSED', campaignGroup: 'urn:li:sponsoredCampaignGroup:1'},
    13: {status: 'ACTIVE', campaignGroup: 'urn:li:sponsoredCampaignGroup:2'},
    14: {status: 'CANCELED', campaignGroup: 'urn:li:sponsoredCampaignGroup:1'},
  };
  const soon = Date.now() + 7 * day,
    later = Date.now() + 37 * day;
  const experiments = new Map([
    [
      500,
      {
        account: acct,
        name: 'Headline test',
        keyMetric: 'CPC',
        confidence: 90,
        scheduledStartAt: soon,
        scheduledEndAt: later,
        userIntendedState: 'DRAFT',
        autoStop: 'AUTO_STOP_AT_END_DATE',
        executionState: 'PENDING',
        cells: [cell(11, 50), cell(12, 50)],
      },
    ],
    [
      501,
      {
        account: acct,
        name: 'Running test',
        keyMetric: 'CPM',
        confidence: 90,
        scheduledStartAt: Date.now() - day,
        scheduledEndAt: later,
        userIntendedState: 'ACTIVE',
        autoStop: 'AUTO_STOP_AT_END_DATE',
        executionState: 'RUNNING',
        cells: [cell(11, 50), cell(12, 50)],
      },
    ],
    [
      502,
      {
        account: acct,
        name: 'Old test',
        keyMetric: 'CPC',
        confidence: 90,
        scheduledStartAt: Date.now() - 60 * day,
        scheduledEndAt: Date.now() - 30 * day,
        userIntendedState: 'ACTIVE',
        executionState: 'ENDED',
        cells: [cell(11, 50), cell(12, 50)],
      },
    ],
    [
      503,
      {
        account: 'urn:li:sponsoredAccount:999',
        name: 'Foreign',
        keyMetric: 'CPC',
        confidence: 90,
        scheduledStartAt: soon,
        scheduledEndAt: later,
        userIntendedState: 'DRAFT',
        executionState: 'PENDING',
        cells: [],
      },
    ],
  ]);
  let next = 600,
    writes = 0;
  const calls = [];
  const notFound = () => Response.json({status: 404, serviceErrorCode: 100, message: 'Not found'}, {status: 404});
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET',
      headers = new Headers(init?.headers);
    calls.push({method, path: url.pathname});
    assert.equal(headers.get('x-restli-protocol-version'), '2.0.0');
    if (method === 'GET' && url.pathname === '/rest/adAccounts/507')
      return Response.json({id: 507, status: 'ACTIVE', currency: 'USD'});
    let m = /^\/rest\/adAccounts\/507\/adCampaigns\/(\d+)$/.exec(url.pathname);
    if (method === 'GET' && m)
      return campaigns[m[1]] ? Response.json({id: Number(m[1]), account: acct, ...campaigns[m[1]]}) : notFound();
    m = /^\/rest\/adExperiments\/(\d+)$/.exec(url.pathname);
    if (method === 'GET' && m)
      return experiments.has(Number(m[1]))
        ? Response.json({id: Number(m[1]), ...experiments.get(Number(m[1]))})
        : notFound();
    writes++;
    if (method === 'POST' && url.pathname === '/rest/adExperiments') {
      const b = JSON.parse(String(init.body)),
        id = next++;
      const row = {...b, autoStop: b.autoStop ?? 'AUTO_STOP_AT_END_DATE', executionState: 'PENDING'};
      if (o.mode !== 'ignore') experiments.set(id, row);
      return new Response(JSON.stringify({id, ...row}), {
        status: 201,
        headers: {'content-type': 'application/json', 'x-restli-id': String(id)},
      });
    }
    if (method === 'POST' && m) {
      assert.equal(headers.get('x-restli-method'), 'PARTIAL_UPDATE');
      const b = JSON.parse(String(init.body));
      if (o.mode !== 'ignore') Object.assign(experiments.get(Number(m[1])), b.patch.$set);
      return new Response(null, {status: 204});
    }
    if (method === 'DELETE' && m) {
      const e = experiments.get(Number(m[1]));
      if (e.executionState !== 'PENDING')
        return Response.json({status: 405, message: 'DELETION_NOT_ALLOWED'}, {status: 405});
      if (o.mode !== 'ignore') experiments.delete(Number(m[1]));
      return new Response(null, {status: 204});
    }
    throw Error('Unexpected ' + method + ' ' + url.pathname);
  };
  const service = new MirrorService(registry, store, new NativeTransport(fetcher), undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const create = payload =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action: actions.create, account_id: '507', payload}},
      actor,
    );
  const update = (id, set, action = actions.update, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action,
          account_id: '507',
          restli_method: 'PARTIAL_UPDATE',
          path_params: {[action === actions.updateAlias ? 'experiment_id' : 'ad_experiment_id']: String(id)},
          payload: {patch: {$set: set}},
          ...extra,
        },
      },
      actor,
    );
  const remove = (id, action = actions.remove) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action,
          account_id: '507',
          path_params: {[action === actions.removeAlias ? 'experiment_id' : 'ad_experiment_id']: String(id)},
        },
      },
      actor,
    );
  const execute = (p, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, experiments, create, update, remove, execute, verify, writes: () => writes, soon, later};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const draft = (f, extra = {}) => ({
  account: acct,
  name: 'Image vs video',
  keyMetric: 'CPC',
  confidence: 90,
  scheduledStartAt: f.soon,
  scheduledEndAt: f.later,
  userIntendedState: 'DRAFT',
  cells: [cell(11, 60), cell(12, 40)],
  ...extra,
});

test('a draft experiment is created without confirmation and verifies; running it needs confirmation and counts as activation; a pending one is deleted; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const p = ok(await f.create(draft(f)));
    assert.equal(p.data.creative_impact.scope, 'ab_test');
    assert.match(p.data.creative_impact.effect, /without running it/);
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const run = ok(await f.update(600, {userIntendedState: 'ACTIVE'}));
    assert.equal((await f.execute(run)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(run, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(run)).data.status, 'verified');
    const d = ok(await f.remove(500, actions.removeAlias));
    ok(await f.execute(d));
    assert.equal(f.experiments.has(500), false);
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, admin, {gateway, account_id: '507', confirmed: true, policy: {allow_activation: false}});
    assert.equal((await g.create(draft(g, {userIntendedState: 'ACTIVE'}))).error?.code, 'POLICY_ACTIVATION_FORBIDDEN');
    ok(await g.create(draft(g)));
  } finally {
    g.store.close();
  }
});

test('a running experiment changes only its late fields; cell names change with the same campaigns and weights', async () => {
  const f = fixture();
  try {
    const p = ok(
      await f.update(
        501,
        {
          name: 'Running test v2',
          scheduledEndAt: f.later + day,
          cells: [cell(11, 50, 'Control'), cell(12, 50, 'Video')],
        },
        actions.updateAlias,
      ),
    );
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.match((await f.update(501, {keyMetric: 'CPM'})).error?.message ?? '', /has started; keyMetric/);
    assert.match(
      (await f.update(501, {cells: [cell(11, 70), cell(12, 30)]})).error?.message ?? '',
      /same campaigns and weights/,
    );
    assert.match((await f.update(502, {name: 'Renamed'})).error?.message ?? '', /has ended/);
  } finally {
    f.store.close();
  }
});

test('malformed experiments are refused before any request', async () => {
  const f0 = fixture(),
    base = draft(f0);
  f0.store.close();
  const cases = [
    ['one cell', {...base, cells: [cell(11, 100)]}],
    ['weights', {...base, cells: [cell(11, 60), cell(12, 60)]}],
    ['same campaign', {...base, cells: [cell(11, 50), cell(11, 50)]}],
    ['confidence', {...base, confidence: 40}],
    ['metric', {...base, keyMetric: 'CPA'}],
    ['too long', {...base, scheduledEndAt: base.scheduledStartAt + 91 * day}],
    ['end before start', {...base, scheduledEndAt: base.scheduledStartAt - day}],
    ['paused at creation', {...base, userIntendedState: 'PAUSED'}],
    ['other account', {...base, account: 'urn:li:sponsoredAccount:999'}],
    ['long name', {...base, name: 'n'.repeat(101)}],
  ];
  for (const [label, payload] of cases) {
    const f = fixture();
    try {
      const r = await f.create(payload);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label + ': ' + JSON.stringify(r).slice(0, 300));
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const r = await f.update(500, {account: acct});
    assert.equal(r.success, false);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('other groups, unservable or foreign campaigns, foreign, unknown or started experiments and unchanged values are refused after reading; an ignored change is not verified; the ledger lists the five writes', async () => {
  const f = fixture();
  try {
    assert.match(
      (await f.create(draft(f, {cells: [cell(11, 50), cell(13, 50)]}))).error?.message ?? '',
      /same campaign group/,
    );
    assert.match((await f.create(draft(f, {cells: [cell(11, 50), cell(14, 50)]}))).error?.message ?? '', /CANCELED/);
    assert.equal((await f.create(draft(f, {cells: [cell(11, 50), cell(99, 50)]}))).error?.code, 'STATE_NOT_FOUND');
    assert.equal((await f.update(503, {name: 'Mine'})).error?.code, 'ACCOUNT_SCOPE_MISMATCH');
    assert.equal((await f.remove(509)).error?.code, 'STATE_NOT_FOUND');
    assert.match((await f.remove(501)).error?.message ?? '', /only PENDING/);
    assert.match((await f.update(500, {name: 'Headline test'})).error?.message ?? '', /already has these values/);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const g = fixture({mode: 'ignore'});
  try {
    const p = ok(await g.update(500, {name: 'Ignored'}));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'linkedin_ab_tests', action);
  }
});
