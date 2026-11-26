import test from 'node:test';
import assert from 'node:assert/strict';
import {googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {normalizeAccount} from '../dist/src/scope.js';
import {isAmount, mergeChanges, requestChanges, targetKeys} from '../dist/src/request-changes.js';
import {clipRow} from '../dist/src/plan-approval.js';

/**
 * R2.5 package r25-approval-fields (the owner's friction report of 2026-11-25, B2 and B6): an approval must show what each step changes:
 * the object, its id, the field and the new value, for every platform. The rows come from the request each step compiles to (method,
 * path, query and body), after the scrubbing the review applies to the request it shows, and never from a provider read. Everything
 * here is synthetic and local: nothing is sent.
 */
let tenants = 0;
/** A compiler of plan steps, as `amcp_write inspect` compiles them (the catalog's own validation and the request's execution risk). */
function compiler(t) {
  const f = googleReconcileFixture({tenant: 'request-changes-' + ++tenants});
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
/** A compiled request written out, for a shape no catalog action is needed for. */
const request = (gateway, method, path, body, extra = {}) => ({
  gateway,
  action: 'synthetic_action',
  method,
  path,
  query: {},
  ...(body === undefined ? {} : {body}),
  headers: {},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  accountId: '123',
  evidence: 'synthetic',
  warnings: [],
  ...extra,
});
const update = entity => ({operation: 'update', entity});

test('Meta: an end date on one ad set is a row with the ad set id, the field and the value as written', t => {
  const compile = compiler(t),
    plan = compile(
      'meta_native_action',
      {
        action: 'meta_ad_set_id_update',
        path_params: {ad_set_id: '456'},
        payload: {end_time: '2026-12-06T23:59:00+0300'},
      },
      'act_111',
    );
  assert.deepEqual(requestChanges(plan, update('ad set')), [
    {object: 'ad set', id: '456', field: 'end_time', new: '2026-12-06T23:59:00+0300'},
  ]);
});

test('Meta: money first, then status, dates and name, then the rest in request order; an absent old value or name is omitted', t => {
  const compile = compiler(t),
    plan = compile(
      'meta_native_action',
      {
        action: 'meta_ad_set_id_update',
        path_params: {ad_set_id: '456'},
        payload: {
          optimization_goal: 'REACH',
          name: 'Renamed',
          end_time: '2026-12-06T23:59:00+0300',
          status: 'PAUSED',
          daily_budget: '456050',
          billing_event: 'IMPRESSIONS',
        },
      },
      'act_111',
    ),
    rows = requestChanges(plan, update('ad set'));
  assert.deepEqual(
    rows.map(r => r.field),
    ['daily_budget', 'status', 'end_time', 'name', 'optimization_goal', 'billing_event'],
  );
  assert.ok(rows.every(r => r.id === '456' && r.object === 'ad set' && !('old' in r)));
  // The value keeps the type it was sent with.
  assert.deepEqual(rows[0], {object: 'ad set', id: '456', field: 'daily_budget', new: '456050'});
  // A bid strategy is money by the rule the approval's money fields already use (it names a bid).
  const bid = compile(
    'meta_native_action',
    {action: 'meta_ad_set_id_update', path_params: {ad_set_id: '456'}, payload: {name: 'x', bid_strategy: 'COST_CAP'}},
    'act_111',
  );
  assert.deepEqual(
    requestChanges(bid, update('ad set')).map(r => r.field),
    ['bid_strategy', 'name'],
  );
});

test('Meta: a create names no id, is called new, and carries the name it is given', t => {
  const compile = compiler(t),
    plan = compile(
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
        },
      },
      'act_111',
    ),
    rows = requestChanges(plan, {operation: 'create', entity: 'ad set'});
  assert.ok(rows.every(r => r.object === 'new ad set "Spring promo"' && !('id' in r) && !('ids' in r)));
  assert.deepEqual(
    rows.map(r => r.field),
    ['daily_budget', 'status', 'name', 'campaign_id', 'billing_event', 'optimization_goal'],
  );
  // The parent a create names stays a field: it says where the object goes.
  assert.deepEqual(
    rows.find(r => r.field === 'campaign_id'),
    {object: 'new ad set "Spring promo"', field: 'campaign_id', new: '2111'},
  );
});

test('a value that repeats the account is no change, and one that only looks like it (another id) is', () => {
  const plan = request('tiktok_native_action', 'POST', '/v1.3/adgroup/update/', {
    advertiser_id: '123',
    adgroup_id: '77',
    campaign_id: '1230',
    budget: 5,
  });
  assert.deepEqual(requestChanges(plan, update('ad group')), [
    {object: 'ad group', id: '77', field: 'budget', new: 5},
    {object: 'ad group', id: '77', field: 'campaign_id', new: '1230'},
  ]);
});

test('Google: a budget update lists the field the update sets, under the id of its resource name', t => {
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
  assert.deepEqual(requestChanges(plan, update('campaign budget')), [
    {object: 'campaign budget', id: '9', field: 'amount_micros', new: '203040000'},
  ]);
});

