import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Registry} from '../src/catalog.js';
import {Compiler} from '../src/compiler.js';
import {parameterHandling} from '../src/parameters.js';
import {projectResponse} from '../src/projection.js';
import {MirrorService, strictOptions} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {Store} from '../src/store.js';
import type {Actor, JsonObject} from '../src/types.js';
const registry = new Registry(),
  compiler = new Compiler(registry),
  actor: Actor = {tenantId: 't', userId: 'u', role: 'admin'};
const meta = {action: 'meta_ad_account_id_campaigns_get', account_id: '123'};
test('every captured direct envelope property has an explicit handling classification', () => {
  for (const tool of registry.data.tools.filter(t => t.mode === 'direct'))
    for (const key of Object.keys(tool.inputSchema.properties))
      assert.ok(parameterHandling(tool.name, key), tool.name + '/' + key);
});
test('Meta fields are native selectors; response controls and top-level context never leak into HTTP', () => {
  const p = compiler.compile(
    'meta_native_action',
    {...meta, fields: ['id', 'name'], result_fields: ['id'], compact: true, max_items: 1},
    strictOptions,
  );
  assert.deepEqual(p.query, {fields: 'id,name'});
  assert.deepEqual(p.responseControls, {fields: ['id'], compact: true, maxItems: 1});
  const batch = compiler.compile(
    'meta_native_action',
    {action: 'meta_batch_create', batch: [{method: 'GET', relative_url: 'me'}], include_headers: false, dry_run: true},
    strictOptions,
  );
  assert.equal(batch.action, 'meta_graph_batch_create');
  assert.deepEqual(batch.body, {batch: [{method: 'GET', relative_url: 'me'}], include_headers: false});
  for (const [key, value] of Object.entries({
    campaign: {},
    adset: {},
    creative: {},
    ad: {},
    assets: [],
    context: {},
    skip_preflight: true,
    override_preflight: true,
    limit: 1,
    search: 'x',
    business_id: '1',
    batch: [],
  }))
    assert.throws(() => compiler.compile('meta_native_action', {...meta, [key]: value}, strictOptions), {
      code: 'UNSUPPORTED_PARAMETER',
    });
  const business = compiler.compile(
    'meta_native_action',
    {action: 'meta_business_id_owned_ad_accounts_get', business_id: '42'},
    strictOptions,
  );
  assert.equal(business.path, '/v25.0/42/owned_ad_accounts');
  assert.deepEqual(business.query, {});
  const report = compiler.compile(
    'meta_native_action',
    {action: 'meta_report_run_get', report_run_id: '42'},
    strictOptions,
  );
  assert.equal(report.path, '/v25.0/42');
  const stats = registry.catalogs
    .get('snapchat_native_action')!
    .actions.find(a => a.method === 'GET' && a.path?.includes('/adaccounts/{ad_account_id}/stats'))!;
  const snap = compiler.compile(
    'snapchat_native_action',
    {action: stats.name, account_id: '123', limit: 7},
    strictOptions,
  );
  assert.equal(snap.query.limit, 7);
  const selector = compiler.compile(
    'meta_native_action',
    {action: 'meta_campaign_create', account_id: '123', fields: ['id'], payload: {fields: ['id']}},
    strictOptions,
  );
  assert.deepEqual(selector.body, {fields: 'id'});
});
test('native fields win only when declared; projection aliases cannot silently disagree', () => {
  const native = compiler.compile(
    'tiktok_native_action',
    {action: 'tiktok_ad_get', advertiser_id: '123', fields: ['ad_id']},
    strictOptions,
  );
  assert.deepEqual(native.query.fields, ['ad_id']);
  assert.equal(native.responseControls, undefined);
  const projected = compiler.compile(
    'snapchat_native_action',
    {action: 'snapchat_campaign_list', account_id: '123', fields: ['id']},
    strictOptions,
  );
  assert.equal(projected.query.fields, undefined);
  assert.deepEqual(projected.responseControls?.fields, ['id']);
  assert.throws(
    () =>
      compiler.compile(
        'snapchat_native_action',
        {action: 'snapchat_campaign_list', account_id: '123', fields: ['id'], result_fields: ['name']},
        strictOptions,
      ),
    {code: 'CONFLICTING_PARAMETER'},
  );
  assert.throws(
    () => compiler.compile('meta_native_action', {...meta, fields: 'id', query: {fields: 'name'}}, strictOptions),
    {code: 'CONFLICTING_PARAMETER'},
  );
});
test('LinkedIn/X top-level paths resolve and X JSON bodies are parsed once with malformed input rejected', () => {
  const x = compiler.compile(
    'x_ads_native_action',
    {action: 'x_accounts_account_id_campaigns_campaign_id_get', account_id: '123', campaign_id: '456'},
    strictOptions,
  );
  assert.equal(x.path, '/12/accounts/123/campaigns/456');
  assert.deepEqual(x.query, {});
  const linked = compiler.compile(
    'linkedin_native_action',
    {
      action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_get',
      ad_account_id: '123',
      campaign_id: '456',
    },
    strictOptions,
  );
  assert.equal(linked.path, '/rest/adAccounts/123/adCampaigns/456');
  const input = {action: 'x_accounts_account_id_campaigns_post', account_id: '123', payload: '{"name":"Draft"}'};
  assert.deepEqual(compiler.compile('x_ads_native_action', input, strictOptions).body, {name: 'Draft'});
  for (const payload of ['false', 'null', '1', '"x"', '{'])
    assert.throws(() => compiler.compile('x_ads_native_action', {...input, payload}, strictOptions), {
      code: 'INVALID_JSON_BODY',
    });
  for (const [key, value] of Object.entries({query: '{}', params: [], payload: 42, path_params: null}))
    assert.throws(() => compiler.compile('meta_native_action', {...meta, [key]: value}, strictOptions));
  assert.throws(
    () =>
      compiler.compile(
        'linkedin_native_action',
        {action: linked.action, path_params: {ad_account_id: '123', campaign_id: '456'}, body_format: 'form'},
        strictOptions,
      ),
    {code: 'UNSUPPORTED_PARAMETER'},
  );
  assert.throws(() => compiler.compile('x_ads_native_action', {...input, ignored_typo: true}, strictOptions), {
    code: 'UNSUPPORTED_PARAMETER',
  });
  assert.throws(
    () => compiler.compile('x_ads_native_action', {...input, payload: [], params: {name: 'lost'}}, strictOptions),
    {code: 'UNSUPPORTED_PARAMETER'},
  );
  assert.equal(compiler.compile('meta_native_action', {...meta, payload: {}}, strictOptions).body, undefined);
  assert.throws(() => compiler.compile('meta_native_action', {...meta, payload: {limit: 1}}, strictOptions), {
    code: 'UNSUPPORTED_PARAMETER',
  });
});
test('projection preserves nested selected fields, empty arrays, paging and every partial failure beyond caps', () => {
  const failed = {id: 'failed', status: 'FAILED', errors: [{message: 'denied', details: null}], unknown: 'diagnostic'};
  const data = {
    data: [{id: '1', name: 'A', metrics: {clicks: 0, spend: 2}, empty: null}, {id: '2'}, failed],
    paging: {next: 'https://example.com/page', cursors: {after: 'c'}, links: []},
    warnings: [],
    summary: {total: 3},
  };
  const before = structuredClone(data),
    p = projectResponse(data, {fields: ['id', 'metrics.clicks'], maxItems: 1, compact: true});
  assert.deepEqual(p.data, {...data, data: [{id: '1', metrics: {clicks: 0}}, failed]});
  assert.equal(p.truncated, true);
  assert.deepEqual(data, before);
  assert.deepEqual(
    projectResponse(
      {
        data: {
          list: [{id: '1', empty: '', nil: null, blank: {}, zero: 0, no: false, array: []}],
          page_info: {total_page: 1},
        },
      },
      {compact: true},
    ).data,
    {data: {list: [{id: '1', zero: 0, no: false, array: []}], page_info: {total_page: 1}}},
  );
  const nested = {data: [{id: '1', child: {deep: {error: {message: 'retain'}}}}]};
  assert.deepEqual(projectResponse(nested, {fields: ['id']}).data, nested);
});
test('filtering runs after pagination and scope observation and leaves vendor failures intact', async () => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  store.putConnection(
    actor,
    {
      id: 'c',
      tenantId: 't',
      gateway: 'meta_native_action',
      accounts: ['123'],
      enabled: true,
      label: 'test',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  let calls = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport((async url => {
      calls++;
      assert.equal(new URL(String(url)).searchParams.get('fields'), 'id,name');
      assert.equal(new URL(String(url)).searchParams.has('result_fields'), false);
      return new Response(
        JSON.stringify(
          calls === 1
            ? {
                data: [{id: '111', name: 'A'}],
                paging: {
                  cursors: {after: 'next'},
                  next: 'https://graph.facebook.com/v25.0/act_123/campaigns?after=next',
                },
              }
            : {data: [{id: '222', name: 'B'}]},
        ),
      );
    }) as typeof fetch),
  );
  try {
    const result = await service.call(
      'meta_native_action',
      {...meta, fields: 'id,name', result_fields: ['name'], max_items: 1, aggregate_pages: true, max_pages: 2},
      actor,
    );
    assert.equal(result.success, true);
    assert.equal(calls, 2);
    assert.equal(result.data.pages, 2);
    assert.equal(result.data.truncated, true);
    assert.equal(result.data.response_truncated, true);
    assert.deepEqual(result.data.data.data, [{name: 'A'}]);
    // Scope proof for the discarded second record must still exist.
    const plan = compiler.compile(
      'meta_native_action',
      {action: 'meta_campaign_get', account_id: '123', params: {campaign_id: '222'}},
      strictOptions,
    );
    const {ScopeGuard} = await import('../src/scope.js');
    new ScopeGuard(registry, store).authorize(plan, store.resolveConnection(actor, plan.gateway, '123'));
    const failing = new MirrorService(
      registry,
      store,
      new NativeTransport(
        (async () =>
          new Response(JSON.stringify({error: {message: 'denied', details: [{id: '1'}, {id: '2'}]}}))) as typeof fetch,
      ),
    );
    const error = await failing.call(
      'meta_native_action',
      {...meta, result_fields: ['id'], max_items: 1, compact: true},
      actor,
    );
    assert.equal(error.success, false);
    assert.equal(error.error.details.upstream.error.details.length, 2);
  } finally {
    store.close();
  }
});
test('introspection ignores response projections and legacy Google writes remain blocked before egress', async () => {
  const store = new Store(':memory:');
  let calls = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport((async () => {
      calls++;
      throw Error('unexpected egress');
    }) as typeof fetch),
  );
  try {
    for (const gateway of [
      'meta_native_action',
      'tiktok_native_action',
      'snapchat_native_action',
      'linkedin_native_action',
      'x_ads_native_action',
    ]) {
      const action = registry.catalogs.get(gateway)!.actions[0]!.name;
      for (const input of [{action: 'LIST_ACTIONS'}, {action: 'DESCRIBE_ACTION', target_action: action}]) {
        const plain = await service.call(gateway, input, actor),
          filtered = await service.call(
            gateway,
            {...input, result_fields: ['name'], max_items: 1, compact: true},
            actor,
          );
        assert.equal(plain.success, true);
        assert.deepEqual(filtered.data, plain.data, gateway + '/' + input.action);
      }
    }
    const legacy: JsonObject = {
      action: 'CREATE_CAMPAIGN',
      account_id: '111',
      payload: {
        resource: {
          name: 'Draft',
          advertising_channel_type: 'SEARCH',
          campaign_budget: 'customers/111/campaignBudgets/222',
        },
      },
      dry_run: false,
      confirmed: true,
      idempotency_key: '11111111-2222-4333-8444-555555555555',
    };
    const denied = await service.call('google_ads_native_action', legacy, actor);
    assert.equal(denied.error.code, 'LIVE_WRITES_DISABLED');
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});
