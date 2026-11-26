import test from 'node:test';
import assert from 'node:assert/strict';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {
  accountKey,
  approvalBytes,
  approvalMoney,
  approvalStep,
  approvalRoom,
  approvalSummary,
  changesShown,
  createChangesShown,
  groupFrom,
  idsShown,
} from '../dist/src/plan-approval.js';
import {compactPlan, planViewBudget} from '../dist/src/campaign-view.js';
import * as spendEffects from '../dist/src/campaign-spend-effects.js';

/**
 * R2.5 package r25-approval-fields (the owner's friction report of 2026-11-25, B2): for 24 end-date changes every step of the approval read
 * `fields_total: 0`, with no ad set id, no field and no date. A plan approval shows what each step changes: the object, its id, the field and
 * the value it is given, for every step, from the request the step compiles to (no provider read). More than the bound is never dropped silently
 * (the step is cut to its own list, with the call that lists it), and steps that make the same change are one group when that is smaller.
 * Everything here is synthetic and local: nothing is sent.
 */
let tenants = 0;
const step = (id, gateway, args, extra = {}) => ({
  id,
  kind: 'write',
  gateway,
  connection_id: 'c',
  account_id: '123',
  description: id,
  arguments: args,
  depends_on: [],
  ...extra,
});
const planOf = steps => ({id: 'plan1', plan_hash: 'ph', steps});
const size = v => Buffer.byteLength(JSON.stringify(v));
function account(t) {
  const f = googleReconcileFixture({tenant: 'approval-changes-' + ++tenants});
  t.after(() => f.store.close());
  return f;
}
/** The summary of a plan of steps, with the compile of each. */
const summarize = (f, steps) => approvalSummary(planOf(steps), spendEffects.stepEffects(f.service, steps));
const entry = (summary, id) => summary.steps.find(s => s.id === id);
/** An ad set whose end date is set, in the account of the owner's report; its id is 15 digits. */
const adSetId = i => '1202' + String(100000000000 + i);
const endDate = (i, date = '2026-12-06T23:59:00+0300') =>
  step(
    'adset_' + String(i).padStart(2, '0'),
    'meta_native_action',
    {action: 'meta_ad_set_id_update', path_params: {ad_set_id: adSetId(i)}, payload: {end_time: date}},
    {account_id: 'act_111'},
  );

test('the limits are pinned: the summary holds 8,192 bytes, a step lists 12 rows (4 for a create) and 12 ids, and a group is 4 steps', () => {
  assert.equal(approvalBytes, 8192);
  assert.equal(changesShown, 12);
  assert.equal(createChangesShown, 4);
  assert.equal(idsShown, 12);
  assert.equal(groupFrom, 4);
  // The compact plan view holds the approval (the lead's ruling of 2026-11-26): the room the approval has is the view's bound less the plan's own view,
  // taken from the view, so it is the plan's and falls with every step.
  assert.equal(planViewBudget, 11264);
  const room = n => approvalRoom(runOf(Array.from({length: n}, (_, i) => endDate(i + 1))));
  assert.ok(room(24) > room(30) && room(30) > room(40) && room(40) > room(44), [24, 30, 40, 44].map(room).join(' '));
  assert.ok(room(24) >= approvalBytes, 'a plan of 24 steps has the 8 KB of the summary');
});

// The second check of 2026-11-26 (S3-B): the rows of a plan are never what pushes the compact view over its bound. Where they would, further steps are cut to their
// own list, and where even that would not fit a plan whose view is within its bound without rows, the plan says once that the rows of every step are in its own list
// (`changes_cut`, with the one digest and the one call) and no step carries a marker. A plan whose view was over its bound without rows stays over it.
const runOf = steps => ({
  id: 'plan1',
  name: 'End dates',
  revision: 2,
  state: 'draft',
  plan_hash: 'a'.repeat(64),
  steps: steps.map(s => ({...s, status: 'pending'})),
});
/** The compact view as approve answers it. */
const viewOf = (run, summary) =>
  compactPlan(run, undefined, {
    approval: summary,
    summary_hash: summary.summary_hash,
    next_call: {
      tool: 'amcp_campaign',
      arguments: {
        action: 'approve',
        id: run.id,
        plan_hash: run.plan_hash,
        summary_hash: summary.summary_hash,
        confirmed: true,
      },
      add_after_user_approval: {spend_change_confirmed: true},
      ...(summary.effects ? {disclose: summary.effects} : {}),
    },
  });
