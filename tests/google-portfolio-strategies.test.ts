import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {googleJson} from '../src/google-contracts.js';
import {googlePortfolioFields, readGooglePortfolioState} from '../src/google-portfolio-strategies.js';
import evidence from './fixtures/google-portfolio-v23.json' with {type: 'json'};
import {removeTestDirectory} from './temp.js';
import type {Connection, JsonObject} from '../src/types.js';

const gateway = 'google_ads_native_action',
  rpc = 'google_ads_v23_bidding_strategy_mutate_bidding_strategies';
const actor = {tenantId: 'portfolios', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const},
  registry = new Registry(),
  key = Buffer.alloc(32, 53).toString('base64');
const rn = (collection = 'biddingStrategies', id = '500') => 'customers/123/' + collection + '/' + id;
const campaign = rn('campaigns', '100'),
  budget = rn('campaignBudgets', '10');
const create = (extra: JsonObject = {}) => ({name: 'Client CPA', targetCpa: {targetCpaMicros: '15000000'}, ...extra});
function fixture(file = ':memory:') {
  const store = new Store(file, key),
    calls: JsonObject[] = [],
    strategies = new Map<string, JsonObject>(),
    campaigns = new Map<string, JsonObject>(),
    budgets = new Map<string, JsonObject>(),
    customer: JsonObject = {id: '123', currencyCode: 'EGP', timeZone: 'Africa/Cairo'};
  const c: Connection = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: actor.tenantId,
    gateway,
    accounts: ['123'],
    writeAccounts: ['123'],
    enabled: true,
    label: 'Synthetic client login',
    scopes: ['https://www.googleapis.com/auth/adwords'],
  };
  if (!store.listConnections(actor.tenantId).length)
    store.putConnection(owner, c, {accessToken: 'synthetic', developerToken: 'synthetic'});
  let mode = 'success',
    next = 500,
    reads = 0,
    hook: ((resource: string) => void) | undefined;
  const transport = new NativeTransport(
    async (url, init) => {
      const path = new URL(String(url)).pathname,
        body = googleJson(JSON.parse(String(init?.body)));
      calls.push({path, body});
      if (path.endsWith('/googleAds:search')) {
        reads++;
        const entity = / FROM ([a-z_]+)/.exec(body.query)![1]!;
        hook?.(entity);
        if (/ORDER BY [a-z_]+\.resource_name/.test(body.query))
          return Response.json({error: {code: 400, message: 'Non-sortable RESOURCE_NAME field'}}, {status: 400});
        if (mode === 'read_error')
          return Response.json({error: {code: 403, message: 'Synthetic access denied'}}, {status: 403});
        if (mode === 'partial_read') return Response.json({results: [], partialFailureError: {code: 3}});
        let rows: JsonObject[] =
          entity === 'customer'
            ? [customer]
            : entity === 'bidding_strategy'
              ? [...strategies.values()].filter(s => s.status === 'ENABLED')
              : entity === 'campaign_budget'
                ? [...budgets.values()]
                : [...campaigns.values()].filter(c => c.status !== 'REMOVED');
        const ids = [...body.query.matchAll(/'(customers\/[^']+)'/g)].map((m: RegExpMatchArray) => m[1]);
        if (ids.length) {
          const field = body.query.includes('campaign.bidding_strategy IN')
            ? 'biddingStrategy'
            : body.query.includes('campaign.campaign_budget IN')
              ? 'campaignBudget'
              : 'resourceName';
          rows = rows.filter(v => ids.includes(v[field]));
        }
        if (entity === 'bidding_strategy')
          rows = rows.map(s => {
            const all = [...campaigns.values()].filter(c => c.biddingStrategy === s.resourceName);
            return {
              ...s,
              campaignCount: String(all.length),
              nonRemovedCampaignCount: String(all.filter(c => c.status !== 'REMOVED').length),
              ...(mode === 'wrong_count' ? {nonRemovedCampaignCount: '99'} : {}),
            };
          });
        if (mode === 'missing' && entity === 'campaign_budget') rows = [];
        if (mode === 'foreign' && entity === 'campaign')
          rows = rows.map(c => ({...c, resourceName: c.resourceName.replace('/123/', '/999/')}));
        if (mode === 'duplicate' && entity === 'bidding_strategy') rows = [...rows, ...rows];
        // Native ordering is deliberately unstable, including across page boundaries.
        if (reads % 2) rows.reverse();
        let token: string | undefined;
        if (mode === 'pages' && entity === 'bidding_strategy' && rows.length > 1) {
          rows.sort((a, b) => a.resourceName.localeCompare(b.resourceName));
          const start = body.pageToken ? 1 : 0;
          token = start === 0 ? 'page2' : undefined;
          rows = rows.slice(start, start + 1);
        }
        if (mode === 'loop' && entity === 'bidding_strategy') token = 'same';
        const data: JsonObject = {
          ...(rows.length
            ? {results: rows.map(row => ({[entity.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())]: row}))}
            : {}),
          fieldMask: 'native-mask',
          queryResourceConsumption: String(reads),
          requestId: 'trace-' + reads,
        };
        if (token) data.nextPageToken = token;
        if (mode === 'count') data.totalResultsCount = '999';
        if (mode === 'unknown') data.partial = true;
        return Response.json(data);
      }
      assert.equal(path, '/v23/customers/123/biddingStrategies:mutate');
      if (mode === 'partial') return Response.json({results: [], partialFailureError: {code: 3}});
      if (mode === 'empty') return Response.json({});
      const results = body.operations.map((op: JsonObject) => {
        const id = op.remove ?? op.update?.resourceName ?? rn('biddingStrategies', String(next++));
        if (mode !== 'ignored') {
          if (op.remove) strategies.delete(id);
          else {
            const row: JsonObject = {
              ...strategies.get(id),
              ...(op.create ?? op.update),
              resourceName: id,
              id: id.split('/').at(-1),
              status: 'ENABLED',
            };
            if (op.create) {
              const scheme = Object.keys(row).find(k =>
                [
                  'targetCpa',
                  'targetRoas',
                  'maximizeConversions',
                  'maximizeConversionValue',
                  'targetImpressionShare',
                  'targetSpend',
                ].includes(k),
              )!;
              row.type = scheme.replace(/[A-Z]/g, c => '_' + c.toLowerCase()).toUpperCase();
            } else
              for (const k of Object.keys(op.update))
                if (typeof op.update[k] === 'object') row[k] = {...strategies.get(id)?.[k], ...op.update[k]};
            for (const k of Object.keys(row))
              if (row[k] && typeof row[k] === 'object')
                for (const f of Object.keys(row[k])) if (row[k][f] === '0' || row[k][f] === 0) delete row[k][f];
            strategies.set(id, row);
          }
        }
        return {
          resourceName:
            mode === 'foreign_receipt'
              ? id.replace('/123/', '/999/')
              : mode === 'reused'
                ? rn('biddingStrategies', '1')
                : mode === 'duplicate_receipt'
                  ? rn()
                  : id,
        };
      });
      // Model the dangerous case: Google accepted the mutation, but its receipt was lost.
      if (mode === 'lost') throw Error('Synthetic lost response after mutation');
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
    action: rpc,
    account_id: '123',
    connection_id: c.id,
    payload: {operations},
    ...extra,
  });
  const prepare = (operations: JsonObject[], extra: JsonObject = {}) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: args(operations, extra)}, actor);
  const execute = (review: JsonObject, extra: JsonObject = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: review.data.review_id,
        idempotency_key: review.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = (review: JsonObject) =>
    service.call('amcp_campaign', {action: 'verify', review_id: review.data.review_id}, actor);
  const seed = (id = '500', extra: JsonObject = {}) => {
    const idRn = rn('biddingStrategies', id);
    strategies.set(idRn, {...create(), resourceName: idRn, id, status: 'ENABLED', type: 'TARGET_CPA', ...extra});
    return idRn;
  };
  const attach = (strategy = rn()) => {
    campaigns.set(campaign, {
      resourceName: campaign,
      name: 'Search campaign',
      status: 'PAUSED',
      advertisingChannelType: 'SEARCH',
      biddingStrategyType: strategies.get(strategy)!.type,
      biddingStrategy: strategy,
      campaignBudget: budget,
      startDate: '2026-09-01',
      endDate: '2037-12-30',
    });
    budgets.set(budget, {
      resourceName: budget,
      name: 'Client budget',
      status: 'ENABLED',
      amountMicros: '50000000',
      deliveryMethod: 'STANDARD',
      period: 'DAILY',
    });
  };
  return {
    store,
    c,
    calls,
    strategies,
    campaigns,
    budgets,
    customer,
    service,
    args,
    prepare,
    execute,
    verify,
    seed,
    attach,
    writes: () => calls.filter(c => !c.path.endsWith('/googleAds:search')).length,
    setMode: (v: string) => {
      mode = v;
    },
    onRead: (fn: (resource: string) => void) => {
      hook = fn;
    },
  };
}
for (const scheme of [
  {targetCpa: {targetCpaMicros: '15000000', cpcBidCeilingMicros: '5000000', cpcBidFloorMicros: '1000000'}},
  {targetRoas: {targetRoas: 3.2, targetRoasTolerancePercentMillis: '10000'}},
  {maximizeConversions: {}},
  {maximizeConversionValue: {targetRoas: 2}},
  {targetImpressionShare: {location: 'TOP_OF_PAGE', locationFractionMicros: '500000', cpcBidCeilingMicros: '3000000'}},
  {targetSpend: {}},
])
  test('portfolio native create/read-back and unused removal: ' + Object.keys(scheme)[0], async () => {
    const f = fixture();
    try {
      const r = await f.prepare([{create: {name: 'Strategy', ...scheme}}]);
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal((await f.execute(r)).data.success, true);
      assert.equal((await f.verify(r)).data.status, 'verified');
      const d = await f.prepare([{remove: rn()}]);
      assert.equal(d.success, true, JSON.stringify(d));
      assert.equal((await f.execute(d)).data.success, true);
      assert.equal((await f.verify(d)).data.status, 'verified');
      assert.equal(f.writes(), 2);
    } finally {
      f.store.close();
    }
  });