test('Google: a field in the mask that the update leaves out is a clear, never skipped; a removal is a deletion row', t => {
  const compile = compiler(t),
    plan = compile('google_ads_native_action', {
      action: 'UPDATE_CAMPAIGN',
      payload: {
        operations: [
          {update: {resource_name: 'customers/123/campaigns/1', name: 'Renamed'}, update_mask: 'name,status'},
          {remove: 'customers/123/campaigns/2'},
        ],
      },
    });
  assert.deepEqual(requestChanges(plan, {operation: 'change', entity: 'campaign'}), [
    {object: 'campaign', id: '1', field: 'status', new: null},
    {object: 'campaign', id: '1', field: 'name', new: 'Renamed'},
    {object: 'campaign', id: '2', field: 'object', new: 'deleted'},
  ]);
});

test('Google: a create lists what the new object is given, without its temporary resource name', t => {
  const compile = compiler(t),
    plan = compile('google_ads_native_action', {
      action: 'CREATE_CAMPAIGN',
      payload: {
        operations: [
          {
            create: {
              resource_name: 'customers/123/campaigns/-1',
              name: 'Spring promo',
              status: 'PAUSED',
              advertising_channel_type: 'SEARCH',
            },
          },
        ],
      },
    });
  const rows = requestChanges(plan, {operation: 'create', entity: 'campaign'});
  assert.deepEqual(rows, [
    {object: 'new campaign "Spring promo"', field: 'status', new: 'PAUSED'},
    {object: 'new campaign "Spring promo"', field: 'name', new: 'Spring promo'},
    {object: 'new campaign "Spring promo"', field: 'advertising_channel_type', new: 'SEARCH'},
  ]);
});

test('TikTok: the ad group an update names is its id, the account it repeats is no change, and money comes before the schedule', t => {
  const compile = compiler(t),
    plan = compile('tiktok_native_action', {
      action: 'tiktok_adgroup_update',
      payload: {advertiser_id: '123', adgroup_id: '77', schedule_end_time: '2026-12-06 23:59:00', budget: 50},
    });
  assert.deepEqual(requestChanges(plan, update('ad group')), [
    {object: 'ad group', id: '77', field: 'budget', new: 50},
    {object: 'ad group', id: '77', field: 'schedule_end_time', new: '2026-12-06 23:59:00'},
  ]);
});

test('TikTok: one status for several ad groups is one row that names them all and how many', t => {
  const compile = compiler(t),
    plan = compile('tiktok_native_action', {
      action: 'tiktok_adgroup_status_update',
      payload: {advertiser_id: '123', adgroup_ids: ['1', '2', '3'], operation_status: 'DISABLE'},
    });
  assert.deepEqual(requestChanges(plan, update('ad group')), [
    {object: 'ad group', ids: ['1', '2', '3'], count: 3, field: 'operation_status', new: 'DISABLE'},
  ]);
});

test('Microsoft: the record of a list names its Id, and a money field comes first', t => {
  const compile = compiler(t),
    plan = compile('microsoft_ads_native_action', {
      action: 'UpdateCampaigns',
      payload: {Campaigns: [{Id: '1', Status: 'Paused', DailyBudget: 40}]},
    });
  assert.deepEqual(requestChanges(plan, update('campaign')), [
    {object: 'campaign', id: '1', field: 'DailyBudget', new: 40},
    {object: 'campaign', id: '1', field: 'Status', new: 'Paused'},
  ]);
});

test('Microsoft: a deletion that lists its ids is one row for them all', t => {
  const compile = compiler(t),
    plan = compile('microsoft_ads_native_action', {action: 'DeleteCampaigns', payload: {CampaignIds: ['1', '2']}});
  assert.deepEqual(requestChanges(plan, {operation: 'delete', entity: 'campaign'}), [
    {object: 'campaign', ids: ['1', '2'], count: 2, field: 'object', new: 'deleted'},
  ]);
});

test('LinkedIn: the patch a campaign takes is read inside its $set, and a money object is one value with its currency', t => {
  const compile = compiler(t),
    plan = compile('linkedin_native_action', {
      action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
      path_params: {ad_account_id: '123', campaign_id: '1'},
      restli_method: 'PARTIAL_UPDATE',
      payload: {patch: {$set: {status: 'PAUSED', dailyBudget: {amount: '50', currencyCode: 'USD'}}}},
    });
  assert.deepEqual(requestChanges(plan, update('ad campaign')), [
    {object: 'ad campaign', id: '1', field: 'dailyBudget', new: '50 USD'},
    {object: 'ad campaign', id: '1', field: 'status', new: 'PAUSED'},
  ]);
});