/** The compile of each step, with the rows left out: the plan as the approval showed it before it listed any. */
const withoutRows = effects =>
  new Map([...effects].map(([id, e]) => [id, typeof e === 'object' ? {...e, changes: []} : e]));
const dateOf = i => '2026-12-' + String(10 + (i % 20)) + 'T23:59:00+0300' + i;
for (const n of [37, 40, 44])
  for (const same of [false, true])
    test(
      'a plan of ' +
        n +
        ' Meta ad sets given ' +
        (same ? 'one end date' : 'different end dates') +
        ' stays inside the compact view, and says where the rows of every step are',
      t => {
        const f = account(t),
          steps = Array.from({length: n}, (_, i) => endDate(i + 1, same ? undefined : dateOf(i))),
          run = runOf(steps),
          effects = spendEffects.stepEffects(f.service, steps),
          summary = approvalSummary(run, effects),
          bare = size(viewOf(run, approvalSummary(run, withoutRows(effects))));
        assert.ok(bare <= planViewBudget, 'the plan without rows is ' + bare + ' bytes: it is a plan the view holds');
        const view = size(viewOf(run, summary));
        assert.ok(view <= planViewBudget, n + ' steps: the view is ' + view + ' bytes');
        // Every step lists its rows, is part of a group or is cut; or the plan says once that the rows of every step are in its own list.
        if (summary.changes_cut === true) {
          assert.ok(summary.steps.every(s => !s.changes && !s.group && !s.truncated));
          assert.equal(summary.truncated, true);
          assert.match(summary.changes_digest, /^[0-9a-f]{16}$/);
          assert.deepEqual(summary.step_fields.arguments.action, 'approval_summary');
          assert.equal(summary.groups, undefined);
          // The rows are bound: a different date in one step is a different summary.
          const moved = approvalSummary(
            run,
            spendEffects.stepEffects(f.service, [endDate(1, '2027-05-05T23:59:00+0300'), ...steps.slice(1)]),
          );
          assert.notEqual(moved.summary_hash, summary.summary_hash);
        } else {
          assert.equal(summary.changes_cut, undefined);
          for (const s of summary.steps) assert.ok(s.changes || s.group || s.truncated, s.id);
        }
      },
    );
test('rows never push the view over its bound: a plan the view holds without them is held with them, up to the one statement that says where they are', t => {
  const f = account(t);
  let said = 0;
  for (const n of [20, 30, 36, 38, 42, 44, 46, 48, 50, 60]) {
    const steps = Array.from({length: n}, (_, i) => endDate(i + 1, dateOf(i))),
      run = runOf(steps),
      effects = spendEffects.stepEffects(f.service, steps),
      summary = approvalSummary(run, effects),
      bare = size(viewOf(run, approvalSummary(run, withoutRows(effects)))),
      view = size(viewOf(run, summary));
    said += summary.changes_cut ? 1 : 0;
    // The statement costs 200 bytes or so: a plan within that of its bound without rows is a known limit, as is one over it.
    if (bare + 200 <= planViewBudget)
      assert.ok(view <= planViewBudget, n + ' steps: ' + view + ' bytes, ' + bare + ' without rows');
    else assert.ok(view <= bare + 260, n + ' steps: ' + view + ' bytes, ' + bare + ' without rows');
  }
  assert.ok(said > 0, 'the last resort was used');
});

test('an end date on an ad set is a row with the object, its id, the field and the value, where the step read fields_total 0', t => {
  const f = account(t),
    summary = summarize(f, [endDate(1, '2026-12-06T23:59:00+0300'), endDate(2, '2026-12-07T23:59:00+0300')]);
  for (const [id, i, date] of [
    ['adset_01', 1, '2026-12-06T23:59:00+0300'],
    ['adset_02', 2, '2026-12-07T23:59:00+0300'],
  ]) {
    const s = entry(summary, id);
    assert.deepEqual(s.changes, [{object: 'ad set', id: adSetId(i), field: 'end_time', new: date}]);
    assert.equal(s.fields_total, 0, 'the money and status fields are counted as they were');
    assert.equal(s.changes_total, undefined);
    assert.equal(s.group, undefined);
  }
});

