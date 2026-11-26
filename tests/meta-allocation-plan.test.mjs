// DEC-02: Meta allocation budget binding. Budget ownership (campaign budget or one ad set) is detected from current
// native reads; lifetime, mixed, split, reserved and changed modes are refused; drafts stay unapproved and exact in
// Meta minor units. Synthetic fixtures only; writes reach only the in-memory fake after explicit review.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {setMetaCurrencyOffsetsForTest} from '../dist/src/budget-units.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {allocationReport} from './fixtures/allocation-data.mjs';

function fixture(t) {
  setMetaCurrencyOffsetsForTest({USD: 100, JPY: 1});
  t.after(() => setMetaCurrencyOffsetsForTest(undefined));
  const report = {...allocationReport(), connection_id: '14100000-0000-4000-8000-000000000001'},
    store = new Store(':memory:', Buffer.alloc(32, 141).toString('base64')),
    owner = {tenantId: 'meta-allocation', userId: 'owner', role: 'admin'},
    key = store.createKey(owner),
    actor = store.authenticate(key);
  t.after(() => store.close());
  const connection = {
    id: report.connection_id,
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100'],
    writeAccounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['ads_read', 'ads_management'],
  };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  store.putDocument(actor.tenantId, 'decision_report', 'source', report);
  // Campaign 10 owns a 100 USD daily budget (10000 cents); campaign 20 keeps 50 USD on its one ad set 201.
  const account = {id: 'act_100', account_id: '100', currency: 'USD', timezone_name: 'UTC', account_status: 1};
  const campaigns = {
    10: {
      id: '10',
      account_id: '100',
      name: 'Efficient',
      status: 'ACTIVE',
      buying_type: 'AUCTION',
      daily_budget: '10000',
    },
    20: {
      id: '20',
      account_id: '100',
      name: 'Established',
      status: 'PAUSED',
      buying_type: 'AUCTION',
      is_adset_budget_sharing_enabled: false,
    },
  };
  const adsets = {
    10: [{id: '101', account_id: '100', campaign_id: '10', status: 'ACTIVE'}],
    20: [{id: '201', account_id: '100', campaign_id: '20', status: 'PAUSED', daily_budget: '5000'}],
  };
  let allowWrite = false,
    edit = (_url, body) => body;
  const requests = [],
    writes = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(raw),
        path = url.pathname.replace(/^\/v\d+\.0\//, '/');
      requests.push({path, method: init.method});
      if (init.method !== 'GET') {
        assert.equal(allowWrite, true, 'no write before explicit execution');
        const body =
          typeof init.body === 'string' && init.body.trim().startsWith('{')
            ? JSON.parse(init.body)
            : Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
        writes.push({path, body});
        const id = path.slice(1),
          target =
            campaigns[id] ??
            Object.values(adsets)
              .flat()
              .find(a => a.id === id);
        assert.ok(target, 'write to a known entity');
        Object.assign(target, body);
        return Response.json({success: true});
      }
      const reply = body => Response.json(edit(url, body, requests.length));
      if (path === '/act_100') return reply(account);
      // The account's own collections establish ownership of the objects later read and changed by ID.
      if (path === '/act_100/campaigns')
        return reply({data: Object.values(campaigns).map(c => ({id: c.id, account_id: c.account_id}))});
      if (path === '/act_100/adsets')
        return reply({
          data: Object.values(adsets)
            .flat()
            .map(a => ({id: a.id, account_id: a.account_id, campaign_id: a.campaign_id})),
        });
      const campaign = /^\/(\d+)$/.exec(path)?.[1];
      if (campaign && campaigns[campaign]) return reply(campaigns[campaign]);
      const listing = /^\/(\d+)\/adsets$/.exec(path)?.[1];
      if (listing) return reply({data: adsets[listing] ?? []});
      const adset = Object.values(adsets)
        .flat()
        .find(a => path === '/' + a.id);
      if (adset) return reply(adset);
      throw Error('Unexpected synthetic request ' + init.method + ' ' + path);
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const options = {
    budget: '200',
    allocations: [
      {entity_id: '10', minimum: '50', maximum: '125'},
      {entity_id: '20', minimum: '50', maximum: '150'},
    ],
    efficiency_low: 0.8,
    efficiency_high: 1.2,
    minimum_conversions: 10,
    maximum_age_days: 7,
  };
  const call = (args, who = actor) => service.call('amcp_reporting', args, who);
  return {
    store,
    owner,
    actor,
    service,
    account,
    campaigns,
    adsets,
    options,
    requests,
    writes,
    call,
    preview: () => call({action: 'preview_allocation_plan', id: 'source', conversion: 'equal_daily', options}),
    create: p =>
      call({
        action: 'create_allocation_plan',
        id: 'source',
        preview_id: p.preview_id,
        preview_hash: p.preview_hash,
        confirmed: true,
      }),
    edit: fn => (edit = fn),
    allowWrite: () => (allowWrite = true),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};

test('a Meta campaign budget and a single-ad-set budget become exact minor-unit, unapproved drafts', async t => {
  const f = fixture(t),
    p = ok(await f.preview());
  // 125 and 75 USD over two days: 62.50 and 37.50 a day, 6250 and 3750 cents.
  assert.deepEqual(
    p.targets.map(x => [
      x.entity_id,
      x.budget_owner,
      x.adset_id ?? null,
      x.current_daily_budget,
      x.daily_budget_native,
    ]),
    [
      ['10', 'campaign', null, '100', '6250'],
      ['20', 'ad_set', '201', '50', '3750'],
    ],
  );
  assert.equal(p.targets[0].currency_offset, 100);
  assert.match(p.meaning, /75% more than a daily budget/);
  assert.ok(p.native_source_references.length >= 10);
  assert.equal(f.writes.length, 0);
  const created = ok(await f.create(p)),
    run = f.store.document(f.actor.tenantId, 'campaign_run', created.id);
  assert.equal(run.state, 'draft');
  assert.equal(created.approval_required, true);
  assert.deepEqual(
    run.steps.map(s => s.arguments),
    [
      {action: 'meta_campaign_id_update', path_params: {campaign_id: '10'}, payload: {daily_budget: '6250'}},
      {action: 'meta_ad_set_id_update', path_params: {ad_set_id: '201'}, payload: {daily_budget: '3750'}},
    ],
  );
  assert.match(
    run.steps[1].description,
    /Campaign 20 \(ad set 201\): daily budget 37\.5 USD \(3750 in Meta minor units\)/,
  );
  assert.match(run.brief, /Daily budgets remain in effect/);
  assert.equal(f.writes.length, 0);
});

test('Meta lifetime, mixed, split, reserved, unbounded and foreign budgets are refused, never guessed', async t => {
  for (const [mutate, code] of [
    [
      f => Object.assign(f.campaigns[10], {daily_budget: undefined, lifetime_budget: '500000'}),
      'ALLOCATION_BUDGET_MODE',
    ],
    [f => (f.adsets[10][0].daily_budget = '2000'), 'ALLOCATION_BUDGET_MODE'],
    [
      f => f.adsets[20].push({id: '202', account_id: '100', campaign_id: '20', status: 'ACTIVE', daily_budget: '100'}),
      'ALLOCATION_BUDGET_MODE',
    ],
    [
      f => Object.assign(f.adsets[20][0], {daily_budget: undefined, lifetime_budget: '90000'}),
      'ALLOCATION_BUDGET_MODE',
    ],
    [f => (f.campaigns[10].buying_type = 'RESERVED'), 'ALLOCATION_BUDGET_MODE'],
    [
      f =>
        f.edit((url, body) =>
          url.pathname.endsWith('/20/adsets') ? {...body, paging: {next: 'https://graph.invalid/next'}} : body,
        ),
      'ALLOCATION_BUDGET_MODE',
    ],
    [f => (f.campaigns[10].account_id = '999'), 'ALLOCATION_BUDGET_CHANGED'],
    [f => (f.account.currency = 'EUR'), 'ALLOCATION_BUDGET_CHANGED'],
    [f => (f.campaigns[10].daily_budget = '10000.5'), 'ALLOCATION_BUDGET_CHANGED'],
  ]) {
    const f = fixture(t);
    mutate(f);
    const r = await f.preview();
    assert.equal(r.success, false, String(mutate));
    assert.equal(r.error.code, code, String(mutate) + ' ' + JSON.stringify(r.error));
    assert.equal(f.store.documents(f.actor.tenantId, 'allocation_preview').length, 0);
    assert.equal(f.writes.length, 0);
  }
  // A deleted sibling ad set never spends, so a single spending ad set still owns the budget.
  const g = fixture(t);
  g.adsets[20].push({id: '209', account_id: '100', campaign_id: '20', status: 'DELETED', daily_budget: '700'});
  assert.equal((await g.preview()).success, true);
});

test('without a pinned Meta currency offset nothing is read and no draft is possible', async t => {
  const f = fixture(t);
  setMetaCurrencyOffsetsForTest(null);
  const r = await f.preview();
  assert.equal(r.error.code, 'ALLOCATION_PRECISION');
  assert.equal(f.requests.length, 0);
});

test('a Meta budget mode that changes during inspection, before the draft or before the step is refused', async t => {
  // Between the two observations campaign 10 moves its budget to its ad set.
  const f = fixture(t);
  let reads = 0;
  f.edit((url, body) => {
    if (url.pathname.endsWith('/10') && ++reads === 2) return {...body, daily_budget: undefined};
    return body;
  });
  assert.equal((await f.preview()).error.code, 'ALLOCATION_BUDGET_CHANGED');
  // After the preview, before the draft.
  const g = fixture(t),
    p = ok(await g.preview());
  g.campaigns[10].daily_budget = '12000';
  assert.equal((await g.create(p)).error.code, 'ALLOCATION_BUDGET_CHANGED');
  g.campaigns[10].daily_budget = '10000';
  const created = ok(await g.create(p));
  // After the draft, before the reviewed step: ownership flips from the campaign to an ad set.
  Object.assign(g.campaigns[10], {daily_budget: undefined});
  g.adsets[10][0].daily_budget = '10000';
  const r = await g.service.call('amcp_campaign', {action: 'prepare_next', id: created.id}, g.actor);
  // The step's own budget-owner re-read refuses it, not an unrelated check.
  assert.equal(r.error?.code, 'ALLOCATION_BUDGET_CHANGED', JSON.stringify(r));
  assert.equal(g.writes.length, 0);
});

test('a Meta allocation step executes only through review, spend confirmation, owner caps and read-back', async t => {
  const f = fixture(t),
    p = ok(await f.preview()),
    created = ok(await f.create(p)),
    review = ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: created.id}, f.actor));
  f.allowWrite();
  const execute = extra =>
    f.service.call(
      'amcp_campaign',
      {
        action: 'execute_next',
        id: created.id,
        review_id: review.review.review_id,
        idempotency_key: review.review.review_id,
        confirmed: true,
        ...extra,
      },
      f.actor,
    );
  assert.equal(ok(await execute()).current.error.code, 'SPEND_CONFIRMATION_REQUIRED');
  assert.equal(f.writes.length, 0);
  const executed = ok(await execute({spend_change_confirmed: true}));
  assert.equal(executed.current.status, 'verified', JSON.stringify(executed.current));
  assert.equal(f.writes.length, 1);
  assert.equal(String(f.writes[0].body.daily_budget), '6250');
  assert.equal(f.campaigns[10].daily_budget, '6250');
});

