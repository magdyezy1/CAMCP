import test from 'node:test';
import assert from 'node:assert/strict';
import {googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {normalizeAccount} from '../dist/src/scope.js';
import {isAmount, mergeChanges, requestChanges, targetKeys} from '../dist/src/request-changes.js';

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

test('a long value is clipped, and a nested value is shown as clipped JSON, whole in its first characters', () => {
  const plan = request('meta_native_action', 'POST', '/v26.0/456', {
    name: 'x'.repeat(200),
    targeting: {geo_locations: {countries: ['SA', 'AE']}, age_min: 18},
  });
  const rows = requestChanges(plan, update('ad set')),
    name = rows.find(r => r.field === 'name'),
    targeting = rows.find(r => r.field === 'targeting');
  assert.equal(name.new.length, 80);
  assert.ok(name.new.endsWith('…'));
  assert.equal(targeting.new, '{"geo_locations":{"countries":["SA","AE"]},"age_min":18}');
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

test('a money amount or a status inside a nested value is a row of its own, by its path, before the clipped value it sits in', () => {
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
      ['creatives', '[{"ad_name":"A","operation_status":"DISABLE"},{"ad_name":"B","operation_status"…'],
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