test('24 ad sets with 24 different end dates list every id and date, inside the bound', t => {
  const f = account(t),
    steps = Array.from({length: 24}, (_, i) =>
      endDate(i + 1, '2026-12-' + String(10 + i).padStart(2, '0') + 'T23:59:00+0300'),
    ),
    summary = summarize(f, steps);
  assert.equal(summary.groups, undefined, 'different dates are different changes');
  assert.equal(summary.truncated, undefined);
  assert.deepEqual(
    summary.steps.map(s => s.changes[0].id),
    steps.map((s, i) => adSetId(i + 1)),
  );
  assert.deepEqual(
    summary.steps.map(s => s.changes[0].new.slice(0, 10)),
    steps.map((s, i) => '2026-12-' + String(10 + i).padStart(2, '0')),
  );
  assert.ok(size(summary.steps) <= approvalBytes, 'the steps are ' + size(summary.steps) + ' bytes');
  // 26 are inside the bound too: the owner's plans are of this size (24 and 26 steps).
  const more = summarize(f, [
    ...steps,
    endDate(25, '2027-01-02T23:59:00+0300'),
    endDate(26, '2027-01-03T23:59:00+0300'),
  ]);
  assert.ok(size(more.steps) <= approvalBytes, 'the steps of 26 are ' + size(more.steps) + ' bytes');
  assert.equal(more.truncated, undefined);
});

test('24 ad sets given the same end date are one group: the count, the ids, the change once, and each step names the group', t => {
  const f = account(t),
    steps = Array.from({length: 24}, (_, i) => endDate(i + 1)),
    summary = summarize(f, steps),
    different = summarize(
      f,
      steps.map((s, i) => endDate(i + 1, '2026-12-' + String(10 + i).padStart(2, '0') + 'T23:59:00+0300')),
    );
  assert.deepEqual(summary.groups, [
    {
      group: 'g1',
      count: 24,
      object: 'ad set',
      ids: steps.map((s, i) => adSetId(i + 1)),
      changes: [{field: 'end_time', new: '2026-12-06T23:59:00+0300'}],
    },
  ]);
  for (const s of summary.steps) {
    assert.equal(s.group, 'g1');
    assert.equal(s.changes, undefined);
  }
  assert.ok(size(summary) < size(different), size(summary) + ' against ' + size(different));
  // The group keeps the order of the steps, so the id of step k is ids[k].
  assert.deepEqual(
    summary.steps.map(s => s.id),
    steps.map(s => s.id),
  );
});

test('what a review hides stays hidden in an approval: a customer list, a token-like value and a field named email', t => {
  const f = account(t),
    token = 'abcdefghijklmnopqrstuvwxyz0123456789',
    steps = [
      step(
        'audience',
        'meta_native_action',
        {
          action: 'meta_custom_audience_id_users_create',
          path_params: {custom_audience_id: '789'},
          payload: {payload: {schema: ['EMAIL'], data: [['person@example.com']]}},
        },
        {account_id: 'act_111'},
      ),
      step(
        'leaky',
        'meta_native_action',
        {
          action: 'meta_ad_set_id_update',
          path_params: {ad_set_id: '456'},
          payload: {name: 'Bearer ' + token, email: 'owner@example.com'},
        },
        {account_id: 'act_111'},
      ),
    ],
    effects = spendEffects.stepEffects(f.service, steps),
    summary = approvalSummary(planOf(steps), effects),
    everything = JSON.stringify([summary, ...steps.map(s => approvalStep(planOf(steps), s.id, effects))]);
  assert.ok(!everything.includes(token) && !everything.includes('example.com'), everything);
  assert.deepEqual(
    entry(summary, 'audience').changes.map(r => [r.field, r.new]),
    [['people', 'withheld: personal data']],
  );
  assert.deepEqual(
    entry(summary, 'leaky').changes.map(r => [r.field, r.new]),
    [
      ['name', 'Bearer [REDACTED]'],
      ['email', '[personal data]'],
    ],
  );
});

test('the money of a group is shown in the account currency too, once for the group', t => {
  const f = account(t),
    steps = [1, 2, 3, 4, 5].map(i =>
      step(
        'adset_' + i,
        'meta_native_action',
        {action: 'meta_ad_set_id_update', path_params: {ad_set_id: adSetId(i)}, payload: {daily_budget: '456050'}},
        {account_id: 'act_111'},
      ),
    ),
    accounts = new Map([[accountKey('meta_native_action', 'act_111'), {currency: 'USD'}]]),
    summary = approvalSummary(planOf(steps), spendEffects.stepEffects(f.service, steps), accounts);
  assert.deepEqual(summary.groups, [
    {
      group: 'g1',
      count: 5,
      object: 'ad set',
      ids: steps.map((_, i) => adSetId(i + 1)),
      changes: [{field: 'daily_budget', new: '456050', shown: '4560.50 USD'}],
    },
  ]);
});

