import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {Compiler} from '../src/compiler.js';
import {CredentialProvider} from '../src/auth.js';
import {NativeTransport, buildUrl} from '../src/transport.js';
import {MirrorService, strictOptions} from '../src/service.js';
import {nextPage} from '../src/pagination.js';
import {SecretBox} from '../src/security.js';
import {applyExecutionRisk} from '../src/execution-risk.js';
import type {Actor, Connection} from '../src/types.js';
const registry = new Registry();
const actor: Actor = {tenantId: 'A', userId: 'r', role: 'reader'};
const key = Buffer.alloc(32, 1).toString('base64');
function setup(gateway: string) {
  const store = new Store(':memory:', key),
    calls: {url: string; init?: RequestInit}[] = [];
  const connection: Connection = {
    id: 'c',
    tenantId: 'A',
    gateway,
    accounts: ['111'],
    enabled: true,
    label: 'fixture',
    scopes: [],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'fake', developerToken: 'fake'});
  const transport = new NativeTransport((async (url, init) => {
    calls.push({url: String(url), init});
    return new Response('{"data":[{"id":"444"}]}');
  }) as typeof fetch);
  return {store, calls, connection, transport, service: new MirrorService(registry, store, transport)};
}
test('all LinkedIn mutation overrides preview or fail without egress; read tunnel remains read-only', async () => {
  const x = setup('linkedin_native_action');
  try {
    const base = {
      action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_get',
      path_params: {ad_account_id: '111', campaign_id: '444'},
    };
    for (const override of ['DELETE', 'PUT', 'PATCH', 'POST']) {
      const preview = await x.service.call('linkedin_native_action', {...base, http_method_override: override}, actor);
      assert.equal(preview.data.executed, false);
      const denied = await x.service.call(
        'linkedin_native_action',
        {...base, http_method_override: override, dry_run: false},
        actor,
      );
      assert.equal(denied.error.code, 'LIVE_WRITES_DISABLED');
    }
    for (const restli of ['ACTION', 'DELETE', 'CREATE', 'PARTIAL_UPDATE', 'BATCH_UPDATE']) {
      const r = await x.service.call('linkedin_native_action', {...base, restli_method: restli, dry_run: false}, actor);
      assert.equal(r.error.code, 'LIVE_WRITES_DISABLED');
    }
    assert.equal(x.calls.length, 0);
    const plan = new Compiler(registry).compile(
      'linkedin_native_action',
      {...base, http_method_override: 'GET', restli_method: 'GET'},
      strictOptions,
    );
    assert.equal(plan.readOnly, true);
    assert.equal(plan.method, 'POST');
    assert.throws(
      () =>
        new Compiler(registry).compile(
          'linkedin_native_action',
          {...base, http_method_override: 'GET\r\nX: evil'},
          strictOptions,
        ),
      /Unsupported/,
    );
  } finally {
    x.store.close();
  }
});
test('final Google resource names and Meta account paths cannot escape binding', async () => {
  for (const [gateway, input] of [
    [
      'google_ads_native_action',
      {
        action: 'google_ads_v23_batch_job_list_batch_job_results',
        account_id: '111',
        path_params: {resource_name: 'customers/222/batchJobs/333'},
      },
    ],
    [
      'google_ads_native_action',
      {
        action: 'google_ads_v23_google_ads_search',
        account_id: '111',
        payload: {
          query: "SELECT campaign.id FROM campaign WHERE campaign.resource_name = 'customers/222/campaigns/333'",
        },
      },
    ],
    ['meta_native_action', {action: 'meta_campaign_id_get', account_id: '111', params: {campaign_id: 'act_222'}}],
  ] as const) {
    const x = setup(gateway);
    try {
      const r = await x.service.call(gateway, input, actor);
      assert.equal(r.error.code, 'ACCOUNT_SCOPE_MISMATCH');
      assert.equal(x.calls.length, 0);
    } finally {
      x.store.close();
    }
  }
});
test('global entity execution requires fresh ownership from a scoped vendor collection', async () => {
  const x = setup('meta_native_action');
  try {
    const input = {action: 'meta_campaign_id_get', account_id: '111', params: {campaign_id: '444'}};
    assert.equal((await x.service.call('meta_native_action', input, actor)).error.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal(x.calls.length, 0);
    assert.equal(
      (
        await x.service.call(
          'meta_native_action',
          {action: 'meta_ad_account_id_campaigns_get', account_id: '111'},
          actor,
        )
      ).success,
      true,
    );
    assert.equal((await x.service.call('meta_native_action', input, actor)).success, true);
    assert.equal(x.calls.length, 2);
    const now = Date.now;
    try {
      Date.now = () => now() + 300001;
      assert.equal((await x.service.call('meta_native_action', input, actor)).error.code, 'RESOURCE_SCOPE_REQUIRED');
    } finally {
      Date.now = now;
    }
  } finally {
    x.store.close();
  }
});
test('explicit read dry-run makes no credential or network request', async () => {
  const x = setup('meta_native_action');
  try {
    const r = await x.service.call(
      'meta_native_action',
      {action: 'meta_ad_account_id_campaigns_get', account_id: '111', dry_run: true},
      actor,
    );
    assert.equal(r.data.executed, false);
    assert.equal(x.calls.length, 0);
  } finally {
    x.store.close();
  }
});
test('query method and batch tunneling cannot bypass write gates, including native extension', async () => {
  const x = setup('meta_native_action');
  try {
    for (const query of [{method: 'DELETE'}, {_method: 'POST'}, {batch: [{method: 'DELETE', relative_url: '444'}]}]) {
      const result = await x.service.call(
        'meta_native_action',
        {action: 'meta_ad_account_id_campaigns_get', account_id: '111', query, dry_run: false},
        actor,
      );
      assert.equal(result.error.code, 'LIVE_WRITES_DISABLED');
      const plan = new Compiler(registry).compile(
        'meta_native_action',
        {account_id: '111', native_request: {method: 'GET', path: '/v25.0/act_111', query}},
        {mode: 'enhanced', flags: {nativeRequests: true}},
      );
      assert.equal(plan.readOnly, false);
    }
    assert.equal(x.calls.length, 0);
  } finally {
    x.store.close();
  }
});
test('native paths cannot smuggle query credentials, mutation overrides or fragments', async () => {
  const x = setup('meta_native_action');
  try {
    const options = {mode: 'enhanced' as const, flags: {nativeRequests: true}},
      service = new MirrorService(registry, x.store, x.transport, options);
    for (const path of [
      '/v25.0/act_111/campaigns?method=POST&access_token=synthetic-query-token',
      '/v25.0/act_111/campaigns#fragment',
      '/v25.0/act_111/campaigns?method=DELETE',
    ]) {
      const result = await service.call(
        'meta_native_action',
        {action: 'meta_ad_account_id_campaigns_get', account_id: '111', native_request: {method: 'GET', path}},
        actor,
      );
      assert.equal(result.error.code, 'INVALID_PATH');
      const plan = new Compiler(registry).compile(
        'meta_native_action',
        {action: 'meta_ad_account_id_campaigns_get', account_id: '111'},
        strictOptions,
      );
      assert.throws(() => buildUrl({...plan, path}, x.connection), /query|fragment/);
    }
    assert.equal(x.calls.length, 0);
  } finally {
    x.store.close();
  }
});
test('incorrect source read-only metadata cannot authorize TikTok rule changes', async () => {
  const x = setup('tiktok_native_action');
  try {
    const input = {
      action: 'tiktok_optimizer_rule_update_status_update',
      advertiser_id: '111',
      params: {rule_ids: ['444'], operate_type: 'TURN_OFF'},
    };
    assert.equal(registry.action('tiktok_native_action', input.action)!.read_only, true);
    const compiled = new Compiler(registry).compile('tiktok_native_action', input, strictOptions);
    assert.equal(applyExecutionRisk(compiled).readOnly, false);
    const preview = await x.service.call('tiktok_native_action', input, actor);
    assert.equal(preview.data.executed, false);
    assert.equal(preview.data.dry_run, true);
    const denied = await x.service.call('tiktok_native_action', {...input, dry_run: false}, actor);
    assert.equal(denied.error.code, 'LIVE_WRITES_DISABLED');
    assert.equal(x.calls.length, 0);
  } finally {
    x.store.close();
  }
});
test('POST read authorization requires an independent known read route', () => {
  const compiler = new Compiler(registry);
  const search = compiler.compile(
    'google_ads_native_action',
    {
      action: 'google_ads_v23_google_ads_search',
      account_id: '111',
      payload: {query: 'SELECT campaign.id FROM campaign LIMIT 1'},
    },
    strictOptions,
  );
  assert.equal(applyExecutionRisk(search).readOnly, true);
  assert.equal(applyExecutionRisk({...search, path: '/v23/customers/111/something:unknown'}).readOnly, false);
  assert.equal(applyExecutionRisk({...search, path: '/v23/customers/111/campaigns:mutate'}).readOnly, false);
  const meta = compiler.compile(
    'meta_native_action',
    {action: 'meta_ad_account_id_campaigns_get', account_id: '111'},
    strictOptions,
  );
  assert.equal(applyExecutionRisk({...meta, body: {method: 'DELETE'}}).readOnly, false);
});
test('refresh promises and encryption AAD isolate delimiter-colliding tuples', async () => {
  const store = new Store(':memory:', key);
  try {
    const a: Connection = {
      tenantId: 'a/b',
      id: 'c',
      gateway: 'google_ads_native_action',
      accounts: ['111'],
      enabled: true,
      label: 'fixture',
      scopes: [],
    };
    const b = {...a, tenantId: 'a', id: 'b/c', accounts: ['222']};
    for (const [i, c] of [a, b].entries())
      store.putConnection({tenantId: c.tenantId, userId: 'a', role: 'admin'}, c, {
        expiresAt: 1,
        refreshToken: 'r' + i,
        clientId: 'c',
        clientSecret: 's',
      });
    let calls = 0;
    const provider = new CredentialProvider(store, (async (_u, init) => {
      calls++;
      return new Response(
        JSON.stringify({access_token: 'new-' + (init!.body as URLSearchParams).get('refresh_token')}),
      );
    }) as typeof fetch);
    const [ca, cb] = await Promise.all([provider.get(a), provider.get(b)]);
    assert.notEqual(ca.accessToken, cb.accessToken);
    assert.equal(calls, 2);
    const sealed = (store.db.prepare('SELECT secret FROM connections WHERE tenant_id=?').get(a.tenantId) as any).secret;
    store.db.prepare('UPDATE connections SET secret=? WHERE tenant_id=?').run(sealed, b.tenantId);
    assert.throws(() => store.credentials(b.tenantId, b.id), /decryption failed/);
  } finally {
    store.close();
  }
});
test('legacy credential migration is explicit and refuses ambiguous legacy scopes', () => {
  const store = new Store(':memory:', key);
  try {
    const c: Connection = {
      tenantId: 'a',
      id: 'c',
      gateway: 'meta_native_action',
      accounts: ['111'],
      enabled: true,
      label: 'f',
      scopes: [],
    };
    store.putConnection({tenantId: 'a', userId: 'u', role: 'admin'}, c, {accessToken: 'initial'});
    store.db.prepare('UPDATE connections SET secret=?').run(new SecretBox(key).seal({accessToken: 'old'}, 'a/c'));
    assert.equal(store.credentials('a', 'c').accessToken, 'old');
    assert.ok((store.db.prepare('SELECT secret FROM connections').get() as any).secret.startsWith('v2:'));
  } finally {
    store.close();
  }
});
test('LinkedIn stringified objects/arrays serialize exactly once; primitive JSON is rejected', async () => {
  const x = setup('linkedin_native_action');
  try {
    const compiler = new Compiler(registry),
      base = {action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post', path_params: {ad_account_id: '111'}};
    for (const payload of ['{"name":"Draft","status":"PAUSED"}', '[{"status":"PAUSED"}]']) {
      const p = compiler.compile('linkedin_native_action', {...base, payload}, strictOptions);
      await x.transport.request(p, x.connection, {accessToken: 'fake'});
      assert.deepEqual(JSON.parse(String(x.calls.at(-1)!.init!.body)), JSON.parse(payload));
    }
    for (const payload of ['true', 'null', '"x"', '{bad'])
      assert.throws(
        () => compiler.compile('linkedin_native_action', {...base, payload}, strictOptions),
        /JSON|object or array/,
      );
  } finally {
    x.store.close();
  }
});
test('job lease generations fence stale completion, failure and renewal', () => {
  const store = new Store(':memory:'),
    clock = Date.now;
  try {
    let now = clock();
    Date.now = () => now;
    const id = store.enqueue('A', 'report', {}),
      a = store.leaseJob(1000)!;
    now += 1001;
    const b = store.leaseJob(1000)!;
    assert.notEqual(a.lease_token, b.lease_token);
    assert.throws(() => store.finishJob(id, a.lease_token, {worker: 'expired'}), /no longer owns/);
    assert.throws(() => store.failJob(id, a.lease_token, {}), /no longer owns/);
    assert.throws(() => store.renewJob(id, a.lease_token), /no longer owns/);
    assert.equal(store.job('A', id).state, 'running');
    store.finishJob(id, b.lease_token, {worker: 'current'});
    assert.deepEqual(store.job('A', id).result, {worker: 'current'});
  } finally {
    Date.now = clock;
    store.close();
  }
});
test('Snapchat supported campaign route preserves invariant filters across pagination', () => {
  const plan = new Compiler(registry).compile(
    'snapchat_native_action',
    {
      action: 'snapchat_campaign_list',
      ad_account_id: '111',
      params: {limit: 10, start_time: '2026-01-01', ad_account_id: '111'},
    },
    strictOptions,
  );
  assert.throws(
    () =>
      nextPage(plan, {paging: {next_link: 'https://adsapi.snapchat.com' + plan.path + '?ad_account_id=222&cursor=x'}}),
    /scope|filters/i,
  );
  const next = nextPage(plan, {paging: {next_link: 'https://adsapi.snapchat.com' + plan.path + '?cursor=x'}})!;
  assert.equal(next.query.start_time, '2026-01-01');
  assert.equal(next.query.limit, 10);
  assert.equal(next.query.cursor, 'x');
});
