import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {actionContracts} from '../src/action-contracts.js';
import {
  biddingEventInstant,
  googleBiddingEventFields,
  readGoogleBiddingEventState,
} from '../src/google-bidding-events.js';
import {removeTestDirectory} from './temp.js';
import type {Connection, JsonObject} from '../src/types.js';
const gateway = 'google_ads_native_action',
  actor = {tenantId: 'events', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const},
  registry = new Registry(),
  key = Buffer.alloc(32, 38).toString('base64');
const kinds = ['biddingSeasonalityAdjustments', 'biddingDataExclusions'] as const;
const resources = ['bidding_seasonality_adjustment', 'bidding_data_exclusion'];
const rpc = (exclusion = false) =>
  exclusion
    ? 'google_ads_v23_bidding_data_exclusion_mutate_bidding_data_exclusions'
    : 'google_ads_v23_bidding_seasonality_adjustment_mutate_bidding_seasonality_adjustments';
const res = (collection: string, id = '500') => 'customers/123/' + collection + '/' + id;
const campaign = res('campaigns', '100'),
  budget = res('campaignBudgets', '10'),
  strategy = res('biddingStrategies', '20');
const make = (exclusion = false, extra: JsonObject = {}): JsonObject => ({
  name: 'Named event',
  scope: 'CAMPAIGN',
  campaigns: [campaign],
  startDateTime: exclusion ? '2026-01-01 00:00:00' : '2098-12-01 00:00:00',
  endDateTime: exclusion ? '2026-01-04 00:00:00' : '2098-12-04 00:00:00',
  ...(!exclusion ? {conversionRateModifier: 1.5} : {}),
  ...extra,
});
function fixture(exclusion = false, file = ':memory:') {
  const kind = kinds[exclusion ? 1 : 0],
    store = new Store(file, key),
    calls: JsonObject[] = [],
    events = new Map<string, JsonObject>(),
    related = new Map<string, JsonObject>(),
    campaigns = new Map<string, JsonObject>([
      [
        campaign,
        {
          resourceName: campaign,
          name: 'Selected campaign',
          status: 'PAUSED',
          advertisingChannelType: 'SEARCH',
          biddingStrategyType: 'TARGET_CPA',
          campaignBudget: budget,
          targetCpa: {targetCpaMicros: '1000000'},
        },
      ],
    ]),
    budgets = new Map<string, JsonObject>([
      [
        budget,
        {
          resourceName: budget,
          name: 'Daily budget',
          status: 'ENABLED',
          amountMicros: '30000000',
          deliveryMethod: 'STANDARD',
        },
      ],
    ]),
    strategies = new Map<string, JsonObject>(),
    customer: JsonObject = {id: '123', currencyCode: 'EGP', timeZone: 'Africa/Cairo'};
  const c: Connection = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: actor.tenantId,
    gateway,
    accounts: ['123'],
    writeAccounts: ['123'],
    enabled: true,
    label: 'Synthetic selected account',
    scopes: ['https://www.googleapis.com/auth/adwords'],
  };
  if (!store.listConnections(actor.tenantId).length)
    store.putConnection(owner, c, {accessToken: 'synthetic', developerToken: 'synthetic'});
  let mode = 'success',
    reads = 0,
    next = 500,
    hook: ((resource: string) => void) | undefined;
  const transport = new NativeTransport(
    async (url, init) => {
      const body = JSON.parse(String(init?.body)),
        path = new URL(String(url)).pathname;
      calls.push({path, body});
      if (path.endsWith('/googleAds:search')) {
        reads++;
        const resource = / FROM ([a-z_]+)/.exec(body.query)![1]!,
          camel = resource.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        hook?.(resource);
        if (/ORDER BY [a-z_]+\.resource_name/.test(body.query))
          return Response.json({error: {code: 400, message: 'Non-sortable RESOURCE_NAME field'}}, {status: 400});
        if (mode === 'error') return Response.json({error: {code: 403, message: 'Synthetic'}});
        if (mode === 'partial_read') return Response.json({results: [], partialFailureError: {code: 3}});
        let rows: JsonObject[] =
          resource === 'customer'
            ? [customer]
            : resource === 'campaign'
              ? [...campaigns.values()]
              : resource === 'campaign_budget'
                ? [...budgets.values()]
                : resource === 'bidding_strategy'
                  ? [...strategies.values()]
                  : resource === resources[exclusion ? 1 : 0]
                    ? [...events.values()]
                    : [...related.values()];
        const ids = [...String(body.query).matchAll(/'(customers\/[^']+)'/g)].map(v => v[1]);
        if (ids.length) rows = rows.filter(v => ids.includes(v.resourceName));
        if (resource === 'campaign' && body.query.includes('advertising_channel_type IN'))
          rows = rows.filter(v => body.query.includes("'" + v.advertisingChannelType + "'") && v.status !== 'REMOVED');
        if (mode === 'missing' && resource === 'campaign') rows = [];
        if (mode === 'foreign' && resource === 'campaign') rows = [{...rows[0], resourceName: res('campaigns', '999')}];
        if (mode === 'duplicate' && resource.startsWith('bidding_')) rows = [...rows, ...rows];
        let token: string | undefined;
        if (mode === 'pages' && resource === resources[exclusion ? 1 : 0] && rows.length > 1) {
          if (!body.pageToken) {
            rows = rows.slice(0, 1);
            token = 'next';
          } else rows = rows.slice(1);
        }
        if (mode === 'loop' && resource === resources[exclusion ? 1 : 0]) token = 'same';
        const d: JsonObject = {
          ...(rows.length ? {results: [...rows].reverse().map(row => ({[camel]: row}))} : {}),
          queryResourceConsumption: String(reads),
          fieldMask: 'native-mask',
        };
        if (token) d.nextPageToken = token;
        if (mode === 'count') d.totalResultsCount = '2';
        if (mode === 'unknown') d.incomplete = true;
        return Response.json(d);
      }
      assert.equal(path, '/v25/customers/123/' + kind + ':mutate');
      if (mode === 'lost') throw Error('Synthetic lost response');
      if (mode === 'partial') return Response.json({results: [], partialFailureError: {code: 3}});
      if (mode === 'empty') return Response.json({});
      const results = body.operations.map((op: JsonObject) => {
        const id = op.remove ?? op.update?.resourceName ?? res(kind, String(next++));
        if (mode !== 'ignored') {
          if (op.remove) events.delete(id);
          else {
            const value: JsonObject = {
              ...events.get(id),
              ...(op.create ?? op.update),
              resourceName: id,
              status: 'ENABLED',
              [exclusion ? 'dataExclusionId' : 'seasonalityAdjustmentId']: id.split('/').at(-1),
            };
            for (const k of ['campaigns', 'advertisingChannelTypes', 'devices'])
              if (Array.isArray(value[k]) && !value[k].length) delete value[k];
            if (value.description === '') delete value.description;
            events.set(id, value);
          }
        }
        return {
          resourceName:
            mode === 'foreign_receipt' ? id.replace('/123/', '/999/') : mode === 'reused' ? res(kind, '1') : id,
        };
      });
      return Response.json({results});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const args = (operations: JsonObject[], extra: JsonObject = {}) => ({
    action: rpc(exclusion),
    account_id: '123',
    connection_id: c.id,
    payload: {operations},
    ...extra,
  });
  const prepare = (operations: JsonObject[], extra: JsonObject = {}) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: args(operations, extra)}, actor);
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
  const seed = (id = '500', extra: JsonObject = {}) => {
    const name = res(kind, id);
    events.set(name, {
      ...make(exclusion),
      resourceName: name,
      status: 'ENABLED',
      [exclusion ? 'dataExclusionId' : 'seasonalityAdjustmentId']: id,
      ...extra,
    });
    return name;
  };
  return {
    kind,
    store,
    service,
    c,
    calls,
    customer,
    campaigns,
    budgets,
    strategies,
    events,
    related,
    args,
    prepare,
    execute,
    verify,
    seed,
    setMode: (v: string) => {
      mode = v;
    },
    onRead: (v: (resource: string) => void) => {
      hook = v;
    },
    writes: () => calls.filter(c => !c.path.endsWith('/googleAds:search')).length,
  };
}
for (const exclusion of [false, true])
  test('bidding event complete create, update/clear, scope replacement and deletion: ' + exclusion, async () => {
    const f = fixture(exclusion);
    try {
      const r = await f.prepare([
        {create: make(exclusion, {devices: ['MOBILE', 'DESKTOP'], description: 'Known event'})},
      ]);
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal((await f.execute(r)).data.success, true);
      assert.equal((await f.verify(r)).data.status, 'verified');
      const name = res(f.kind);
      const update = await f.prepare([
        {
          update: {
            resourceName: name,
            description: '',
            devices: [],
            scope: 'CHANNEL',
            campaigns: [],
            advertisingChannelTypes: ['SEARCH'],
          },
          updateMask: 'description,devices,scope,campaigns,advertising_channel_types',
        },
      ]);
      assert.equal(update.success, true, JSON.stringify(update));
      assert.equal((await f.execute(update)).data.success, true);
      assert.equal((await f.verify(update)).data.status, 'verified');
      const removal = await f.prepare([{remove: name}]);
      assert.equal(removal.success, true, JSON.stringify(removal));
      assert.equal((await f.execute(removal)).data.success, true);
      assert.equal((await f.verify(removal)).data.status, 'verified');
      assert.equal(f.writes(), 3);
    } finally {
      f.store.close();
    }
  });

