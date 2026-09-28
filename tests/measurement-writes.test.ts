import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ReportWorker} from '../src/worker.js';
import {PlatformOAuth} from '../server/platform-oauth.js';
import {WebStore} from '../server/web-store.js';
import {gtmWriteActions, gtmWriteScopes} from '../src/measurement-writes.js';
import {writeOutcome} from '../src/write-outcome.js';
import {validateState} from '../src/write-state.js';
import type {Actor, JsonObject, CompiledRequest} from '../src/types.js';
const registry = new Registry(),
  key = Buffer.alloc(32, 117).toString('base64'),
  actor: Actor = {tenantId: 'test', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'},
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};
const scopes = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters',
  'searchadsorg',
  ...gtmWriteScopes,
];
interface Scenario {
  gateway: string;
  id: string;
  input: JsonObject;
  reads: Record<string, unknown>;
  output: unknown;
  status?: number;
}
function fixture(s: Scenario) {
  const store = new Store(':memory:', key);
  store.putConnection(
    admin,
    {
      id: 'c',
      tenantId: actor.tenantId,
      gateway: s.gateway,
      accounts: [s.id],
      writeAccounts: [s.id],
      scopes,
      enabled: true,
      label: 'synthetic',
    },
    {accessToken: 'synthetic'},
  );
  const calls: {url: URL; method: string; body?: JsonObject; headers: Headers}[] = [],
    state = structuredClone(s.reads);
  let output = s.output,
    status = s.status ?? 200,
    readStatus = 200;
  const transport = new NativeTransport((async (url, init) => {
    const u = new URL(String(url));
    calls.push({
      url: u,
      method: init!.method!,
      body: init!.body ? JSON.parse(String(init!.body)) : undefined,
      headers: new Headers(init!.headers),
    });
    if (init!.method === 'GET') {
      if (readStatus !== 200) return Response.json({error: {code: readStatus}}, {status: readStatus});
      assert.ok(Object.hasOwn(state, u.pathname), 'Unexpected state read: ' + u.pathname);
      const value = state[u.pathname],
        telemetry =
          s.gateway === 'apple_ads_native_action'
            ? {futureEnvelopeTelemetry: {cost: calls.length}}
            : u.pathname.endsWith('/status')
              ? {}
              : {requestId: String(calls.length), updateTime: String(calls.length)};
      return value === null
        ? new Response('{"error":{"code":404}}', {status: 404})
        : new Response(JSON.stringify({...(value as JsonObject), ...telemetry}));
    }
    return new Response(output === null ? null : JSON.stringify(output), {status});
  }) as typeof fetch);
  return {
    store,
    state,
    calls,
    service: new MirrorService(registry, store, transport, undefined, policy),
    setReadStatus: (code: number) => {
      readStatus = code;
    },
    setOutput: (v: unknown, code = 200) => {
      output = v;
      status = code;
    },
  };
}
const prepare = (f: ReturnType<typeof fixture>, s: Scenario, a = actor) =>
  f.service.call('amcp_write', {action: 'prepare', gateway: s.gateway, arguments: s.input}, a);
const execute = (f: ReturnType<typeof fixture>, r: JsonObject, extra: JsonObject = {}) =>
  f.service.call(
    'amcp_write',
    {
      action: 'execute',
      review_id: r.review_id,
      idempotency_key: r.idempotency_key,
      confirmed: true,
      spend_change_confirmed: true,
      ...extra,
    },
    actor,
  );
const verify = (f: ReturnType<typeof fixture>, r: JsonObject) =>
  f.service.call('amcp_campaign', {action: 'verify', review_id: r.review_id}, actor);