test('a group needs four steps that make one change, in one account, and is made only when it is smaller', t => {
  const f = account(t);
  // Three are listed one by one.
  const three = summarize(f, [endDate(1), endDate(2), endDate(3)]);
  assert.equal(three.groups, undefined);
  assert.ok(three.steps.every(s => s.changes.length === 1));
  // Four of one change are a group.
  assert.equal(
    summarize(
      f,
      [1, 2, 3, 4].map(i => endDate(i)),
    ).groups?.[0].count,
    4,
  );
  // Other accounts, other fields and other values are other groups, here two of six.
  const other = id =>
    step(
      id,
      'meta_native_action',
      {
        action: 'meta_ad_set_id_update',
        path_params: {ad_set_id: '9' + id.length},
        payload: {end_time: '2026-12-06T23:59:00+0300'},
      },
      {account_id: 'act_222'},
    );
  const mixed = summarize(f, [1, 2, 3, 4].map(i => endDate(i)).concat(['a', 'bb', 'ccc', 'dddd'].map(other)));
  assert.deepEqual(
    mixed.groups.map(g => [g.group, g.count]),
    [
      ['g1', 4],
      ['g2', 4],
    ],
  );
  // A step that lists a row the group could not name once (it names several objects) is its own: one status for many ad groups is no group.
  const pause = id =>
    step(id, 'tiktok_native_action', {
      action: 'tiktok_adgroup_status_update',
      payload: {advertiser_id: '123', adgroup_ids: ['1', '2'], operation_status: 'DISABLE'},
    });
  assert.equal(summarize(f, ['a', 'b', 'c', 'd'].map(pause)).groups, undefined);
});

test('a step that changes several fields lists them in order, money first, and a create lists its name and dates', t => {
  const f = account(t),
    update = step(
      'budget',
      'meta_native_action',
      {
        action: 'meta_ad_set_id_update',
        path_params: {ad_set_id: '456'},
        payload: {end_time: '2026-12-06T23:59:00+0300', daily_budget: '456050', name: 'Renamed', status: 'PAUSED'},
      },
      {account_id: 'act_111'},
    ),
    create = step(
      'create',
      'meta_native_action',
      {
        action: 'meta_adset_create',
        payload: {
          name: 'Spring promo',
          campaign_id: '2111',
          daily_budget: '4000',
          billing_event: 'IMPRESSIONS',
          optimization_goal: 'REACH',
          status: 'PAUSED',
          start_time: '2026-12-01T00:00:00+0300',
        },
      },
      {account_id: 'act_111'},
    ),
    summary = summarize(f, [update, create]);
  assert.deepEqual(
    entry(summary, 'budget').changes.map(r => r.field),
    ['daily_budget', 'status', 'end_time', 'name'],
  );
  // A create lists its dates and its name: the money and status it sets are in spend and status, the rest of what it sets is counted.
  const made = entry(summary, 'create');
  assert.deepEqual(
    made.changes.map(r => [r.object, r.field, r.new]),
    [
      ['new ad set "Spring promo"', 'start_time', '2026-12-01T00:00:00+0300'],
      ['new ad set "Spring promo"', 'name', 'Spring promo'],
    ],
  );
  assert.deepEqual(made.spend, [{field: '/payload/daily_budget', value: '4000'}]);
  assert.deepEqual(made.status, [{field: '/payload/status', value: 'PAUSED'}]);
  assert.equal(made.changes_total, 7, 'the rest are counted');
  assert.match(made.changes_digest, /^[0-9a-f]{16}$/);
  assert.equal(made.all_fields, undefined);
  assert.deepEqual(summary.step_fields, {
    tool: 'amcp_campaign',
    arguments: {action: 'approval_summary', id: '<this plan>', step_id: '<step id>'},
  });
  assert.equal(
    made.truncated,
    undefined,
    'a cut of the rows the summary lists is no truncation that locks the approval',
  );
  // The step's own list holds them all.
  const all = approvalStep(planOf([update, create]), 'create', spendEffects.stepEffects(f.service, [update, create]));
  assert.equal(all.changes_total, 7);
  assert.equal(all.changes.length, 7);
});

