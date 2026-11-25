import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {saveSpendPolicy, checkSpendPolicy, exceededCaps} from '../dist/src/spend-policy.js';
import {spendConfirmationError} from '../dist/src/preflight.js';
import {assertWriteShape} from '../dist/src/write-shape.js';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/*
 * r25-mf-caps (the audit of f6f5490d, 2026-11-25): PUT /v1/adaccounts/{id}/campaigns replaces whole records. A campaign PUT that
 * left its caps out was read as clearing nothing: the owner policy compared no amount and the review asked for no spend
 * confirmation (a name-only PUT), so a daily budget or a lifetime spend cap the campaign held could go without either. The
 * repository's own contract for every Snapchat PUT is that it can reset what it omits (ad squads and ads refuse it with
 * INCOMPLETE_SNAPCHAT_REPLACEMENT); the audit could not confirm that an omitted cap is cleared, so the policy fails closed.
 */
const key = Buffer.alloc(32, 86).toString('base64'),
  actor = {tenantId: 'snapchat-replace', userId: 'owner', role: 'admin'};
const withPolicy = (policy, run) => {
  const s = new Store(':memory:', key);
  try {
    saveSpendPolicy(s, actor, {scope: 'workspace', confirmed: true, policy});
    return run(s);
  } finally {
    s.close();
  }
};
const base = {
  gateway: 'snapchat_native_action',
  accountId: '123',
  headers: {},
  query: {},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'synthetic snapchat replace',
  warnings: [],
};
const put = rows => ({
  ...base,
  action: 'snapchat_adaccounts_ad_account_id_campaigns_update',
  method: 'PUT',
  path: '/v1/adaccounts/123/campaigns',
  body: {campaigns: rows},
});
const patch = ops => ({
  ...base,
  action: 'snapchat_adaccounts_ad_account_id_campaigns_campaign_id_patch',
  method: 'PATCH',
  path: '/v1/adaccounts/123/campaigns/c1',
  body: ops,
});
const campaign = (id, caps = {daily_budget_micro: 100000000, lifetime_spend_cap_micro: 100000000}) => ({
  id,
  ad_account_id: '123',
  name: 'A',
  status: 'ACTIVE',
  end_time: '2027-01-01T00:00:00Z',
  ...caps,
});
/** The state a review keeps of a campaign PUT: one read of each record the request names. */
const state = (...records) => records.map(record => ({campaigns: [{campaign: record}]}));
const audit = {
  enforcement: 'block',
  max_budget_native: 200000000,
  max_total_budget_native: 200000000,
  max_budget_increase_percent: 10,
  max_daily_increase_native: 10000000,
};

test('a name-only campaign PUT that omits the caps the campaign holds is judged as clearing them', () => {
  const rename = put([{id: 'c1', name: 'Renamed'}]),
    held = state(campaign('c1'));
  assertWriteShape(rename);
  withPolicy(audit, s =>
    assert.throws(
      () => checkSpendPolicy(s, actor, rename, held),
      e => {
        assert.equal(e.code, 'POLICY_AMOUNT_UNSUPPORTED');
        assert.equal(e.details.field, '/body/campaigns/0/daily_budget_micro');
        return true;
      },
    ),
  );
  const flag = spendConfirmationError(rename, held);
  assert.equal(flag?.code, 'SPEND_CONFIRMATION_REQUIRED');
  assert.deepEqual(flag.details.fields, ['daily_budget_micro', 'lifetime_spend_cap_micro']);
});

test('under confirm both omitted caps are findings the user must approve, and execute stops until they do', () => {
  const rename = put([{id: 'c1', name: 'Renamed'}]),
    held = state(campaign('c1'));
  withPolicy({...audit, enforcement: 'confirm'}, s => {
    assert.deepEqual(
      exceededCaps(checkSpendPolicy(s, actor, rename, held)).map(c => [c.rule, c.field]),
      [
        ['POLICY_AMOUNT_UNSUPPORTED', '/body/campaigns/0/daily_budget_micro'],
        ['POLICY_AMOUNT_UNSUPPORTED', '/body/campaigns/0/lifetime_spend_cap_micro'],
      ],
    );
    assert.throws(() => checkSpendPolicy(s, actor, rename, held, 'review-1'), {code: 'CAP_CONFIRMATION_REQUIRED'});
    assert.equal(checkSpendPolicy(s, actor, rename, held, 'review-1', true).requested_increase_decimal, '0');
  });
});