const ga = (kind = 'audience'): Scenario => ({
  gateway: 'ga4_native_action',
  id: '123',
  input: {
    operation: kind === 'audience' ? 'ga4_create_audience_export' : 'ga4_create_report_task',
    arguments: {
      property: '123',
      request:
        kind === 'audience'
          ? {audience: 'properties/123/audiences/1', dimensions: [{dimensionName: 'userId'}]}
          : {
              reportDefinition: {
                dateRanges: [{startDate: '2026-09-01', endDate: '2026-09-02'}],
                metrics: [{name: 'sessions'}],
              },
            },
    },
  },
  reads: {'/v1beta/properties/123': {name: 'properties/123', displayName: 'Synthetic'}},
  output:
    kind === 'audience'
      ? {name: 'operations/1', metadata: {name: 'properties/123/audienceExports/2'}}
      : {name: 'properties/123/reportTasks/2'},
});
const sc = (action = 'SUBMIT_SITEMAP'): Scenario => {
  const site = 'sc-domain:example.test',
    path = '/webmasters/v3/sites/' + encodeURIComponent(site),
    sitemap = 'https://example.test/sitemap.xml';
  return {
    gateway: 'google_search_console_native_action',
    id: site,
    input: {
      operation: 'gsc_site_ops',
      arguments: {action, site_url: site, ...(action.includes('SITEMAP') ? {sitemap_url: sitemap} : {})},
    },
    reads: {
      [path]: {siteUrl: site, permissionLevel: 'siteOwner'},
      ...(action.includes('SITEMAP')
        ? {[path + '/sitemaps/' + encodeURIComponent(sitemap)]: action === 'SUBMIT_SITEMAP' ? null : {path: sitemap}}
        : {}),
    },
    output: null,
  };
};
const ap = (verb = 'create'): Scenario => ({
  gateway: 'apple_ads_native_action',
  id: '77',
  input: {
    action: 'apple_ads_v1_campaign_' + verb,
    account_id: '77',
    ...(verb === 'create'
      ? {
          payload: {
            adAccountId: 77,
            name: 'Synthetic paused',
            status: 'PAUSED',
            billingEvent: 'TAPS',
            promotedObjectType: 'APP',
            promotedObjectId: '123',
            dailyBudget: {amount: '1', currency: 'USD'},
            targeting: {},
          },
        }
      : {path_params: {id: '5'}, ...(verb === 'update' ? {payload: {name: 'Updated synthetic'}} : {})}),
  },
  reads: {
    [verb === 'create' ? '/v1/ad-accounts/77' : '/v1/campaigns/5']: {
      result: {id: verb === 'create' ? 77 : 5, adAccountId: 77, name: 'Synthetic', status: 'PAUSED'},
    },
  },
  output: verb === 'delete' ? {result: null} : {result: {id: 5, adAccountId: 77, name: 'Synthetic', status: 'PAUSED'}},
});
function gtm(a: string): Scenario {
  const base = 'accounts/44',
    container = base + '/containers/55',
    workspace = container + '/workspaces/66',
    mapping: Record<string, string> = {
      CONTAINER: 'containers',
      WORKSPACE: 'workspaces',
      TAG: 'tags',
      TRIGGER: 'triggers',
      VARIABLE: 'variables',
      GTAG_CONFIG: 'gtag_config',
      TEMPLATE: 'templates',
      FOLDER: 'folders',
      ZONE: 'zones',
      CLIENT: 'clients',
      TRANSFORMATION: 'transformations',
      ENVIRONMENT: 'environments',
      CONTAINER_VERSION: 'versions',
    };
  const entity = a.replace(/^(CREATE|UPDATE|DELETE|PUBLISH)_/, ''),
    kind = mapping[entity]!,
    parent =
      entity === 'CONTAINER'
        ? base
        : ['WORKSPACE', 'ENVIRONMENT', 'CONTAINER_VERSION'].includes(entity)
          ? container
          : workspace,
    resource = parent + '/' + kind + '/7',
    prefix = '/tagmanager/v2/';
  const versionCreate = a === 'CREATE_CONTAINER_VERSION',
    publish = a === 'PUBLISH_CONTAINER_VERSION',
    create = a.startsWith('CREATE_') && !versionCreate,
    target = versionCreate ? workspace : resource;
  const arguments_: JsonObject = {
    action: a,
    account_id: '44',
    ...(create ? {parent} : {path: target}),
    ...(!a.startsWith('DELETE_') && !publish ? {payload: {name: 'Synthetic'}} : {}),
  };
  const reads: Record<string, unknown> = {
    [prefix + (create ? parent : target)]: {path: create ? parent : target, fingerprint: 'before', name: 'Synthetic'},
  };
  if (versionCreate) reads[prefix + workspace + '/status'] = {workspaceChange: []};
  if (publish) reads[prefix + container + '/versions:live'] = null;
  return {
    gateway: 'gtm_native_action',
    id: '44',
    input: {operation: 'gtm_ops', arguments: arguments_},
    reads,
    output: a.startsWith('DELETE_')
      ? null
      : versionCreate || publish
        ? {containerVersion: {path: container + '/versions/7', containerVersionId: '7'}, compilerError: false}
        : {path: resource, fingerprint: 'after', name: 'Synthetic'},
  };
}
test('all four integrations prepare frozen native mutations, execute once and replay without egress', async () => {
  for (const s of [
    ga(),
    ga('report'),
    ...['ADD_SITE', 'DELETE_SITE', 'SUBMIT_SITEMAP', 'DELETE_SITEMAP'].map(sc),
    ...['create', 'update', 'delete'].map(ap),
    ...['CREATE_TAG', 'UPDATE_TAG', 'DELETE_TAG', 'PUBLISH_CONTAINER_VERSION', 'CREATE_CONTAINER_VERSION'].map(gtm),
  ]) {
    const f = fixture(s);
    try {
      const prepared = await prepare(f, s);
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      assert.ok(f.calls.every(c => c.method === 'GET'));
      const done = await execute(f, prepared.data);
      assert.equal(done.success, true, JSON.stringify(done));
      assert.equal(done.data.executed, true);
      assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1);
      if (s.gateway === 'apple_ads_native_action')
        assert.ok(f.calls.every(c => c.headers.get('x-ap-context') === 'adAccountId=77;'));
      if (s.gateway === 'ga4_native_action')
        assert.equal(f.calls[0]!.url.origin, 'https://analyticsadmin.googleapis.com');
      const count = f.calls.length,
        replay = await execute(f, prepared.data);
      assert.equal(replay.data.replayed, true);
      assert.equal(f.calls.length, count);
      assert.ok(f.store.verifyAudit());
    } finally {
      f.store.close();
    }
  }
});
for (const change of ['processing', 'submission', 'provider_error'])
  test('Search Console sitemap ' + change + ' distinguishes crawl observations from submission state', async () => {
    const s = sc('DELETE_SITEMAP'),
      f = fixture(s),
      target = Object.keys(f.state).find(p => p.includes('/sitemaps/'))!;
    try {
      const original = {
        path: 'https://example.test/sitemap.xml',
        lastSubmitted: '2026-09-01T00:00:00Z',
        type: 'sitemap',
        isSitemapsIndex: false,
        lastDownloaded: '2026-09-01T00:00:00Z',
        isPending: true,
        errors: '1',
        warnings: '2',
        contents: [{type: 'web', submitted: '100', indexed: '0'}],
      };
      f.state[target] = original;
      const p = await prepare(f, s);
      assert.equal(p.success, true, JSON.stringify(p));
      f.state[target] = {
        ...original,
        lastDownloaded: '2026-09-02T00:00:00Z',
        isPending: false,
        errors: '2',
        warnings: '4',
        contents: [{type: 'web', submitted: '120', indexed: '80'}],
        ...(change === 'submission' ? {lastSubmitted: '2026-09-02T00:00:00Z'} : {}),
        ...(change === 'provider_error' ? {error: {code: 403, message: 'Synthetic denial'}} : {}),
      };
      const out = await execute(f, p.data);
      if (change === 'processing') {
        assert.equal(out.success, true, JSON.stringify(out));
        assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1);
      } else {
        assert.equal(out.success, false);
        assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
        if (change === 'submission') {
          assert.equal(out.error.code, 'STATE_CHANGED');
          assert.deepEqual(out.error.details.changed_fields, ['$[1]["lastSubmitted"]']);
        }
      }
    } finally {
      f.store.close();
    }
  });

