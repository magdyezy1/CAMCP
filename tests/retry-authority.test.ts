import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, Connection, JsonObject} from '../src/types.js';
const registry = new Registry(),
  owner: Actor = {tenantId: 'retry-authority', userId: 'owner', role: 'admin'},
  id = '336ecb51-2df8-4967-8bd3-cba64d552296';
const cases: [string, string, string[], string, JsonObject][] = [
  [
    'GA4 sync',
    'ga4_native_action',
    ['https://www.googleapis.com/auth/analytics.readonly'],
    'ga4_native_action',
    {operation: 'ga4_sync_properties', arguments: {connection_id: id, dry_run: false}},
  ],
  [
    'Search Console sync',
    'google_search_console_native_action',
    ['https://www.googleapis.com/auth/webmasters.readonly'],
    'google_search_console_native_action',
    {operation: 'gsc_connection_ops', arguments: {action: 'sync_sites', connection_id: id, dry_run: false}},
  ],
  [
    'native Meta read',
    'meta_native_action',
    ['ads_management'],
    'meta_native_action',
    {action: 'meta_ad_account_id_campaigns_get', account_id: '123', connection_id: id, dry_run: false},
  ],
  [
    'Meta post discovery',
    'meta_native_action',
    ['ads_management', 'pages_show_list', 'pages_read_engagement'],
    'amcp_native_action',
    {
      operation: 'fetch_meta_existing_posts',
      arguments: {action: 'GET_PAGE_POSTS', account_id: '123', page_id: '77', connection_id: id},
    },
  ],
  [
    'review preparation',
    'meta_native_action',
    ['ads_management'],
    'amcp_write',
    {
      action: 'prepare',
      gateway: 'meta_native_action',
      connection_id: id,
      arguments: {
        action: 'meta_campaign_create',
        account_id: '123',
        payload: {
          name: 'Synthetic paused draft',
          status: 'PAUSED',
          objective: 'OUTCOME_TRAFFIC',
          special_ad_categories: [],
        },
      },
    },
  ],
  [
    'Meta public archive',
    'meta_native_action',
    ['ads_read'],
    'amcp_native_action',
    {operation: 'search_ads_library', arguments: {search_term: 'Synthetic', country: 'US', limit: 1}},
  ],
  [
    'GTM diagnostics',
    'gtm_native_action',
    ['https://www.googleapis.com/auth/tagmanager.readonly'],
    'gtm_native_action',
    {operation: 'gtm_audit_ops', arguments: {connection_id: id, account_id: '123'}},
  ],
  [
    'readiness',
    'meta_native_action',
    ['ads_management'],
    'amcp_workspace',
    {action: 'check', connection_id: id, account_id: '123', live: true},
  ],
];
for (const [name, gateway, scopes, tool, input] of cases)
  test(name + ' rechecks actor before retry', async () => {
    const store = new Store(':memory:', Buffer.alloc(32, 39).toString('base64'));
    try {
      store.putConnection(
        owner,
        {
          id,
          tenantId: owner.tenantId,
          gateway,
          label: 'Synthetic',
          enabled: true,
          scopes,
          accounts: ['123'],
          writeAccounts: ['123'],
        },
        {accessToken: 'synthetic'},
      );
      const key = store.createKey(owner),
        actor = store.authenticate(key);
      let calls = 0;
      const transport = new NativeTransport(
          async () => {
            calls++;
            if (calls === 1) {
              store.revokeKey(key);
              return Response.json({}, {status: 503});
            }
            return Response.json({data: [], accountSummaries: [], siteEntry: [], id: 'act_123', currency: 'USD'});
          },
          async () => {},
        ),
        service = new MirrorService(registry, store, transport, undefined, {
          allowWrites: true,
          requireBeforeState: true,
          maxBudgetChange: 0.2,
        });
      const r = await service.call(tool, input, actor);
      assert.equal(r.success, false, JSON.stringify(r));
      assert.equal(calls, 1, 'Revoked actors must not send a second HTTP attempt');
    } finally {
      store.close();
    }
  });