test('a JSON Patch names each field by its path, under the id its route names; a test op sets nothing', t => {
  const compile = compiler(t),
    plan = compile('snapchat_native_action', {
      action: 'snapchat_campaign_update',
      params: {ad_account_id: '123', campaign_id: 'c1'},
      body: [
        {op: 'replace', path: '/status', value: 'PAUSED'},
        {op: 'replace', path: '/daily_budget_micro', value: 62500000},
        {op: 'remove', path: '/end_time'},
      ],
    });
  assert.deepEqual(requestChanges(plan, update('campaign')), [
    {object: 'campaign', id: 'c1', field: 'daily_budget_micro', new: 62500000},
    {object: 'campaign', id: 'c1', field: 'status', new: 'PAUSED'},
    {object: 'campaign', id: 'c1', field: 'end_time', new: '(removed)'},
  ]);
  const asserted = request('snapchat_native_action', 'PATCH', '/v1/adaccounts/123/campaigns/c1', [
    {op: 'test', path: '/status', value: 'ACTIVE'},
  ]);
  assert.deepEqual(requestChanges(asserted, update('campaign')), []);
});

test('Reddit, DV360, X and Apple: the object is the id its route ends with, and the wrapper a platform uses is opened', t => {
  const compile = compiler(t);
  assert.deepEqual(
    requestChanges(
      compile('reddit_native_action', {
        operation: 'reddit_campaign_ops',
        arguments: {
          action: 'UPDATE_CAMPAIGN',
          payload: {data: {configured_status: 'PAUSED'}},
          params: {campaign_id: '100'},
        },
      }),
      update('campaign'),
    ),
    [{object: 'campaign', id: '100', field: 'configured_status', new: 'PAUSED'}],
  );
  assert.deepEqual(
    requestChanges(
      compile('dv360_native_action', {
        action: 'DV360_ADVERTISERS_CAMPAIGNS_PATCH',
        params: {advertiserId: '123', campaignId: '1', updateMask: 'entityStatus'},
        body: {entityStatus: 'ENTITY_STATUS_PAUSED'},
      }),
      update('campaign'),
    ),
    [{object: 'campaign', id: '1', field: 'entityStatus', new: 'ENTITY_STATUS_PAUSED'}],
  );
  assert.deepEqual(
    requestChanges(
      compile('x_ads_native_action', {
        action: 'x_accounts_account_id_campaigns_campaign_id_put',
        params: {account_id: '123', campaign_id: 'c1'},
        payload: {entity_status: 'PAUSED', daily_budget_amount_local_micro: 5000000},
      }),
      update('campaign'),
    ),
    [
      {object: 'campaign', id: 'c1', field: 'daily_budget_amount_local_micro', new: 5000000},
      {object: 'campaign', id: 'c1', field: 'entity_status', new: 'PAUSED'},
    ],
  );
  assert.deepEqual(
    requestChanges(
      compile('apple_ads_native_action', {
        action: 'apple_ads_v1_campaign_update',
        path_params: {id: '1'},
        payload: {status: 'PAUSED'},
      }),
      update('campaign'),
    ),
    [{object: 'campaign', id: '1', field: 'status', new: 'PAUSED'}],
  );
});

test('a DELETE request is a deletion row for the id its route ends with', () => {
  const plan = request('snapchat_native_action', 'DELETE', '/v1/campaigns/c9', undefined, {destructive: true});
  assert.deepEqual(requestChanges(plan, {operation: 'delete', entity: 'campaign'}), [
    {object: 'campaign', id: 'c9', field: 'object', new: 'deleted'},
  ]);
});

test('a step that sets nothing has no row: an empty payload, and a body of ids and the account alone', t => {
  const compile = compiler(t);
  assert.deepEqual(
    requestChanges(
      compile(
        'meta_native_action',
        {action: 'meta_ad_set_id_update', path_params: {ad_set_id: '456'}, payload: {}},
        'act_111',
      ),
      update('ad set'),
    ),
    [],
  );
  assert.deepEqual(
    requestChanges(
      compile('tiktok_native_action', {
        action: 'tiktok_adgroup_update',
        payload: {advertiser_id: '123', adgroup_id: '77'},
      }),
      update('ad group'),
    ),
    [],
  );
});

test('a reference to a predecessor shows as that step, in the id and in a field, never as the stand-in it was checked with', () => {
  const plan = request('tiktok_native_action', 'POST', '/v1.3/campaign/status/update/', {
    advertiser_id: '123',
    campaign_ids: ['7300000000000000001', '7300000000000000002'],
    operation_status: 'DISABLE',
  });
  const references = new Map([
    ['7300000000000000001', 'camp_a#/data/data/campaign_id'],
    ['7300000000000000002', 'camp_b#/data/data/campaign_id'],
  ]);
  assert.deepEqual(requestChanges(plan, {...update('campaign'), references}), [
    {
      object: 'campaign',
      ids: ['result of camp_a', 'result of camp_b'],
      count: 2,
      field: 'operation_status',
      new: 'DISABLE',
    },
  ]);
  // The name the plan holds for the step a reference points at names the object; two names are two rows, one name is one.
  assert.deepEqual(
    requestChanges(plan, {
      ...update('campaign'),
      references,
      names: id => ({'result of camp_a': 'DNU A', 'result of camp_b': 'DNU B'})[id],
    }),
    [
      {object: 'campaign "DNU A"', id: 'result of camp_a', field: 'operation_status', new: 'DISABLE'},
      {object: 'campaign "DNU B"', id: 'result of camp_b', field: 'operation_status', new: 'DISABLE'},
    ],
  );
  const one = request('tiktok_native_action', 'POST', '/v1.3/adgroup/create/', {
    advertiser_id: '123',
    campaign_id: '7300000000000000001',
    adgroup_name: 'Group',
  });
  assert.deepEqual(requestChanges(one, {operation: 'create', entity: 'ad group', references}), [
    {object: 'new ad group "Group"', field: 'adgroup_name', new: 'Group'},
    {object: 'new ad group "Group"', field: 'campaign_id', new: 'result of camp_a'},
  ]);
});