test('portfolio update merges untouched limits, exact masks and proto zero omission', async () => {
  const f = fixture();
  try {
    f.seed('500', {
      targetCpa: {targetCpaMicros: '15000000', cpcBidFloorMicros: '1000000', cpcBidCeilingMicros: '4000000'},
    });
    f.attach();
    const r = await f.prepare([
      {
        update: {resourceName: rn(), targetCpa: {cpcBidFloorMicros: '0'}},
        updateMask: 'target_cpa.cpc_bid_floor_micros',
      },
    ]);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(Object.keys(r.data.before_state[0].campaigns).length, 1);
    assert.equal(Object.keys(r.data.before_state[0].budgets).length, 1);
    assert.equal((await f.execute(r)).data.success, true);
    assert.equal((await f.verify(r)).data.status, 'verified');
    assert.equal(f.strategies.get(rn())!.targetCpa.targetCpaMicros, '15000000');
    assert.equal(
      (
        await f.prepare([
          {
            update: {resourceName: rn(), targetCpa: {cpcBidFloorMicros: '5000000'}},
            updateMask: 'targetCpa.cpcBidFloorMicros',
          },
        ])
      ).success,
      false,
    );
  } finally {
    f.store.close();
  }
});

test('portfolio invalid fields, oneofs, masks, units and cross-account IDs stop before egress', async () => {
  const f = fixture();
  try {
    const invalid = [
      {create: {}},
      {create: create({name: ' x '})},
      {create: create({name: 'ع'.repeat(128)})},
      {create: create({targetRoas: {targetRoas: 2}})},
      {create: create({enhancedCpc: {}})},
      {create: create({currencyCode: 'USD'})},
      {create: create({alignedCampaignBudgetId: '9'})},
      {create: create({status: 'ENABLED'})},
      {create: create({targetCpa: {targetCpaMicros: '-1'}})},
      {create: create({targetCpa: {targetCpaMicros: 9007199254740992}})},
      {create: create({targetCpa: {targetCpaMicros: '9223372036854775808'}})},
      {create: {name: 'ROAS', targetRoas: {targetRoas: 0}}},
      {
        create: {
          name: 'Impressions',
          targetImpressionShare: {location: 'TOP_OF_PAGE', locationFractionMicros: '1000001', cpcBidCeilingMicros: '5'},
        },
      },
      {create: {name: 'Clicks', targetSpend: {targetSpendMicros: '5'}}},
      {update: {resourceName: rn(), name: 'New'}, updateMask: '*'},
      {update: {resourceName: rn(), name: 'New'}, updateMask: 'name,status'},
      {update: {resourceName: rn(), targetCpa: {targetCpaMicros: '4'}}, updateMask: 'targetCpa'},
      {update: {resourceName: rn(), targetCpa: {}}, updateMask: 'targetCpa'},
      {update: {resourceName: rn(), name: null}, updateMask: 'name'},
      {remove: rn().replace('/123/', '/999/')},
      {remove: rn(), updateMask: 'name'},
      {create: create(), remove: rn()},
    ];
    for (const op of invalid) assert.equal((await f.prepare([op])).success, false, JSON.stringify(op));
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('portfolio type changes, name collisions, associated removal and manager/alignment boundaries fail closed', async () => {
  for (const mode of [
    'type',
    'name',
    'duplicate_batch',
    'associated',
    'historical',
    'manager',
    'aligned',
    'currency',
    'incomplete_target',
  ]) {
    const f = fixture();
    try {
      f.seed();
      f.seed('501', {name: 'Other'});
      let ops: JsonObject[] = [{update: {resourceName: rn(), name: 'Renamed'}, updateMask: 'name'}];
      if (mode === 'type')
        ops = [{update: {resourceName: rn(), targetRoas: {targetRoas: 3}}, updateMask: 'targetRoas.targetRoas'}];
      if (mode === 'name') ops = [{create: create()}];
      if (mode === 'duplicate_batch')
        ops = [{create: create({name: 'Duplicate'})}, {create: create({name: 'Duplicate'})}];
      if (mode === 'associated' || mode === 'historical') {
        f.attach();
        if (mode === 'historical') f.campaigns.get(campaign)!.status = 'REMOVED';
        ops = [{remove: rn()}];
      }
      if (mode === 'manager') f.customer.manager = true;
      if (mode === 'aligned') f.strategies.get(rn())!.alignedCampaignBudgetId = '10';
      if (mode === 'currency') f.strategies.get(rn())!.effectiveCurrencyCode = 'USD';
      if (mode === 'incomplete_target') delete f.strategies.get(rn())!.targetCpa;
      assert.equal((await f.prepare(ops)).success, false, mode);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('portfolio comparison ignores telemetry/order/unrelated targets, detects real configuration and membership', async () => {
  for (const changed of ['none', 'target', 'budget', 'campaign', 'membership', 'sharing']) {
    const f = fixture();
    try {
      f.seed();
      f.seed('501', {name: 'Other'});
      f.attach();
      f.setMode('pages');
      const r = await f.prepare([
        {
          update: {resourceName: rn(), targetCpa: {targetCpaMicros: '20000000'}},
          updateMask: 'targetCpa.targetCpaMicros',
        },
      ]);
      assert.equal(r.success, true, JSON.stringify(r));
      f.strategies.get(rn('biddingStrategies', '501'))!.targetCpa.targetCpaMicros = '123456';
      if (changed === 'target') f.strategies.get(rn())!.targetCpa.targetCpaMicros = '17000000';
      if (changed === 'budget') f.budgets.get(budget)!.amountMicros = '60000000';
      if (changed === 'campaign') f.campaigns.get(campaign)!.status = 'ENABLED';
      if (changed === 'membership' || changed === 'sharing') {
        const other = rn('campaigns', '101');
        f.campaigns.set(other, {
          ...f.campaigns.get(campaign),
          resourceName: other,
          ...(changed === 'sharing' ? {biddingStrategy: rn('biddingStrategies', '501')} : {}),
        });
      }
      const out = await f.execute(r);
      if (changed === 'none') {
        assert.equal(out.data.success, true, JSON.stringify(out));
        assert.equal((await f.verify(r)).data.status, 'verified');
      } else {
        assert.equal(out.error.code, 'STATE_CHANGED', JSON.stringify(out));
        assert.ok(
          out.error.details.changed_fields.some((s: string) =>
            s.includes(
              changed === 'target'
                ? 'targetCpa'
                : changed === 'budget'
                  ? 'amountMicros'
                  : changed === 'campaign'
                    ? 'status'
                    : 'campaign',
            ),
          ),
          JSON.stringify(out),
        );
        assert.equal(f.writes(), 0);
      }
    } finally {
      f.store.close();
    }
  }
});

test('portfolio discovery rejects incomplete pages, invalid envelopes, missing budgets and count disagreement', async () => {
  for (const mode of [
    'read_error',
    'partial_read',
    'count',
    'wrong_count',
    'unknown',
    'missing',
    'foreign',
    'duplicate',
    'loop',
  ]) {
    const f = fixture();
    try {
      f.seed();
      f.attach();
      f.setMode(mode);
      assert.equal(
        (await f.prepare([{update: {resourceName: rn(), name: 'New'}, updateMask: 'name'}])).success,
        false,
        mode,
      );
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('portfolio discovery rejects changes within a snapshot', async () => {
  const f = fixture();
  try {
    f.seed();
    f.attach();
    f.onRead(entity => {
      if (entity === 'campaign_budget') f.strategies.get(rn())!.targetCpa.targetCpaMicros = '18000000';
    });
    assert.equal(
      (await f.prepare([{update: {resourceName: rn(), name: 'New'}, updateMask: 'name'}])).error.code,
      'PORTFOLIO_STATE_UNVERIFIED',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('portfolio requests, bytes, pages and monotonic deadlines are bounded', async t => {
  const f = fixture();
  try {
    const p = f.service.compiler.compile(gateway, f.args([{create: create()}]), {mode: 'strict', flags: {}});
    for (const mode of ['bytes', 'pages', 'deadline']) {
      let calls = 0,
        elapsed = 0;
      t.mock.method(performance, 'now', () => elapsed);
      await assert.rejects(
        () =>
          readGooglePortfolioState(p, async () => {
            calls++;
            if (mode === 'deadline') elapsed = 60001;
            return {
              status: 200,
              headers: {},
              data: {
                results: [{customer: f.customer}],
                ...(mode === 'bytes'
                  ? {fieldMask: 'x'.repeat(4 * 1024 * 1024)}
                  : mode === 'pages'
                    ? {nextPageToken: String(calls)}
                    : {}),
              },
            };
          }),
        {code: 'PORTFOLIO_STATE_UNVERIFIED'},
      );
      assert.equal(calls, mode === 'pages' ? 25 : 1);
      t.mock.restoreAll();
    }
  } finally {
    t.mock.restoreAll();
    f.store.close();
  }
});

test('portfolio policies keep bids separate from budgets and require explicit serving confirmation', async () => {
  const f = fixture();
  try {
    f.seed();
    f.attach();
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      policy: {max_budget_native: 1, max_daily_increase_native: 0, max_budget_increase_percent: 0},
      confirmed: true,
    });
    const r = await f.prepare([
      {update: {resourceName: rn(), targetCpa: {targetCpaMicros: '60000000'}}, updateMask: 'targetCpa.targetCpaMicros'},
    ]);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.spend_policy.requested_increase_native, 0);
    assert.equal((await f.execute(r, {spend_change_confirmed: false})).error.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes(), 0);
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', policy: {allow_activation: false}, confirmed: true});
    assert.equal((await f.execute(r)).error.code, 'POLICY_ACTIVATION_FORBIDDEN');
    const rename = await f.prepare([{update: {resourceName: rn(), name: 'Rename only'}, updateMask: 'name'}]);
    assert.equal(rename.success, true, JSON.stringify(rename));
    assert.equal((await f.execute(rename, {spend_change_confirmed: false})).data.success, true);
    f.campaigns.clear();
    const remove = await f.prepare([{remove: rn()}]);
    assert.equal(remove.success, true, JSON.stringify(remove));
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', policy: {allow_deletion: false}, confirmed: true});
    assert.equal((await f.execute(remove)).error.code, 'POLICY_DELETION_FORBIDDEN');
  } finally {
    f.store.close();
  }
});

test('portfolio scopes, grants, disconnect and in-flight reauthorization fence execution', async () => {
  for (const mode of ['scope', 'grant', 'disabled', 'inflight_scope', 'inflight_grant', 'inflight_login']) {
    const f = fixture();
    try {
      f.seed();
      const r = await f.prepare([{update: {resourceName: rn(), name: 'After'}, updateMask: 'name'}]);
      assert.equal(r.success, true, JSON.stringify(r));
      const change = () =>
        f.store.putConnection(
          owner,
          {
            ...f.c,
            ...(mode.includes('scope')
              ? {scopes: []}
              : mode.includes('grant')
                ? {writeAccounts: []}
                : mode === 'disabled'
                  ? {enabled: false}
                  : {}),
          },
          {accessToken: mode === 'inflight_login' ? 'changed-login' : 'synthetic', developerToken: 'synthetic'},
        );
      if (mode.startsWith('inflight')) f.onRead(change);
      else change();
      assert.equal((await f.execute(r)).success, false, mode);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('portfolio native receipts and partial/uncertain outcomes cannot manufacture success or replay', async () => {
  for (const mode of ['partial', 'empty', 'foreign_receipt', 'reused', 'duplicate_receipt', 'lost']) {
    const f = fixture();
    try {
      f.seed('1', {name: 'Old'});
      const r = await f.prepare([{create: create()}, {create: create({name: 'Second'})}]);
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

test('portfolio read-back detects ignored create, update, removal and unrelated later fields', async () => {
  for (const operation of ['create', 'update', 'remove', 'later_target']) {
    const f = fixture();
    try {
      f.seed('1', {name: 'Existing'});
      const op =
        operation === 'create'
          ? {create: create()}
          : operation === 'remove'
            ? {remove: rn('biddingStrategies', '1')}
            : {update: {resourceName: rn('biddingStrategies', '1'), name: 'Renamed'}, updateMask: 'name'};
      const r = await f.prepare([op]);
      assert.equal(r.success, true, JSON.stringify(r));
      if (operation !== 'later_target') f.setMode('ignored');
      assert.equal((await f.execute(r)).data.success, true);
      if (operation === 'later_target')
        f.strategies.get(rn('biddingStrategies', '1'))!.targetCpa.targetCpaMicros = '555000000';
      const v = await f.verify(r);
      assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
      assert.ok(v.data.checks[0].changed_fields.length);
    } finally {
      f.store.close();
    }
  }
});

test('portfolio concurrent submissions and restart retain exact outcomes without resubmission', async () => {
  for (const lost of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'amcp-portfolios-'));
    let f = fixture(join(directory, 'store.sqlite'));
    try {
      const r = await f.prepare([{create: create()}]);
      assert.equal(r.success, true, JSON.stringify(r));
      if (lost) f.setMode('lost');
      await Promise.all([f.execute(r), f.execute(r)]);
      assert.equal(f.writes(), 1);
      f.store.close();
      f = fixture(join(directory, 'store.sqlite'));
      const out = await f.execute(r);
      assert.equal(f.writes(), 0);
      if (lost) assert.equal(out.error.code, 'WRITE_OUTCOME_UNCERTAIN');
      else assert.equal(out.data.success, true);
    } finally {
      f.store.close();
      removeTestDirectory(directory, 'amcp-portfolios-');
    }
  }
});

test('portfolio projection fields correspond to source-hashed native v23 definitions', () => {
  for (const field of googlePortfolioFields) {
    const [parent, child] = field.split('.');
    assert.ok(evidence.resourceFields.includes(parent!), field);
    if (child) {
      const message = parent!
        .split('_')
        .map(s => s[0]!.toUpperCase() + s.slice(1))
        .join('');
      assert.ok((evidence.fields as Record<string, string[]>)[message]?.includes(child), field);
    }
  }
  assert.equal(evidence.enums.bidding_strategy_error.CANNOT_CHANGE_BIDDING_STRATEGY_TYPE, 3);
  assert.equal(evidence.enums.bidding_strategy_error.CANNOT_REMOVE_ASSOCIATED_STRATEGY, 4);
  for (const source of Object.values(evidence.sources)) assert.match(source.sha256, /^[a-f0-9]{64}$/);
  assert.ok(googlePortfolioFields.includes('non_removed_campaign_count'));
  assert.ok(!googlePortfolioFields.includes('query_resource_consumption'));
});

test('portfolio legacy create/update/remove follow the same reviewed native contract', async () => {
  const f = fixture();
  try {
    const make = await f.prepare([], {
      action: 'CREATE_BIDDING_STRATEGY',
      payload: {resource: {name: 'Legacy CPA', target_cpa: {target_cpa_micros: '15000000'}}},
    });
    assert.equal(make.success, true, JSON.stringify(make));
    assert.equal((await f.execute(make)).data.success, true);
    assert.equal((await f.verify(make)).data.status, 'verified');
    const edit = await f.prepare([], {
      action: 'UPDATE_BIDDING_STRATEGY',
      payload: {resource_name: rn(), resource: {name: 'Legacy renamed'}, update_mask: 'name'},
    });
    assert.equal(edit.success, true, JSON.stringify(edit));
    assert.equal((await f.execute(edit, {spend_change_confirmed: false})).data.success, true);
    assert.equal((await f.verify(edit)).data.status, 'verified');
    const remove = await f.prepare([], {action: 'REMOVE_BIDDING_STRATEGY', payload: {resource_name: rn()}});
    assert.equal(remove.success, true, JSON.stringify(remove));
    assert.equal((await f.execute(remove, {spend_change_confirmed: false})).data.success, true);
    assert.equal((await f.verify(remove)).data.status, 'verified');
    assert.equal(f.writes(), 3);
  } finally {
    f.store.close();
  }
});