const policy = {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0.2};
const metaConnection: Connection = {
  id,
  tenantId: owner.tenantId,
  gateway: 'meta_native_action',
  label: 'Synthetic',
  enabled: true,
  accounts: ['123'],
  writeAccounts: ['123'],
  scopes: ['ads_management'],
};
const readInput = {action: 'meta_ad_account_id_campaigns_get', account_id: '123', connection_id: id, dry_run: false};
function readFixture(change: (s: Store, c: Connection) => void, retry = true) {
  const store = new Store(':memory:', Buffer.alloc(32, 39).toString('base64'));
  store.putConnection(owner, metaConnection, {accessToken: 'synthetic'});
  let calls = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(
      async () => {
        if (++calls === 1) {
          change(store, metaConnection);
          return Response.json({data: []}, {status: retry ? 503 : 200});
        }
        return Response.json({data: []});
      },
      async () => {},
    ),
  );
  return {store, service, count: () => calls, call: () => service.call('meta_native_action', readInput, owner)};
}
for (const mode of ['replace', 'remove', 'grant', 'scope'] as const)
  for (const retry of [true, false])
    test('native reads withhold ' + mode + ' changes ' + (retry ? 'before retry' : 'after response'), async () => {
      const f = readFixture((s, c) => {
        if (mode === 'remove')
          s.db.prepare('DELETE FROM connections WHERE tenant_id=? AND id=?').run(owner.tenantId, id);
        else
          s.putConnection(
            owner,
            {
              ...c,
              ...(mode === 'grant' ? {accounts: [], writeAccounts: []} : {}),
              ...(mode === 'scope' ? {scopes: []} : {}),
            },
            {accessToken: mode === 'replace' ? 'replacement' : 'synthetic'},
          );
      }, retry);
      try {
        const r = await f.call();
        assert.equal(r.success, false, JSON.stringify(r));
        if (mode === 'scope') assert.equal(r.error?.code, 'INSUFFICIENT_SCOPE');
        assert.equal(f.count(), 1);
        assert.equal(JSON.stringify(r).includes('replacement'), false);
      } finally {
        f.store.close();
      }
    });

test('unrelated label edits and added account grants do not invalidate a valid read retry', async () => {
  const f = readFixture((s, c) =>
    s.putConnection(owner, {...c, label: 'Renamed', accounts: ['123', '456']}, {accessToken: 'synthetic'}),
  );
  try {
    assert.equal((await f.call()).success, true);
    assert.equal(f.count(), 2);
  } finally {
    f.store.close();
  }
});

test('revocation during provider pacing prevents the first native HTTP attempt', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 39).toString('base64'));
  try {
    store.putConnection(owner, metaConnection, {accessToken: 'synthetic'});
    const key = store.createKey(owner),
      actor = store.authenticate(key);
    let calls = 0,
      waits = 0;
    const transport = new NativeTransport(
        async () => {
          calls++;
          return Response.json({data: []});
        },
        async () => {
          waits++;
          store.revokeKey(key);
        },
        30000,
        8 * 1024 * 1024,
        0,
        250,
        2000,
      ),
      service = new MirrorService(registry, store, transport);
    assert.equal((await service.call('meta_native_action', readInput, actor)).success, false);
    assert.equal(waits, 1);
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});

test('login replacement while credentials resolve cannot send the old native token', async t => {
  const f = readFixture(() => {});
  try {
    t.mock.method(f.service.credentials, 'get', async () => {
      f.store.putConnection(owner, metaConnection, {accessToken: 'replacement'});
      return {accessToken: 'synthetic'};
    });
    const r = await f.call();
    assert.equal(r.error?.code, 'REAUTHORIZATION_REQUIRED');
    assert.equal(f.count(), 0);
  } finally {
    f.store.close();
  }
});

test('review preparation stops its retry if write grants or its login change', async () => {
  for (const change of ['grant', 'login']) {
    const store = new Store(':memory:', Buffer.alloc(32, 39).toString('base64'));
    try {
      store.putConnection(owner, metaConnection, {accessToken: 'synthetic'});
      let calls = 0;
      const service = new MirrorService(
        registry,
        store,
        new NativeTransport(
          async () => {
            if (++calls === 1) {
              store.putConnection(
                owner,
                {...metaConnection, writeAccounts: change === 'grant' ? [] : ['123']},
                {accessToken: change === 'login' ? 'replacement' : 'synthetic'},
              );
              return Response.json({}, {status: 503});
            }
            return Response.json({id: 'act_123', currency: 'USD', account_status: 1});
          },
          async () => {},
        ),
        undefined,
        policy,
      );
      const r = await service.call('amcp_write', cases[4]![4], owner);
      assert.equal(r.success, false);
      assert.equal(calls, 1);
      assert.equal(store.documents(owner.tenantId, 'write_review').length, 0);
    } finally {
      store.close();
    }
  }
});

test('revocation during pacing before a reviewed mutation prevents mutation dispatch', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 39).toString('base64'));
  try {
    store.putConnection(owner, metaConnection, {accessToken: 'synthetic'});
    const key = store.createKey(owner),
      actor = store.authenticate(key);
    let writes = 0,
      waits = 0;
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(
        async (_u, i) => {
          if (i!.method === 'POST') {
            writes++;
            return Response.json({id: '111'});
          }
          return Response.json({id: 'act_123', currency: 'USD', account_status: 1});
        },
        async () => {
          waits++;
          store.revokeKey(key);
        },
        30000,
        8 * 1024 * 1024,
        2,
        60000,
        60000,
      ),
      undefined,
      policy,
    );
    const p = await service.call('amcp_write', cases[4]![4], actor);
    assert.equal(p.success, true, JSON.stringify(p));
    const r = await service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
      },
      actor,
    );
    assert.equal(r.success, false);
    assert.equal(waits, 1);
    assert.equal(writes, 0);
  } finally {
    store.close();
  }
});