test('every enabled Tag Manager CRUD and publishing contract compiles, validates before-state and confirms its exact result', async () => {
  for (const a of gtmWriteActions) {
    const s = gtm(a),
      f = fixture(s);
    try {
      const prepared = await prepare(f, s);
      assert.equal(prepared.success, true, a + ': ' + JSON.stringify(prepared));
      const result = await execute(f, prepared.data);
      assert.equal(result.success, true, a + ': ' + JSON.stringify(result));
    } finally {
      f.store.close();
    }
  }
});
test('readers, missing write grants, missing provider scopes and disabled deployments fail before provider egress', async () => {
  for (const s of [ga(), gtm('CREATE_TAG'), sc(), ap()]) {
    const f = fixture(s);
    try {
      assert.equal((await prepare(f, s, {...actor, role: 'reader'})).error.code, 'FORBIDDEN');
      const c = f.store.listConnections(actor.tenantId)[0]!;
      f.store.putConnection(admin, {...c, writeAccounts: []}, {accessToken: 'synthetic'});
      assert.equal((await prepare(f, s)).error.code, 'WRITE_ACCOUNT_FORBIDDEN');
      f.store.putConnection(admin, {...c, scopes: []}, {accessToken: 'synthetic'});
      assert.equal((await prepare(f, s)).error.code, 'PROVIDER_WRITE_SCOPE_REQUIRED');
      assert.equal(f.calls.length, 0);
      const disabled = new MirrorService(registry, f.store);
      assert.equal(
        (await disabled.call('amcp_write', {action: 'prepare', gateway: s.gateway, arguments: s.input}, actor)).error
          .code,
        'LIVE_WRITES_DISABLED',
      );
    } finally {
      f.store.close();
    }
  }
});
test('stale state, lost grants, absent-target changes and missing explicit confirmation cannot execute', async () => {
  for (const s of [ga(), gtm('UPDATE_TAG'), sc(), ap('update')]) {
    const f = fixture(s);
    try {
      const prepared = await prepare(f, s);
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      assert.equal((await execute(f, prepared.data, {confirmed: false})).error.code, 'CONFIRMATION_REQUIRED');
      const target = Object.keys(f.state).at(-1)!,
        before = f.state[target] as JsonObject | null;
      f.state[target] =
        before === null
          ? {path: 'https://example.test/sitemap.xml'}
          : s.gateway === 'apple_ads_native_action'
            ? {...before, result: {...before.result, name: 'Changed account'}}
            : {...before, changed: 'new state'};
      assert.equal((await execute(f, prepared.data)).error.code, 'STATE_CHANGED');
      assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('cross-resource and unqualified inputs fail before reads, including nested delegated connection conflicts', async () => {
  const scenarios = [ga(), gtm('UPDATE_TAG'), gtm('CREATE_TAG'), ap(), sc()];
  scenarios[0]!.input.arguments.request.audience = 'properties/999/audiences/1';
  scenarios[1]!.input.arguments.payload.accountId = '999';
  scenarios[2]!.input.arguments.payload.path = 'accounts/44/containers/999/workspaces/66/tags/7';
  scenarios[3]!.input.payload.status = 'ENABLED';
  scenarios[4]!.input.arguments.sitemap_url = 'javascript:alert(1)';
  for (const s of scenarios) {
    const f = fixture(s);
    try {
      assert.equal((await prepare(f, s)).success, false);
      assert.equal(f.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
  const s = gtm('CREATE_TAG'),
    f = fixture(s);
  try {
    const conflict = await f.service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway: s.gateway,
        connection_id: 'c',
        arguments: {
          ...s.input,
          arguments: {...s.input.arguments, connection_id: '00000000-0000-4000-8000-000000000001'},
        },
      },
      actor,
    );
    assert.equal(conflict.error.code, 'CONFLICTING_PARAMETER');
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('missing target and false provider receipts cannot be reported as success or retried', async () => {
  for (const s of [ga(), gtm('CREATE_TAG'), ap('update'), sc()]) {
    const f = fixture(s);
    try {
      const prepared = await prepare(f, s);
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      f.setOutput({unexpected: 'not a receipt'});
      const out = await execute(f, prepared.data);
      assert.equal(out.success, false);
      assert.equal(out.data.executed, true);
      const count = f.calls.length;
      assert.equal((await execute(f, prepared.data)).data.replayed, true);
      assert.equal(f.calls.length, count);
    } finally {
      f.store.close();
    }
  }
  const s = ap('update'),
    f = fixture(s);
  try {
    f.state['/v1/campaigns/5'] = {result: {id: 6, adAccountId: 77}};
    assert.equal((await prepare(f, s)).error.code, 'STATE_TARGET_MISMATCH');
  } finally {
    f.store.close();
  }
});
test('provider OAuth advertises write scopes only when enabled and does not grant them to old connections', () => {
  const store = new Store(':memory:', key);
  try {
    const web = new WebStore(store, {origin: 'https://amcp.shop', masterKey: key});
    const reader = new PlatformOAuth(web, {}),
      writer = new PlatformOAuth(web, {}, fetch, true);
    for (const [id, required] of [
      ['gtm', gtmWriteScopes],
      ['gsc', ['https://www.googleapis.com/auth/webmasters']],
    ] as const) {
      const r = reader.publicConfig().find(p => p.id === id)!,
        w = writer.publicConfig().find(p => p.id === id)!;
      for (const scope of required) {
        assert.ok(!r.scopes.includes(scope));
        assert.ok(w.scopes.includes(scope));
      }
      assert.equal(w.reviewedWrites, true);
    }
    assert.ok(
      writer
        .publicConfig()
        .filter(p => ['ga4', 'gtm', 'gsc', 'apple'].includes(p.id))
        .every(p => p.reviewedWrites),
    );
    const override = new PlatformOAuth(
      web,
      {AMCP_GSC_SCOPES: 'https://www.googleapis.com/auth/webmasters.readonly'},
      fetch,
      true,
    );
    assert.deepEqual(override.publicConfig().find(p => p.id === 'gsc')!.scopes, [
      'https://www.googleapis.com/auth/webmasters.readonly',
    ]);
  } finally {
    store.close();
  }
});
test('native provider contract validators reject cross-account responses and failed publishing', () => {
  const read = {
    gateway: 'gtm_native_action',
    path: '/tagmanager/v2/accounts/44/containers/55/workspaces/66',
    accountId: '44',
    query: {},
  } as CompiledRequest;
  assert.throws(
    () => validateState(read, {data: {path: 'accounts/999/containers/55/workspaces/66'}, status: 200, headers: {}}),
    {code: 'STATE_TARGET_MISMATCH'},
  );
  const publish = {
    ...read,
    method: 'POST',
    action: 'gtm_ops/PUBLISH_CONTAINER_VERSION',
    path: '/tagmanager/v2/accounts/44/containers/55/versions/7:publish',
    body: {},
  };
  for (const output of [
    {containerVersion: {path: 'accounts/999/containers/55/versions/7', containerVersionId: '7'}},
    {containerVersion: {path: 'accounts/44/containers/55/versions/7', containerVersionId: '7'}, compilerError: true},
  ])
    assert.equal(writeOutcome({data: output, status: 200, headers: {}}, publish).success, false);
});
test('Tag Manager snapshots include workspace contents or live version and native fingerprints prevent races', async () => {
  const s = gtm('UPDATE_TAG'),
    f = fixture(s);
  try {
    const r = await prepare(f, s);
    assert.equal(r.success, true);
    assert.equal(r.data.request.query.fingerprint, 'before');
    assert.equal((await execute(f, r.data)).success, true);
    assert.equal(f.calls.at(-1)!.url.searchParams.get('fingerprint'), 'before');
  } finally {
    f.store.close();
  }
  const v = gtm('CREATE_CONTAINER_VERSION'),
    g = fixture(v);
  try {
    const status = Object.keys(g.state).find(k => k.endsWith('/status'))!;
    g.state[status] = {};
    const r = await prepare(g, v);
    assert.equal(r.success, true, JSON.stringify(r));
    g.state[status] = {workspaceChange: [{tag: {name: 'A changed tag', fingerprint: 'new'}}]};
    assert.equal((await execute(g, r.data)).error.code, 'STATE_CHANGED');
    g.state[status] = {mergeConflict: [{entityInWorkspace: {tag: {name: 'Conflict'}}}]};
    assert.equal((await prepare(g, v)).error.code, 'STATE_CONFLICT');
  } finally {
    g.store.close();
  }
});
test('provider scope revocation and direct delegated requests cannot bypass mutation reviews', async () => {
  for (const s of [ga(), gtm('CREATE_TAG'), sc(), ap()]) {
    const f = fixture(s);
    try {
      const r = await prepare(f, s);
      assert.equal(r.success, true);
      const c = f.store.listConnections(actor.tenantId)[0]!;
      f.store.putConnection(admin, {...c, scopes: []}, {accessToken: 'synthetic'});
      assert.equal((await execute(f, r.data)).error.code, 'PROVIDER_WRITE_SCOPE_REQUIRED');
      assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
      const direct = s.input.operation
        ? {...s.input, arguments: {...s.input.arguments, dry_run: false, confirmed: true}}
        : {...s.input, dry_run: false, confirmed: true};
      const bypass = await f.service.call(s.gateway, direct, actor);
      assert.equal(bypass.success, false);
      assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
    } finally {
      f.store.close();
    }
  }
});

for (const kind of ['audience', 'report'])
  test(
    'GA4 ' + kind + ' verification preserves async states and detects changed definitions without repeating creation',
    async () => {
      const s = ga(kind),
        f = fixture(s);
      try {
        const p = await prepare(f, s);
        assert.equal(p.success, true, JSON.stringify(p));
        assert.equal((await execute(f, p.data)).success, true);
        const name = 'properties/123/' + (kind === 'audience' ? 'audienceExports' : 'reportTasks') + '/2',
          path = '/' + (kind === 'audience' ? 'v1beta' : 'v1alpha') + '/' + name;
        const record = (phase: string) => ({
          ...s.input.arguments.request,
          name,
          ...(kind === 'audience'
            ? {state: phase, ...(phase === 'FAILED' ? {errorMessage: 'Synthetic quota exhaustion'} : {})}
            : {
                reportMetadata: {
                  state: phase,
                  creationQuotaTokensCharged: 52,
                  ...(phase === 'FAILED' ? {errorMessage: 'Synthetic quota exhaustion'} : {}),
                },
              }),
        });
        for (const phase of ['CREATING', 'FAILED', 'UNRECOGNIZED', 'ACTIVE']) {
          f.state[path] = record(phase);
          const out = await verify(f, p.data);
          assert.equal(out.success, true, JSON.stringify(out));
          assert.equal(
            out.data.status,
            phase === 'ACTIVE' ? 'verified' : phase === 'FAILED' ? 'failed' : 'pending',
            JSON.stringify(out),
          );
          if (out.data.status === 'pending') {
            assert.equal(out.data.automatic_retry_of_mutation, false);
            assert.equal(out.data.next_call.arguments.review_id, p.data.review_id);
          }
          f.store.db
            .prepare("DELETE FROM documents WHERE tenant_id=? AND kind='write_verification'")
            .run(actor.tenantId);
        }
        f.state[path] = {
          ...record('ACTIVE'),
          ...(kind === 'audience'
            ? {audience: 'properties/123/audiences/99'}
            : {reportDefinition: {...s.input.arguments.request.reportDefinition, metrics: [{name: 'activeUsers'}]}}),
        };
        const mismatch = await verify(f, p.data);
        assert.equal(mismatch.data.status, 'inconclusive', JSON.stringify(mismatch));
        assert.ok(mismatch.data.checks[0].changed_fields.length);
        assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1);
      } finally {
        f.store.close();
      }
    },
  );

test('all enabled Tag Manager mutations read back exact entities, absence or the live published version', async () => {
  for (const a of gtmWriteActions) {
    const s = gtm(a),
      f = fixture(s);
    try {
      const p = await prepare(f, s);
      assert.equal(p.success, true, a + JSON.stringify(p));
      assert.equal((await execute(f, p.data)).success, true);
      const receipt = s.output as JsonObject;
      if (a.startsWith('DELETE_')) f.state['/tagmanager/v2/' + s.input.arguments.path] = null;
      else if (a === 'PUBLISH_CONTAINER_VERSION')
        f.state['/tagmanager/v2/' + receipt.containerVersion.path.replace(/\/versions\/[^/]+$/, '/versions:live')] =
          receipt.containerVersion;
      else if (a === 'CREATE_CONTAINER_VERSION')
        f.state['/tagmanager/v2/' + receipt.containerVersion.path] = receipt.containerVersion;
      else f.state['/tagmanager/v2/' + receipt.path] = {...s.input.arguments.payload, ...receipt};
      const out = await verify(f, p.data);
      assert.equal(out.data.status, 'verified', a + JSON.stringify(out));
      assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1);
    } finally {
      f.store.close();
    }
  }
});

test('Tag Manager publish never verifies only the requested version when another version is live', async () => {
  const s = gtm('PUBLISH_CONTAINER_VERSION'),
    f = fixture(s);
  try {
    const p = await prepare(f, s);
    assert.equal((await execute(f, p.data)).success, true);
    f.state['/tagmanager/v2/accounts/44/containers/55/versions:live'] = {
      path: 'accounts/44/containers/55/versions/8',
      containerVersionId: '8',
    };
    const out = await verify(f, p.data);
    assert.equal(out.data.status, 'inconclusive', JSON.stringify(out));
    assert.ok(out.data.checks[0].changed_fields.includes('/container_version_id'));
    assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1);
  } finally {
    f.store.close();
  }
});

for (const s of [
  ...['create', 'update', 'delete'].map(ap),
  ...['ADD_SITE', 'DELETE_SITE', 'SUBMIT_SITEMAP', 'DELETE_SITEMAP'].map(sc),
])
  test('native read-back verifies ' + s.gateway + ' ' + (s.input.action ?? s.input.arguments.action), async () => {
    const f = fixture(s);
    try {
      const p = await prepare(f, s);
      assert.equal((await execute(f, p.data)).success, true);
      if (s.gateway === 'apple_ads_native_action')
        f.state['/v1/campaigns/5'] = s.input.action.endsWith('_delete')
          ? null
          : {result: {...(s.output as JsonObject).result, ...s.input.payload}};
      else {
        const target = Object.keys(f.state).at(-1)!;
        f.state[target] = s.input.arguments.action.startsWith('DELETE_')
          ? null
          : target.includes('/sitemaps/')
            ? {path: s.input.arguments.sitemap_url, isPending: true}
            : s.reads[target];
      }
      const out = await verify(f, p.data);
      assert.equal(out.data.status, 'verified', JSON.stringify(out));
      assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1);
    } finally {
      f.store.close();
    }
  });

test('permission errors and revoked grants never verify absence after deletion', async () => {
  for (const s of [ap('delete'), sc('DELETE_SITEMAP'), gtm('DELETE_TAG')]) {
    const f = fixture(s);
    try {
      const p = await prepare(f, s);
      assert.equal((await execute(f, p.data)).success, true);
      f.setReadStatus(403);
      const denied = await verify(f, p.data);
      assert.equal(denied.data.status, 'unverified', JSON.stringify(denied));
      const c = f.store.listConnections(actor.tenantId)[0]!;
      f.store.putConnection(admin, {...c, enabled: false, accounts: [], writeAccounts: []}, {accessToken: 'synthetic'});
      const calls = f.calls.length;
      assert.equal((await verify(f, p.data)).success, false);
      assert.equal(f.calls.length, calls);
    } finally {
      f.store.close();
    }
  }
});

for (const outcome of ['ready', 'failed', 'limit'])
  test('background verification retries only reads and preserves ' + outcome, async () => {
    const s = ga(),
      f = fixture(s);
    try {
      const p = await prepare(f, s),
        e = await execute(f, p.data),
        id = e.data.verification.job_id;
      const path = '/v1beta/properties/123/audienceExports/2',
        record = {...s.input.arguments.request, name: 'properties/123/audienceExports/2', state: 'CREATING'};
      f.state[path] = record;
      const worker = new ReportWorker(
        f.store,
        async () => {
          throw Error('No report execution');
        },
        (tenant, kind, input) => f.service.verificationJob(tenant, kind, input),
      );
      await worker.once();
      let job = f.store.job(actor.tenantId, id);
      assert.equal(job.state, 'queued');
      assert.equal(job.error.code, 'VERIFICATION_PENDING');
      assert.equal(job.input.review_id, p.data.review_id);
      f.state[path] = {...record, state: outcome === 'ready' ? 'ACTIVE' : outcome === 'failed' ? 'FAILED' : 'CREATING'};
      f.store.db.prepare('UPDATE jobs SET available_at=0,attempts=? WHERE id=?').run(outcome === 'limit' ? 11 : 1, id);
      await worker.once();
      job = f.store.job(actor.tenantId, id);
      if (outcome === 'ready') {
        assert.equal(job.state, 'complete');
        assert.equal(job.result.status, 'verified');
      } else {
        assert.equal(job.state, 'failed');
        assert.equal(job.error.code, outcome === 'limit' ? 'VERIFICATION_POLL_LIMIT' : 'VERIFICATION_FAILED');
      }
      assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1);
      assert.equal(
        f.store.document(actor.tenantId, 'write_verification', p.data.review_id).status,
        outcome === 'ready' ? 'verified' : outcome === 'failed' ? 'failed' : 'pending',
      );
    } finally {
      f.store.close();
    }
  });

test('verification jobs reject stale lease ownership before another provider read', async () => {
  const s = ga(),
    f = fixture(s);
  try {
    const p = await prepare(f, s),
      e = await execute(f, p.data),
      job = f.store.leaseJob(60000),
      count = f.calls.length;
    assert.ok(job);
    assert.equal(job.id, e.data.verification.job_id);
    await assert.rejects(
      () =>
        f.service.verificationJob(actor.tenantId, 'write_verification', {
          ...job.input,
          __job_id: job.id,
          __lease_token: 'stale-token',
        }),
      {code: 'STALE_JOB_LEASE'},
    );
    assert.equal(f.calls.length, count);
  } finally {
    f.store.close();
  }
});
