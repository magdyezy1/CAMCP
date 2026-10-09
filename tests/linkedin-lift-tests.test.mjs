import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * LinkedIn brand lift tests (Brand Lift Testing: Overview, Lift Test Management API, Lift Test Survey Management API;
 * li-lms-2025-10 to li-lms-2026-09, read 2026-09-30). A test starts at 00:00 UTC and ends at 23:45 UTC, runs 3 to 90
 * days within 180 days, and becomes READY only with survey questions.
 */
const registry = new Registry(),
  gateway = 'linkedin_native_action';
const actor = {tenantId: 'linkedin-lift-tests', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const actions = {
  create: 'linkedin_rest_ad_lift_tests_post',
  update: 'linkedin_rest_ad_lift_tests_ad_lift_test_id_post',
  updateAlias: 'linkedin_rest_ad_lift_tests_lift_test_id_post',
  remove: 'linkedin_rest_ad_lift_tests_ad_lift_test_id_delete',
  removeAlias: 'linkedin_rest_ad_lift_tests_lift_test_id_delete',
  surveys: 'linkedin_rest_ad_lift_tests_ad_lift_test_id_ad_lift_test_surveys_delete',
  surveysAlias: 'linkedin_rest_ad_lift_tests_lift_test_id_ad_lift_test_surveys_delete',
  addSurveys: 'linkedin_rest_ad_lift_tests_lift_test_id_ad_lift_test_surveys_post',
};
const idParam = action =>
  /_lift_test_id_/.test(action) && !/_ad_lift_test_id_/.test(action) ? 'lift_test_id' : 'ad_lift_test_id';
const acct = 'urn:li:sponsoredAccount:507',
  group = id => 'urn:li:sponsoredCampaignGroup:' + id,
  day = 86400000,
  quarter = 15 * 60000;
const midnight = Math.floor(Date.now() / day) * day,
  start = midnight + 7 * day,
  end = start + 21 * day - quarter;
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 94).toString('base64'));
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
  const groups = {
    21: {status: 'ACTIVE'},
    22: {status: 'PAUSED'},
    23: {status: 'CANCELED'},
  };
  const base = {
    account: acct,
    liftEntity: {account: acct},
    brandName: 'Badger',
    brandNameLocale: {language: 'en', country: 'US'},
    schedule: {start, end},
  };
  const tests = new Map([
    [700, {...base, name: 'Draft with questions', userState: 'DRAFT', executionState: 'CREATED'}],
    [701, {...base, name: 'Draft without questions', userState: 'DRAFT', executionState: 'CREATED'}],
    [702, {...base, name: 'Scheduled', userState: 'READY', executionState: 'SCHEDULED'}],
    [703, {...base, name: 'Ended', userState: 'READY', executionState: 'ENDED'}],
    [704, {...base, name: 'Canceled', userState: 'CANCELED', executionState: 'ENDED'}],
    [
      705,
      {...base, account: 'urn:li:sponsoredAccount:999', name: 'Foreign', userState: 'DRAFT', executionState: 'CREATED'},
    ],
    [706, {...base, name: 'Resumable', userState: 'READY', executionState: 'ENDED_RESUMABLE'}],
  ]);
  const surveys = new Map([
    [700, ['AWARENESS', 'RECALL']],
    [701, []],
  ]);
  let next = 800,
    writes = 0;
  const calls = [];
  const notFound = () => Response.json({status: 404, serviceErrorCode: 100, message: 'Not found'}, {status: 404});
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET',
      headers = new Headers(init?.headers);
    calls.push({method, path: url.pathname, search: url.search});
    assert.equal(headers.get('x-restli-protocol-version'), '2.0.0');
    if (method === 'GET' && url.pathname === '/rest/adAccounts/507') return Response.json({id: 507, status: 'ACTIVE'});
    let m = /^\/rest\/adAccounts\/507\/adCampaignGroups\/(\d+)$/.exec(url.pathname);
    if (method === 'GET' && m)
      return groups[m[1]] ? Response.json({id: Number(m[1]), account: acct, ...groups[m[1]]}) : notFound();
    if (method === 'GET' && url.pathname === '/rest/adLiftTests') {
      assert.equal(url.searchParams.get('q'), 'criteria');
      assert.equal(url.searchParams.get('account'), acct);
      const rows = [...tests]
        .filter(([, t]) => t.account === acct && t.executionState === url.searchParams.get('executionState'))
        .map(([id, t]) => ({id, ...t}));
      return Response.json({elements: rows, paging: {start: 0, count: 100, total: rows.length}});
    }
    m = /^\/rest\/adLiftTests\/(\d+)\/adLiftTestSurveys$/.exec(url.pathname);
    if (method === 'GET' && m)
      return Response.json({
        elements: (surveys.get(Number(m[1])) ?? []).map(id => ({id, adLiftTest: 'urn:li:adLiftTest:' + m[1]})),
        paging: {start: 0, count: 10},
      });
    if (method === 'DELETE' && m) {
      writes++;
      const ids = /^List\((.*)\)$/.exec(url.searchParams.get('ids'))[1].split(',');
      if (o.mode !== 'ignore')
        surveys.set(
          Number(m[1]),
          surveys.get(Number(m[1])).filter(x => !ids.includes(x)),
        );
      return new Response(null, {status: 204});
    }
    m = /^\/rest\/adLiftTests\/(\d+)$/.exec(url.pathname);
    if (method === 'GET' && m)
      return tests.has(Number(m[1])) ? Response.json({id: Number(m[1]), ...tests.get(Number(m[1]))}) : notFound();
    writes++;
    if (method === 'POST' && url.pathname === '/rest/adLiftTests') {
      const b = JSON.parse(String(init.body)),
        id = next++;
      if (o.mode !== 'ignore') tests.set(id, {...b, executionState: 'CREATED'});
      return new Response(JSON.stringify({id, ...b, executionState: 'CREATED'}), {
        status: 201,
        headers: {'content-type': 'application/json', 'x-restli-id': String(id)},
      });
    }
    if (method === 'POST' && m) {
      assert.equal(headers.get('x-restli-method'), 'PARTIAL_UPDATE');
      const b = JSON.parse(String(init.body)),
        t = tests.get(Number(m[1]));
      if (o.mode !== 'ignore') {
        Object.assign(t, b.patch.$set);
        if (b.patch.$set.userState === 'READY') {
          t.executionState = 'SCHEDULED';
          for (const other of tests.values())
            if (other.account === acct && other.executionState === 'ENDED_RESUMABLE') other.executionState = 'ENDED';
        }
      }
      return new Response(null, {status: 204});
    }
    if (method === 'DELETE' && m) {
      const t = tests.get(Number(m[1]));
      if (t.executionState !== 'CREATED')
        return Response.json({status: 422, code: 'DELETE_NOT_ALLOWED'}, {status: 422});
      if (o.mode !== 'ignore') tests.delete(Number(m[1]));
      return new Response(null, {status: 204});
    }
    throw Error('Unexpected ' + method + ' ' + url.pathname);
  };
  const service = new MirrorService(registry, store, new NativeTransport(fetcher), undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = args =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: {account_id: '507', ...args}}, actor);
  const create = payload => prepare({action: actions.create, payload});
  const update = (id, set, action = actions.update, extra = {}) =>
    prepare({
      action,
      restli_method: 'PARTIAL_UPDATE',
      path_params: {[idParam(action)]: String(id)},
      payload: {patch: {$set: set}},
      ...extra,
    });
  const remove = (id, action = actions.remove) => prepare({action, path_params: {[idParam(action)]: String(id)}});
  const dropQuestions = (id, ids, action = actions.surveys, extra = {}) =>
    prepare({action, path_params: {[idParam(action)]: String(id)}, query: {ids}, ...extra});
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
  return {
    store,
    calls,
    tests,
    surveys,
    create,
    update,
    remove,
    dropQuestions,
    prepare,
    execute,
    verify,
    writes: () => writes,
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const draft = (extra = {}) => ({
  account: acct,
  liftEntity: {campaignGroups: [group(22), group(21)]},
  name: 'Q4 brand lift',
  brandName: 'Badger',
  brandNameLocale: {language: 'en', country: 'US'},
  description: 'Awareness after the autumn push',
  schedule: {start, end},
  userState: 'DRAFT',
  ...extra,
});

test('a draft lift test is created on campaign groups and verifies; READY needs confirmation, counts as activation and ends resumable tests; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const p = ok(await f.create(draft()));
    assert.equal(p.data.creative_impact.scope, 'lift_test');
    assert.match(p.data.creative_impact.effect, /without running it/);
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const run = ok(await f.update(700, {userState: 'READY'}, actions.updateAlias));
    assert.deepEqual(run.data.creative_impact.questions, ['AWARENESS', 'RECALL']);
    assert.deepEqual(run.data.creative_impact.resumable_tests_ended, [{id: '706', name: 'Resumable'}]);
    assert.match(run.data.creative_impact.effect, /control group/);
    assert.equal((await f.execute(run)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(run, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(run)).data.status, 'verified');
    const rename = ok(await f.update(702, {name: 'Scheduled, renamed'}));
    ok(await f.execute(rename));
    assert.equal(ok(await f.verify(rename)).data.status, 'verified');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, admin, {gateway, account_id: '507', confirmed: true, policy: {allow_activation: false}});
    assert.equal((await g.update(700, {userState: 'READY'})).error?.code, 'POLICY_ACTIVATION_FORBIDDEN');
    ok(await g.update(700, {name: 'Renamed draft'}));
  } finally {
    g.store.close();
  }
});

