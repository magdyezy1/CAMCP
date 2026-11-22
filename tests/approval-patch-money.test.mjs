import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {savePlanPolicy} from '../dist/src/campaign-inventory.js';
import {approvalFields, approvalMoney, approvalSummary} from '../dist/src/plan-approval.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import * as spendEffects from '../dist/src/campaign-spend-effects.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {namesSpendField} from '../dist/src/spend-effects.js';
import {snapchatAllocationData} from './fixtures/snapchat-allocation-data.mjs';

/**
 * R2.5 package r25-approval-effects, fix round (the lead's review of 3ad1f091, S2-3; the lead decided 2026-11-22 to fix it now). A JSON Patch
 * names its field by path: `{op: 'replace', path: '/daily_budget_micro', value: 62500000}` sets a budget as `{daily_budget_micro: ...}` does.
 * `approvalFields` listed the patch's status and never its money, so a plan whose budgets are written as patches (Snapchat's allocation draft
 * is exactly that) had `fields_total: 0` and `approvalMoney` false, and the owner's distinct-approver policy (CMP-05) did not govern it: its
 * own owner approved and ran their own budget reallocation. Under the policy a plan that changes a budget needs the distinct approver,
 * whatever shape the budget is written in. Everything is synthetic and local.
 */
const patch = (...ops) => ({body: ops});
const op = (o, path, value) => ({op: o, path, value});

test('a JSON Patch add or replace of a money field is a spend field; of a status field a status field; a test assertion is nothing', () => {
  assert.deepEqual(approvalFields(patch(op('replace', '/daily_budget_micro', 62500000))), [
    {field: '/body/0/value', value: 62500000, kind: 'spend'},
  ]);
  assert.deepEqual(approvalFields(patch(op('add', '/lifetime_budget', '900'))), [
    {field: '/body/0/value', value: '900', kind: 'spend'},
  ]);
  assert.deepEqual(approvalFields(patch(op('replace', '/entityStatus', 'ENTITY_STATUS_PAUSED'))), [
    {field: '/body/0/value', value: 'ENTITY_STATUS_PAUSED', kind: 'status'},
  ]);
  // A nested path names its last segment; a test asserts and sets nothing; a remove and a move carry no value to list.
  assert.deepEqual(
    approvalFields(patch(op('replace', '/campaigns/2/bid_amount', '5'))).map(f => f.kind),
    ['spend'],
  );
  for (const other of ['test', 'remove', 'move', 'copy'])
    assert.deepEqual(approvalFields(patch(op(other, '/daily_budget_micro', 1))), [], other);
  assert.deepEqual(approvalFields(patch(op('replace', '/name', 'Renamed'))), []);
  // A budget the value of which is a reference to a predecessor is skipped, as a key's is.
  assert.deepEqual(approvalFields(patch(op('replace', '/daily_budget_micro', {$ref: 'a#/data/x'}))), []);
});

test('a plan that writes its budget as a patch changes spending: approvalMoney reads it', () => {
  const run = {
    id: 'p',
    plan_hash: 'h',
    steps: [
      {
        id: 'squad',
        kind: 'write',
        gateway: 'snapchat_native_action',
        account_id: '1',
        depends_on: [],
        arguments: {action: 'snapchat_adsquad_update', body: [op('replace', '/daily_budget_micro', 62500000)]},
      },
    ],
  };
  const summary = approvalSummary(run);
  assert.equal(summary.fields_total, 1);
  assert.equal(approvalMoney(summary), true);
  assert.deepEqual(summary.steps[0].spend, [{field: '/body/0/value', value: 62500000}]);
});

function allocation(t) {
  const data = snapchatAllocationData(),
    store = new Store(':memory:', Buffer.alloc(32, 123).toString('base64')),
    owner = {tenantId: 'patch-money', userId: 'owner', role: 'admin'},
    actor = store.authenticate(store.createKey(owner)),
    other = store.authenticate(store.createKey({tenantId: 'patch-money', userId: 'colleague', role: 'admin'}));
  t.after(() => store.close());
  store.putConnection(
    owner,
    {
      id: data.report.connection_id,
      tenantId: actor.tenantId,
      gateway: data.report.gateway,
      accounts: [data.report.account_id],
      writeAccounts: [data.report.account_id],
      enabled: true,
      label: 'Synthetic',
      scopes: ['snapchat-marketing-api'],
    },
    {accessToken: 'synthetic'},
  );
  store.putDocument(actor.tenantId, 'decision_report', 'source', data.report);
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async url => Response.json(data.response(url))),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {
    data,
    store,
    actor,
    other,
    owner,
    report: (input, who = actor) => service.call('amcp_reporting', input, who),
    campaign: (input, who = actor) => service.call('amcp_campaign', input, who),
  };
}

test('an allocation plan (budgets written as patches) under the distinct-approver policy: its owner is told to assign an approver, another member may approve', async t => {
  const f = allocation(t);
  const preview = await f.report({
    action: 'preview_allocation_plan',
    id: 'source',
    conversion: 'equal_daily',
    options: f.data.options,
  });
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 400));
  const created = await f.report({
    action: 'create_allocation_plan',
    id: 'source',
    preview_id: preview.data.preview_id,
    preview_hash: preview.data.preview_hash,
    confirmed: true,
  });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 400));
  const id = created.data.id;
  savePlanPolicy(f.store, f.owner, {require_distinct_approver: true, confirmed: true});
  const shown = await f.campaign({action: 'approve', id});
  assert.equal(shown.success, true, JSON.stringify(shown).slice(0, 400));
  // The summary shows the new budgets, and the owner's own approval is refused.
  assert.ok(shown.data.approval.fields_total >= 1, JSON.stringify(shown.data.approval).slice(0, 400));
  assert.equal(shown.data.approver_required, true);
  const refused = await f.campaign({
    action: 'approve',
    id,
    plan_hash: shown.data.plan_hash,
    summary_hash: shown.data.summary_hash,
    confirmed: true,
    spend_change_confirmed: true,
  });
  assert.equal(refused.success, false);
  assertRefused(refused, 'DISTINCT_APPROVER_REQUIRED');
  // Another member is not the plan's owner: the same summary is theirs to approve.
  const theirs = await f.campaign({action: 'approve', id}, f.other);
  assert.equal(theirs.success, true, JSON.stringify(theirs).slice(0, 400));
  assert.equal(theirs.data.approver_required, undefined);
});