test('an object whose name or old value the plan or a review holds shows them; an absent one is left out, never marked unknown', () => {
  const plan = request('meta_native_action', 'POST', '/v26.0/456', {
    end_time: '2026-12-06T23:59:00+0300',
    status: 'PAUSED',
  });
  const rows = requestChanges(plan, {
    ...update('ad set'),
    names: id => (id === '456' ? 'Spring promo' : undefined),
    before: (id, field) => (id === '456' && field === 'end_time' ? '2026-12-02T23:59:00+0300' : undefined),
  });
  assert.deepEqual(rows, [
    {object: 'ad set "Spring promo"', id: '456', field: 'status', new: 'PAUSED'},
    {
      object: 'ad set "Spring promo"',
      id: '456',
      field: 'end_time',
      old: '2026-12-02T23:59:00+0300',
      new: '2026-12-06T23:59:00+0300',
    },
  ]);
  assert.ok(!('old' in rows[0]));
});

test('a long value is whole in its row, and a nested value is its JSON; a view that cannot hold it cuts it with a marker (clipRow)', () => {
  const plan = request('meta_native_action', 'POST', '/v26.0/456', {
    name: 'x'.repeat(200),
    targeting: {geo_locations: {countries: ['SA', 'AE']}, age_min: 18},
  });
  const rows = requestChanges(plan, update('ad set')),
    name = rows.find(r => r.field === 'name'),
    targeting = rows.find(r => r.field === 'targeting');
  assert.equal(name.new, 'x'.repeat(200));
  assert.equal(targeting.new, '{"geo_locations":{"countries":["SA","AE"]},"age_min":18}');
  // The view cuts a value over 80 characters and says so; a row that is cut nowhere is returned as it is.
  const cut = clipRow(name);
  assert.equal(cut.new.length, 80);
  assert.ok(cut.new.endsWith('…'));
  assert.equal(cut.clipped, true);
  assert.equal(name.clipped, undefined, 'the row itself is not changed');
  assert.equal(clipRow(targeting), targeting);
  assert.deepEqual(clipRow({object: 'ad set', id: '1', field: 'name', old: 'y'.repeat(100), new: 'z'}), {
    object: 'ad set',
    id: '1',
    field: 'name',
    old: 'y'.repeat(79) + '…',
    new: 'z',
    clipped: true,
  });
});

test('what the review hides stays hidden: a credential key, a bearer token, a person, a customer list and a field named email', t => {
  const compile = compiler(t),
    plan = compile(
      'meta_native_action',
      {
        action: 'meta_ad_set_id_update',
        path_params: {ad_set_id: '456'},
        payload: {
          name: 'Spring Bearer abcdefgh12345678',
          access_token: 'EAAB' + 'x'.repeat(70),
          email: 'person@example.com',
          note: 'call +966501234567 or ' + 'a'.repeat(64),
        },
      },
      'act_111',
    ),
    rows = requestChanges(plan, update('ad set')),
    byField = field => rows.find(r => r.field === field).new;
  assert.equal(byField('name'), 'Spring Bearer [REDACTED]');
  assert.equal(byField('access_token'), '[REDACTED]');
  assert.equal(byField('email'), '[personal data]');
  assert.equal(byField('note'), 'call [personal data] or [personal data]');
  const shown = JSON.stringify(rows);
  for (const secret of ['abcdefgh12345678', 'person@example.com', '+966501234567', 'EAABxxxx'])
    assert.ok(!shown.includes(secret), secret + ' is shown');
  // A write that uploads people lists no value of its body, whatever the payload holds.
  const list = compile(
    'meta_native_action',
    {
      action: 'meta_custom_audience_id_users_create',
      path_params: {custom_audience_id: '789'},
      payload: {payload: {schema: ['EMAIL'], data: [['person@example.com'], ['other@example.com']]}},
    },
    'act_111',
  );
  assert.deepEqual(requestChanges(list, {operation: 'update', entity: 'custom audience'}), [
    {object: 'custom audience', id: '789', field: 'people', new: 'withheld: personal data'},
  ]);
});

