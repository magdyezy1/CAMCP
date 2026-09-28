import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {appleActions} from '../src/apple-native.js';
import {appleModelEvidence} from '../src/apple-entity-writes.js';
import type {JsonObject} from '../src/types.js';

const gateway = 'apple_ads_native_action',
  registry = new Registry(),
  actor = {tenantId: 'apple-entities', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const};
const cases = [
  {
    kind: 'adgroup',
    collection: 'adgroups',
    sdk: 'adgroups',
    create: {
      name: 'Search group',
      campaignId: 101,
      pricingModel: 'CPT',
      status: 'PAUSED',
      bidStrategy: {bidStrategyType: 'MANUAL_CPT', bid: {amount: '1.50', currency: 'USD'}},
      targeting: {country: {include: ['US']}},
    },
    update: {name: 'Renamed group', bidStrategy: {bid: {amount: '1.60', currency: 'USD'}}},
  },
  {
    kind: 'ad',
    collection: 'ads',
    sdk: 'ads',
    create: {adGroupId: 201, creativeId: 301, name: 'Search ad', status: 'PAUSED'},
    update: {name: 'Renamed ad', status: 'ENABLED'},
  },
  {
    kind: 'creative',
    collection: 'creatives',
    sdk: 'creatives',
    create: {
      name: 'Default page',
      creativeType: 'DEFAULT_PRODUCT_PAGE',
      destination: {destinationType: 'APP_STORE_PRODUCT_PAGE', parameters: {adamId: '123456789'}},
    },
    update: {name: 'Renamed creative'},
  },
  {
    kind: 'keyword',
    collection: 'keywords',
    sdk: 'keywords',
    create: {
      adGroupId: 201,
      text: 'budget planner',
      matchType: 'EXACT',
      bid: {amount: '1.50', currency: 'USD'},
      status: 'PAUSED',
    },
    update: {bid: {amount: '1.60', currency: 'USD'}, status: 'PAUSED'},
  },
  {
    kind: 'negative_keyword',
    collection: 'negative-keywords',
    sdk: 'negativeKeywords',
    create: {campaignId: 101, text: 'free', matchType: 'EXACT', status: 'ENABLED'},
    update: {status: 'PAUSED'},
  },
  {
    kind: 'shared_budget',
    collection: 'shared-budgets',
    sdk: 'sharedBudgets',
    create: {
      name: 'App portfolio',
      startTime: '2026-09-20T00:00:00Z',
      endTime: '2026-10-20T00:00:00Z',
      value: {amount: '100.00', currency: 'USD'},
      adAccountIds: [77, 88],
      invoiceDetail: {
        primaryBuyerName: 'Synthetic buyer',
        primaryBuyerEmail: 'buyer@example.test',
        billingEmail: 'billing@example.test',
      },
    },
    update: {name: 'Renamed portfolio', value: {amount: '110.00', currency: 'USD'}},
  },
] as const;
type Scenario = (typeof cases)[number];
function fixture(s: Scenario = cases[0]) {
  const store = new Store(':memory:', Buffer.alloc(32, 80).toString('base64')),
    calls: JsonObject[] = [],
    records = new Map<string, JsonObject>();
  const connection = {
      id: 'apple',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['77', '88', '99'],
      writeAccounts: ['77', '88', '99'],
      enabled: true,
      label: 'Synthetic Apple',
      scopes: ['searchadsorg'],
    },
    credentials = {accessToken: 'synthetic'};
  store.putConnection(owner, connection, credentials);
  for (const account of [77, 88, 99])
    records.set('/v1/ad-accounts/' + account, {id: account, orgId: 5, name: 'Synthetic ' + account, currency: 'USD'});
  records.set('/v1/campaigns/101', {
    id: 101,
    adAccountId: 77,
    name: 'App campaign',
    status: 'PAUSED',
    promotedObjectId: '123456789',
    dailyBudget: {amount: '10.00', currency: 'USD'},
  });
  records.set('/v1/adgroups/201', {
    id: 201,
    adAccountId: 77,
    campaignId: 101,
    name: 'Group',
    status: 'PAUSED',
    pricingModel: 'CPT',
  });
  records.set('/v1/creatives/301', {
    id: 301,
    adAccountId: 77,
    name: 'Creative',
    creativeType: 'DEFAULT_PRODUCT_PAGE',
    destination: {destinationType: 'APP_STORE_PRODUCT_PAGE', parameters: {adamId: '123456789'}},
  });
  let writes = 0,
    reads = 0,
    foreign = false,
    lost = false,
    failRead = 0,
    softDelete = false,
    revoke = false,
    wrongParent = false,
    receiptError = false;
  const normalizeMoney = (v: any): any =>
    Array.isArray(v)
      ? v.map(normalizeMoney)
      : v && typeof v === 'object'
        ? {
            ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeMoney(x)])),
            ...(typeof v.amount === 'string' && v.currency == null ? {currency: 'USD'} : {}),
          }
        : v;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (url, init) => {
      const path = new URL(String(url)).pathname,
        method = init!.method!,
        body = init?.body ? JSON.parse(String(init.body)) : undefined,
        headers = new Headers(init?.headers);
      calls.push({path, method, body, headers: Object.fromEntries(headers)});
      if (method === 'GET') {
        reads++;
        if (revoke) store.putConnection(owner, {...connection, writeAccounts: ['77']}, credentials);
        if (failRead) return Response.json({error: {code: failRead}}, {status: failRead});
        const row = records.get(path);
        return row
          ? Response.json({
              result: {
                ...row,
                systemStatus: reads % 2 ? 'PROCESSING' : 'RUNNING',
                displayStatus: String(reads),
                modificationTime: String(reads),
              },
              requestId: String(reads),
              futureMeter: reads * 7,
            })
          : Response.json({error: {code: 404}}, {status: 404});
      }
      writes++;
      assert.ok(path.startsWith('/v1/' + s.collection));
      const id = method === 'POST' ? 900 : Number(path.split('/').at(-1)),
        target = '/v1/' + s.collection + '/' + id;
      if (method === 'DELETE') {
        if (softDelete) records.get(target)!.deleted = true;
        else records.delete(target);
        return Response.json({result: null});
      }
      const before = records.get(target) ?? {},
        row = normalizeMoney({
          ...before,
          ...body,
          id,
          ...(s.kind === 'shared_budget' ? {orgId: 5} : {adAccountId: 77}),
          deleted: false,
        });
      records.set(target, row);
      if (lost) throw Error('Synthetic lost response after accepted mutation');
      return Response.json({
        result: {
          ...row,
          ...(foreign ? (s.kind === 'shared_budget' ? {orgId: 999} : {adAccountId: 999}) : {}),
          ...(wrongParent ? {adGroupId: 999, campaignId: 999, creativeId: 999} : {}),
        },
        ...(receiptError ? {error: {code: 'INVALID', message: 'Synthetic provider failure'}} : {}),
      });
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const prepare = (verb = 'create', payload: JsonObject = s.create) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: 'apple_ads_v1_' + s.kind + '_' + verb,
          account_id: '77',
          ...(verb === 'create' ? {} : {path_params: {id: '900'}}),
          ...(verb === 'delete' ? {} : {payload}),
        },
      },
      actor,
    );
  const execute = (p: JsonObject, extra: JsonObject = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = (p: JsonObject) =>
    service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {
    store,
    service,
    calls,
    records,
    connection,
    credentials,
    prepare,
    execute,
    verify,
    writes: () => writes,
    reads: () => reads,
    foreign: () => {
      foreign = true;
    },
    lose: () => {
      lost = true;
    },
    badParent: () => {
      wrongParent = true;
    },
    error: () => {
      receiptError = true;
    },
    setReadError: (n: number) => {
      failRead = n;
    },
    softDelete: () => {
      softDelete = true;
    },
    revoke: () => {
      revoke = true;
    },
  };
}