test('a step over twelve rows lists twelve and counts the rest, and a changed value among those not listed changes the summary_hash', t => {
  const f = account(t),
    keys = [
      'name',
      'start_time',
      'end_time',
      'optimization_goal',
      'billing_event',
      'destination_type',
      'pacing_type',
      'use_new_app_click',
      'is_dynamic_creative',
      'lifetime_imp_cap',
      'time_start',
      'time_stop',
      'rf_prediction_id',
      'instagram_actor_id',
    ],
    plan = last =>
      step(
        'many',
        'meta_native_action',
        {
          action: 'meta_ad_set_id_update',
          path_params: {ad_set_id: '456'},
          payload: Object.fromEntries(keys.map((k, i) => [k, i === keys.length - 1 ? last : 'v' + i])),
        },
        {account_id: 'act_111'},
      ),
    a = summarize(f, [plan('one')]),
    b = summarize(f, [plan('two')]),
    s = entry(a, 'many');
  assert.equal(s.changes.length, 12);
  assert.equal(s.changes_total, 14);
  assert.match(s.changes_digest, /^[0-9a-f]{16}$/);
  assert.equal(a.step_fields.arguments.action, 'approval_summary', 'the plan says where the rest of a step is');
  // The last row is not listed, and its value is in the hash.
  assert.ok(!JSON.stringify(a).includes('"one"') && !JSON.stringify(b).includes('"two"'));
  assert.notEqual(a.summary_hash, b.summary_hash);
  assert.equal(summarize(f, [plan('one')]).summary_hash, a.summary_hash, 'the same plan has the same summary_hash');
});

test('a value that changes, for the same field, changes the summary_hash; a plan the summary was read for has one hash', t => {
  const f = account(t),
    base = summarize(f, [endDate(1), endDate(2)]),
    again = summarize(f, [endDate(1), endDate(2)]),
    moved = summarize(f, [endDate(1), endDate(2, '2026-12-07T23:59:00+0300')]);
  assert.equal(again.summary_hash, base.summary_hash);
  assert.notEqual(moved.summary_hash, base.summary_hash);
  assert.equal(entry(moved, 'adset_02').changes[0].new, '2026-12-07T23:59:00+0300');
});

test('a step of 30 records is judged by its parts: its rows are all there, twelve listed and the rest one call away', t => {
  const f = account(t),
    operations = Array.from({length: 30}, (_, i) => ({
      update: {resource_name: at('campaigns', String(i + 1)), name: 'Renamed ' + (i + 1)},
      update_mask: 'name',
    })),
    steps = [step('rename', 'google_ads_native_action', {action: 'UPDATE_CAMPAIGN', payload: {operations}})],
    effects = spendEffects.stepEffects(f.service, steps),
    summary = approvalSummary(planOf(steps), effects),
    s = entry(summary, 'rename');
  assert.equal(effects.get('rename').checked, true, 'judged in its parts of 25');
  assert.equal(s.changes.length, 12);
  assert.equal(s.changes_total, 30);
  assert.deepEqual(
    s.changes.map(r => [r.object, r.id, r.field, r.new]),
    Array.from({length: 12}, (_, i) => ['campaign', String(i + 1), 'name', 'Renamed ' + (i + 1)]),
  );
  const all = approvalStep(planOf(steps), 'rename', effects);
  assert.equal(all.changes.length, 30);
  assert.deepEqual(all.changes.at(-1), {object: 'campaign', id: '30', field: 'name', new: 'Renamed 30'});
});

test('one status for many objects is one row; past twelve ids it lists twelve and its count says how many', t => {
  const f = account(t),
    // 20 ids is what TikTok takes in one status change (src/tiktok-entity-status.ts maxIds).
    ids = Array.from({length: 20}, (_, i) => String(1000 + i)),
    steps = [
      step('pause', 'tiktok_native_action', {
        action: 'tiktok_adgroup_status_update',
        payload: {advertiser_id: '123', adgroup_ids: ids, operation_status: 'DISABLE'},
      }),
    ],
    effects = spendEffects.stepEffects(f.service, steps),
    summary = approvalSummary(planOf(steps), effects),
    s = entry(summary, 'pause');
  assert.equal(s.changes.length, 1);
  assert.equal(s.changes[0].count, 20);
  assert.deepEqual(s.changes[0].ids, ids.slice(0, 12));
  assert.equal(s.changes_total, 20, 'the row is cut: the step counts what it changes and says where the rest is');
  assert.equal(summary.step_fields.arguments.action, 'approval_summary');
  const all = approvalStep(planOf(steps), 'pause', effects);
  assert.deepEqual(all.changes[0].ids, ids);
  assert.equal(all.changes_total, 20);
});

