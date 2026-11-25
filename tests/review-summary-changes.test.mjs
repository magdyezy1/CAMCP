import test from 'node:test';
import assert from 'node:assert/strict';
import {googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {normalizeAccount} from '../dist/src/scope.js';
import {reviewSummary} from '../dist/src/review-summary.js';

/**
 * R2.5 package r25-approval-fields (the owner's friction report of 2026-11-25, B6): a single write's review read "Update 1 456 in account 111;
 * daily_budget 456050" (the id for the object, raw cents, no dates), and its "Before" data listed ids without names. The line names the object, the
 * field and the value it is given, with the value the review read for it (old → new), money in the account's currency; the objects whose names the
 * review read are listed with their ids. The exact native request below the line stays the authority. Everything is synthetic and local.
 */
let tenants = 0;
function compiler(t) {
  const f = googleReconcileFixture({tenant: 'review-changes-' + ++tenants});
  t.after(() => f.store.close());
  const svc = f.service;
  return (gateway, args, account = '123') => {
    const delegated = svc.registry.tools.get(gateway)?.mode === 'delegated',
      input = structuredClone(args);
    if (svc.registry.acceptsArgument(gateway, 'account_id', delegated ? input.operation : undefined)) {
      const id = normalizeAccount(gateway, account);
      if (delegated) input.arguments = {...input.arguments, account_id: id};
      else input.account_id = id;
    }
    svc.registry.validate(gateway, input, svc.options);
    return applyExecutionRisk(
      delegated ? svc.delegatedCompiler.compile(gateway, input) : svc.compiler.compile(gateway, input, svc.options),
    );
  };
}
const adSet = (compile, payload) =>
  compile('meta_native_action', {action: 'meta_ad_set_id_update', path_params: {ad_set_id: '456'}, payload}, 'act_111');

test('a Meta ad set update names the ad set, its field, and old → new, with the budget in the account currency', t => {
  const compile = compiler(t),
    plan = adSet(compile, {daily_budget: '456050', end_time: '2026-12-06T23:59:00+0300'}),
    state = [
      {id: 'act_111', name: 'Acme', currency: 'USD'},
      {
        id: '456',
        name: 'Spring promo',
        daily_budget: '400000',
        end_time: '2026-11-30T23:59:00+0300',
        status: 'ACTIVE',
      },
    ],
    s = reviewSummary(plan, state);
  assert.equal(
    s.text,
    'Update 1 ad set in account Acme (111): ad set "Spring promo" (456): daily_budget 4000.00 → 4560.50 USD (456050 1/100 USD), end_time 2026-11-30T23:59:00+0300 → 2026-12-06T23:59:00+0300.',
  );
  assert.deepEqual(s.changes, [
    {
      object: 'ad set "Spring promo"',
      id: '456',
      field: 'daily_budget',
      old: '400000',
      new: '456050',
      shown: '4000.00 → 4560.50 USD',
    },
    {
      object: 'ad set "Spring promo"',
      id: '456',
      field: 'end_time',
      old: '2026-11-30T23:59:00+0300',
      new: '2026-12-06T23:59:00+0300',
    },
  ]);
  assert.deepEqual(s.objects, [{id: '456', name: 'Spring promo'}]);
  // The fields the line always had are as they were, and the authority sentence is kept.
  assert.deepEqual(s.money, [
    {field: '/daily_budget', native: '456050', native_unit: '1/100 USD', amount: '4560.50', currency: 'USD'},
  ]);
  assert.match(s.authority, /exact native request below is what is sent/);
});

test('an account the review did not read is known by what AMCP stored of it: its currency, never a guess', t => {
  const compile = compiler(t),
    plan = adSet(compile, {daily_budget: '456050', end_time: '2026-12-06T23:59:00+0300'}),
    stored = reviewSummary(plan, [], {name: 'Acme', currency: 'USD'}),
    none = reviewSummary(plan, []);
  assert.equal(
    stored.text,
    'Update 1 ad set in account Acme (111): ad set (456): daily_budget 4560.50 USD (456050 1/100 USD), end_time 2026-12-06T23:59:00+0300.',
  );
  // Without a currency Meta's cents are not converted: the value stays what it was sent as, and no old value or name is invented.
  assert.equal(
    none.text,
    'Update 1 ad set in account 111: ad set (456): daily_budget 456050, end_time 2026-12-06T23:59:00+0300.',
  );
  assert.equal(none.objects, undefined);
  assert.equal(none.money[0].amount, undefined);
  assert.ok(
    none.changes.every(r => r.old === undefined),
    'a value the review did not read is omitted, never "unknown"',
  );
  // What the review read of the account wins over what was stored.
  const read = reviewSummary(plan, [{id: 'act_111', currency: 'EUR'}], {currency: 'USD'});
  assert.match(read.text, /daily_budget 4560\.50 EUR/);
});

test('a Google budget is in the account currency the account is stored with, where the review read no customer', t => {
  const compile = compiler(t),
    plan = compile('google_ads_native_action', {
      action: 'UPDATE_CAMPAIGN_BUDGET',
      payload: {
        operations: [
          {
            update: {resource_name: 'customers/123/campaignBudgets/9', amount_micros: '203040000'},
            update_mask: 'amount_micros',
          },
        ],
      },
    });
  assert.equal(
    reviewSummary(plan, []).text,
    'Update 1 campaign budget in account 123: campaign budget (9): amount_micros 203.04 in account currency (203040000 micros).',
  );
  assert.equal(
    reviewSummary(
      plan,
      [{resourceName: 'customers/123/campaignBudgets/9', name: 'Main budget', amountMicros: '150000000'}],
      {currency: 'USD'},
    ).text,
    'Update 1 campaign budget in account 123: campaign budget "Main budget" (9): amount_micros 150.00 → 203.04 USD (203040000 micros).',
  );
});

test('a value that stays what it is says so, and a request that changes many objects names the first three and counts the rest', t => {
  const compile = compiler(t),
    same = reviewSummary(
      adSet(compile, {daily_budget: '400000'}),
      [{id: '456', name: 'Spring promo', daily_budget: '400000'}],
      {
        currency: 'USD',
      },
    );
  assert.equal(
    same.text,
    'Update 1 ad set in account 111: ad set "Spring promo" (456): daily_budget 4000.00 USD (400000 1/100 USD) (unchanged).',
  );
  const pause = compile('tiktok_native_action', {
    action: 'tiktok_adgroup_status_update',
    payload: {advertiser_id: '123', adgroup_ids: ['1', '2', '3', '4', '5'], operation_status: 'DISABLE'},
  });
  assert.equal(
    reviewSummary(pause, []).text,
    'Update 5 ad groups in account 123: ad group (1, 2, 3 and 2 more): operation_status DISABLE.',
  );
  const records = compile('microsoft_ads_native_action', {
    action: 'UpdateCampaigns',
    payload: {Campaigns: Array.from({length: 12}, (_, i) => ({Id: String(100 + i), Status: 'Paused'}))},
  });
  const s = reviewSummary(records, []);
  assert.equal(s.text, 'Update 12 campaigns in account 123: campaign (100, 101, 102 and 9 more): Status Paused.');
  assert.ok(Buffer.byteLength(JSON.stringify(s)) < 1024, 'a summary stays small beside the request it summarizes');
});

test('a patch-shaped and a mask-shaped update read the values the review read', t => {
  const compile = compiler(t),
    patch = reviewSummary(
      compile('snapchat_native_action', {
        action: 'snapchat_campaign_update',
        params: {ad_account_id: '123', campaign_id: 'c1'},
        body: [
          {op: 'replace', path: '/status', value: 'PAUSED'},
          {op: 'replace', path: '/daily_budget_micro', value: 62500000},
        ],
      }),
      [{id: 'c1', name: 'Brand', status: 'ACTIVE', daily_budget_micro: 50000000}],
      {currency: 'EUR'},
    ),
    mask = reviewSummary(
      compile('google_ads_native_action', {
        action: 'UPDATE_CAMPAIGN',
        payload: {
          operations: [{update: {resource_name: 'customers/123/campaigns/5', status: 'PAUSED'}, update_mask: 'status'}],
        },
      }),
      [{results: [{campaign: {resourceName: 'customers/123/campaigns/5', status: 'ENABLED', name: 'Brand'}}]}],
    );
  assert.equal(
    patch.text,
    'Update 1 campaign in account 123: campaign "Brand" (c1): daily_budget_micro 50.00 → 62.50 EUR (62500000 micros), status ACTIVE → PAUSED.',
  );
  assert.equal(mask.text, 'Update 1 campaign in account 123: campaign "Brand" (5): status ENABLED → PAUSED.');
  assert.deepEqual(mask.status, [{field: '/operations/0/update/status', from: 'ENABLED', to: 'PAUSED'}]);
});

test('no secret and no person is in the line or its rows: a token, an email field and a customer list', t => {
  const compile = compiler(t),
    token = 'abcdefghijklmnopqrstuvwxyz0123456789',
    leaky = reviewSummary(adSet(compile, {name: 'Bearer ' + token, email: 'owner@example.com'}), []),
    list = reviewSummary(
      compile(
        'meta_native_action',
        {
          action: 'meta_custom_audience_id_users_create',
          path_params: {custom_audience_id: '77'},
          payload: {schema: ['EMAIL'], data: [['someone@example.com']]},
        },
        'act_111',
      ),
      [],
    );
  for (const s of [leaky, list]) {
    const all = JSON.stringify(s);
    assert.ok(!all.includes(token) && !all.includes('example.com'), all);
  }
  assert.match(leaky.text, /name Bearer \[REDACTED\], email \[personal data\]/);
  assert.deepEqual(list.changes, [{object: 'users', field: 'people', new: 'withheld: personal data'}]);
  // A name and a value the review read are shown as the review shows its before-state: a credential shape or a person in them is hidden too, and a
  // long one is clipped (Ruling 16: the default view of a step never held the hidden value).
  const read = reviewSummary(adSet(compile, {name: 'Renamed'}), [
    {id: '456', name: 'Win now &password=hunter2 b c', owner: 'a@b.co'},
  ]);
  assert.ok(!JSON.stringify(read).includes('hunter2'), read.text);
  assert.match(
    read.text,
    /ad set "Win now &password=\[REDACTED\] b c" \(456\): name Win now &password=\[REDACTED\] b c → Renamed/,
  );
  const long = reviewSummary(adSet(compile, {name: 'Renamed'}), [{id: '456', name: 'N'.repeat(300)}]);
  assert.ok(long.objects[0].name.length <= 60, String(long.objects[0].name.length));
  assert.ok(long.changes[0].old.length <= 80);
});

test('a request whose entity the summary cannot name says what it always said: the head, the money and the statuses', () => {
  // A Google service named like a member of every object (the ledger's `constructor`) is no entity of the summary's: it has no rows, no throw, and
  // the line is the head with its money and status as it was before the rows.
  const plan = {
    gateway: 'google_ads_native_action',
    action: 'x',
    method: 'POST',
    path: '/v25/customers/1/constructor:mutate',
    query: {},
    body: {daily_budget: 500, status: 'PAUSED'},
    headers: {},
    readOnly: false,
    destructive: false,
    requiresConfirmation: false,
    accountId: '123',
    evidence: '',
    warnings: [],
  };
  const s = reviewSummary(plan, []);
  assert.match(s.text, /^Change 1 .+ in account 123; daily_budget 500 micros; status PAUSED\.$/s);
  assert.equal(s.changes, undefined);
  assert.deepEqual(s.status, [{field: '/status', to: 'PAUSED'}]);
});