test('only the cap a PUT leaves out is judged, per record, and a record that restates both is not', () => {
  const rows = [
      {id: 'c1', ad_account_id: '123', name: 'A', status: 'ACTIVE', daily_budget_micro: 100000000},
      {id: 'c2', name: 'B', daily_budget_micro: 100000000, lifetime_spend_cap_micro: 100000000},
    ],
    held = state(campaign('c1'), campaign('c2'));
  withPolicy({...audit, enforcement: 'confirm'}, s =>
    assert.deepEqual(
      exceededCaps(checkSpendPolicy(s, actor, put(rows), held)).map(c => c.field),
      ['/body/campaigns/0/lifetime_spend_cap_micro'],
    ),
  );
});

test('a campaign PUT that restates its caps, or raises one within the caps, is compared as it always was', () => {
  const restate = put([{id: 'c1', name: 'A', daily_budget_micro: 100000000, lifetime_spend_cap_micro: 100000000}]),
    raise = put([{id: 'c1', name: 'A', daily_budget_micro: 100000000, lifetime_spend_cap_micro: 110000000}]),
    over = put([{id: 'c1', name: 'A', daily_budget_micro: 100000000, lifetime_spend_cap_micro: 111000000}]),
    held = state(campaign('c1'));
  withPolicy(audit, s => {
    assert.equal(checkSpendPolicy(s, actor, restate, held).requested_increase_decimal, '0');
    assert.equal(checkSpendPolicy(s, actor, raise, held).requested_increase_decimal, '10000000');
    assert.throws(() => checkSpendPolicy(s, actor, over, held), {code: 'POLICY_INCREASE_LIMIT'});
  });
  // A cap named null stays the cleared cap it always was.
  withPolicy(audit, s =>
    assert.throws(
      () =>
        checkSpendPolicy(
          s,
          actor,
          put([{id: 'c1', name: 'A', daily_budget_micro: 100000000, lifetime_spend_cap_micro: null}]),
          held,
        ),
      {code: 'POLICY_AMOUNT_UNSUPPORTED'},
    ),
  );
});

test('a PUT omits nothing when the campaign holds no cap, and a PATCH never omits: both pass as before', () => {
  const none = state(campaign('c1', {})),
    onlyTotal = state(campaign('c1', {lifetime_spend_cap_micro: 100000000}));
  withPolicy(audit, s => {
    assert.equal(checkSpendPolicy(s, actor, put([{id: 'c1', name: 'Renamed'}]), none).requested_increase_decimal, '0');
    assert.equal(spendConfirmationError(put([{id: 'c1', name: 'Renamed'}]), none), undefined);
    // The campaign has no daily budget to lose, so leaving it out clears nothing.
    const total = put([{id: 'c1', name: 'A', lifetime_spend_cap_micro: 100000000}]);
    assert.equal(checkSpendPolicy(s, actor, total, onlyTotal).requested_increase_decimal, '0');
    // A JSON Patch changes only what it names.
    const rename = patch([{op: 'replace', path: '/name', value: 'Renamed'}]);
    assert.equal(checkSpendPolicy(s, actor, rename, state(campaign('c1'))).requested_increase_decimal, '0');
    assert.equal(spendConfirmationError(rename, state(campaign('c1'))), undefined);
  });
});

test('a record the reviewed state does not show is judged as holding its caps', () => {
  const rename = put([{id: 'c9', name: 'Renamed'}]);
  withPolicy(audit, s => {
    for (const unknown of [[], state(campaign('c1')), [{}], undefined])
      assert.throws(() => checkSpendPolicy(s, actor, rename, unknown), {code: 'POLICY_AMOUNT_UNSUPPORTED'});
  });
  assert.equal(spendConfirmationError(rename, state(campaign('c1')))?.code, 'SPEND_CONFIRMATION_REQUIRED');
});

test('with no cap to judge the policy passes it, and the spending confirmation still asks, with the state and only with it', () => {
  const rename = put([{id: 'c1', name: 'Renamed'}]),
    held = state(campaign('c1'));
  withPolicy({enforcement: 'block', allow_activation: false}, s =>
    assert.equal(checkSpendPolicy(s, actor, rename, held).requested_increase_decimal, '0'),
  );
  assert.equal(spendConfirmationError(rename, held)?.code, 'SPEND_CONFIRMATION_REQUIRED');
  // Without a state (a plan's approval, an inspect) nothing says what the PUT would reset: it asks as it always did.
  assert.equal(spendConfirmationError(rename), undefined);
});