test('one plan of five platforms lists each step by its own object, id, field and value (Meta, Google, TikTok, LinkedIn, Microsoft)', t => {
  const f = account(t),
    steps = [
      endDate(1),
      step('google', 'google_ads_native_action', {
        action: 'UPDATE_CAMPAIGN_BUDGET',
        payload: {
          operations: [
            {
              update: {resource_name: at('campaignBudgets', '9'), amount_micros: '203040000'},
              update_mask: 'amount_micros',
            },
          ],
        },
      }),
      step('tiktok', 'tiktok_native_action', {
        action: 'tiktok_campaign_status_update',
        payload: {advertiser_id: '123', campaign_ids: ['11', '12'], operation_status: 'DISABLE'},
      }),
      step('linkedin', 'linkedin_native_action', {
        action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
        path_params: {ad_account_id: '123', campaign_id: '1'},
        restli_method: 'PARTIAL_UPDATE',
        payload: {patch: {$set: {status: 'PAUSED', dailyBudget: {amount: '50', currencyCode: 'USD'}}}},
      }),
      step('microsoft', 'microsoft_ads_native_action', {
        action: 'UpdateCampaigns',
        payload: {Campaigns: [{Id: '5', Status: 'Paused'}]},
      }),
    ],
    summary = summarize(f, steps),
    rows = id => entry(summary, id).changes.map(({shown: _shown, ...row}) => row);
  assert.deepEqual(rows('adset_01'), [
    {object: 'ad set', id: adSetId(1), field: 'end_time', new: '2026-12-06T23:59:00+0300'},
  ]);
  assert.deepEqual(rows('google'), [{object: 'campaign budget', id: '9', field: 'amount_micros', new: '203040000'}]);
  assert.deepEqual(rows('tiktok'), [
    {object: 'campaign', ids: ['11', '12'], count: 2, field: 'operation_status', new: 'DISABLE'},
  ]);
  assert.deepEqual(rows('linkedin'), [
    {object: 'ad campaign', id: '1', field: 'dailyBudget', new: '50 USD'},
    {object: 'ad campaign', id: '1', field: 'status', new: 'PAUSED'},
  ]);
  assert.deepEqual(rows('microsoft'), [{object: 'campaign', id: '5', field: 'Status', new: 'Paused'}]);
  assert.equal(summary.truncated, undefined);
  assert.ok(size(summary.steps) <= approvalBytes);
});

test('money is shown in the account currency where the account is known, and nothing of it is in the summary_hash', t => {
  const f = account(t),
    google = step('budget', 'google_ads_native_action', {
      action: 'UPDATE_CAMPAIGN_BUDGET',
      payload: {
        operations: [
          {
            update: {resource_name: at('campaignBudgets', '9'), amount_micros: '203040000'},
            update_mask: 'amount_micros',
          },
        ],
      },
    }),
    meta = step(
      'adset',
      'meta_native_action',
      {action: 'meta_ad_set_id_update', path_params: {ad_set_id: '456'}, payload: {daily_budget: '456050'}},
      {account_id: 'act_111'},
    ),
    recipe = step(
      'recipe',
      'meta_native_action',
      {action: 'meta_ad_set_id_update', path_params: {ad_set_id: '457'}, payload: {daily_budget: '456050'}},
      {account_id: 'act_222', expected_currency: 'EUR'},
    ),
    steps = [google, meta, recipe],
    effects = spendEffects.stepEffects(f.service, steps),
    accounts = new Map([
      [accountKey('google_ads_native_action', '123'), {name: 'Acme US', currency: 'USD', timezone: 'America/New_York'}],
      [accountKey('meta_native_action', 'act_111'), {currency: 'USD', timezone: 'Asia/Riyadh'}],
    ]),
    bare = approvalSummary(planOf(steps), effects),
    shown = approvalSummary(planOf(steps), effects, accounts);
  const money = (summary, id) => entry(summary, id).changes[0].shown;
  assert.equal(money(shown, 'budget'), '203.04 USD');
  assert.equal(money(shown, 'adset'), '4560.50 USD');
  assert.equal(money(shown, 'recipe'), '4560.50 EUR', 'a recipe step states the currency it expects');
  // Without the account: Google micros are still an amount of the account currency, whichever it is; Meta's cents cannot be converted and stay native.
  assert.equal(money(bare, 'budget'), '203.04 in account currency');
  assert.equal(money(bare, 'adset'), undefined);
  assert.deepEqual(shown.accounts, [
    {
      gateway: 'google_ads_native_action',
      account_id: '123',
      name: 'Acme US',
      currency: 'USD',
      timezone: 'America/New_York',
    },
    {gateway: 'meta_native_action', account_id: 'act_111', currency: 'USD', timezone: 'Asia/Riyadh'},
  ]);
  assert.equal(bare.accounts, undefined);
  // What the account store says is not what the approver signs: the hash is the same with and without it, and the native values are in the rows.
  assert.equal(shown.summary_hash, bare.summary_hash);
  assert.equal(entry(shown, 'adset').changes[0].new, '456050');
  assert.equal(approvalStep(planOf(steps), 'adset', effects, accounts).changes[0].shown, '4560.50 USD');
});