// The review of 2026-11-26 (S2-2): an update changes what its mask names. DV360's and Business Profile's mask is in the query, and was dropped as a
// control key, so a body field outside it showed as a change and a masked field the body leaves out showed as nothing.
test('DV360: an update changes what its updateMask names: a masked field the body leaves out is a clear, and a body field outside the mask is no change', t => {
  const compile = compiler(t),
    plan = compile('dv360_native_action', {
      action: 'DV360_ADVERTISERS_CAMPAIGNS_PATCH',
      params: {advertiserId: '123', campaignId: '1', updateMask: 'displayName,campaignFlight.plannedDates.endDate'},
      body: {displayName: 'N', entityStatus: 'ENTITY_STATUS_PAUSED'},
    });
  assert.deepEqual(requestChanges(plan, update('campaign')), [
    {object: 'campaign', id: '1', field: 'campaignFlight.plannedDates.endDate', new: null},
    {object: 'campaign', id: '1', field: 'displayName', new: 'N'},
  ]);
  // A masked path the body has, however deep, is that leaf and not the clipped JSON of the branch it sits in.
  const dated = request(
    'dv360_native_action',
    'PATCH',
    '/v4/advertisers/123/campaigns/1',
    {budget: {budgetUnit: 'BUDGET_UNIT_CURRENCY', note: 'x'}, campaignFlight: {plannedDates: {endDate: '2026-12-06'}}},
    {query: {updateMask: 'campaignFlight.plannedDates.endDate'}},
  );
  assert.deepEqual(requestChanges(dated, update('campaign')), [
    {object: 'campaign', id: '1', field: 'campaignFlight.plannedDates.endDate', new: '2026-12-06'},
  ]);
  // No mask, or a mask that names every field, is every field of the body, as it was.
  for (const mask of [undefined, '*'])
    assert.deepEqual(
      requestChanges(
        request(
          'dv360_native_action',
          'PATCH',
          '/v4/advertisers/123/campaigns/1',
          {displayName: 'N'},
          {query: mask ? {updateMask: mask} : {}},
        ),
        update('campaign'),
      ),
      [{object: 'campaign', id: '1', field: 'displayName', new: 'N'}],
    );
});

test('Google: a field of an update record outside its update_mask is no change, and a masked path is read as deep as it goes', () => {
  const plan = request('google_ads_native_action', 'POST', '/v25/customers/123/campaigns:mutate', {
    operations: [
      {
        update: {
          resource_name: 'customers/123/campaigns/1',
          name: 'Renamed',
          status: 'PAUSED',
          target_cpa: {target_cpa_micros: '5000000'},
        },
        update_mask: 'status,target_cpa.target_cpa_micros',
      },
    ],
  });
  assert.deepEqual(requestChanges(plan, update('campaign')), [
    {object: 'campaign', id: '1', field: 'target_cpa.target_cpa_micros', new: '5000000'},
    {object: 'campaign', id: '1', field: 'status', new: 'PAUSED'},
  ]);
});

// The review of 2026-11-26 (S3-2): a date nested in a value (DV360's campaignFlight, a schedule of TikTok or Meta) was clipped with the JSON it sits in, and a
// value was cut in the row itself; a row holds what the request says, and a view that cannot hold it cuts it (clipRow, tests/approval-changes.test.mjs).
test('the dates inside a nested value are rows of their own, a DV360 date is its text, and a long value is whole in its row', () => {
  const dv360 = request('dv360_native_action', 'POST', '/v4/advertisers/123/insertionOrders', {
      displayName: 'IO',
      flight: {
        dateRange: {startDate: {year: 2026, month: 1, day: 5}, endDate: {year: 2026, month: 12, day: 6}},
        label: 'x',
      },
    }),
    rows = requestChanges(dv360, {operation: 'create', entity: 'insertion order'});
  assert.deepEqual(
    rows.filter(r => /Date$/.test(r.field)).map(r => [r.field, r.new]),
    [
      ['flight.dateRange.startDate', '2026-01-05'],
      ['flight.dateRange.endDate', '2026-12-06'],
    ],
  );
  const tiktok = requestChanges(
    request('tiktok_native_action', 'POST', '/v1.3/adgroup/update/', {
      advertiser_id: '123',
      adgroup_id: '77',
      schedule_infos: [{start_time: '2026-12-01 00:00:00', end_time: '2026-12-31 00:00:00', note: 'n'}],
    }),
    update('ad group'),
  );
  assert.deepEqual(
    tiktok.filter(r => /time$/.test(r.field)).map(r => [r.id, r.field, r.new]),
    [
      ['77', 'schedule_infos.0.start_time', '2026-12-01 00:00:00'],
      ['77', 'schedule_infos.0.end_time', '2026-12-31 00:00:00'],
    ],
  );
  const targeting = {
      geo_locations: {countries: ['SA', 'AE', 'EG', 'KW', 'QA', 'BH', 'OM', 'JO', 'LB', 'MA', 'TN', 'DZ']},
    },
    meta = requestChanges(request('meta_native_action', 'POST', '/v26.0/456', {targeting}), update('ad set'));
  assert.equal(meta[0].new, JSON.stringify(targeting));
  assert.ok(meta[0].new.length > 80 && !meta[0].clipped, 'the row holds the whole value');
});

