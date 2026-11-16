import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {findCreated} from '../dist/src/write-reconciliation.js';
import {agrees, sameValue} from '../dist/src/created-agreement.js';
import {standardBodies} from './helpers/tiktok-standard-creates.mjs';
import {gateway as tiktokGateway, stamp, tiktokReconcileFixture} from './helpers/tiktok-reconcile-fixture.mjs';
import {
  account as metaAccount,
  creates as metaCreates,
  gateway as metaGateway,
  metaTime,
} from './helpers/meta-reconcile-fixture.mjs';

/**
 * R2.5 M2, lead review S2-3: a created lookup counts a match as this write's object only when the fields the review froze agree with
 * those the provider echoes. A name is no identity: a create of the same name, under the same parent, in the same minutes, that differs
 * in a field (the path an agent takes after the duplicate guard refuses an identical one) is another object. It is a doubt, shown and
 * never called this write's, so the answer is indeterminate and never applied. An object another review's receipt names is that
 * review's, so it is neither found nor a doubt.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const compiler = new Compiler(new Registry()),
  options = {mode: 'strict', flags: {}};
const compile = (gateway, action, account, params, payload) =>
  applyExecutionRisk(
    compiler.compile(
      gateway,
      {action, account_id: account, ...(params ? {params} : {}), payload, dry_run: true},
      options,
    ),
  );
const claimed = Date.parse('2026-10-10T10:00:00Z');
const ids = list => (list ?? []).map(x => x.id);

test('the agreement rule: what the provider echoes must hold the value the review froze; what it does not echo is not asked', () => {
  const echoes = [
    ['budget', 'budget'],
    ['objective_type', 'objective_type'],
  ];
  assert.equal(
    agrees({budget: 50, objective_type: 'TRAFFIC'}, {budget: '50.00', objective_type: 'TRAFFIC'}, echoes),
    true,
    'digits by value',
  );
  assert.equal(
    agrees({budget: 50, objective_type: 'TRAFFIC'}, {budget: 50, objective_type: 'REACH'}, echoes),
    false,
    'one field differs',
  );
  assert.equal(agrees({budget: 50, objective_type: 'TRAFFIC'}, {budget: 60}, echoes), false);
  assert.equal(agrees({budget: 50}, {}, echoes), true, 'not echoed');
  assert.equal(agrees({budget: 50}, {budget: null}, echoes), true, 'a null is not an echo');
  assert.equal(agrees({}, {budget: 99, objective_type: 'REACH'}, echoes), true, 'the review froze neither');
  assert.equal(
    agrees({amountMicros: '5'}, {amount_micros: '5'}, [['amount_micros', 'amount_micros']]),
    true,
    'either spelling',
  );
  assert.equal(sameValue('PAUSED', 'paused'), false, 'text exactly, case included');
  assert.equal(sameValue({a: [1, 2]}, {a: [1, 2]}), true);
  assert.equal(sameValue(true, 'true'), false);
});

// ----- TikTok -----
const tiktok = (kind, edit = p => p) => {
  const {action, payload} = standardBodies('123')[kind];
  return compile(tiktokGateway, action, '123', undefined, edit(structuredClone(payload)));
};
const tiktokRow = (id, extra = {}) => ({
  campaign_id: id,
  campaign_name: 'Synthetic campaign',
  objective_type: 'TRAFFIC',
  budget_mode: 'BUDGET_MODE_INFINITE',
  operation_status: 'DISABLE',
  create_time: stamp(claimed + 5000),
  ...extra,
});
test('a TikTok object of the same name, parent and window that differs in a frozen field is a doubt, never this write’s', () => {
  const lookup = findCreated(tiktok('campaign'), {state: [], claimedAt: claimed});
  assert.ok(lookup, 'a campaign create has a lookup');
  const match = rows =>
    lookup.match(
      [
        {
          status: 200,
          headers: {},
          data: {code: 0, data: {list: rows, page_info: {page: 1, total_page: 1, total_number: rows.length}}},
        },
      ],
      claimed,
    );
  assert.deepEqual(ids(match([tiktokRow('401')]).found), ['401'], 'the same fields: this write’s');
  let m = match([tiktokRow('401', {objective_type: 'REACH'})]);
  assert.deepEqual([ids(m.found), ids(m.undated)], [[], ['401']], 'another objective');
  m = match([tiktokRow('401', {budget_mode: 'BUDGET_MODE_DAY'})]);
  assert.deepEqual([ids(m.found), ids(m.undated)], [[], ['401']], 'another budget mode');
  // A field TikTok does not echo is not asked, and two objects, one of each, are shown and not chosen between.
  const bare = {campaign_id: '402', campaign_name: 'Synthetic campaign', create_time: stamp(claimed + 5000)};
  assert.deepEqual(ids(match([bare]).found), ['402']);
  m = match([tiktokRow('401', {objective_type: 'REACH'}), tiktokRow('403')]);
  assert.deepEqual(
    [ids(m.found), ids(m.undated)],
    [['403'], ['401']],
    'the one that agrees is found, the other is a doubt',
  );
  assert.equal(m.complete, true);
});

test('probe C: a same-name create that differs in one field, made by another review, is not the lost create’s; the lost one appears not applied', async () => {
  const f = tiktokReconcileFixture();
  try {
    const {id} = await f.lose('campaign', {applied: false});
    // The identical prepare is refused, so the agent changes one field and creates that.
    assert.equal((await f.prepare('campaign')).error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    const tweaked = await f.prepare('campaign', p => ({...p, objective_type: 'REACH'}));
    assert.equal(tweaked.success, true, JSON.stringify(tweaked).slice(0, 400));
    assert.equal((await f.execute(tweaked.data.review_id)).success, true);
    const campaigns = f.rows.campaign.filter(r => r.campaign_name === 'Synthetic campaign');
    assert.equal(campaigns.length, 1, 'only the other review’s campaign exists');
    f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
    assert.equal(await f.worker.once(), true);
    const status = await f.call('amcp_write', {action: 'status', review_id: id});
    assert.equal(
      status.data.reconciliation.classification,
      'appears_not_applied',
      JSON.stringify(status.data.reconciliation),
    );
    assert.equal(status.data.reconciliation.observed_ids, undefined, 'nothing is offered for acceptance');
    assert.notEqual(status.data.next_call?.add_after_user_approval?.accept_applied, true);
    assert.equal(f.sent.length, 2, 'the lost create and the other review’s, each sent once; the check sent nothing');
  } finally {
    f.close();
  }
});

test('a same-name object that differs and that no review of AMCP made stays a doubt: the lost create is indeterminate, not absent and not applied', async () => {
  const f = tiktokReconcileFixture();
  try {
    const {id} = await f.lose('campaign', {applied: false});
    // Someone else made it, in the same minutes, in TikTok's own interface.
    f.rows.campaign.push({
      campaign_id: '777',
      advertiser_id: f.world.id,
      campaign_name: 'Synthetic campaign',
      objective_type: 'REACH',
      budget_mode: 'BUDGET_MODE_INFINITE',
      operation_status: 'DISABLE',
      create_time: stamp(Date.now()),
    });
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'undated_match');
    assert.deepEqual(r.data.undated, [{id: '777'}]);
    assert.equal(r.data.observed_ids, undefined);
  } finally {
    f.close();
  }
});

// ----- Meta -----
const meta = kind => {
  const [action, params, payload] = metaCreates[kind];
  return compile(metaGateway, action, metaAccount, params, payload);
};
test('a Meta campaign of the same name, made in the window, that differs in a frozen field is a doubt, never this write’s', () => {
  const plan = compile(metaGateway, 'meta_campaign_create', metaAccount, undefined, {
    name: 'Synthetic campaign',
    status: 'PAUSED',
    objective: 'OUTCOME_TRAFFIC',
    daily_budget: 5000,
    is_adset_budget_sharing_enabled: false,
  });
  const lookup = findCreated(plan, {state: [], claimedAt: claimed});
  assert.ok(lookup, 'a campaign create has a lookup');
  assert.match(lookup.reads[0].query.fields, /objective/, 'the lookup asks for what it compares');
  const row = (id, extra = {}) => ({
    id,
    name: 'Synthetic campaign',
    created_time: metaTime(claimed + 5000),
    status: 'PAUSED',
    objective: 'OUTCOME_TRAFFIC',
    daily_budget: '5000',
    ...extra,
  });
  const match = rows => lookup.match([{status: 200, headers: {}, data: {data: rows}}], claimed);
  assert.deepEqual(ids(match([row('1')]).found), ['1'], 'the same fields, a number as its digits');
  for (const [label, extra] of Object.entries({
    objective: {objective: 'OUTCOME_SALES'},
    status: {status: 'ACTIVE'},
    budget: {daily_budget: '9000'},
  })) {
    const m = match([row('2', extra)]);
    assert.deepEqual([ids(m.found), ids(m.undated)], [[], ['2']], label);
  }
  assert.deepEqual(
    ids(match([{id: '3', name: 'Synthetic campaign', created_time: metaTime(claimed + 5000)}]).found),
    ['3'],
    'a field Meta did not echo is not asked',
  );
});
test('a Meta product set, feed or audience that differs in a frozen field is a doubt, never this write’s', () => {
  const state = [{sets: [{id: '7001'}], feeds: [{id: '6001'}]}];
  // A set and a feed carry no creation time: they are this write's only while the check is within 15 minutes of the claim.
  const soon = claimed + 60000;
  const page = rows => [{status: 200, headers: {}, data: {data: rows}}];
  const set = findCreated(
    compile(metaGateway, metaCreates.set[0], metaAccount, metaCreates.set[1], {
      name: 'Synthetic set',
      filter: {category: {i_contains: 'shoe'}},
    }),
    {state, claimedAt: claimed},
  );
  assert.ok(set, 'a product set create has a lookup');
  const setRow = (id, filter) => ({
    id,
    name: 'Synthetic set',
    filter: JSON.stringify(filter),
    product_catalog: {id: '555'},
  });
  assert.deepEqual(
    ids(set.match(page([setRow('7100', {category: {i_contains: 'shoe'}})]), claimed, soon).found),
    ['7100'],
    'the filter as text or as an object',
  );
  const differing = set.match(page([setRow('7100', {category: {i_contains: 'bag'}})]), claimed, soon);
  assert.deepEqual([ids(differing.found), ids(differing.undated)], [[], ['7100']], 'another filter');
  const feed = findCreated(meta('feed'), {state, claimedAt: claimed});
  const feedRow = (id, extra = {}) => ({id, name: 'Synthetic feed', deletion_enabled: false, ...extra});
  assert.deepEqual(ids(feed.match(page([feedRow('6100')]), claimed, soon).found), ['6100']);
  const other = feed.match(page([feedRow('6100', {deletion_enabled: true})]), claimed, soon);
  assert.deepEqual([ids(other.found), ids(other.undated)], [[], ['6100']], 'another deletion rule');
  const audience = findCreated(meta('audience'), {state: [], claimedAt: claimed});
  const seconds = Math.floor((claimed + 5000) / 1000);
  const audienceRow = (id, extra = {}) => ({
    id,
    account_id: metaAccount,
    name: 'Synthetic audience',
    time_created: seconds,
    subtype: 'CUSTOM',
    ...extra,
  });
  assert.deepEqual(ids(audience.match(page([audienceRow('4100')]), claimed).found), ['4100']);
  const lookalike = audience.match(page([audienceRow('4100', {subtype: 'LOOKALIKE'})]), claimed);
  assert.deepEqual([ids(lookalike.found), ids(lookalike.undated)], [[], ['4100']], 'another kind of audience');
});

// ----- Google -----
test('a Google object of the same name that differs in a frozen field is a doubt, never this write’s', () => {
  const create = {name: 'Spring budget', amountMicros: '5000000', deliveryMethod: 'STANDARD'};
  const plan = compile(
    'google_ads_native_action',
    'google_ads_v23_campaign_budget_mutate_campaign_budgets',
    '123',
    undefined,
    {operations: [{create}]},
  );
  const lookup = findCreated(plan, {state: [], claimedAt: claimed});
  assert.ok(lookup, 'a budget create has a lookup');
  assert.match(JSON.stringify(lookup.reads[0].body), /amount_micros/, 'the lookup asks for what it compares');
  const row = (n, extra = {}) => ({
    campaignBudget: {
      resourceName: 'customers/123/campaignBudgets/' + n,
      name: 'Spring budget',
      amountMicros: '5000000',
      deliveryMethod: 'STANDARD',
      ...extra,
    },
  });
  const match = rows => lookup.match([{status: 200, headers: {}, data: {results: rows}}], claimed);
  assert.equal(match([row('1')]).found.length, 1, 'the same fields');
  const differing = match([row('2', {amountMicros: '9000000'})]);
  assert.deepEqual([differing.found.length, differing.undated?.length], [0, 1], 'another amount');
});
