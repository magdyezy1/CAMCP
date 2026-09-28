import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertGoogleConversionGoal,
  googleConversionGoalKind,
  googleConversionGoalFields,
  readGoogleConversionGoalState,
  googleConversionGoalOutcome,
  verifyGoogleConversionGoal,
} from '../src/google-conversion-goals.js';
import {stable} from '../src/security.js';
import {googleJson} from '../src/google-contracts.js';
import type {CompiledRequest, JsonObject} from '../src/types.js';
import type {TransportResult} from '../src/transport.js';
import {mkdtempSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {actionContracts} from '../src/action-contracts.js';
import {removeTestDirectory} from './temp.js';
import type {Connection} from '../src/types.js';
const gateway = 'google_ads_native_action',
  rn = (kind: string, id: string) => 'customers/123/' + kind + '/' + id;
const c1 = rn('campaigns', '100'),
  c2 = rn('campaigns', '101'),
  accountGoal = rn('customerConversionGoals', '3~2'),
  campaignGoal = rn('campaignConversionGoals', '100~3~2'),
  config = rn('conversionGoalCampaignConfigs', '100'),
  custom = rn('customConversionGoals', '500');
const camel = (v: string) => v.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const mutate = (kind: string, operations: JsonObject[]): CompiledRequest => ({
  gateway,
  action: 'synthetic',
  method: 'POST',
  path: '/v23/customers/123/' + kind + ':mutate',
  body: {operations},
  query: {},
  headers: {},
  accountId: '123',
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'synthetic',
  warnings: [],
});
const edit = (kind = 'customerConversionGoals', name = accountGoal, value: JsonObject = {biddable: false}) =>
  mutate(kind, [{update: {resourceName: name, ...value}, updateMask: Object.keys(value).join(',')}]);
function backend() {
  const tables: Record<string, JsonObject[]> = {
    customer: [
      {
        id: '123',
        currencyCode: 'USD',
        timeZone: 'UTC',
        conversionTrackingSetting: {googleAdsConversionCustomer: 'customers/123'},
      },
    ],
    customer_conversion_goal: [{resourceName: accountGoal, category: 'PURCHASE', origin: 'WEBSITE', biddable: true}],
    campaign_conversion_goal: [
      {resourceName: campaignGoal, campaign: c1, category: 'PURCHASE', origin: 'WEBSITE', biddable: true},
      {
        resourceName: rn('campaignConversionGoals', '101~3~2'),
        campaign: c2,
        category: 'PURCHASE',
        origin: 'WEBSITE',
        biddable: false,
      },
    ],
    conversion_goal_campaign_config: [
      {resourceName: config, campaign: c1, goalConfigLevel: 'CUSTOMER'},
      {resourceName: rn('conversionGoalCampaignConfigs', '101'), campaign: c2, goalConfigLevel: 'CAMPAIGN'},
    ],
    custom_conversion_goal: [
      {
        resourceName: custom,
        id: '500',
        name: 'Approved purchase events',
        status: 'ENABLED',
        conversionActions: [rn('conversionActions', '900'), rn('conversionActions', '901')],
      },
    ],
    campaign: [c1, c2].map((resourceName, i) => ({
      resourceName,
      name: 'Campaign ' + i,
      status: 'PAUSED',
      advertisingChannelType: 'SEARCH',
      biddingStrategyType: 'MAXIMIZE_CONVERSIONS',
      campaignBudget: rn('campaignBudgets', '10'),
    })),
    campaign_budget: [
      {resourceName: rn('campaignBudgets', '10'), name: 'Budget', status: 'ENABLED', amountMicros: '30000000'},
    ],
    conversion_action: ['900', '901'].map((id, i) => ({
      resourceName: rn('conversionActions', id),
      name: 'Action ' + id,
      status: 'ENABLED',
      type: 'WEBPAGE',
      category: 'PURCHASE',
      origin: 'WEBSITE',
      ownerCustomer: 'customers/123',
      primaryForGoal: !i,
      valueSettings: {defaultValue: 1, defaultCurrencyCode: 'USD', alwaysUseDefaultValue: false},
    })),
  };
  let mode = 'success',
    count = 0,
    writes = 0;
  const calls: CompiledRequest[] = [];
  const send = async (p: CompiledRequest): Promise<TransportResult> => {
    calls.push(structuredClone(p));
    if (p.path.endsWith('googleAds:search')) {
      count++;
      const b = p.body as JsonObject,
        resource = / FROM ([a-z_]+)/.exec(b.query)![1]!,
        records = structuredClone(tables[resource]!);
      let rows = records;
      if (mode === 'missing_config' && resource === 'conversion_goal_campaign_config') rows = [];
      if (mode === 'duplicate' && resource === 'customer_conversion_goal') rows = [...rows, ...rows];
      if (mode === 'foreign' && resource === 'customer_conversion_goal')
        rows = [{...rows[0], resourceName: 'customers/999/customerConversionGoals/3~2'}];
      if (mode === 'partial') return {status: 200, data: {results: [], partialFailureError: {code: 3}}, headers: {}};
      if (mode === 'error') return {status: 403, data: {error: {code: 403}}, headers: {}};
      if (mode === 'unknown_row' && resource === 'customer_conversion_goal')
        return {status: 200, data: {results: [{customerConversionGoal: rows[0], errors: []}]}, headers: {}};
      let token: string | undefined;
      if (mode === 'pages' && resource === 'conversion_action') {
        if (!b.pageToken) {
          rows = records.slice(0, 1);
          token = 'second';
        } else rows = records.slice(1);
      }
      if (mode === 'repeat' && resource === 'conversion_action') token = 'same';
      return {
        status: 200,
        headers: {},
        data: {
          ...(rows.length ? {results: rows.reverse().map(r => ({[camel(resource)]: r}))} : {}),
          queryResourceConsumption: String(count),
          ...(token ? {nextPageToken: token} : {}),
        },
      };
    }
    writes++;
    const resource = (
        {
          customerConversionGoals: 'customer_conversion_goal',
          campaignConversionGoals: 'campaign_conversion_goal',
          conversionGoalCampaignConfigs: 'conversion_goal_campaign_config',
          customConversionGoals: 'custom_conversion_goal',
        } as Record<string, string>
      )[p.path.split('/').at(-1)!.split(':')[0]!]!,
      ops = googleJson(p.body).operations;
    const results = ops.map((op: JsonObject, i: number) => {
      const name = op.remove ?? op.update?.resourceName ?? rn('customConversionGoals', String(600 + i));
      if (mode !== 'ignored') {
        if (op.create)
          tables[resource]!.push({...op.create, resourceName: name, id: name.split('/').at(-1), status: 'ENABLED'});
        else if (op.remove) tables[resource] = tables[resource]!.filter(r => r.resourceName !== name);
        else {
          const old = tables[resource]!.find(r => r.resourceName === name)!;
          Object.assign(old, op.update);
          if (mode !== 'ignore_side_effect') {
            if (resource === 'customer_conversion_goal')
              for (const cg of tables.campaign_conversion_goal!)
                if (
                  cg.category === old.category &&
                  cg.origin === old.origin &&
                  tables.conversion_goal_campaign_config!.some(
                    c => c.campaign === cg.campaign && c.goalConfigLevel === 'CUSTOMER',
                  )
                )
                  cg.biddable = old.biddable;
            if (resource === 'campaign_conversion_goal')
              tables.conversion_goal_campaign_config!.find(c => c.campaign === old.campaign)!.goalConfigLevel =
                'CAMPAIGN';
            if (resource === 'conversion_goal_campaign_config') {
              if (op.update.customConversionGoal && !op.update.goalConfigLevel) old.goalConfigLevel = 'CAMPAIGN';
              if (op.update.goalConfigLevel === 'CUSTOMER')
                for (const cg of tables.campaign_conversion_goal!)
                  if (cg.campaign === old.campaign)
                    cg.biddable = tables.customer_conversion_goal!.find(
                      g => g.category === cg.category && g.origin === cg.origin,
                    )!.biddable;
            }
          }
        }
      }
      return {resourceName: name};
    });
    return {status: 200, headers: {}, data: {results}};
  };
  return {
    tables,
    calls,
    send,
    mode: (v: string) => {
      mode = v;
    },
    writes: () => writes,
  };
}
async function lifecycle(p: CompiledRequest, b = backend()) {
  assertGoogleConversionGoal(p);
  const before = await readGoogleConversionGoalState(p, b.send),
    receipt = await b.send(p);
  assert.equal(googleConversionGoalOutcome(p, receipt, before), true);
  const check = await verifyGoogleConversionGoal(p, {data: receipt.data}, before, b.send);
  assert.equal(check.status, 'verified', JSON.stringify(check));
  return {b, before, receipt, check};
}
test('account conversion goals propagate only to campaigns using account defaults', async () => {
  const {b, check} = await lifecycle(edit());
  assert.equal(b.tables.campaign_conversion_goal![0]!.biddable, false);
  assert.equal(b.tables.campaign_conversion_goal![1]!.biddable, false);
  assert.equal(check.checks.length, 2);
});
test('campaign goal changes include the automatic switch to campaign-specific configuration', async () => {
  const {b, check} = await lifecycle(edit('campaignConversionGoals', campaignGoal, {biddable: false}));
  assert.equal(b.tables.conversion_goal_campaign_config![0]!.goalConfigLevel, 'CAMPAIGN');
  assert.equal(check.checks.length, 2);
});
test('attaching custom goals includes secondary actions and switches campaign level without clearing standard goals', async () => {
  const {b} = await lifecycle(edit('conversionGoalCampaignConfigs', config, {customConversionGoal: custom}));
  assert.equal(b.tables.conversion_goal_campaign_config![0]!.goalConfigLevel, 'CAMPAIGN');
  assert.equal(b.tables.campaign_conversion_goal![0]!.biddable, true);
  assert.equal(b.tables.conversion_action![1]!.primaryForGoal, false);
});
test('returning to customer defaults verifies propagation and an inactive retained custom reference', async () => {
  const b = backend();
  Object.assign(b.tables.conversion_goal_campaign_config![0]!, {
    goalConfigLevel: 'CAMPAIGN',
    customConversionGoal: custom,
  });
  b.tables.campaign_conversion_goal![0]!.biddable = false;
  const {check} = await lifecycle(edit('conversionGoalCampaignConfigs', config, {goalConfigLevel: 'CUSTOMER'}), b);
  assert.equal(b.tables.campaign_conversion_goal![0]!.biddable, true);
  assert.equal(check.checks.length, 2);
});
test('custom goals support creation, complete member replacement, rename and deletion', async () => {
  const b = backend();
  await lifecycle(
    mutate('customConversionGoals', [
      {create: {name: 'User-approved goal', conversionActions: [rn('conversionActions', '900')]}},
    ]),
    b,
  );
  await lifecycle(
    edit('customConversionGoals', custom, {name: 'Changed', conversionActions: [rn('conversionActions', '901')]}),
    b,
  );
  await lifecycle(mutate('customConversionGoals', [{remove: custom}]), b);
  assert.equal(b.writes(), 3);
});
test('custom reference clearing uses an explicit field mask and verifies an empty saved reference', async () => {
  const b = backend();
  Object.assign(b.tables.conversion_goal_campaign_config![0]!, {
    goalConfigLevel: 'CAMPAIGN',
    customConversionGoal: custom,
  });
  await lifecycle(edit('conversionGoalCampaignConfigs', config, {customConversionGoal: ''}), b);
  assert.equal(b.tables.conversion_goal_campaign_config![0]!.customConversionGoal, '');
});
test('provider telemetry, resource order and custom member order do not change configuration hashes', async () => {
  const b = backend(),
    p = edit(),
    a = await readGoogleConversionGoalState(p, b.send);
  b.tables.custom_conversion_goal![0]!.conversionActions.reverse();
  for (const rows of Object.values(b.tables)) rows.reverse();
  const next = await readGoogleConversionGoalState(p, b.send);
  assert.equal(stable(a), stable(next));
  b.tables.conversion_action![0]!.valueSettings.defaultValue = 20;
  assert.notEqual(stable(a), stable(await readGoogleConversionGoalState(p, b.send)));
});
test('ProtoJSON omitted false biddability has the same meaningful state as explicit false', async () => {
  const b = backend(),
    p = edit();
  b.tables.customer_conversion_goal![0]!.biddable = false;
  const a = await readGoogleConversionGoalState(p, b.send);
  delete b.tables.customer_conversion_goal![0]!.biddable;
  assert.equal(stable(a), stable(await readGoogleConversionGoalState(p, b.send)));
});
test('standard-goal creates/removals, immutable updates, fake masks, nulls and unsafe IDs fail before reads', () => {
  const bad = [
    mutate('customerConversionGoals', [{create: {category: 'PURCHASE', origin: 'WEBSITE', biddable: true}}]),
    mutate('campaignConversionGoals', [{remove: campaignGoal}]),
    edit('customerConversionGoals', accountGoal, {category: 'SIGNUP'}),
    edit('customerConversionGoals', accountGoal, {biddable: null}),
    edit('customerConversionGoals', accountGoal, {biddable: 'true'}),
    edit('conversionGoalCampaignConfigs', config, {goalConfigLevel: 'CUSTOMER', customConversionGoal: custom}),
    edit('customConversionGoals', custom, {conversionActions: []}),
    edit('customConversionGoals', custom, {
      conversionActions: [rn('conversionActions', '900'), rn('conversionActions', '900')],
    }),
    edit('customConversionGoals', custom, {conversionActions: ['customers/999/conversionActions/900']}),
    edit('customConversionGoals', custom, {status: 'REMOVED'}),
    edit('campaignConversionGoals', rn('campaignConversionGoals', '100~3'), {biddable: true}),
  ];
  for (const p of bad) assert.throws(() => assertGoogleConversionGoal(p), JSON.stringify(p.body));
  for (const fields of [{partialFailure: true}, {validateOnly: true}, {responseContentType: 'MUTABLE_RESOURCE'}])
    assert.throws(() => assertGoogleConversionGoal({...edit(), body: {...(edit().body as JsonObject), ...fields}}));
});
test('manager tracking, missing configurations, hidden actions and referenced removals stop before mutation', async () => {
  for (const mode of ['manager', 'shared', 'missing_config', 'action', 'referenced', 'duplicate_name']) {
    const b = backend();
    let p = edit();
    if (mode === 'manager') b.tables.customer![0]!.manager = true;
    if (mode === 'shared')
      b.tables.customer![0]!.conversionTrackingSetting.googleAdsConversionCustomer = 'customers/999';
    if (mode === 'missing_config') b.mode(mode);
    if (mode === 'action') {
      b.tables.conversion_action![0]!.status = 'HIDDEN';
      p = edit('customConversionGoals', custom, {name: 'Changed'});
    }
    if (mode === 'referenced') {
      Object.assign(b.tables.conversion_goal_campaign_config![0]!, {
        goalConfigLevel: 'CAMPAIGN',
        customConversionGoal: custom,
      });
      p = mutate('customConversionGoals', [{remove: custom}]);
    }
    if (mode === 'duplicate_name')
      p = mutate('customConversionGoals', [
        {create: {name: 'Approved purchase events', conversionActions: [rn('conversionActions', '900')]}},
      ]);
    await assert.rejects(() => readGoogleConversionGoalState(p, b.send));
    assert.equal(b.writes(), 0);
  }
});
test('failed, partial, duplicate, foreign and malformed state cannot become an empty successful review', async () => {
  for (const mode of ['partial', 'error', 'duplicate', 'foreign', 'unknown_row', 'repeat']) {
    const b = backend();
    b.mode(mode);
    await assert.rejects(() => readGoogleConversionGoalState(edit(), b.send));
    assert.equal(b.writes(), 0);
  }
});
test('complete conversion-action pagination includes both current definitions', async () => {
  const b = backend();
  b.mode('pages');
  const [state] = (await readGoogleConversionGoalState(edit(), b.send)) as JsonObject[];
  assert.equal(Object.keys(state!.conversionActions).length, 2);
  assert.ok(b.calls.some(p => (p.body as JsonObject).pageToken === 'second'));
});
test('successful receipts cannot conceal ignored biddability or inheritance side effects', async () => {
  for (const mode of ['ignored', 'ignore_side_effect']) {
    const b = backend(),
      p = edit();
    const before = await readGoogleConversionGoalState(p, b.send);
    b.mode(mode);
    const receipt = await b.send(p),
      check = await verifyGoogleConversionGoal(p, {data: receipt.data}, before, b.send);
    assert.equal(check.status, 'inconclusive');
    assert.ok(check.checks.some(c => c.changed_fields.includes('biddable')));
    assert.equal(b.writes(), 1);
  }
});
test('malformed, foreign, reused and partial creation receipts remain failures', async () => {
  const b = backend(),
    p = mutate('customConversionGoals', [{create: {name: 'New', conversionActions: [rn('conversionActions', '900')]}}]),
    before = await readGoogleConversionGoalState(p, b.send);
  for (const data of [
    {},
    {results: []},
    {results: [{resourceName: custom}]},
    {results: [{resourceName: 'customers/999/customConversionGoals/600'}]},
    {results: [{resourceName: rn('customConversionGoals', '600')}], partialFailureError: {code: 3}},
  ])
    assert.equal(googleConversionGoalOutcome(p, {status: 200, data, headers: {}}, before), false);
});
test('goal routes do not admit alternate methods, origins or native job APIs', () => {
  const p = edit();
  assert.equal(googleConversionGoalKind(p), 'customerConversionGoals');
  for (const x of [
    {...p, method: 'GET'},
    {...p, origin: 'https://other.invalid'},
    {...p, path: p.path + '/run'},
    {...p, specialTransport: 'upload'},
  ])
    assert.equal(googleConversionGoalKind(x), undefined);
});

const actor = {tenantId: 'conversion-goals', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const},
  key = Buffer.alloc(32, 64).toString('base64'),
  registry = new Registry();
const rpc: Record<string, string> = {
  customerConversionGoals: 'google_ads_v23_customer_conversion_goal_mutate_customer_conversion_goals',
  campaignConversionGoals: 'google_ads_v23_campaign_conversion_goal_mutate_campaign_conversion_goals',
  conversionGoalCampaignConfigs:
    'google_ads_v23_conversion_goal_campaign_config_mutate_conversion_goal_campaign_configs',
  customConversionGoals: 'google_ads_v23_custom_conversion_goal_mutate_custom_conversion_goals',
};
function fixture(file = ':memory:', b = backend(), allowWrites = true) {
  const store = new Store(file, key),
    c: Connection = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: actor.tenantId,
      gateway,
      label: 'Selected conversion customer',
      accounts: ['123'],
      writeAccounts: ['123'],
      scopes: ['https://www.googleapis.com/auth/adwords'],
      enabled: true,
    };
  if (!store.listConnections(actor.tenantId).length)
    store.putConnection(owner, c, {accessToken: 'synthetic', developerToken: 'synthetic'});
  let mode = 'success',
    afterRead: (() => void) | undefined;
  const transport = new NativeTransport(
    async (url, init) => {
      const p = {...edit(), path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body))},
        isRead = p.path.endsWith('googleAds:search');
      assert.equal(init?.method, 'POST');
      assert.equal(new URL(String(url)).origin, 'https://googleads.googleapis.com');
      const response = await b.send(p);
      if (isRead) afterRead?.();
      if (!isRead && mode === 'lost') throw Error('Synthetic response lost after commit');
      if (!isRead && mode === 'partial') return Response.json({results: [], partialFailureError: {code: 3}});
      if (!isRead && mode === 'foreign')
        return Response.json({results: [{resourceName: 'customers/999/customerConversionGoals/3~2'}]});
      return Response.json(response.data, {status: response.status});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const args = (p: CompiledRequest, action?: string) => ({
    action: action ?? rpc[googleConversionGoalKind(p)!],
    account_id: '123',
    connection_id: c.id,
    payload: p.body,
  });
  const prepare = (p = edit(), action?: string) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: args(p, action)}, actor);
  const execute = (r: JsonObject, extra: JsonObject = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: r.data.review_id,
        idempotency_key: r.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = (r: JsonObject) =>
    service.call('amcp_campaign', {action: 'verify', review_id: r.data.review_id}, actor);
  return {
    b,
    store,
    c,
    service,
    args,
    prepare,
    execute,
    verify,
    onRead: (fn: () => void) => {
      afterRead = fn;
    },
    mode: (v: string) => {
      mode = v;
    },
  };
}
for (const p of [
  edit(),
  edit('campaignConversionGoals', campaignGoal, {biddable: false}),
  edit('conversionGoalCampaignConfigs', config, {customConversionGoal: custom}),
  mutate('customConversionGoals', [
    {create: {name: 'Created through AMCP', conversionActions: [rn('conversionActions', '901')]}},
  ]),
])
  test(
    'real reviewed ' + googleConversionGoalKind(p) + ' lifecycle executes once and verifies native effects',
    async () => {
      const f = fixture();
      try {
        const r = await f.prepare(p);
        assert.equal(r.success, true, JSON.stringify(r));
        const out = await f.execute(r);
        assert.equal(out.success, true, JSON.stringify(out));
        assert.equal(out.data.success, true, JSON.stringify(out));
        const v = await f.verify(r);
        assert.equal(v.data.status, 'verified', JSON.stringify(v));
        assert.equal((await f.execute(r)).data.replayed, true);
        assert.equal(f.b.writes(), 1);
      } finally {
        f.store.close();
      }
    },
  );