// The review of 2026-11-26 (S2-3): TikTok's budget updates list `budget: [{adgroup_id, budget}]`, and the rows lost the id of every ad group.
test('a list whose items each name their object is one record each: TikTok budgets, a Smart+ budget and an ad update by creative', t => {
  const compile = compiler(t),
    budget = compile('tiktok_native_action', {
      action: 'tiktok_adgroup_budget_update',
      payload: {
        advertiser_id: '123',
        budget: [
          {adgroup_id: '11', budget: 50},
          {adgroup_id: '12', budget: 60},
          {adgroup_id: '13', budget: 50},
        ],
      },
    });
  assert.deepEqual(requestChanges(budget, update('ad group')), [
    {object: 'ad group', ids: ['11', '13'], count: 2, field: 'budget', new: 50},
    {object: 'ad group', id: '12', field: 'budget', new: 60},
  ]);
  assert.deepEqual(
    requestChanges(
      compile('tiktok_native_action', {
        action: 'tiktok_adgroup_budget_update',
        payload: {advertiser_id: '123', scheduled_budget: [{adgroup_id: '11', scheduled_budget: 50}]},
      }),
      update('ad group'),
    ),
    [{object: 'ad group', id: '11', field: 'scheduled_budget', new: 50}],
  );
  assert.deepEqual(
    requestChanges(
      compile('tiktok_native_action', {
        action: 'tiktok_smart_plus_adgroup_budget_update',
        payload: {advertiser_id: '123', budget: [{adgroup_id: '11', budget: 50}]},
      }),
      update('ad group'),
    ),
    [{object: 'ad group', id: '11', field: 'budget', new: 50}],
  );
  assert.deepEqual(
    requestChanges(
      compile('tiktok_native_action', {
        action: 'tiktok_ad_update',
        payload: {
          advertiser_id: '123',
          adgroup_id: '9',
          creatives: [
            {ad_id: '21', ad_name: 'A'},
            {ad_id: '22', ad_name: 'B'},
          ],
        },
      }),
      update('ad'),
    ),
    [
      {object: 'ad', id: '21', field: 'ad_name', new: 'A'},
      {object: 'ad', id: '22', field: 'ad_name', new: 'B'},
      {object: 'ad', field: 'adgroup_id', new: '9'},
    ],
  );
});

test('a list of labels or interests that carries a bare id is no list of the objects changed, and an X batch names the object of each item', () => {
  const labels = request('meta_native_action', 'POST', '/v26.0/456', {adlabels: [{id: '1'}, {id: '2'}], name: 'N'});
  assert.deepEqual(
    requestChanges(labels, update('ad set')).map(r => [r.id, r.field]),
    [
      ['456', 'name'],
      ['456', 'adlabels'],
    ],
  );
  const batch = request('x_ads_native_action', 'POST', '/12/batch/accounts/123/campaigns', [
    {operation_type: 'Update', params: {campaign_id: 'c1', entity_status: 'PAUSED'}},
    {operation_type: 'Delete', params: {campaign_id: 'c2'}},
    {operation_type: 'Create', params: {name: 'New one', entity_status: 'PAUSED'}},
  ]);
  assert.deepEqual(requestChanges(batch, {operation: 'change', entity: 'campaign'}), [
    {object: 'campaign', id: 'c1', field: 'entity_status', new: 'PAUSED'},
    {object: 'new campaign "New one"', field: 'entity_status', new: 'PAUSED'},
    {object: 'new campaign "New one"', field: 'name', new: 'New one'},
    {object: 'campaign', id: 'c2', field: 'object', new: 'deleted'},
  ]);
});

// The review of 2026-11-26 (S4): the account id is dropped for the keys that name the account only, and the parent id beside a list is no field of it.
test('a value equal to the account is the account repeated only under an account key: a budget or a name of the same digits is a change', () => {
  const plan = request('tiktok_native_action', 'POST', '/v1.3/adgroup/update/', {
    advertiser_id: '123',
    adgroup_id: '77',
    budget: 123,
    adgroup_name: '123',
  });
  assert.deepEqual(requestChanges(plan, update('ad group')), [
    {object: 'ad group', id: '77', field: 'budget', new: 123},
    {object: 'ad group', id: '77', field: 'adgroup_name', new: '123'},
  ]);
});

test('Microsoft: the campaign an ad group is created under is where it goes, and no field of it; an update of an ad group has no CampaignId row', t => {
  const compile = compiler(t),
    add = compile('microsoft_ads_native_action', {
      action: 'AddAdGroups',
      payload: {CampaignId: '100', AdGroups: [{Name: 'G', Status: 'Paused'}]},
    }),
    edit = compile('microsoft_ads_native_action', {
      action: 'UpdateAdGroups',
      payload: {CampaignId: '100', AdGroups: [{Id: '7', Status: 'Paused'}]},
    });
  assert.deepEqual(requestChanges(add, {operation: 'create', entity: 'ad group'}), [
    {object: 'new ad group "G" in campaign 100', field: 'Status', new: 'Paused'},
    {object: 'new ad group "G" in campaign 100', field: 'Name', new: 'G'},
  ]);
  assert.deepEqual(requestChanges(edit, update('ad group')), [
    {object: 'ad group', id: '7', field: 'Status', new: 'Paused'},
  ]);
});