test("the hook is Snapchat's alone, answers for the account campaign PUT only, and reads the state it replaces", () => {
  const hooks = registeredProviderHooks.filter(h => h.writes?.omittedMoney).map(h => h.gateway);
  assert.deepEqual(hooks, ['snapchat_native_action']);
  const omitted = (plan, held) =>
    registeredProviderHooks.find(h => h.gateway === hooks[0]).writes.omittedMoney(plan, held);
  assert.deepEqual(omitted(put([{id: 'c1', name: 'x'}]), state(campaign('c1'))), [
    '/body/campaigns/0/daily_budget_micro',
    '/body/campaigns/0/lifetime_spend_cap_micro',
  ]);
  // Another route, another method, a body with no records: nothing is omitted.
  const nested = {
    ...base,
    action: 'snapchat_campaigns_campaign_id_adsquads_update',
    method: 'PUT',
    path: '/v1/campaigns/c1/adsquads',
    body: {adsquads: [{id: 's1', name: 'x'}]},
  };
  assert.deepEqual(omitted(nested, []), []);
  assert.deepEqual(omitted(patch([{op: 'replace', path: '/name', value: 'x'}]), state(campaign('c1'))), []);
  assert.deepEqual(omitted({...put([]), body: {}}, []), []);
  assert.deepEqual(omitted({...put([]), body: undefined}, []), []);
});

// End to end: the same PUT through amcp_write prepare, so the state a review reads (a GET of each record it names) is the shape the hook reads.
const registry = new Registry();
function reviewed(policy, held) {
  const store = new Store(':memory:', key),
    connection = {
      id: 'login',
      tenantId: actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    };
  store.putConnection(actor, connection, {accessToken: 'fixture'});
  store.rememberResource(connection, '123', 'campaigns/111');
  if (policy) saveSpendPolicy(store, actor, {scope: 'workspace', confirmed: true, policy});
  let writes = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (input, init) => {
      if (init.method !== 'GET') {
        writes++;
        return Response.json({
          request_status: 'SUCCESS',
          campaigns: [{sub_request_status: 'SUCCESS', campaign: {id: '111', ad_account_id: '123', status: 'PAUSED'}}],
        });
      }
      const path = new URL(String(input)).pathname,
        kind = path.split('/').at(-2);
      return Response.json({
        request_status: 'SUCCESS',
        [kind]: [
          {
            sub_request_status: 'SUCCESS',
            [kind === 'adaccounts' ? 'adaccount' : 'campaign']: {
              id: path.split('/').at(-1),
              ad_account_id: '123',
              name: 'A',
              status: 'PAUSED',
              ...held,
            },
          },
        ],
      });
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  return {
    store,
    writes: () => writes,
    prepare: rows =>
      service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway: 'snapchat_native_action',
          arguments: {action: 'snapchat_campaign_replace', account_id: '123', payload: {campaigns: rows}},
        },
        actor,
      ),
    execute: (review, extra = {}) =>
      service.call(
        'amcp_write',
        {
          action: 'execute',
          review_id: review.review_id,
          idempotency_key: review.idempotency_key,
          confirmed: true,
          ...extra,
        },
        actor,
      ),
  };
}
const held = {daily_budget_micro: 100000000, lifetime_spend_cap_micro: 100000000};

test('through amcp_write: a name-only campaign PUT is refused under a numeric cap, and without one it asks for the spend confirmation', async () => {
  const rename = [{id: '111', name: 'Renamed'}];
  // Block: refused at prepare, and nothing is sent.
  let f = reviewed({enforcement: 'block', max_budget_native: 200000000}, held);
  try {
    assertRefused(await f.prepare(rename), 'POLICY_AMOUNT_UNSUPPORTED', {writes: f.writes});
  } finally {
    f.store.close();
  }
  // No policy: prepared, and the review needs spend_change_confirmed, naming the two caps it would reset.
  f = reviewed(undefined, held);
  try {
    const review = await f.prepare(rename);
    assert.equal(review.success, true, JSON.stringify(review));
    assert.deepEqual(
      review.data.execute_requirements.reasons.map(r => [r.flag, r.fields]),
      [['spend_change_confirmed', ['daily_budget_micro', 'lifetime_spend_cap_micro']]],
    );
    assertRefused(await f.execute(review.data), 'SPEND_CONFIRMATION_REQUIRED', {writes: f.writes});
    const sent = await f.execute(review.data, {spend_change_confirmed: true});
    assert.equal(sent.success, true, JSON.stringify(sent));
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  // A campaign that holds no cap has nothing to lose: the same PUT needs no confirmation.
  f = reviewed(undefined, {});
  try {
    const review = await f.prepare(rename);
    assert.equal(review.success, true, JSON.stringify(review));
    assert.deepEqual(review.data.execute_requirements.reasons, []);
  } finally {
    f.store.close();
  }
});