test('event calendar, account timezone and DST boundaries are explicit', () => {
  assert.equal(biddingEventInstant('2026-01-02 12:00:00', 'Africa/Cairo'), Date.parse('2026-01-02T10:00:00Z'));
  assert.equal(biddingEventInstant('2026-07-02 12:00:00', 'America/New_York'), Date.parse('2026-07-02T16:00:00Z'));
  for (const value of ['2026-02-30 00:00:00', '2026-01-01 24:00:00', '2026-01-01T00:00:00Z'])
    assert.throws(() => biddingEventInstant(value, 'UTC'), {code: 'INVALID_BIDDING_EVENT'});
  for (const value of ['2026-03-08 02:30:00', '2026-11-01 01:30:00'])
    assert.throws(() => biddingEventInstant(value, 'America/New_York'), {code: 'INVALID_BIDDING_EVENT'});
  assert.throws(() => biddingEventInstant('2026-01-01 00:00:00', 'Unknown/Zone'), {
    code: 'BIDDING_EVENT_STATE_UNVERIFIED',
  });
});

test('event fields, scope oneofs, IDs, output fields, multipliers and masks fail before egress', async () => {
  const f = fixture();
  try {
    const name = res(f.kind);
    for (const op of [
      {create: make(false, {scope: 'CUSTOMER'})},
      {create: make(false, {scope: 'CHANNEL', advertisingChannelTypes: ['PERFORMANCE_MAX']})},
      {create: make(false, {campaigns: [campaign, campaign]})},
      {create: make(false, {campaigns: [campaign.replace('/123/', '/999/')]})},
      {create: make(false, {devices: ['UNKNOWN']})},
      {create: make(false, {conversionRateModifier: 50})},
      {create: make(false, {conversionRateModifier: '1.2'})},
      {create: make(false, {resourceName: name})},
      {create: make(false, {status: 'ENABLED'})},
      {create: make(false, {startDateTime: '2026-02-30 00:00:00'})},
      {create: make(false, {name: 'x'.repeat(256)})},
      {update: {resourceName: name, name: 'New'}, updateMask: '*'},
      {update: {resourceName: name, devices: []}, updateMask: 'devices,name'},
      {update: {resourceName: name, description: 'New'}, updateMask: 'name'},
      {remove: name, updateMask: 'name'},
    ])
      assert.equal((await f.prepare([op])).success, false, JSON.stringify(op));
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('event updates merge full native state before validating scope and dates', async () => {
  const f = fixture();
  try {
    const name = f.seed();
    for (const op of [
      {
        update: {resourceName: name, scope: 'CHANNEL', advertisingChannelTypes: ['SEARCH']},
        updateMask: 'scope,advertisingChannelTypes',
      },
      {update: {resourceName: name, endDateTime: '2098-12-30 00:00:00'}, updateMask: 'endDateTime'},
      {update: {resourceName: name, endDateTime: '2098-11-30 00:00:00'}, updateMask: 'endDateTime'},
    ])
      assert.equal((await f.prepare([op])).error.code, 'INVALID_BIDDING_EVENT');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('event review normalizes native sets and cost telemetry but preserves other configuration', async () => {
  for (const changed of ['none', 'event', 'budget', 'campaign', 'unknown_order', 'portfolio']) {
    const f = fixture();
    try {
      const name = f.seed('500', {devices: ['MOBILE', 'DESKTOP'], futureConfiguration: {ordered: ['first', 'second']}});
      f.seed('501', {name: 'Sibling event'});
      if (changed === 'portfolio') {
        f.campaigns.get(campaign)!.biddingStrategy = strategy;
        f.strategies.set(strategy, {
          resourceName: strategy,
          name: 'Shared CPA',
          status: 'ENABLED',
          type: 'TARGET_CPA',
          targetCpa: {targetCpaMicros: '1000000'},
        });
      }
      f.setMode('pages');
      const r = await f.prepare([{update: {resourceName: name, name: 'Reviewed change'}, updateMask: 'name'}]);
      assert.equal(r.success, true, JSON.stringify(r));
      f.events.get(name)!.devices.reverse();
      if (changed === 'event') f.events.get(name)!.conversionRateModifier = 2;
      if (changed === 'budget') f.budgets.get(budget)!.amountMicros = '40000000';
      if (changed === 'campaign') f.campaigns.get(campaign)!.targetCpa.targetCpaMicros = '2000000';
      if (changed === 'unknown_order') f.events.get(name)!.futureConfiguration.ordered.reverse();
      if (changed === 'portfolio') f.strategies.get(strategy)!.targetCpa.targetCpaMicros = '3000000';
      const out = await f.execute(r);
      assert.equal(out.success, changed === 'none', JSON.stringify(out));
      if (changed !== 'none') {
        assert.equal(out.error.code, 'STATE_CHANGED');
        assert.ok(out.error.details.changed_fields.length);
        assert.equal(f.writes(), 0);
      } else assert.equal((await f.verify(r)).data.status, 'verified');
    } finally {
      f.store.close();
    }
  }
});

test('campaign scope changes review both old and new dependencies', async () => {
  const f = fixture();
  try {
    const name = f.seed(),
      other = res('campaigns', '200'),
      otherBudget = res('campaignBudgets', '11');
    f.campaigns.set(other, {...f.campaigns.get(campaign), resourceName: other, campaignBudget: otherBudget});
    f.budgets.set(otherBudget, {...f.budgets.get(budget), resourceName: otherBudget});
    const r = await f.prepare([{update: {resourceName: name, campaigns: [other]}, updateMask: 'campaigns'}]);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(Object.keys(r.data.before_state[0].campaigns).length, 2);
    f.budgets.get(budget)!.amountMicros = '9000000';
    assert.equal((await f.execute(r)).error.code, 'STATE_CHANGED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('event dates honor local elapsed bounds, future seasonality and explicit planned exclusions', async () => {
  const f = fixture(),
    d = fixture(true);
  try {
    assert.equal(
      (
        await f.prepare([
          {create: make(false, {startDateTime: '2020-01-01 00:00:00', endDateTime: '2020-01-02 00:00:00'})},
        ])
      ).error.code,
      'INVALID_BIDDING_EVENT',
    );
    const name = f.seed('500', {startDateTime: '2020-01-01 00:00:00', endDateTime: '2020-01-02 00:00:00'});
    assert.equal(
      (await f.prepare([{update: {resourceName: name, name: 'Historical rename'}, updateMask: 'name'}])).success,
      true,
    );
    assert.equal(
      (
        await d.prepare([
          {create: make(true, {startDateTime: '2098-12-01 00:00:00', endDateTime: '2098-12-03 00:00:00'})},
        ])
      ).success,
      true,
    );
  } finally {
    f.store.close();
    d.store.close();
  }
});

test('manager accounts, missing campaigns and unqualified bid/channel variants cannot execute', async () => {
  for (const mode of ['manager', 'missing', 'foreign', 'manual', 'hotel', 'app', 'cross_portfolio', 'targetless']) {
    const f = fixture();
    try {
      if (mode === 'manager') f.customer.manager = true;
      if (['missing', 'foreign'].includes(mode)) f.setMode(mode);
      if (mode === 'manual') f.campaigns.get(campaign)!.biddingStrategyType = 'MANUAL_CPC';
      if (mode === 'hotel') f.campaigns.get(campaign)!.advertisingChannelType = 'HOTEL';
      if (mode === 'app') f.campaigns.get(campaign)!.advertisingChannelType = 'MULTI_CHANNEL';
      if (mode === 'cross_portfolio') f.campaigns.get(campaign)!.biddingStrategy = 'customers/999/biddingStrategies/20';
      if (mode === 'targetless') f.campaigns.get(campaign)!.biddingStrategyType = 'MAXIMIZE_CONVERSIONS';
      assert.equal((await f.prepare([{create: make()}])).success, false, mode);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('Performance Max campaign scope and future channel membership are distinguished', async () => {
  const f = fixture();
  try {
    f.campaigns.get(campaign)!.advertisingChannelType = 'PERFORMANCE_MAX';
    f.campaigns.get(campaign)!.biddingStrategyType = 'MAXIMIZE_CONVERSION_VALUE';
    const r = await f.prepare([{create: make()}]);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal((await f.execute(r)).data.success, true);
    f.events.clear();
    const channel = await f.prepare([
      {create: make(false, {scope: 'CHANNEL', campaigns: [], advertisingChannelTypes: ['SEARCH']})},
    ]);
    assert.equal(channel.success, true, JSON.stringify(channel));
    assert.deepEqual(channel.data.before_state[0].campaigns, {});
    assert.match(JSON.stringify(channel.data), /future matching campaigns/);
  } finally {
    f.store.close();
  }
});

test('event discovery fails on partial/unknown envelopes, wrong counts, duplicates and loops', async () => {
  for (const mode of ['error', 'partial_read', 'unknown', 'count', 'duplicate', 'loop']) {
    const f = fixture();
    try {
      f.seed();
      f.setMode(mode);
      assert.equal((await f.prepare([{create: make(false, {name: 'Second'})}])).success, false, mode);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('changes during dependency reads cannot produce a mixed event snapshot', async () => {
  const f = fixture();
  try {
    const name = f.seed();
    f.onRead(resource => {
      if (resource === 'campaign_budget') f.events.get(name)!.conversionRateModifier = 2;
    });
    assert.equal(
      (await f.prepare([{update: {resourceName: name, name: 'After'}, updateMask: 'name'}])).error.code,
      'BIDDING_EVENT_STATE_UNVERIFIED',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('event response bytes, page loops and monotonic deadlines are bounded', async t => {
  const f = fixture();
  try {
    const p = f.service.compiler.compile(gateway, f.args([{create: make()}]), {mode: 'strict', flags: {}});
    for (const mode of ['bytes', 'total', 'pages', 'deadline']) {
      let calls = 0,
        elapsed = 0;
      t.mock.method(performance, 'now', () => elapsed);
      await assert.rejects(
        () =>
          readGoogleBiddingEventState(p, async () => {
            calls++;
            const d: JsonObject = {results: [{customer: f.customer}]};
            if (mode === 'bytes' || mode === 'total')
              d.fieldMask = 'x'.repeat((mode === 'bytes' ? 4 : 3) * 1024 * 1024);
            if (mode === 'pages' || mode === 'total') d.nextPageToken = String(calls);
            if (mode === 'deadline') elapsed = 60001;
            return {status: 200, headers: {}, data: d};
          }),
        {code: 'BIDDING_EVENT_STATE_UNVERIFIED'},
        mode,
      );
      assert.equal(calls, mode === 'total' ? 3 : mode === 'pages' ? 25 : 1);
      t.mock.restoreAll();
    }
  } finally {
    t.mock.restoreAll();
    f.store.close();
  }
});

test('data-exclusion active capacity counts the whole batch before execution', async () => {
  const f = fixture(true);
  try {
    for (let i = 1; i <= 500; i++) f.seed(String(i), {name: 'Existing ' + i});
    const denied = await f.prepare([{create: make(true, {name: 'Extra'})}]);
    assert.equal(denied.error.code, 'INVALID_BIDDING_EVENT');
    const replacement = await f.prepare([{remove: res(f.kind, '1')}, {create: make(true, {name: 'Replacement'})}]);
    assert.equal(replacement.success, true, JSON.stringify(replacement));
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('event spending confirmation, activation/deletion policies and changed scopes are enforced', async () => {
  for (const mode of ['confirmation', 'activation', 'deletion', 'grant', 'scope', 'inflight', 'inflight_scope']) {
    const f = fixture();
    try {
      const name = f.seed(),
        r = await f.prepare([{remove: name}]);
      assert.equal(r.success, true, JSON.stringify(r));
      if (mode === 'activation' || mode === 'deletion')
        saveSpendPolicy(f.store, owner, {
          gateway,
          account_id: '123',
          policy: {[mode === 'activation' ? 'allow_activation' : 'allow_deletion']: false},
          confirmed: true,
        });
      if (mode === 'grant' || mode === 'scope')
        f.store.putConnection(
          owner,
          {...f.c, ...(mode === 'scope' ? {scopes: []} : {writeAccounts: []})},
          {accessToken: 'synthetic'},
        );
      if (mode === 'inflight' || mode === 'inflight_scope')
        f.onRead(() =>
          f.store.putConnection(
            owner,
            {...f.c, ...(mode === 'inflight_scope' ? {scopes: []} : {writeAccounts: []})},
            {accessToken: 'synthetic'},
          ),
        );
      assert.equal(
        (await f.execute(r, mode === 'confirmation' ? {spend_change_confirmed: false} : {})).success,
        false,
        mode,
      );
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('event receipts require exact fresh native IDs and uncertain outcomes cannot replay', async () => {
  for (const mode of ['partial', 'empty', 'foreign_receipt', 'reused', 'lost']) {
    const f = fixture();
    try {
      f.seed('1', {name: 'Old event'});
      const r = await f.prepare([{create: make()}]);
      assert.equal(r.success, true, JSON.stringify(r));
      f.setMode(mode);
      const out = await f.execute(r);
      assert.ok(!out.success || !out.data.success, mode);
      await f.execute(r);
      assert.equal(f.writes(), 1);
      assert.notEqual((await f.verify(r)).data?.status, 'verified');
    } finally {
      f.store.close();
    }
  }
});

test('ignored event creation, changes and removals cannot pass read-back', async () => {
  for (const operation of ['create', 'update', 'remove']) {
    const f = fixture();
    try {
      const name = f.seed('1', {name: 'Old event'}),
        op =
          operation === 'create'
            ? {create: make()}
            : operation === 'update'
              ? {update: {resourceName: name, devices: []}, updateMask: 'devices'}
              : {remove: name};
      f.events.get(name)!.devices = ['MOBILE'];
      const r = await f.prepare([op]);
      assert.equal(r.success, true, JSON.stringify(r));
      f.setMode('ignored');
      assert.equal((await f.execute(r)).data.success, true);
      const v = await f.verify(r);
      assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
      assert.ok(v.data.checks[0].changed_fields.length);
    } finally {
      f.store.close();
    }
  }
});

test('event claims survive concurrent calls, lost responses and process-store reopen', async () => {
  for (const lost of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'amcp-events-'));
    let f = fixture(false, join(directory, 'store.sqlite'));
    try {
      const r = await f.prepare([{create: make()}]);
      assert.equal(r.success, true, JSON.stringify(r));
      if (lost) f.setMode('lost');
      await Promise.all([f.execute(r), f.execute(r)]);
      assert.equal(f.writes(), 1);
      f.store.close();
      f = fixture(false, join(directory, 'store.sqlite'));
      const out = await f.execute(r);
      assert.equal(f.writes(), 0);
      if (lost) assert.equal(out.error.code, 'WRITE_OUTCOME_UNCERTAIN');
      else assert.equal(out.data.success, true);
    } finally {
      f.store.close();
      removeTestDirectory(directory, 'amcp-events-');
    }
  }
});

test('event verification checks current scope before cached results and native execution requires review', async () => {
  const f = fixture();
  try {
    const r = await f.prepare([{create: make()}]);
    await f.execute(r);
    assert.equal((await f.verify(r)).data.status, 'verified');
    f.store.putConnection(owner, {...f.c, scopes: []}, {accessToken: 'synthetic'});
    assert.equal((await f.verify(r)).error.code, 'INSUFFICIENT_SCOPE');
    f.store.putConnection(owner, f.c, {accessToken: 'synthetic'});
    const direct = await f.service.call(
      gateway,
      {
        ...f.args([{create: make()}]),
        dry_run: false,
        confirmed: true,
        idempotency_key: '12345678-1234-4234-9234-123456789abc',
      },
      actor,
    );
    assert.equal(direct.error.code, 'WRITE_REVIEW_REQUIRED');
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('both event actions are inventoried with explicit reviewed families', () => {
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && [rpc(), rpc(true)].includes(r.action));
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.family === 'google_bidding_events' && r.status === 'reviewed_write_family'));
});

test('unsupported native skip_preflight cannot enter the reviewed event execution path', async () => {
  const f = fixture();
  try {
    const out = await f.service.call(
      gateway,
      {
        ...f.args([{create: make()}]),
        dry_run: false,
        confirmed: true,
        skip_preflight: true,
        idempotency_key: '12345678-1234-4234-9234-123456789abc',
      },
      actor,
    );
    assert.equal(out.error.code, 'UNSUPPORTED_PARAMETER');
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('event history capacity reserves read-back room even when the batch also removes an event', async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 1000; i++) f.seed(String(i), {name: 'History ' + i, status: i < 1000 ? 'REMOVED' : 'ENABLED'});
    const out = await f.prepare([{remove: res(f.kind, '1000')}, {create: make()}]);
    assert.equal(out.error.code, 'INVALID_BIDDING_EVENT');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('campaign and portfolio bidding type disagreement cannot establish event prerequisites', async () => {
  const f = fixture();
  try {
    f.campaigns.get(campaign)!.biddingStrategy = strategy;
    f.strategies.set(strategy, {
      resourceName: strategy,
      name: 'Portfolio',
      status: 'ENABLED',
      type: 'TARGET_ROAS',
      targetRoas: {targetRoas: 3},
    });
    assert.equal((await f.prepare([{create: make()}])).error.code, 'BIDDING_EVENT_STATE_UNVERIFIED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('reader roles, foreign tenants and duplicate account connections cannot replace the reviewed grant', async () => {
  const f = fixture();
  try {
    for (const who of [
      {...actor, role: 'reader' as const},
      {...actor, tenantId: 'foreign'},
    ]) {
      const denied = await f.service.call(
        'amcp_write',
        {action: 'prepare', gateway, arguments: f.args([{create: make()}])},
        who,
      );
      assert.equal(denied.success, false);
    }
    assert.equal(f.calls.length, 0);
    const r = await f.prepare([{create: make()}]);
    assert.equal(r.success, true);
    f.store.putConnection(
      owner,
      {...f.c, id: '22222222-2222-4222-8222-222222222222'},
      {accessToken: 'another synthetic'},
    );
    f.store.putConnection(owner, {...f.c, writeAccounts: []}, {accessToken: 'synthetic'});
    assert.equal((await f.execute(r)).success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('event verification stops when the Ads scope is revoked during a read', async () => {
  const f = fixture();
  try {
    const r = await f.prepare([{create: make()}]);
    await f.execute(r);
    const before = f.calls.length;
    f.onRead(() => f.store.putConnection(owner, {...f.c, scopes: []}, {accessToken: 'synthetic'}));
    const v = await f.verify(r);
    assert.equal(v.data.status, 'unverified');
    assert.equal(v.data.checks[0].code, 'INSUFFICIENT_SCOPE');
    assert.equal(f.calls.length, before + 1);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('event state fields are selectable in the pinned official v23 reference evidence', () => {
  const evidence = JSON.parse(readFileSync('tests/fixtures/google-bidding-event-fields-v23.json', 'utf8'));
  assert.equal(evidence.api_version, 'v23');
  for (const [i, kind] of kinds.entries())
    for (const field of googleBiddingEventFields[kind])
      assert.equal(evidence.resources[resources[i]!].fields[field]?.selectable, true, kind + '.' + field);
});