test('a draft test and its survey questions are deleted and verify; canceling warns that it cannot be undone', async () => {
  const f = fixture();
  try {
    const q = ok(await f.dropQuestions(700, ['RECALL'], actions.surveysAlias));
    assert.deepEqual(q.data.creative_impact.questions_removed, ['RECALL']);
    ok(await f.execute(q));
    assert.deepEqual(f.surveys.get(700), ['AWARENESS']);
    assert.equal(ok(await f.verify(q)).data.status, 'verified');
    const d = ok(await f.remove(701, actions.removeAlias));
    ok(await f.execute(d));
    assert.equal(f.tests.has(701), false);
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    const c = ok(await f.update(702, {userState: 'CANCELED'}));
    assert.match(JSON.stringify(c.data), /cannot be undone/);
    ok(await f.execute(c));
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, admin, {gateway, account_id: '507', confirmed: true, policy: {allow_deletion: false}});
    assert.equal((await g.remove(701)).error?.code, 'POLICY_DELETION_FORBIDDEN');
    assert.equal((await g.dropQuestions(700, ['RECALL'])).error?.code, 'POLICY_DELETION_FORBIDDEN');
  } finally {
    g.store.close();
  }
});

test('malformed lift tests are refused before any request', async () => {
  const f = fixture();
  try {
    const cases = [
      ['start not at midnight', draft({schedule: {start: start + 3600000, end}})],
      ['end not at 23:45', draft({schedule: {start, end: end + quarter}})],
      ['shorter than 3 days', draft({schedule: {start, end: start + 2 * day - quarter}})],
      ['longer than 90 days', draft({schedule: {start, end: start + 91 * day - quarter}})],
      ['start in the past', draft({schedule: {start: midnight - day, end}})],
      ['end beyond 180 days', draft({schedule: {start, end: midnight + 200 * day - quarter}})],
      ['READY at creation', draft({userState: 'READY'})],
      ['another account', draft({account: 'urn:li:sponsoredAccount:999'})],
      ['another account as the entity', draft({liftEntity: {account: 'urn:li:sponsoredAccount:999'}})],
      ['the 202510 campaign group', draft({liftEntity: {campaignGroup: group(21)}})],
      ['a repeated group', draft({liftEntity: {campaignGroups: [group(21), group(21)]}})],
      [
        'more than 50 groups',
        draft({liftEntity: {campaignGroups: Array.from({length: 51}, (_, i) => group(100 + i))}}),
      ],
      ['an unknown field', draft({budget: 5})],
      ['a bad locale', draft({brandNameLocale: {language: 'EN', country: 'us'}})],
      ['a long name', draft({name: 'x'.repeat(201)})],
      ['a long description', draft({description: 'x'.repeat(1001)})],
    ];
    for (const [label, payload] of cases)
      assert.equal((await f.create(payload)).error?.code, 'INVALID_LINKEDIN_LIFT_TEST', label);
    assert.equal((await f.update(700, {account: acct})).error?.code, 'INVALID_LINKEDIN_LIFT_TEST');
    assert.equal(
      (
        await f.prepare({
          action: actions.update,
          path_params: {ad_lift_test_id: '700'},
          payload: {patch: {$set: {name: 'x'}}},
        })
      ).error?.code,
      'INVALID_LINKEDIN_LIFT_TEST',
      'without PARTIAL_UPDATE',
    );
    assert.equal((await f.update(700, {userState: 'PAUSED'})).error?.code, 'INVALID_LINKEDIN_LIFT_TEST');
    assert.equal((await f.dropQuestions(700, ['SENTIMENT'])).error?.code, 'INVALID_LINKEDIN_LIFT_TEST');
    assert.equal(
      (await f.dropQuestions(700, ['RECALL'], actions.surveys, {query: {ids: ['RECALL'], fields: 'id'}})).error?.code,
      'INVALID_LINKEDIN_LIFT_TEST',
    );
    assert.equal(
      (await f.prepare({action: actions.create, api_version: '202510', payload: draft()})).error?.code,
      // PRV-02: 202510 is outside the reviewed LinkedIn-Version window and refused before the family's 202511 gate.
      'API_VERSION_UNREVIEWED',
      'campaign groups before 202511',
    );
    assert.equal(f.writes(), 0);
    assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
  } finally {
    f.store.close();
  }
});