test('every Apple child write uses the exact pinned SDK method and model', () => {
  const evidence = appleModelEvidence();
  assert.equal(evidence.revision, 'f90ac18b616e0ba2bbf2d17d73f54deeb2dd7af1');
  assert.equal(Object.keys(evidence.models).length, 82);
  for (const row of cases)
    for (const [verb, suffix, method] of [
      ['create', 'Post', 'POST'],
      ['update', 'IdPut', 'PUT'],
      ['delete', 'IdDelete', 'DELETE'],
    ]) {
      const native = appleActions.find(a => a.name === 'apple_ads_v1_' + row.kind + '_' + verb)!;
      assert.ok(native);
      assert.equal(native.method, method);
      assert.equal(native.path, 'https://api.ads.apple.com' + evidence.methods[row.sdk + suffix].path);
      assert.equal(
        evidence.methods[row.sdk + suffix].account_context,
        row.kind === 'shared_budget' ? 'none' : 'required',
      );
    }
});
for (const row of cases)
  test('Apple ' + row.kind + ' create, update, read-back, replay and removal lifecycle', async () => {
    const f = fixture(row);
    try {
      const p = await f.prepare();
      assert.equal(p.success, true, JSON.stringify(p));
      assert.equal(f.writes(), 0);
      if (row.kind === 'shared_budget')
        assert.deepEqual(p.data.request.scopeContext.appleSharedAccountIds, ['77', '88']);
      const result = await f.execute(p);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal((await f.verify(p)).data.status, 'verified');
      assert.equal((await f.execute(p)).data.replayed, true);
      assert.equal(f.writes(), 1);
      const update = await f.prepare('update', row.update);
      assert.equal(update.success, true, JSON.stringify(update));
      assert.equal((await f.execute(update)).success, true);
      const checked = await f.verify(update);
      assert.equal(checked.data.status, 'verified', JSON.stringify(checked));
      const remove = await f.prepare('delete');
      assert.equal(remove.success, true, JSON.stringify(remove));
      assert.equal((await f.execute(remove)).success, true);
      assert.equal((await f.verify(remove)).data.status, 'verified');
      assert.equal(f.writes(), 3);
      for (const call of f.calls) {
        if (row.kind === 'shared_budget' && call.method !== 'GET')
          assert.equal(call.headers['x-ap-context'], undefined);
        else
          assert.equal(
            call.headers['x-ap-context'],
            'adAccountId=' + (call.path.startsWith('/v1/ad-accounts/') ? call.path.split('/').at(-1) : '77') + ';',
          );
      }
    } finally {
      f.store.close();
    }
  });
