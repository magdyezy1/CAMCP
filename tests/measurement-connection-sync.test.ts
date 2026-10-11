import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, Connection, JsonObject} from '../src/types.js';
import {AssetDiscovery} from '../server/asset-discovery.js';
import {collectMeasurementAssets} from '../src/google-measurement-assets.js';
import {actionContracts} from '../src/action-contracts.js';
import {MirrorError} from '../src/errors.js';
import {readFileSync, mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {removeTestDirectory} from './temp.js';
import {assertRefused} from './helpers/assert-refused.js';

const registry = new Registry(),
  owner = {tenantId: 'measurement-sync', userId: 'owner', role: 'admin' as const},
  id = '336ecb51-2df8-4967-8bd3-cba64d552296',
  key = Buffer.alloc(32, 72).toString('base64');
const cases = [
  ['ga4_native_action', 'ga4_sync_properties', {}],
  ['google_search_console_native_action', 'gsc_connection_ops', {action: 'sync_sites'}],
] as const;
function fixture(index = 0, file = ':memory:') {
  const [gateway, operation, args] = cases[index]!,
    store = new Store(file, key),
    c: Connection = {
      id,
      tenantId: owner.tenantId,
      gateway,
      label: 'Synthetic login',
      accounts: [index ? 'https://example.com/' : '123'],
      writeAccounts: [],
      enabled: true,
      scopes: [
        index
          ? 'https://www.googleapis.com/auth/webmasters.readonly'
          : 'https://www.googleapis.com/auth/analytics.readonly',
      ],
    };
  store.putConnection(owner, c, {accessToken: 'synthetic'});
  const calls: {url: URL; init: RequestInit | undefined}[] = [];
  let hook: ((u: URL, i: RequestInit | undefined) => Response | Promise<Response>) | undefined;
  const fetcher: typeof fetch = async (u, i) => {
    const url = new URL(String(u));
    calls.push({url, init: i});
    return hook
      ? hook(url, i)
      : Response.json(
          index
            ? {siteEntry: [{siteUrl: 'https://example.com/', permissionLevel: 'siteOwner'}]}
            : {
                accountSummaries: [
                  {
                    account: 'accounts/1',
                    propertySummaries: [{property: 'properties/123', displayName: 'Synthetic property'}],
                  },
                ],
              },
        );
  };
  const service = new MirrorService(registry, store, new NativeTransport(fetcher), undefined, {
    allowWrites: false,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  return {
    store,
    c,
    calls,
    service,
    fetcher,
    hook: (h: typeof hook) => (hook = h),
    call: (extra: JsonObject = {}, actor: Actor = owner) =>
      service.call(gateway, {operation, arguments: {...args, connection_id: id, dry_run: false, ...extra}}, actor),
  };
}
for (let i = 0; i < cases.length; i++)
  test(cases[i]![0] + ' exposes native discovery as a persisted connection sync', async () => {
    const f = fixture(i);
    try {
      const result = await f.call();
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.data.complete, true);
      assert.equal(result.data.assets.length, 1);
      assert.equal(f.store.document(owner.tenantId, 'website_assets', id).groups[0].complete, true);
      assert.deepEqual(f.store.listConnections(owner.tenantId)[0]!.accounts, f.c.accounts);
      assert.deepEqual(f.store.listConnections(owner.tenantId)[0]!.writeAccounts, []);
      assert.equal(f.calls.length, 1);
      assert.ok(f.calls.every(c => c.init?.method === 'GET' && c.init.redirect === 'error'));
    } finally {
      f.store.close();
    }
  });

test('sync preview is the default and neither reads credentials nor makes network or database changes', async () => {
  for (let i = 0; i < 2; i++) {
    const f = fixture(i),
      spy = mock.method(f.store, 'credentials', () => {
        throw Error('No preview credentials');
      });
    try {
      for (const dry_run of [undefined, true]) {
        const r = await f.call({dry_run});
        assert.equal(r.success, true, JSON.stringify(r));
        assert.equal(r.data.executed, false);
        assert.equal(r.data.next_call.arguments.arguments.dry_run, false);
      }
      assert.equal(spy.mock.callCount(), 0);
      assert.equal(f.calls.length, 0);
      assert.equal(f.store.documents(owner.tenantId, 'website_assets').length, 0);
    } finally {
      spy.mock.restore();
      f.store.close();
    }
  }
});

test('reader/operator roles, missing scopes and unknown connection IDs stop before egress', async () => {
  const f = fixture();
  try {
    for (const role of ['reader', 'operator'] as const) {
      const r = await f.call({}, {...owner, role});
      assert.equal(r.error?.code, 'FORBIDDEN');
    }
    assert.equal(
      (await f.call({connection_id: 'b9a767a2-e9a5-4863-9806-05a459367597'})).error?.code,
      'CONNECTION_NOT_FOUND',
    );
    f.store.putConnection(owner, {...f.c, scopes: []}, {accessToken: 'synthetic'});
    assert.equal((await f.call()).error?.code, 'INSUFFICIENT_SCOPE');
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('identity selection uses an explicit UUID or sole/default login, never another tenant', async () => {
  const f = fixture(),
    other = 'b9a767a2-e9a5-4863-9806-05a459367597';
  try {
    f.store.putConnection(owner, {...f.c, id: other}, {accessToken: 'other-synthetic'});
    assert.equal((await f.call({connection_id: undefined})).error?.code, 'AMBIGUOUS_CONNECTION');
    f.store.putConnection(owner, {...f.c, isDefault: true}, {accessToken: 'synthetic'});
    assert.equal((await f.call({connection_id: undefined})).data?.connection_id, id);
    const tenant = {...owner, tenantId: 'other-tenant'};
    assert.equal((await f.call({}, tenant)).error?.code, 'CONNECTION_NOT_FOUND');
    assert.equal(f.calls.length, 1);
  } finally {
    f.store.close();
  }
});

test('GA4 paginated summaries and optional details preserve exact IDs, currency and reporting timezone', async () => {
  const f = fixture();
  try {
    f.hook(url => {
      if (url.pathname.endsWith('/properties/123'))
        return Response.json({
          name: 'properties/123',
          account: 'accounts/1',
          displayName: 'Property <script>data</script>',
          currencyCode: 'EGP',
          timeZone: 'Africa/Cairo',
        });
      if (url.pathname.endsWith('/properties/456'))
        return Response.json({
          name: 'properties/456',
          account: 'accounts/2',
          displayName: 'Second',
          timeZone: 'America/New_York',
        });
      return url.searchParams.get('pageToken')
        ? Response.json({
            accountSummaries: [{account: 'accounts/2', propertySummaries: [{property: 'properties/456'}]}],
          })
        : Response.json({
            accountSummaries: [{account: 'accounts/1', propertySummaries: [{property: 'properties/123'}]}],
            nextPageToken: 'page+two/=',
          });
    });
    const r = await f.call({include_details: true, max_pages: 2});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual(
      r.data.assets.map((x: any) => x.id),
      ['123', '456'],
    );
    assert.equal(r.data.assets[0].currency, 'EGP');
    assert.equal(r.data.assets[0].timezone, 'Africa/Cairo');
    assert.equal(r.data.assets[1].currency, undefined);
    assert.match(r.meta.untrusted_provider_content, /data/);
    assert.equal(f.calls[1]!.url.searchParams.get('pageToken'), 'page+two/=');
    assert.ok(f.calls.slice(0, 2).every(x => x.url.searchParams.get('pageSize') === '200'));
    assert.equal(f.calls.length, 4);
    assert.equal(JSON.stringify(f.store.audit(owner.tenantId)).includes('<script>'), false);
  } finally {
    f.store.close();
  }
});

test('Search Console preserves Domain and URL-prefix identities and excludes unverified users explicitly', async () => {
  const f = fixture(1);
  try {
    f.hook(() =>
      Response.json({
        siteEntry: [
          {siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner'},
          {siteUrl: 'https://example.com/path/', permissionLevel: 'siteRestrictedUser'},
          {siteUrl: 'https://unverified.example/', permissionLevel: 'siteUnverifiedUser'},
        ],
      }),
    );
    const r = await f.call();
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual(
      r.data.assets.map((x: any) => x.id),
      ['sc-domain:example.com', 'https://example.com/path/'],
    );
    assert.equal(r.data.excluded_unverified, 1);
    assert.equal(r.data.missing_selected_ids[0], 'https://example.com/');
    assert.deepEqual(f.store.listConnections(owner.tenantId)[0]!.accounts, f.c.accounts);
    assert.equal(f.calls[0]!.url.search, '');
  } finally {
    f.store.close();
  }
});

test('a documented empty collection is complete without removing current selections or manufacturing grants', async () => {
  for (let i = 0; i < 2; i++) {
    const f = fixture(i);
    try {
      f.hook(() => Response.json({}));
      const r = await f.call();
      assert.equal(r.success, true);
      assert.deepEqual(r.data.assets, []);
      assert.equal(r.data.complete, true);
      assert.deepEqual(r.data.missing_selected_ids, f.c.accounts);
      assert.deepEqual(f.store.listConnections(owner.tenantId)[0]!.accounts, f.c.accounts);
    } finally {
      f.store.close();
    }
  }
});

test('distinct paginated properties under one parent are merged, while repeated property records still fail', async () => {
  const f = fixture();
  try {
    f.hook(url =>
      Response.json({
        accountSummaries: [
          {
            account: 'accounts/1',
            propertySummaries: [{property: url.searchParams.has('pageToken') ? 'properties/456' : 'properties/123'}],
          },
        ],
        ...(url.searchParams.has('pageToken') ? {} : {nextPageToken: 'page2'}),
      }),
    );
    const r = await f.call();
    assert.equal(r.success, true);
    assert.deepEqual(
      r.data.assets.map((a: any) => a.id),
      ['123', '456'],
    );
    assert.ok(r.data.assets.every((a: any) => a.parentId === 'accounts/1'));
    f.hook(url =>
      Response.json({
        accountSummaries: [{account: 'accounts/1', propertySummaries: [{property: 'properties/123'}]}],
        ...(url.searchParams.has('pageToken') ? {} : {nextPageToken: 'page2'}),
      }),
    );
    assert.equal((await f.call()).error?.code, 'ASSET_RESPONSE_INVALID');
  } finally {
    f.store.close();
  }
});

test('monotonic deadline and stolen lease cannot publish a discovery response', async () => {
  for (const mode of ['deadline', 'lease']) {
    const f = fixture();
    let time: ReturnType<typeof mock.method> | undefined;
    try {
      f.hook(() => {
        if (mode === 'deadline') {
          const now = performance.now();
          time = mock.method(performance, 'now', () => now + 70000);
        } else f.store.db.prepare("UPDATE service_locks SET owner='new-worker'").run();
        return Response.json({accountSummaries: []});
      });
      const r = await f.call();
      assert.equal(r.error?.code, mode === 'deadline' ? 'ASSET_SYNC_LIMIT' : 'ASSET_SYNC_CHANGED');
      assert.equal(f.store.documents(owner.tenantId, 'website_assets').length, 0);
    } finally {
      time?.mock.restore();
      f.store.close();
    }
  }
});

test('native discovery transport aborts at its server-derived deadline without credentials in the error', async () => {
  let aborted = false;
  const f = fixture();
  try {
    const transport = new NativeTransport(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(Error('private token should not appear'));
            },
            {once: true},
          );
          setTimeout(() => {}, 40);
        }),
      async () => {},
      30000,
    );
    const start = performance.now();
    await assert.rejects(
      collectMeasurementAssets(
        f.c.gateway,
        async p => (await transport.request(p, f.c, {accessToken: 'synthetic'})).data,
        {deadline: performance.now() + 20},
      ),
      (e: any) => !JSON.stringify(e).includes('private token'),
    );
    assert.equal(aborted, true);
    assert.ok(performance.now() - start < 2000);
  } finally {
    f.store.close();
  }
});

test('limited, repeated and malformed GA4 pages retain old rows with visible incomplete status', async () => {
  const responses = [
    {accountSummaries: [], nextPageToken: 'same'},
    {accountSummaries: 'invalid'},
    {unexpected: true},
    {error: {code: 403, message: 'private provider body'}},
  ];
  for (const body of responses) {
    const f = fixture();
    try {
      const prior = {kind: 'properties', assets: [{id: 'old', name: 'Retained'}], complete: true};
      f.store.putDocument(owner.tenantId, 'website_assets', id, {
        groups: [prior],
        selected: ['properties/123'],
        lastSync: 1,
      });
      f.hook(() => Response.json(body));
      const r = await f.call({max_pages: 1});
      assertRefused(r, ['ASSET_SYNC_LIMIT', 'ASSET_RESPONSE_INVALID', 'PLATFORM_ERROR']);
      const saved = f.store.document(owner.tenantId, 'website_assets', id);
      assert.deepEqual(saved.groups[0].assets, prior.assets);
      assert.equal(saved.groups[0].complete, false);
      assert.match(saved.error, /Discovery failed/);
      assert.equal(saved.lastSync, 1);
      assert.equal(saved.error.includes('private provider body'), false);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    f.hook(() => Response.json({nextPageToken: 'same'}));
    assert.equal((await f.call({max_pages: 4})).error?.code, 'ASSET_RESPONSE_INVALID');
    assert.equal(f.calls.length, 2);
  } finally {
    f.store.close();
  }
});

test('wrong or repeated properties and invalid details cannot become successful discovery', async () => {
  const cases = [
    {
      accountSummaries: [
        {account: 'accounts/1', propertySummaries: [{property: 'properties/123'}, {property: 'properties/123'}]},
      ],
    },
    {accountSummaries: [{account: 'accounts/1'}, {account: 'accounts/invalid'}]},
    {accountSummaries: [{account: 'accounts/1', propertySummaries: [{property: '../secret'}]}]},
  ];
  for (const body of cases) {
    const f = fixture();
    try {
      f.hook(() => Response.json(body));
      assertRefused(await f.call(), 'ASSET_RESPONSE_INVALID');
    } finally {
      f.store.close();
    }
  }
  for (const details of [
    {name: 'properties/999', timeZone: 'UTC'},
    {name: 'properties/123', account: 'accounts/999', timeZone: 'UTC'},
    {name: 'properties/123', timeZone: 'Not/AZone'},
    {name: 'properties/123', timeZone: 'UTC', currencyCode: 'unknown'},
  ]) {
    const f = fixture();
    try {
      f.hook(url =>
        Response.json(
          url.pathname.includes('/properties/')
            ? details
            : {accountSummaries: [{account: 'accounts/1', propertySummaries: [{property: 'properties/123'}]}]},
        ),
      );
      assert.equal((await f.call({include_details: true})).error?.code, 'ASSET_RESPONSE_INVALID');
    } finally {
      f.store.close();
    }
  }
});

test('Search Console rejects unexpected paging, duplicate sites, unsafe identities and unknown permissions', async () => {
  for (const body of [
    {siteEntry: [], nextPageToken: 'invented'},
    {siteEntry: [{siteUrl: 'https://example.com/', permissionLevel: 'future-role'}]},
    {siteEntry: [{siteUrl: 'https://u:p@example.com/', permissionLevel: 'siteOwner'}]},
    {siteEntry: [{siteUrl: 'sc-domain:../private', permissionLevel: 'siteOwner'}]},
    {siteEntry: Array(2).fill({siteUrl: 'https://example.com/', permissionLevel: 'siteOwner'})},
  ]) {
    const f = fixture(1);
    try {
      f.hook(() => Response.json(body));
      assert.equal((await f.call()).error?.code, 'ASSET_RESPONSE_INVALID');
    } finally {
      f.store.close();
    }
  }
});

test('revoked credentials or removed connection during a request withhold data and do not overwrite a new login', async () => {
  for (const mode of ['replace', 'remove']) {
    const f = fixture();
    try {
      f.hook(() => {
        if (mode === 'replace') f.store.putConnection(owner, {...f.c, label: 'New login'}, {accessToken: 'new-login'});
        else f.store.db.prepare('DELETE FROM connections WHERE tenant_id=? AND id=?').run(owner.tenantId, id);
        return Response.json({accountSummaries: []});
      });
      const r = await f.call();
      assert.equal(r.error?.code, 'CONNECTION_CHANGED');
      assert.equal(f.store.documents(owner.tenantId, 'website_assets').length, 0);
      if (mode === 'replace') assert.equal(f.store.credentials(owner.tenantId, id).accessToken, 'new-login');
    } finally {
      f.store.close();
    }
  }
});

test('a rejected old refresh cannot write a discovery failure onto the replacement login', async () => {
  const f = fixture(),
    spy = mock.method(f.service.credentials, 'get', async () => {
      f.store.putConnection(owner, {...f.c, label: 'New login'}, {accessToken: 'replacement'});
      throw new MirrorError('CONNECTION_CHANGED', 'Old refresh was fenced.');
    });
  try {
    assert.equal((await f.call()).error?.code, 'CONNECTION_CHANGED');
    assert.equal(f.store.documents(owner.tenantId, 'website_assets').length, 0);
    assert.equal(f.calls.length, 0);
  } finally {
    spy.mock.restore();
    f.store.close();
  }
});

test('in-flight API-key revocation and scope removal stop the next page and metadata persistence', async () => {
  for (const mode of ['key', 'scope']) {
    const f = fixture();
    try {
      const key = f.store.createKey(owner),
        actor = f.store.authenticate(key);
      f.hook(() => {
        if (mode === 'key') f.store.revokeKey(key);
        else f.store.putConnection(owner, {...f.c, scopes: []}, {accessToken: 'synthetic'});
        return Response.json({accountSummaries: [], nextPageToken: 'second'});
      });
      const r = await f.call({}, actor);
      assertRefused(r, ['UNAUTHORIZED', 'INSUFFICIENT_SCOPE']);
      assert.equal(f.calls.length, 1);
      assert.equal(f.store.documents(owner.tenantId, 'website_assets').length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('concurrent metadata selection wins over an older sync', async () => {
  const f = fixture();
  try {
    f.hook(() => {
      f.store.putDocument(owner.tenantId, 'website_assets', id, {
        groups: [],
        selected: ['properties/new-selection'],
        newer: true,
      });
      return Response.json({accountSummaries: []});
    });
    const r = await f.call();
    assert.equal(r.error?.code, 'ASSET_SYNC_CHANGED');
    const saved = f.store.document(owner.tenantId, 'website_assets', id);
    assert.equal(saved.newer, true);
    assert.deepEqual(saved.selected, ['properties/new-selection']);
    assert.deepEqual(saved.groups, []);
  } finally {
    f.store.close();
  }
});

test('a second simultaneous sync stops before egress and the original can finish once', async () => {
  const f = fixture();
  let release!: (r: Response) => void, arrived!: () => void;
  const ready = new Promise<void>(r => (arrived = r));
  try {
    f.hook(() => {
      arrived();
      return new Promise(r => (release = r));
    });
    const first = f.call();
    await ready;
    assert.equal((await f.call()).error?.code, 'ASSET_SYNC_IN_PROGRESS');
    release(Response.json({accountSummaries: []}));
    assert.equal((await first).success, true);
    assert.equal(f.calls.length, 1);
  } finally {
    f.store.close();
  }
});

test('separate SQLite workers share the sync lease and completed metadata survives restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amcp-measurement-sync-')),
    file = join(dir, 'test.sqlite'),
    f = fixture(0, file),
    second = new Store(file, key);
  let release!: (r: Response) => void, arrived!: () => void;
  const ready = new Promise<void>(r => (arrived = r));
  try {
    const service = new MirrorService(
      registry,
      second,
      new NativeTransport(async () => {
        throw Error('Second worker must not send');
      }),
    );
    f.hook(() => {
      arrived();
      return new Promise(r => (release = r));
    });
    const run = f.call();
    await ready;
    const other = await service.call(
      'ga4_native_action',
      {operation: 'ga4_sync_properties', arguments: {connection_id: id, dry_run: false}},
      owner,
    );
    assert.equal(other.error?.code, 'ASSET_SYNC_IN_PROGRESS');
    release(Response.json({accountSummaries: []}));
    assert.equal((await run).success, true);
    const reopened = new Store(file, key);
    try {
      assert.equal(reopened.document(owner.tenantId, 'website_assets', id).groups[0].complete, true);
      assert.deepEqual(reopened.listConnections(owner.tenantId)[0]!.accounts, ['123']);
    } finally {
      reopened.close();
    }
  } finally {
    f.store.close();
    second.close();
    removeTestDirectory(dir, 'amcp-measurement-sync-');
  }
});

test('failed audit persistence rolls back otherwise successful discovery metadata', async () => {
  const f = fixture();
  const original = f.store.appendAudit.bind(f.store),
    spy = mock.method(f.store, 'appendAudit', (tenant: string, request: string, event: unknown) => {
      if ((event as any).event === 'measurement_connection_synced') throw Error('Synthetic audit failure');
      return original(tenant, request, event);
    });
  try {
    const r = await f.call();
    // The injected audit failure is a crash by design, so INTERNAL_ERROR is the expected code; its text stays private.
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'INTERNAL_ERROR');
    assert.doesNotMatch(r.error.message, /Synthetic audit failure/);
    const saved = f.store.document(owner.tenantId, 'website_assets', id);
    assert.equal(saved.groups[0].complete, false);
    assert.deepEqual(saved.groups[0].assets, []);
    assert.equal(saved.lastSync, undefined);
  } finally {
    spy.mock.restore();
    f.store.close();
  }
});

test('sync respects total asset and request bounds without returning partial success', async () => {
  await assert.rejects(
    collectMeasurementAssets('ga4_native_action', async () => ({
      accountSummaries: [
        {
          account: 'accounts/1',
          propertySummaries: Array.from({length: 10001}, (_, i) => ({property: 'properties/' + (i + 1)})),
        },
      ],
    })),
    {code: 'ASSET_SYNC_LIMIT'},
  );
  let calls = 0;
  await assert.rejects(
    collectMeasurementAssets(
      'ga4_native_action',
      async p => {
        calls++;
        return p.path.includes('/properties/')
          ? {name: p.path.slice(8), timeZone: 'UTC'}
          : {
              accountSummaries: [
                {
                  account: 'accounts/1',
                  propertySummaries: Array.from({length: 250}, (_, i) => ({property: 'properties/' + (i + 1)})),
                },
              ],
            };
      },
      {includeDetails: true},
    ),
    {code: 'ASSET_SYNC_LIMIT'},
  );
  assert.equal(calls, 250);
});

test('website and MCP use the same native discovery contract and reject the same malformed pages', async () => {
  for (let i = 0; i < 2; i++) {
    const f = fixture(i);
    try {
      const mcp = await f.call(),
        web = await new AssetDiscovery(f.store, f.fetcher).sync(f.c);
      assert.deepEqual(web.groups[0]!.assets, mcp.data.assets);
      assert.equal(web.groups[0]!.complete, true);
      f.hook(() => Response.json({unexpected: 'not an empty report'}));
      const failed = await new AssetDiscovery(f.store, f.fetcher).sync(f.c);
      assert.equal(failed.groups[0]!.complete, false);
    } finally {
      f.store.close();
    }
  }
});

test('captured schemas reject OAuth/redirect overrides and expose only the two implemented sync workflows', async () => {
  const f = fixture(1);
  try {
    for (const extra of [{code: 'private-code'}, {redirect_uri: 'https://evil.invalid/'}, {force: true}]) {
      const r = await f.call(extra);
      assert.equal(r.error?.code, 'INVALID_ARGUMENT');
    }
    assert.equal(f.calls.length, 0);
    const rows = actionContracts(registry).filter(r =>
      r.implementation.startsWith('src/measurement-connection-sync.ts'),
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.status === 'local_workflow'));
    assert.equal(JSON.stringify(f.store.audit(owner.tenantId)).includes('private-code'), false);
  } finally {
    f.store.close();
  }
});

test('task-oriented discovery guide examples validate and preview without provider requests', async () => {
  const file = JSON.parse(
    readFileSync('Skills/amcp-campaign-builder/examples/measurement-connection-sync.json', 'utf8'),
  );
  assert.equal(file.examples.length, 2);
  for (const example of file.examples) {
    const index = cases.findIndex(c => c[0] === example.gateway);
    assert.ok(index >= 0);
    const f = fixture(index);
    try {
      const r = await f.service.call(example.gateway, example.input, owner);
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.dry_run, true);
      assert.equal(f.calls.length, 0);
      assert.equal(f.store.documents(owner.tenantId, 'website_assets').length, 0);
    } finally {
      f.store.close();
    }
  }
});