/**
 * The sweep the lead asked for with S2-3: the money a write family sets that `approvalFields` did not list, because its name carries none of the words
 * (budget, bid, amount, spend_cap, cpc, cpm, target_cpa, target_roas) the list was built on. Each is a field the repository itself reads as money:
 * the review's generic rule names any field containing `spend` (src/spend-effects.ts `spendWords`), the spend policy reads `daily_cap` and `total_cap`
 * (`nativeAmountField`) and a LinkedIn `unit_cost` (`bidMoneyParent`), Reddit's `goal_value` is "always a budget here" (src/reddit-writes.ts), and Google's
 * pinned fields name `target_cpv_micros` and `target_spend_micros` (generated/google-bid-fields.json). A plan that sets one changes spending to the
 * distinct-approver policy.
 */
test('the money a family sets under a name the list did not carry is a spend field', () => {
  for (const key of [
    'daily_min_spend_target', // Meta ad set
    'lifetime_min_spend_target', // Meta ad set
    'target_spend_micros', // Google (pinned: unsupported money)
    'target_cpv_micros', // Google (pinned: bid)
    'goal_value', // Reddit (a budget for DAILY_SPEND and LIFETIME_SPEND goals)
    'daily_cap', // the spend policy's native amount fields
    'total_cap',
    'unit_cost', // LinkedIn (the policy's bid parent)
    'dailyMinSpendTarget',
    'targetCpvMicros',
    'goalValue',
  ]) {
    assert.deepEqual(approvalFields({[key]: '5000'}), [{field: '/' + key, value: '5000', kind: 'spend'}], key);
    assert.deepEqual(
      approvalFields(patch(op('replace', '/' + key, '5000'))).map(f => f.kind),
      ['spend'],
      'patch ' + key,
    );
  }
  // Names that only look alike stay what they were.
  for (const key of [
    'name',
    'daily_schedule',
    'target_audience',
    'goal_type',
    'capital_city',
    'unit_id',
    // TikTok audience targeting and a reach-and-frequency setting that only look like money (re-review S3-1), in any spelling.
    'spending_power',
    'spendingPower',
    'cpv_video_duration',
    'cpvVideoDuration',
  ])
    assert.deepEqual(approvalFields({[key]: 'x'}), [], key);
  const summary = approvalSummary({
    id: 'p',
    plan_hash: 'h',
    steps: [
      {
        id: 'goal',
        kind: 'write',
        gateway: 'reddit_native_action',
        account_id: '1',
        depends_on: [],
        arguments: {operation: 'reddit_campaign_ops', arguments: {payload: {data: {goal_value: '5000000'}}}},
      },
    ],
  });
  assert.equal(approvalMoney(summary), true);
});

test('re-review S3-1: spending_power and cpv_video_duration are no spend field, to the approval and to the review rule that names spend fields', t => {
  const f = googleReconcileFixture({tenant: 'patch-money-s31'});
  t.after(() => f.store.close());
  const step = (id, fields, gateway = 'tiktok_native_action', action = 'tiktok_adgroup_update') => ({
    id,
    kind: 'write',
    gateway,
    connection_id: 'c',
    account_id: '123',
    description: id,
    depends_on: [],
    arguments: {action, payload: {advertiser_id: '123', adgroup_id: '9', ...fields}},
  });
  const compiled = s =>
    applyExecutionRisk(f.service.compiler.compile(s.gateway, {...s.arguments, account_id: '123'}, f.service.options));
  const targeting = step('targeting', {spending_power: 'HIGH'}),
    budget = step('budget', {budget: 50, spending_power: 'HIGH'}),
    meta = {
      ...step('floor', {}, 'meta_native_action', 'meta_adset_update'),
      arguments: {action: 'meta_adset_update', ad_set_id: '1', payload: {daily_min_spend_target: '100'}},
    };
  // The review's rule that names spend fields (src/spend-effects.ts) no longer reads spending_power as spend, and still reads a budget and
  // Meta's minimum spend target. (An ad group update that sets a field its family does not list as neutral still asks for
  // spend_change_confirmed through the family's delivery-edit rule, which is a separate rule and unchanged.)
  assert.equal(namesSpendField(compiled(targeting)), false, 'spending_power alone');
  assert.equal(namesSpendField(compiled(budget)), true, 'a budget');
  assert.equal(namesSpendField(compiled(meta)), true, 'Meta minimum spend target');
  // The approval agrees: spending_power lists no field and is no money; a budget beside it is.
  const facts = spendEffects.stepEffects(f.service, [targeting, budget]),
    summary = approvalSummary({id: 'p', plan_hash: 'h', steps: [targeting, budget]}, facts);
  assert.equal(summary.steps[0].fields_total, 0, 'spending_power is no budget or bid field');
  assert.equal(approvalMoney(approvalSummary({id: 'p', plan_hash: 'h', steps: [targeting]}, facts)), false);
  assert.equal(facts.get('budget').spend, true, 'a budget still asks for spend_change_confirmed');
  assert.deepEqual(summary.steps[1].spend, [{field: '/payload/budget', value: 50}]);
});