test('native schemas reject unknown fields, bad enums, IDs, money, parents and unpaused creation before egress', async () => {
  const inputs: [Scenario, JsonObject][] = [
    [cases[0], {...cases[0].create, status: 'ENABLED'}],
    [cases[0], {...cases[0].create, pricingModel: 'CPC'}],
    [cases[0], {...cases[0].create, campaignId: '101'}],
    [cases[0], {...cases[0].create, targeting: {invented: {include: ['US']}}}],
    [cases[1], {...cases[1].create, adAccountId: 999}],
    [cases[3], {...cases[3].create, bid: {amount: 1.5}}],
    [cases[3], {...cases[3].create, bid: {amount: '1.001'}}],
    [cases[3], {...cases[3].create, matchType: 'INVENTED_MATCH_TYPE'}],
    [cases[4], {...cases[4].create, adGroupId: 201}],
    [cases[5], {...cases[5].create, adAccountIds: [77, 77]}],
    [cases[5], {...cases[5].create, adAccountIds: [88]}],
    [cases[5], {...cases[5].create, invoiceDetail: {primaryBuyerName: 'No emails'}}],
    [cases[5], {...cases[5].create, endTime: '2026-01-01T00:00:00Z'}],
  ];
  for (const [row, payload] of inputs) {
    const f = fixture(row);
    try {
      const p = await f.prepare('create', payload);
      assert.equal(p.success, false, JSON.stringify(payload));
      assert.equal(f.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('updates cannot reparent an ad, creative, keyword or ad group', async () => {
  for (const [row, fields] of [
    [cases[0], {campaignId: 999}],
    [cases[1], {creativeId: 999}],
    [cases[2], {destination: {destinationType: 'LOCAL_ADS_PLACECARD'}}],
    [cases[3], {text: 'different'}],
  ] as [Scenario, JsonObject][]) {
    const f = fixture(row);
    try {
      assert.equal((await f.prepare('update', fields)).success, false);
      assert.equal(f.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('parent/account identity, currency and same-organization requirements fail closed', async () => {
  for (const [row, path, change, code] of [
    [cases[0], '/v1/campaigns/101', {adAccountId: 999}, 'STATE_TARGET_MISMATCH'],
    [cases[0], '/v1/campaigns/101', {deleted: true}, 'STATE_TARGET_DELETED'],
    [cases[3], '/v1/ad-accounts/77', {currency: 'EUR'}, 'CURRENCY_MISMATCH'],
    [cases[5], '/v1/ad-accounts/88', {orgId: 6}, 'STATE_ORGANIZATION_MISMATCH'],
    [cases[5], '/v1/ad-accounts/88', {currency: 'EUR'}, 'STATE_CURRENCY_REQUIRED'],
  ] as [Scenario, string, JsonObject, string][]) {
    const f = fixture(row);
    try {
      Object.assign(f.records.get(path)!, change);
      const p = await f.prepare();
      assert.equal(p.error.code, code, JSON.stringify(p));
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('real parent changes conflict but Apple telemetry and processing observations do not', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true);
    f.records.get('/v1/campaigns/101')!.dailyBudget.amount = '20.00';
    const e = await f.execute(p);
    assert.equal(e.error.code, 'STATE_CHANGED');
    assert.ok(JSON.stringify(e.error.details.changed_fields).includes('dailyBudget'));
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('shared budgets discover old membership and require every old and new account grant', async () => {
  const f = fixture(cases[5]);
  try {
    f.records.set('/v1/shared-budgets/900', {...cases[5].create, id: 900, orgId: 5, adAccountIds: [77, 99]});
    f.store.putConnection(owner, {...f.connection, writeAccounts: ['77', '88']}, f.credentials);
    assert.equal((await f.prepare('update', {adAccountIds: [77, 88]})).error.code, 'WRITE_ACCOUNT_FORBIDDEN');
    assert.equal(f.writes(), 0);
    f.store.putConnection(owner, f.connection, f.credentials);
    const p = await f.prepare('update', {adAccountIds: [77, 88]});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(p.data.request.scopeContext.appleSharedAccountIds, ['77', '88', '99']);
    f.store.putConnection(owner, {...f.connection, writeAccounts: ['77', '88']}, f.credentials);
    assert.equal((await f.execute(p)).error.code, 'WRITE_ACCOUNT_FORBIDDEN');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('revocation during a shared state read prevents preparing or executing the mutation', async () => {
  const f = fixture(cases[5]);
  try {
    f.revoke();
    const p = await f.prepare();
    assert.equal(p.error.code, 'WRITE_ACCOUNT_FORBIDDEN');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('every shared account policy constrains amount, percentage and cumulative native budget increases', async () => {
  const f = fixture(cases[5]);
  try {
    f.records.set('/v1/shared-budgets/900', {...cases[5].create, id: 900, orgId: 5});
    for (const id of ['77', '88'])
      saveSpendPolicy(f.store, owner, {
        confirmed: true,
        gateway,
        account_id: id,
        policy: {
          allow_activation: true,
          allow_deletion: false,
          max_budget_native: id === '88' ? 105 : 500,
          max_budget_increase_percent: 10,
          max_daily_increase_native: 10,
        },
      });
    assert.equal(
      (await f.prepare('update', {value: {amount: '110.00', currency: 'USD'}})).error.code,
      'POLICY_BUDGET_LIMIT',
    );
    saveSpendPolicy(f.store, owner, {
      confirmed: true,
      gateway,
      account_id: '88',
      policy: {
        allow_activation: true,
        allow_deletion: false,
        max_budget_native: 500,
        max_budget_increase_percent: 10,
        max_daily_increase_native: 10,
      },
    });
    assert.equal(
      (await f.prepare('update', {value: {amount: '111.00', currency: 'USD'}})).error.code,
      'POLICY_INCREASE_LIMIT',
    );
    const p = await f.prepare('update', {value: {amount: '110.00', currency: 'USD'}});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p)).success, true);
    const rows = f.store.db.prepare("SELECT data FROM documents WHERE kind='spend_reservation'").all() as JsonObject[];
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => JSON.parse(r.data).increase_native === 10));
    assert.equal(
      (await f.prepare('update', {value: {amount: '111.00', currency: 'USD'}})).error.code,
      'POLICY_DAILY_INCREASE_LIMIT',
    );
    assert.equal((await f.prepare('delete')).error.code, 'POLICY_DELETION_FORBIDDEN');
  } finally {
    f.store.close();
  }
});
test('budget policy reservations are atomic across all shared accounts', async () => {
  const f = fixture(cases[5]);
  try {
    for (const id of ['77', '88'])
      saveSpendPolicy(f.store, owner, {
        confirmed: true,
        gateway,
        account_id: id,
        policy: {allow_activation: true, max_daily_increase_native: 500},
      });
    const p = await f.prepare();
    assert.equal(p.success, true);
    saveSpendPolicy(f.store, owner, {
      confirmed: true,
      gateway,
      account_id: '88',
      policy: {allow_activation: true, max_daily_increase_native: 50},
    });
    assert.equal((await f.execute(p)).error.code, 'POLICY_DAILY_INCREASE_LIMIT');
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='spend_reservation'").get()!.n, 0);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('receipts must identify the account, parent and organization; HTTP 200 errors remain failures', async () => {
  for (const mode of ['foreign', 'parent', 'error'] as const)
    for (const row of [cases[1], cases[5]]) {
      if (mode === 'parent' && row.kind === 'shared_budget') continue;
      const f = fixture(row);
      try {
        const p = await f.prepare();
        assert.equal(p.success, true);
        if (mode === 'foreign') f.foreign();
        else if (mode === 'parent') f.badParent();
        else f.error();
        const out = await f.execute(p);
        assert.equal(out.success, false, JSON.stringify(out));
        assert.equal(f.writes(), 1);
        const again = await f.execute(p);
        if (mode === 'error') assert.equal(again.error.code, 'WRITE_OUTCOME_UNCERTAIN');
        else assert.equal(again.data.replayed, true);
        assert.equal(f.writes(), 1);
      } finally {
        f.store.close();
      }
    }
});
test('a shared budget requires explicit spend acknowledgement and cannot bypass an owner activation ban', async () => {
  const f = fixture(cases[5]);
  try {
    const p = await f.prepare();
    assert.equal(p.success, true);
    assert.equal((await f.execute(p, {spend_change_confirmed: false})).error.code, 'SPEND_CONFIRMATION_REQUIRED');
    saveSpendPolicy(f.store, owner, {confirmed: true, gateway, account_id: '88', policy: {allow_activation: false}});
    assert.equal((await f.execute(p)).error.code, 'POLICY_ACTIVATION_FORBIDDEN');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('concurrent executions issue one mutation and a lost response never authorizes a retry', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    const result = await Promise.all([f.execute(p), f.execute(p)]);
    assert.ok(result.some(r => r.success));
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    const p = await g.prepare();
    g.lose();
    assert.equal((await g.execute(p)).success, false);
    assert.equal((await g.execute(p)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(g.writes(), 1);
  } finally {
    g.store.close();
  }
});
test('soft deletion verifies exact deleted state; permission failures never prove deletion', async () => {
  for (const denied of [false, true]) {
    const f = fixture(cases[3]);
    try {
      const p = await f.prepare();
      assert.equal((await f.execute(p)).success, true);
      const remove = await f.prepare('delete');
      f.softDelete();
      assert.equal((await f.execute(remove)).success, true);
      if (denied) f.setReadError(403);
      const v = await f.verify(remove);
      assert.equal(v.data.status, denied ? 'unverified' : 'verified');
      assert.equal(f.writes(), 2);
    } finally {
      f.store.close();
    }
  }
});
test('omitted currency uses the frozen account currency and verification does not replay writes', async () => {
  const f = fixture(cases[3]);
  try {
    const p = await f.prepare('create', {...cases[3].create, bid: {amount: '1.50'}});
    assert.equal(p.success, true);
    assert.equal((await f.execute(p)).success, true);
    assert.equal((await f.verify(p)).data.status, 'verified');
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