test('accepted mutations retain a completed receipt before revoked callers are denied delivery', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 39).toString('base64'));
  try {
    store.putConnection(owner, metaConnection, {accessToken: 'synthetic'});
    const key = store.createKey(owner),
      actor = store.authenticate(key);
    let writes = 0;
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(
        async (_u, i) => {
          if (i!.method === 'POST') {
            writes++;
            store.revokeKey(key);
            return Response.json({id: '111'});
          }
          return Response.json({id: 'act_123', currency: 'USD', account_status: 1});
        },
        async () => {},
      ),
      undefined,
      policy,
    );
    const p = await service.call('amcp_write', cases[4]![4], actor);
    assert.equal(p.success, true, JSON.stringify(p));
    const execution = {
      action: 'execute',
      review_id: p.data.review_id,
      idempotency_key: p.data.idempotency_key,
      confirmed: true,
      spend_change_confirmed: true,
    };
    assert.equal((await service.call('amcp_write', execution, actor)).success, false);
    const receipt = store.db
      .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
      .get(owner.tenantId, p.data.idempotency_key) as JsonObject;
    assert.equal(receipt.state, 'complete');
    assert.equal(JSON.parse(receipt.result).success, true);
    assert.equal(writes, 1);
    assert.equal((await service.call('amcp_write', execution, actor)).success, false);
    assert.equal(writes, 1);
  } finally {
    store.close();
  }
});

test('write read-back rechecks authority before retry and retains the accepted write receipt', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 39).toString('base64'));
  try {
    store.putConnection(owner, metaConnection, {accessToken: 'synthetic'});
    const key = store.createKey(owner),
      actor = store.authenticate(key);
    let verifying = false,
      reads = 0,
      writes = 0;
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(
        async (_u, i) => {
          if (i!.method === 'POST') {
            writes++;
            return Response.json({id: '111'});
          }
          if (verifying) {
            reads++;
            store.revokeKey(key);
            return Response.json({}, {status: 503});
          }
          return Response.json({id: 'act_123', currency: 'USD', account_status: 1});
        },
        async () => {},
      ),
      undefined,
      policy,
    );
    const p = await service.call('amcp_write', cases[4]![4], actor);
    assert.equal(p.success, true);
    assert.equal(
      (
        await service.call(
          'amcp_write',
          {
            action: 'execute',
            review_id: p.data.review_id,
            idempotency_key: p.data.idempotency_key,
            confirmed: true,
            spend_change_confirmed: true,
          },
          actor,
        )
      ).success,
      true,
    );
    verifying = true;
    await assert.rejects(service.verifyWrite(actor, p.data.review_id));
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    assert.equal(
      (
        store.db
          .prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?')
          .get(owner.tenantId, p.data.idempotency_key) as JsonObject
      ).state,
      'complete',
    );
  } finally {
    store.close();
  }
});

test('media preparation cannot retry an account read after the actor is revoked', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 39).toString('base64'));
  try {
    store.putConnection(owner, metaConnection, {accessToken: 'synthetic'});
    const key = store.createKey(owner),
      actor = store.authenticate(key);
    let calls = 0,
      downloads = 0;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(
        async () => {
          calls++;
          store.revokeKey(key);
          return Response.json({}, {status: 503});
        },
        async () => {},
      ),
      undefined,
      policy,
      async () => {
        downloads++;
        return new Response(png, {headers: {'content-type': 'image/png', 'content-length': String(png.length)}});
      },
    );
    const r = await service.call(
      'amcp_media',
      {
        action: 'prepare',
        platform: 'meta',
        connection_id: id,
        account_id: '123',
        drive_url: 'https://drive.google.com/file/d/abcdefghijklmno/view?usp=sharing',
        name: 'Synthetic',
      },
      actor,
    );
    assert.equal(r.success, false);
    assert.equal(calls, 1);
    assert.equal(downloads, 1);
    assert.equal(store.documents(owner.tenantId, 'media_review').length, 0);
  } finally {
    store.close();
  }
});

test('provider validate-only rechecks authorization after native pacing without sending a mutation', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 39).toString('base64'));
  try {
    const c = {
      ...metaConnection,
      gateway: 'google_ads_native_action',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    };
    store.putConnection(owner, c, {accessToken: 'synthetic'});
    const key = store.createKey(owner),
      actor = store.authenticate(key);
    let calls = 0,
      waits = 0;
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(
        async () => {
          calls++;
          return Response.json({results: []});
        },
        async () => {
          waits++;
          store.revokeKey(key);
        },
        30000,
        8 * 1024 * 1024,
        0,
        250,
        2000,
      ),
      undefined,
      policy,
    );
    const r = await service.call(
      'amcp_campaign',
      {
        action: 'validate_provider',
        gateway: 'google_ads_native_action',
        connection_id: id,
        arguments: {
          action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
          account_id: '123',
          payload: {operations: [{create: {name: 'Synthetic', amount_micros: '1000000', delivery_method: 'STANDARD'}}]},
        },
      },
      actor,
    );
    assert.equal(r.success, false);
    assert.equal(waits, 1);
    assert.equal(calls, 0);
    assert.equal(store.documents(owner.tenantId, 'provider_validation').length, 0);
  } finally {
    store.close();
  }
});