test('legacy campaign-goal and configuration aliases execute the same native contracts', async () => {
  for (const [action, p] of [
    ['UPDATE_CAMPAIGN_CONVERSION_GOAL', edit('campaignConversionGoals', campaignGoal, {biddable: false})],
    [
      'UPDATE_CONVERSION_GOAL_CAMPAIGN_CONFIG',
      edit('conversionGoalCampaignConfigs', config, {customConversionGoal: custom}),
    ],
  ] as const) {
    const f = fixture();
    try {
      const r = await f.prepare(p, action);
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal((await f.execute(r)).data.success, true);
      assert.equal((await f.verify(r)).data.status, 'verified');
    } finally {
      f.store.close();
    }
  }
});
test('a genuine goal, action, budget or campaign edit conflicts while provider cost changes do not', async () => {
  for (const field of ['goal', 'action', 'budget', 'campaign', 'telemetry']) {
    const f = fixture();
    try {
      const r = await f.prepare();
      assert.equal(r.success, true);
      if (field === 'goal') f.b.tables.customer_conversion_goal![0]!.biddable = false;
      if (field === 'action') f.b.tables.conversion_action![0]!.valueSettings.defaultValue = 50;
      if (field === 'budget') f.b.tables.campaign_budget![0]!.amountMicros = '31000000';
      if (field === 'campaign') f.b.tables.campaign![0]!.name = 'Changed';
      const result = await f.execute(r);
      if (field === 'telemetry') assert.equal(result.data.success, true, JSON.stringify(result));
      else {
        assert.equal(result.error.code, 'STATE_CHANGED', JSON.stringify(result));
        assert.ok(result.error.details.changed_fields.length);
        assert.equal(f.b.writes(), 0);
      }
    } finally {
      f.store.close();
    }
  }
});
test('goal mutations retain spend, activation and deletion policy safeguards', async () => {
  const f = fixture();
  try {
    const r = await f.prepare();
    assert.equal((await f.execute(r, {spend_change_confirmed: false})).error.code, 'SPEND_CONFIRMATION_REQUIRED');
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', policy: {allow_activation: false}, confirmed: true});
    assert.equal((await f.execute(r)).error.code, 'POLICY_ACTIVATION_FORBIDDEN');
    assert.equal(f.b.writes(), 0);
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', policy: {allow_deletion: false}, confirmed: true});
    const removed = await f.prepare(mutate('customConversionGoals', [{remove: custom}]));
    assert.equal(removed.error.code, 'POLICY_DELETION_FORBIDDEN');
    assert.equal(f.b.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('unattached custom-goal creation has no activation effect but mixed edits cannot use that exemption', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      policy: {allow_activation: false, max_budget_native: 1},
      confirmed: true,
    });
    const p = mutate('customConversionGoals', [
        {
          create: {
            name: 'Budget performance - business goal',
            status: 'ENABLED',
            conversionActions: [rn('conversionActions', '900')],
          },
        },
      ]),
      r = await f.prepare(p);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal((await f.execute(r, {spend_change_confirmed: false})).data.success, true);
    assert.equal((await f.verify(r)).data.status, 'verified');
    const mixed = await f.prepare(
      mutate('customConversionGoals', [
        {create: {name: 'Other', conversionActions: [rn('conversionActions', '900')]}},
        {update: {resourceName: custom, name: 'Edited'}, updateMask: 'name'},
      ]),
    );
    assert.equal(mixed.error.code, 'POLICY_ACTIVATION_FORBIDDEN');
  } finally {
    f.store.close();
  }
});
test('changed roles, tenants, scopes, connection grants and disabled deployment block before mutation', async () => {
  for (const mode of ['reader', 'tenant', 'grant', 'scope', 'revoke', 'deployment', 'another_connection']) {
    const f = fixture(':memory:', backend(), mode !== 'deployment');
    try {
      if (['reader', 'tenant'].includes(mode)) {
        const result = await f.service.call(
          'amcp_write',
          {action: 'prepare', gateway, arguments: f.args(edit())},
          mode === 'reader' ? {...actor, role: 'reader'} : {...actor, tenantId: 'foreign'},
        );
        assert.equal(result.success, false);
        assert.equal(f.b.calls.length, 0);
        continue;
      }
      if (mode === 'deployment') {
        assert.equal((await f.prepare()).error.code, 'LIVE_WRITES_DISABLED');
        continue;
      }
      const r = await f.prepare();
      assert.equal(r.success, true);
      if (mode === 'another_connection') {
        f.store.putConnection(owner, {...f.c, id: '22222222-2222-4222-8222-222222222222'}, {accessToken: 'other'});
        f.store.putConnection(owner, {...f.c, writeAccounts: []}, {accessToken: 'synthetic'});
      }
      if (mode === 'grant') f.store.putConnection(owner, {...f.c, writeAccounts: []}, {accessToken: 'synthetic'});
      if (mode === 'scope') f.store.putConnection(owner, {...f.c, scopes: []}, {accessToken: 'synthetic'});
      if (mode === 'revoke')
        f.onRead(() => f.store.putConnection(owner, {...f.c, writeAccounts: []}, {accessToken: 'synthetic'}));
      assert.equal((await f.execute(r)).success, false);
      assert.equal(f.b.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('partial and foreign native receipts retain failures and never dispatch a second time', async () => {
  for (const mode of ['partial', 'foreign']) {
    const f = fixture();
    try {
      const r = await f.prepare();
      f.mode(mode);
      const out = await f.execute(r);
      assert.equal(out.data.success, false, JSON.stringify(out));
      const again = await f.execute(r);
      assert.equal(again.data.replayed, true);
      assert.equal(again.data.success, false);
      assert.equal(f.b.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});
test('concurrent and restarted execution retain completed or uncertain claims', async () => {
  for (const lost of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'amcp-conversion-goals-')),
      b = backend();
    let f = fixture(join(directory, 'store.sqlite'), b);
    try {
      const r = await f.prepare();
      if (lost) f.mode('lost');
      await Promise.all([f.execute(r), f.execute(r)]);
      assert.equal(b.writes(), 1);
      f.store.close();
      f = fixture(join(directory, 'store.sqlite'), b);
      const again = await f.execute(r);
      if (lost) assert.equal(again.error.code, 'WRITE_OUTCOME_UNCERTAIN');
      else assert.equal(again.data.replayed, true);
      assert.equal(b.writes(), 1);
    } finally {
      f.store.close();
      removeTestDirectory(directory, 'amcp-conversion-goals-');
    }
  }
});
test('cached and in-flight verification recheck provider scopes; direct gateway execution cannot bypass review', async () => {
  const f = fixture();
  try {
    const r = await f.prepare();
    await f.execute(r);
    assert.equal((await f.verify(r)).data.status, 'verified');
    f.store.putConnection(owner, {...f.c, scopes: []}, {accessToken: 'synthetic'});
    assert.equal((await f.verify(r)).error.code, 'INSUFFICIENT_SCOPE');
    f.store.putConnection(owner, f.c, {accessToken: 'synthetic'});
    const out = await f.service.call(
      gateway,
      {...f.args(edit()), dry_run: false, confirmed: true, idempotency_key: '12345678-1234-4234-9234-123456789abc'},
      actor,
    );
    assert.equal(out.error.code, 'WRITE_REVIEW_REQUIRED');
    const fresh = await f.prepare(edit('campaignConversionGoals', campaignGoal, {biddable: true}));
    await f.execute(fresh);
    f.onRead(() => f.store.putConnection(owner, {...f.c, scopes: []}, {accessToken: 'synthetic'}));
    const v = await f.verify(fresh);
    assert.equal(v.data.status, 'unverified');
    assert.equal(v.data.checks[0].code, 'INSUFFICIENT_SCOPE');
    assert.equal(f.b.writes(), 2);
  } finally {
    f.store.close();
  }
});
test('native mutation envelopes exactly match pinned Discovery without invented partialFailure fields', async () => {
  const models = JSON.parse(readFileSync('.mirror/VENDOR/google-ads-v23.json', 'utf8')).document.schemas;
  for (const [kind, action] of Object.entries(rpc)) {
    const route = registry.action(gateway, action)!;
    assert.ok(route.path?.includes(kind));
    const input = Object.values(models).find((s: any) =>
      s.id?.endsWith('Services__Mutate' + kind[0]!.toUpperCase() + kind.slice(1) + 'Request'),
    ) as JsonObject;
    assert.ok(input);
    assert.equal(input.properties.partialFailure, undefined);
    assert.throws(() =>
      assertGoogleConversionGoal({
        ...edit(
          kind,
          kind === 'customConversionGoals'
            ? custom
            : kind === 'campaignConversionGoals'
              ? campaignGoal
              : kind === 'conversionGoalCampaignConfigs'
                ? config
                : accountGoal,
        ),
        body: {operations: [], partialFailure: false},
      }),
    );
  }
});
test('all four conversion-goal RPCs and both legacy aliases have explicit family inventory', () => {
  const rows = actionContracts(registry).filter(r => r.family === 'google_conversion_goals');
  assert.equal(rows.length, 6);
  assert.ok(rows.every(r => r.status === 'reviewed_write_family'));
});

test('a verified custom goal can be attached in a separately reviewed dependent campaign step', async () => {
  const f = fixture();
  try {
    const create = mutate('customConversionGoals', [
      {create: {name: 'Explicit sales goal', conversionActions: [rn('conversionActions', '901')]}},
    ]);
    const attach = edit('conversionGoalCampaignConfigs', config, {
      customConversionGoal: {$ref: 'goal#/data/results/0/resourceName'},
    });
    const created = await f.service.call(
      'amcp_campaign',
      {
        action: 'create',
        name: 'Reviewed goal and attachment',
        brief: 'Synthetic user-approved conversion action and campaign.',
        steps: [
          {
            id: 'goal',
            kind: 'write',
            gateway,
            connection_id: f.c.id,
            account_id: '123',
            arguments: f.args(create),
            depends_on: [],
          },
          {
            id: 'attach',
            kind: 'write',
            gateway,
            connection_id: f.c.id,
            account_id: '123',
            arguments: f.args(attach),
            depends_on: ['goal'],
          },
        ],
      },
      actor,
    );
    assert.equal(created.success, true, JSON.stringify(created));
    const id = created.data.id;
    for (const step of ['goal', 'attach']) {
      const p = await f.service.call('amcp_campaign', {action: 'prepare_next', id}, actor);
      assert.equal(p.success, true, JSON.stringify(p));
      assert.equal(p.data.step_id, step, JSON.stringify(p));
      const executed = await f.service.call(
        'amcp_campaign',
        {
          action: 'execute_next',
          id,
          review_id: p.data.review.review_id,
          idempotency_key: p.data.review.idempotency_key,
          confirmed: true,
          spend_change_confirmed: true,
        },
        actor,
      );
      assert.equal(executed.success, true, JSON.stringify(executed));
      assert.equal(
        executed.data.steps.find((s: JsonObject) => s.id === step).status,
        'verified',
        JSON.stringify(executed),
      );
      if (step === 'attach') assert.equal(executed.data.state, 'complete');
    }
    assert.equal(f.b.writes(), 2);
    assert.equal(
      f.b.tables.conversion_goal_campaign_config![0]!.customConversionGoal,
      rn('customConversionGoals', '600'),
    );
    assert.equal(f.b.tables.conversion_goal_campaign_config![0]!.goalConfigLevel, 'CAMPAIGN');
    assert.equal(f.b.tables.campaign_conversion_goal![0]!.biddable, true);
  } finally {
    f.store.close();
  }
});

test('an inactive removed custom reference does not prevent keeping account defaults but cannot be reactivated', async () => {
  const b = backend();
  b.tables.custom_conversion_goal![0]!.status = 'REMOVED';
  b.tables.conversion_goal_campaign_config![0]!.customConversionGoal = custom;
  const p = edit('conversionGoalCampaignConfigs', config, {goalConfigLevel: 'CUSTOMER'}),
    before = await readGoogleConversionGoalState(p, b.send),
    result = await b.send(p);
  assert.equal((await verifyGoogleConversionGoal(p, {data: result.data}, before, b.send)).status, 'verified');
  await assert.rejects(() =>
    readGoogleConversionGoalState(edit('conversionGoalCampaignConfigs', config, {goalConfigLevel: 'CAMPAIGN'}), b.send),
  );
  assert.equal(b.writes(), 1);
});

test('goal reviews remain immutable and expire before dispatch', async () => {
  const f = fixture();
  try {
    const r = await f.prepare();
    assert.equal((await f.execute(r, {arguments: {payload: {operations: []}}})).error.code, 'INVALID_ARGUMENT');
    const doc = f.store.document(actor.tenantId, 'write_review', r.data.review_id);
    f.store.putDocument(actor.tenantId, 'write_review', r.data.review_id, {...doc, expires_at: 0});
    assert.equal((await f.execute(r)).error.code, 'REVIEW_EXPIRED');
    assert.equal(f.b.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('incomplete counts, request pages, response bytes and total row bounds fail closed', async () => {
  for (const mode of ['count', 'pages', 'bytes', 'total_bytes', 'rows']) {
    const b = backend();
    let n = 0;
    const send = async (p: CompiledRequest) => {
      const out = await b.send(p);
      n++;
      const body = p.body as JsonObject,
        d = out.data as JsonObject;
      if (mode === 'count') d.totalResultsCount = '2';
      if (mode === 'pages') d.nextPageToken = 'more-' + n;
      if (mode === 'bytes') d.fieldMask = 'x'.repeat(4 * 1024 * 1024);
      if (mode === 'total_bytes') d.fieldMask = 'x'.repeat(1024 * 1024);
      if (mode === 'rows' && body.query.includes(' FROM conversion_action'))
        d.results = Array.from({length: 30001}, () => ({conversionAction: {}}));
      return out;
    };
    await assert.rejects(
      () => readGoogleConversionGoalState(edit(), send),
      {code: 'CONVERSION_GOAL_STATE_UNVERIFIED'},
      mode,
    );
    assert.equal(b.writes(), 0);
    if (mode === 'pages') assert.equal(n, 25);
    if (mode === 'total_bytes') assert.equal(n, 8);
  }
});

test('the monotonic state deadline stops discovery after a slow provider read', async t => {
  const b = backend();
  let time = 0;
  t.mock.method(performance, 'now', () => time);
  await assert.rejects(
    () =>
      readGoogleConversionGoalState(edit(), async p => {
        const out = await b.send(p);
        time = 60001;
        return out;
      }),
    {code: 'CONVERSION_GOAL_STATE_UNVERIFIED'},
  );
  assert.equal(b.calls.length, 1);
  assert.equal(b.writes(), 0);
});

test('goal history capacity reserves complete read-back space for a new custom definition', async () => {
  const b = backend(),
    base = b.tables.custom_conversion_goal![0]!;
  b.tables.custom_conversion_goal = Array.from({length: 2000}, (_, i) => ({
    ...base,
    id: String(1000 + i),
    resourceName: rn('customConversionGoals', String(1000 + i)),
    name: 'Historical ' + i,
    status: 'REMOVED',
  }));
  await assert.rejects(
    () =>
      readGoogleConversionGoalState(
        mutate('customConversionGoals', [
          {create: {name: 'New definition', conversionActions: [rn('conversionActions', '900')]}},
        ]),
        b.send,
      ),
    {code: 'INVALID_CONVERSION_GOAL'},
  );
  assert.equal(b.writes(), 0);
});

test('system and former-manager observations do not grant custom-goal ownership or block an owned goal', async () => {
  const b = backend(),
    system = rn('conversionActions', '902'),
    foreign = rn('conversionActions', '903');
  b.tables.conversion_action!.push(
    {...b.tables.conversion_action![0], resourceName: system, name: 'System-defined', ownerCustomer: null},
    {
      ...b.tables.conversion_action![0],
      resourceName: foreign,
      name: 'Former manager definition',
      ownerCustomer: 'customers/999',
    },
  );
  await readGoogleConversionGoalState(edit(), b.send);
  for (const id of [system, foreign])
    await assert.rejects(() =>
      readGoogleConversionGoalState(
        mutate('customConversionGoals', [{create: {name: 'Unsafe member', conversionActions: [id]}}]),
        b.send,
      ),
    );
  assert.equal(b.writes(), 0);
});

test('portfolio configuration is part of the frozen goal dependency state', async () => {
  const f = fixture();
  try {
    const name = rn('biddingStrategies', '30');
    for (const c of f.b.tables.campaign!) c.biddingStrategy = name;
    f.b.tables.bidding_strategy = [
      {
        resourceName: name,
        name: 'Portfolio',
        status: 'ENABLED',
        type: 'MAXIMIZE_CONVERSIONS',
        maximizeConversions: {targetCpaMicros: '1000000'},
      },
    ];
    const r = await f.prepare();
    assert.equal(r.success, true, JSON.stringify(r));
    f.b.tables.bidding_strategy[0]!.maximizeConversions.targetCpaMicros = '2000000';
    assert.equal((await f.execute(r)).error.code, 'STATE_CHANGED');
    assert.equal(f.b.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('all selected goal fields have current official v23 selectable and repetition evidence', () => {
  const evidence = JSON.parse(readFileSync('tests/fixtures/google-goal-fields-v23.json', 'utf8')),
    resources: Record<string, string> = {
      customerConversionGoals: 'customer_conversion_goal',
      campaignConversionGoals: 'campaign_conversion_goal',
      conversionGoalCampaignConfigs: 'conversion_goal_campaign_config',
      customConversionGoals: 'custom_conversion_goal',
    };
  for (const [kind, fields] of Object.entries(googleConversionGoalFields))
    for (const field of fields) {
      const proof = evidence.resources[resources[kind]!].fields[field];
      assert.equal(proof?.selectable, true, kind + '.' + field);
      assert.equal(proof?.repeated, field === 'conversion_actions', kind + '.' + field);
    }
});