// The owner's decision of 2026-11-25 ("a cut can never increase spend"): a genuine decrease is always allowed, even above the cap. The drafted budget of
// campaign 10 (10000 to 6250 cents) is a cut, so an owner cap of 6000 does not stop it; before the decision it did.
test('an owner cap below the drafted Meta budget does not stop a step that cuts the budget (owner decision of 2026-11-25)', async t => {
  const f = fixture(t),
    p = ok(await f.preview()),
    created = ok(await f.create(p));
  saveSpendPolicy(f.store, f.owner, {
    gateway: 'meta_native_action',
    account_id: '100',
    confirmed: true,
    policy: {max_budget_native: 6000},
  });
  const review = ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: created.id}, f.actor));
  f.allowWrite();
  const executed = ok(
    await f.service.call(
      'amcp_campaign',
      {
        action: 'execute_next',
        id: created.id,
        review_id: review.review.review_id,
        idempotency_key: review.review.review_id,
        confirmed: true,
        spend_change_confirmed: true,
      },
      f.actor,
    ),
  );
  assert.equal(executed.current.status, 'verified', JSON.stringify(executed.current));
  assert.equal(f.writes.length, 1);
  assert.equal(f.campaigns[10].daily_budget, '6250');
});

test('an owner cap below the drafted Meta budget stops a step that raises the budget at execution', async t => {
  const f = fixture(t);
  // Campaign 10 holds 30 USD a day, so the drafted 62.50 USD raises it (a cut is not stopped, test above).
  f.campaigns[10].daily_budget = '3000';
  const p = ok(await f.preview()),
    created = ok(await f.create(p));
  saveSpendPolicy(f.store, f.owner, {
    gateway: 'meta_native_action',
    account_id: '100',
    confirmed: true,
    policy: {max_budget_native: 6000},
  });
  const review = await f.service.call('amcp_campaign', {action: 'prepare_next', id: created.id}, f.actor);
  f.allowWrite();
  const outcome = review.success
    ? await f.service.call(
        'amcp_campaign',
        {
          action: 'execute_next',
          id: created.id,
          review_id: review.data.review.review_id,
          idempotency_key: review.data.review.review_id,
          confirmed: true,
          spend_change_confirmed: true,
        },
        f.actor,
      )
    : review;
  assert.match(JSON.stringify(outcome), /POLICY_BUDGET_LIMIT/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.campaigns[10].daily_budget, '3000');
});