// The review of 2026-11-26 (S3-3): the display of a review hides a signed token, an AWS access key, a Google refresh token and a phone number in a
// phone-named field (src/security.ts), and the rows of an approval are read through the same display scrub, never a weaker one.
test('what the display of a review hides is hidden in the rows: a signed token, an AWS key, a refresh token and a phone number', () => {
  const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    aws = 'AKIAIOSFODNN7EXAMPLE',
    refresh = '1//0gAbCdEfGhIjKlMnOpQrStUvWxYz-0123456789',
    plan = request('meta_native_action', 'POST', '/v26.0/456', {
      name: 'Launch ' + jwt,
      description: 'key ' + aws,
      note: refresh,
      phone: '0501234567',
      mobile: '(050) 123-4567',
      targeting: {contact: {phone_number: '+966 50 123 4567'}, keep: 'plain'},
    }),
    rows = requestChanges(plan, update('ad set')),
    all = JSON.stringify(rows);
  for (const secret of [jwt, aws, refresh, '0501234567', '123-4567', '50 123 4567'])
    assert.ok(!all.includes(secret), secret + ' is in ' + all);
  const by = Object.fromEntries(rows.map(r => [r.field, r.new]));
  assert.equal(by.name, 'Launch [REDACTED]');
  assert.equal(by.description, 'key [REDACTED]');
  assert.equal(by.note, '[REDACTED]');
  assert.equal(by.phone, '[personal data]');
  assert.equal(by.mobile, '[personal data]');
  assert.match(by.targeting, /"phone_number":"\[personal data\]"\},"keep":"plain"/);
});

// The second check of 2026-11-26 (S3-A): the number an ad dials is ad content, shown in the rows as the review shows it; a person's number is hidden.
test('the number an ad dials is a row the approver can check: a call asset, a TikTok creative, a call to action; a person’s number is hidden', () => {
  const shownIn = (gateway, path, body, entity) =>
      JSON.stringify(requestChanges(request(gateway, 'POST', path, body), {operation: 'create', entity})),
    call = shownIn(
      'google_ads_native_action',
      '/v25/customers/123/assets:mutate',
      {
        operations: [{create: {callAsset: {phoneNumber: '+1 650 555 0100', countryCode: 'US'}}}],
      },
      'asset',
    ),
    snake = shownIn(
      'google_ads_native_action',
      '/v25/customers/123/assets:mutate',
      {
        operations: [{create: {call_asset: {phone_number: '+16505550100', country_code: 'US'}}}],
      },
      'asset',
    ),
    tiktok = shownIn(
      'tiktok_native_action',
      '/open_api/v1.3/ad/create/',
      {
        advertiser_id: '123',
        adgroup_id: '9',
        creatives: [{ad_name: 'A', phone_number: '0501234567', phone_region_code: 'SA'}],
      },
      'ad',
    ),
    meta = shownIn(
      'meta_native_action',
      '/v26.0/act_111/adcreatives',
      {
        name: 'C',
        object_story_spec: {
          page_id: '1',
          link_data: {call_to_action: {type: 'CALL_NOW', value: {link: 'tel:+16505550100'}}},
        },
      },
      'ad creative',
    );
  assert.ok(call.includes('+1 650 555 0100'), call);
  assert.ok(snake.includes('+16505550100'), snake);
  assert.ok(tiktok.includes('0501234567'), tiktok);
  assert.ok(meta.includes('tel:+16505550100'), meta);
  // A customer's number, a lead's (in the local format too) and a number in text that no ad dials stay hidden.
  const person = shownIn(
    'meta_native_action',
    '/v26.0/act_111/customaudiences',
    {
      name: 'A',
      customers: [{phone: '+15551234567'}],
      lead: {phone: '0501234567'},
      notes: 'ring +16505550100 now',
    },
    'audience',
  );
  for (const number of ['5551234567', '0501234567', '6505550100']) assert.ok(!person.includes(number), person);
  assert.match(person, /ring \[personal data\] now/);
});

test('a body that is not an object is shown whole and clipped, and a request that cannot be decoded is one row that says so', () => {
  const text = request('meta_native_action', 'POST', '/v26.0/456', 'a=1&access_token=abcdefgh12345678');
  assert.deepEqual(requestChanges(text, update('ad set')), [
    {object: 'ad set', id: '456', field: 'body', new: 'a=1&access_token=[REDACTED]'},
  ]);
  const broken = new Proxy(request('meta_native_action', 'POST', '/v26.0/456', {a: 1}), {
    get(target, key) {
      if (key === 'body') throw new Error('synthetic');
      return target[key];
    },
  });
  assert.deepEqual(requestChanges(broken, update('ad set')), [
    {object: 'ad set', field: 'request', new: 'not decoded: POST /v26.0/456'},
  ]);
});