test('a decimal amount is shown in the account currency too (Microsoft: DailyBudget 12.5), and a list of items that each name their ad group keeps every id', t => {
  const f = account(t),
    steps = [
      step('ms', 'microsoft_ads_native_action', {
        action: 'UpdateCampaigns',
        payload: {Campaigns: [{Id: '1', DailyBudget: 12.5}]},
      }),
      step('budgets', 'tiktok_native_action', {
        action: 'tiktok_adgroup_budget_update',
        payload: {
          advertiser_id: '123',
          budget: [
            {adgroup_id: '11', budget: 50},
            {adgroup_id: '12', budget: 60},
          ],
        },
      }),
    ],
    summary = summarize(f, steps);
  assert.deepEqual(entry(summary, 'ms').changes, [
    {object: 'campaign', id: '1', field: 'DailyBudget', new: 12.5, shown: '12.50 in account currency'},
  ]);
  assert.deepEqual(entry(summary, 'budgets').changes, [
    {object: 'ad group', id: '11', field: 'budget', new: 50},
    {object: 'ad group', id: '12', field: 'budget', new: 60},
  ]);
});

// The review of 2026-11-26 (S3-2): the summary may cut a value it cannot hold, but never silently, and the step's own list never cuts one.
test('a value longer than the summary holds is cut with a marker, whole in the step’s own list, and its tail is in the summary_hash', t => {
  const f = account(t),
    countries = ['SA', 'AE', 'EG', 'KW', 'QA', 'BH', 'OM', 'JO', 'LB', 'MA', 'TN', 'DZ'],
    targeting = tail => ({geo_locations: {countries}, excluded_geo_locations: {regions: [tail]}}),
    wide = tail =>
      step(
        'wide',
        'meta_native_action',
        {action: 'meta_ad_set_id_update', path_params: {ad_set_id: '456'}, payload: {targeting: targeting(tail)}},
        {account_id: 'act_111'},
      ),
    one = summarize(f, [wide('one')]),
    two = summarize(f, [wide('two')]),
    s = entry(one, 'wide'),
    row = s.changes.find(r => r.field === 'targeting');
  assert.equal(row.clipped, true);
  assert.equal(row.new.length, 80);
  assert.ok(row.new.endsWith('…'));
  assert.equal(s.changes_total, 1, 'a step that lists a cut value says so, and where the whole one is');
  assert.match(s.changes_digest, /^[0-9a-f]{16}$/);
  assert.notEqual(one.summary_hash, two.summary_hash, 'the tail of the value is bound by the hash');
  const own = approvalStep(
    planOf([wide('one')]),
    'wide',
    spendEffects.stepEffects(f.service, [wide('one')]),
  ).changes.find(r => r.field === 'targeting');
  assert.equal(own.new, JSON.stringify(targeting('one')));
  assert.equal(own.clipped, undefined);
  // A value that fits is not marked.
  const small = summarize(f, [endDate(1)]);
  assert.equal(entry(small, 'adset_01').changes[0].clipped, undefined);
  assert.equal(entry(small, 'adset_01').changes_total, undefined);
});