test('lift tests that cannot take the change are refused after reading, without writes', async () => {
  const f = fixture();
  try {
    const cases = [
      ['READY without questions', await f.update(701, {userState: 'READY'})],
      ['a scheduled test changes its brand', await f.update(702, {brandName: 'Other'})],
      ['a scheduled test moves its start', await f.update(702, {schedule: {start: start + day, end}})],
      ['an ended test', await f.update(703, {name: 'Again'})],
      ['a canceled test', await f.update(704, {name: 'Again'})],
      ['back to DRAFT', await f.update(702, {userState: 'DRAFT'})],
      ['unchanged', await f.update(700, {name: 'Draft with questions'})],
      ['a canceled campaign group', await f.create(draft({liftEntity: {campaignGroups: [group(23)]}}))],
      ['a scheduled test is deleted', await f.remove(702)],
      ['questions of a scheduled test', await f.dropQuestions(702, ['RECALL'])],
      ['a question the test does not have', await f.dropQuestions(700, ['FAVORABILITY'])],
    ];
    for (const [label, r] of cases)
      assert.equal(r.error?.code, 'INVALID_LINKEDIN_LIFT_TEST', label + ': ' + JSON.stringify(r).slice(0, 300));
    assert.equal((await f.update(705, {name: 'Mine'})).error?.code, 'ACCOUNT_SCOPE_MISMATCH');
    assert.equal((await f.create(draft({liftEntity: {campaignGroups: [group(29)]}}))).error?.code, 'STATE_NOT_FOUND');
    assert.equal((await f.update(799, {name: 'Missing'})).error?.code, 'STATE_NOT_FOUND');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('an ignored write is not verified, and the ledger lists the family and the reason for new survey questions', async () => {
  const f = fixture({mode: 'ignore'});
  try {
    const p = ok(await f.update(700, {name: 'Ignored'}));
    ok(await f.execute(p));
    assert.notEqual((await f.verify(p)).data?.status, 'verified');
    const q = ok(await f.dropQuestions(700, ['RECALL']));
    ok(await f.execute(q));
    assert.notEqual((await f.verify(q)).data?.status, 'verified');
  } finally {
    f.store.close();
  }
  const rows = actionContracts(registry);
  const row = action => rows.find(r => r.gateway === gateway && r.action === action);
  for (const action of Object.values(actions).filter(a => a !== actions.addSurveys)) {
    assert.equal(row(action)?.status, 'reviewed_write_family', action);
    assert.equal(row(action).family, 'linkedin_lift_tests', action);
  }
  assert.equal(row(actions.addSurveys)?.status, 'blocked_write');
  assert.match(row(actions.addSurveys).reason, /no request body/);
});