test('a money amount or a status inside a nested value is a row of its own, by its path, before the value it sits in', () => {
  const plan = request('tiktok_native_action', 'POST', '/v1.3/ad/create/', {
    advertiser_id: '123',
    adgroup_id: '9',
    creatives: [
      {ad_name: 'A', operation_status: 'DISABLE'},
      {ad_name: 'B', operation_status: 'ENABLE', budget: '12'},
    ],
  });
  assert.deepEqual(
    requestChanges(plan, {operation: 'create', entity: 'ad'}).map(r => [r.field, r.new]),
    [
      ['creatives.1.budget', '12'],
      ['creatives.0.operation_status', 'DISABLE'],
      ['creatives.1.operation_status', 'ENABLE'],
      ['adgroup_id', '9'],
      [
        'creatives',
        '[{"ad_name":"A","operation_status":"DISABLE"},{"ad_name":"B","operation_status":"ENABLE","budget":"12"}]',
      ],
    ],
  );
  // A money object ({amount, currencyCode}) is one value, not two leaves, and a value that is no amount (a mode) is no money row.
  const linked = request('linkedin_native_action', 'POST', '/rest/adAccounts/123/adCampaigns/1', {
    patch: {$set: {totalBudget: {amount: '500', currencyCode: 'USD'}, budget_mode: 'DAILY'}},
  });
  assert.deepEqual(
    requestChanges(linked, update('ad campaign')).map(r => [r.field, r.new]),
    [
      ['totalBudget', '500 USD'],
      ['budget_mode', 'DAILY'],
    ],
  );
  assert.deepEqual(
    [isAmount('5'), isAmount('5.50'), isAmount(5), isAmount('DAILY'), isAmount(null), isAmount('1e3')],
    [true, true, true, false, false, false],
  );
});

test('a generation acts on no entity: it has no row, whatever its body holds', () => {
  const generate = request('google_ads_native_action', 'POST', '/v23/customers/123:generateShareablePreviews', {
    shareablePreviews: [{assetGroup: 'customers/123/assetGroups/7', previewType: 'PERFORMANCE_MAX'}],
  });
  assert.deepEqual(requestChanges(generate, {operation: 'generate', entity: 'shareable preview'}), []);
  // The same body as an update is read as one: the operation is what decides.
  assert.ok(requestChanges(generate, {operation: 'update', entity: 'shareable preview'}).length > 0);
});

test('an API version is no object id, in either case; the id after it is', () => {
  for (const version of ['v26.0', 'V26.0', 'v1beta']) {
    assert.deepEqual(
      requestChanges(request('meta_native_action', 'POST', '/' + version, {name: 'x'}), update('ad set')),
      [{object: 'ad set', field: 'name', new: 'x'}],
    );
    assert.deepEqual(
      requestChanges(request('meta_native_action', 'POST', '/' + version + '/456', {name: 'x'}), update('ad set')),
      [{object: 'ad set', id: '456', field: 'name', new: 'x'}],
    );
  }
  assert.deepEqual([...targetKeys('ad group')], ['id', 'ids', 'adgroupid', 'adgroupids']);
  assert.deepEqual([...targetKeys('campaigns')], ['id', 'ids', 'campaignid', 'campaignids']);
});

test('the same change to several objects is one row that names them all, money first, and merging never alters the rows it is given', () => {
  const given = [
    {object: 'ad set', id: '1', field: 'end_time', new: 'x'},
    {object: 'ad set', id: '2', field: 'end_time', new: 'x'},
    {object: 'ad set', id: '1', field: 'end_time', new: 'x'},
    {object: 'ad set', id: '3', field: 'status', new: 'PAUSED'},
    {object: 'ad set', id: '3', field: 'daily_budget', new: '5'},
    {object: 'ad set', ids: ['4', '5'], count: 2, field: 'end_time', new: 'x'},
    {object: 'campaign', field: 'name', new: 'N'},
  ].map(row => Object.freeze({...row, ...(row.ids ? {ids: Object.freeze([...row.ids])} : {})}));
  assert.deepEqual(mergeChanges(given), [
    {object: 'ad set', id: '3', field: 'daily_budget', new: '5'},
    {object: 'ad set', id: '3', field: 'status', new: 'PAUSED'},
    {object: 'ad set', ids: ['1', '2', '4', '5'], count: 4, field: 'end_time', new: 'x'},
    {object: 'campaign', field: 'name', new: 'N'},
  ]);
  assert.deepEqual(given[5].ids, ['4', '5'], 'the rows it was given are as they were');
  // A different old value is a different change, and rows that name no object are never merged with each other.
  const apart = mergeChanges([
    {object: 'ad set', id: '1', field: 'end_time', old: 'a', new: 'x'},
    {object: 'ad set', id: '2', field: 'end_time', old: 'b', new: 'x'},
    {object: 'ad set', field: 'name', new: 'N'},
    {object: 'ad set', field: 'name', new: 'N'},
  ]);
  assert.equal(apart.length, 4);
});