test('a patch-shaped step lists its fields by path under the id of its route', t => {
  const f = account(t),
    steps = [
      step('patch', 'snapchat_native_action', {
        action: 'snapchat_campaign_update',
        params: {ad_account_id: '123', campaign_id: 'c1'},
        body: [
          {op: 'replace', path: '/status', value: 'PAUSED'},
          {op: 'replace', path: '/daily_budget_micro', value: 62500000},
        ],
      }),
    ],
    s = entry(summarize(f, steps), 'patch');
  assert.deepEqual(s.changes, [
    {object: 'campaign', id: 'c1', field: 'daily_budget_micro', new: 62500000, shown: '62.50 in account currency'},
    {object: 'campaign', id: 'c1', field: 'status', new: 'PAUSED'},
  ]);
});

test('a step that sets nothing has no rows and is no group; a plan without the compile is summarized as it was', t => {
  const f = account(t),
    empty = step(
      'empty',
      'meta_native_action',
      {action: 'meta_ad_set_id_update', path_params: {ad_set_id: '456'}, payload: {}},
      {account_id: 'act_111'},
    ),
    ids = step('ids', 'tiktok_native_action', {
      action: 'tiktok_adgroup_update',
      payload: {advertiser_id: '123', adgroup_id: '77'},
    }),
    summary = summarize(f, [empty, ids]);
  for (const id of ['empty', 'ids']) {
    assert.equal(entry(summary, id).changes, undefined, id);
    assert.equal(entry(summary, id).changes_total, undefined, id);
  }
  assert.equal(summary.groups, undefined);
  // No effects map: the distinct-approver path reads the same summary it always read, with no row in it.
  const policy = approvalSummary(planOf([endDate(1), endDate(2), endDate(3), endDate(4)]));
  assert.ok(policy.steps.every(s => s.changes === undefined && s.group === undefined));
  assert.equal(policy.groups, undefined);
  assert.equal(approvalMoney(policy), false);
});

test('past the bound, steps are cut to their own list with the call that lists it: no row is dropped without saying where it is', t => {
  const f = account(t),
    keys = [
      'name',
      'start_time',
      'end_time',
      'optimization_goal',
      'billing_event',
      'destination_type',
      'pacing_type',
      'use_new_app_click',
      'is_dynamic_creative',
      'lifetime_imp_cap',
      'time_start',
      'time_stop',
    ],
    steps = Array.from({length: 14}, (_, n) =>
      step(
        'wide_' + n,
        'meta_native_action',
        {
          action: 'meta_ad_set_id_update',
          path_params: {ad_set_id: adSetId(n)},
          payload: Object.fromEntries(keys.map((k, i) => [k, 'v' + n + '_' + i])),
        },
        {account_id: 'act_111'},
      ),
    ),
    effects = spendEffects.stepEffects(f.service, steps),
    summary = approvalSummary(planOf(steps), effects);
  assert.ok(size(summary.steps) <= approvalBytes, 'the steps are ' + size(summary.steps) + ' bytes');
  assert.equal(summary.truncated, true);
  const cut = summary.steps.filter(s => s.truncated);
  assert.ok(cut.length > 0 && cut.length < steps.length, 'some are cut, the first listed: ' + cut.length);
  for (const s of summary.steps) {
    // A step lists its rows, or says it is cut and how many it has: the call that lists them is the plan's own (`step_fields`), and one digest binds them all.
    if (s.truncated) {
      assert.equal(s.changes, undefined);
      assert.equal(s.changes_total, 12);
      assert.deepEqual(s.aggregates, [], 'the aggregates an older web bundle reads');
      assert.equal(s.all_fields, undefined);
    } else assert.equal(s.changes.length, 12);
  }
  assert.deepEqual(summary.step_fields.arguments, {
    action: 'approval_summary',
    id: '<this plan>',
    step_id: '<step id>',
  });
  assert.match(summary.changes_digest, /^[0-9a-f]{16}$/);
  // A value that changes in a cut step moves the hash, though the summary lists none of its rows.
  const moved = steps.map((s, n) =>
    n === steps.length - 1
      ? step(
          s.id,
          s.gateway,
          {
            ...s.arguments,
            payload: {...s.arguments.payload, name: 'another'},
          },
          {account_id: 'act_111'},
        )
      : s,
  );
  assert.notEqual(
    approvalSummary(planOf(moved), spendEffects.stepEffects(f.service, moved)).summary_hash,
    summary.summary_hash,
  );
  // The steps that stay listed are the first of the plan: the largest are cut first, and of equal ones the last.
  assert.ok(summary.steps.slice(0, steps.length - cut.length).every(s => !s.truncated));
  // Every row of a cut step is in its own list.
  assert.equal(approvalStep(planOf(steps), cut[0].id, effects).changes.length, 12);
});
