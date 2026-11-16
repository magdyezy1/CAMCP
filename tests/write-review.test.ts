import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Registry} from '../src/catalog.js';
import {Compiler} from '../src/compiler.js';
import {Store} from '../src/store.js';
import {NativeTransport} from '../src/transport.js';
import {MirrorService} from '../src/service.js';
import {writeOutcome} from '../src/write-outcome.js';
import {validateState} from '../src/write-state.js';
import {removeTestDirectory} from './temp.js';
import type {Actor, JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';
const registry = new Registry(),
  key = Buffer.alloc(32, 21).toString('base64'),
  actor: Actor = {tenantId: 't', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'};
const policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};
function setup(file = ':memory:') {
  const store = new Store(file, key);
  store.putConnection(
    admin,
    {
      id: 'c',
      tenantId: 't',
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'test',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const calls: {method: string; url: string; body?: string}[] = [],
    state = {id: 'act_123', currency: 'USD', account_status: 1};
  let mode = 'success';
  const transport = new NativeTransport((async (url, init) => {
    calls.push({method: init!.method!, url: String(url), body: init!.body?.toString()});
    if (init!.method === 'GET') return new Response(JSON.stringify(state));
    if (mode === 'lost') throw Error('connection lost');
    if (mode === 'partial') return new Response(JSON.stringify({id: '111', errors: [{message: 'item failed'}]}));
    return new Response(JSON.stringify({id: '111'}));
  }) as typeof fetch);
  const service = new MirrorService(registry, store, transport, undefined, policy);
  return {
    store,
    service,
    calls,
    state,
    mode: (value: string) => {
      mode = value;
    },
  };
}
const create = {
  gateway: 'meta_native_action',
  arguments: {
    action: 'meta_campaign_create',
    account_id: '123',
    payload: {
      name: 'Draft',
      status: 'PAUSED',
      objective: 'OUTCOME_TRAFFIC',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    },
  },
};
async function prepare(s: MirrorService, input: JsonObject = create, a = actor) {
  const r = await s.call('amcp_write', {action: 'prepare', ...input}, a);
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
}
const execution = (r: JsonObject) => ({
  action: 'execute',
  review_id: r.review_id,
  idempotency_key: r.idempotency_key,
  confirmed: true,
});
test('review reads state, requires exact approval, executes once and replays without egress', async () => {
  const x = setup();
  try {
    const r = await prepare(x.service);
    assert.equal(r.executed, false);
    assert.equal(x.calls.length, 1);
    assert.ok(x.service.listTools().some(t => t.name === 'amcp_write'));
    const unconfirmed = await x.service.call('amcp_write', {...execution(r), confirmed: false}, actor);
    assert.equal(unconfirmed.error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(x.calls.length, 1);
    const out = await x.service.call('amcp_write', execution(r), actor);
    assert.equal(out.success, true);
    assert.equal(out.data.executed, true);
    assert.equal(out.data.data.id, '111');
    assert.equal(x.calls.filter(c => c.method === 'POST').length, 1);
    const replay = await x.service.call('amcp_write', execution(r), actor);
    assert.equal(replay.data.replayed, true);
    assert.equal(x.calls.length, 3);
    assert.equal(x.store.verifyAudit(), true);
  } finally {
    x.store.close();
  }
});
test('reader, tenant, actor, revoked grants, disabled deployment and direct native writes cannot bypass review', async () => {
  const x = setup();
  try {
    const reader = await x.service.call('amcp_write', {action: 'prepare', ...create}, {...actor, role: 'reader'});
    // A read-only client is told so, with the scope it lacks (MCP-09), instead of a generic refusal.
    assert.equal(reader.error.code, 'CONNECTOR_READ_ONLY');
    assert.equal(x.calls.length, 0);
    const r = await prepare(x.service);
    for (const a of [
      {...actor, userId: 'other'},
      {...actor, tenantId: 'other'},
    ]) {
      const result = await x.service.call('amcp_write', execution(r), a);
      assertRefused(result, ['FORBIDDEN', 'NOT_FOUND']);
    }
    const direct = await x.service.call(
      'meta_native_action',
      {...create.arguments, dry_run: false, confirmed: true, idempotency_key: 'x', before_state: {verified: true}},
      actor,
    );
    assert.equal(direct.error.code, 'WRITE_REVIEW_REQUIRED');
    const c = x.store.listConnections('t')[0]!;
    x.store.putConnection(admin, {...c, writeAccounts: []}, x.store.credentials('t', 'c'));
    const revoked = await x.service.call('amcp_write', execution(r), actor);
    assert.equal(revoked.error.code, 'WRITE_ACCOUNT_FORBIDDEN');
    const disabled = new MirrorService(registry, x.store);
    const denied = await disabled.call('amcp_write', execution(r), actor);
    assert.equal(denied.error.code, 'LIVE_WRITES_DISABLED');
    assert.equal(x.calls.filter(c => c.method === 'POST').length, 0);
  } finally {
    x.store.close();
  }
});
test('stale, expired and modified reviews cannot execute and concurrent executions converge on one durable claim', async () => {
  const x = setup();
  try {
    const r = await prepare(x.service);
    x.state.account_status = 2;
    assert.equal((await x.service.call('amcp_write', execution(r), actor)).error.code, 'STATE_CHANGED');
    x.state.account_status = 1;
    assert.equal(
      (await x.service.call('amcp_write', {...execution(r), arguments: {payload: {name: 'tampered'}}}, actor)).error
        .code,
      'INVALID_ARGUMENT',
    );
    const doc = x.store.document('t', 'write_review', r.review_id);
    x.store.putDocument('t', 'write_review', r.review_id, {...doc, expires_at: 0});
    assert.equal((await x.service.call('amcp_write', execution(r), actor)).error.code, 'REVIEW_EXPIRED');
    const fresh = await prepare(x.service);
    const results = await Promise.all([
      x.service.call('amcp_write', execution(fresh), actor),
      x.service.call('amcp_write', execution(fresh), actor),
    ]);
    assert.ok(results.some(r => r.success));
    assert.equal(x.calls.filter(c => c.method === 'POST').length, 1);
  } finally {
    x.store.close();
  }
});
test('uncertain writes never retry; partial failures retain details and durable failed replay', async () => {
  const x = setup();
  try {
    x.mode('lost');
    const r = await prepare(x.service),
      failed = await x.service.call('amcp_write', execution(r), actor);
    assert.equal(failed.error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(x.calls.filter(c => c.method === 'POST').length, 1);
    assert.equal((await x.service.call('amcp_write', execution(r), actor)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(x.calls.filter(c => c.method === 'POST').length, 1);
    x.mode('partial');
    // Another campaign: an identical create is refused at prepare while the first is uncertain (R2.5 M2, L5-06), and this test is
    // about what a partial failure retains, not about that refusal.
    const p = await prepare(x.service, {
        ...create,
        arguments: {...create.arguments, payload: {...create.arguments.payload, name: 'Draft partial'}},
      }),
      partial = await x.service.call('amcp_write', execution(p), actor);
    assert.equal(partial.success, false);
    assert.equal(partial.data.executed, true);
    assert.equal(partial.data.failures[0].value[0].message, 'item failed');
    const replay = await x.service.call('amcp_write', execution(p), actor);
    assertRefused(replay, 'WRITE_PARTIAL_OR_FAILED');
    assert.equal(replay.data.replayed, true);
    assert.equal(x.calls.filter(c => c.method === 'POST').length, 2);
  } finally {
    x.store.close();
  }
});
test('receipt and idempotency survive process restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-write-')),
    file = path.join(dir, 'test.sqlite');
  let store: Store | undefined;
  try {
    const x = setup(file),
      r = await prepare(x.service);
    x.store.close();
    store = new Store(file, key);
    let writes = 0;
    const s = new MirrorService(
      registry,
      store,
      new NativeTransport(
        (async (_url, init) =>
          new Response(
            JSON.stringify(
              init!.method === 'GET' ? {id: 'act_123', currency: 'USD', account_status: 1} : (writes++, {id: '111'}),
            ),
          )) as typeof fetch,
      ),
      undefined,
      policy,
    );
    assert.equal((await s.call('amcp_write', execution(r), actor)).success, true);
    store.close();
    store = new Store(file, key);
    const again = new MirrorService(
      registry,
      store,
      new NativeTransport((async () => {
        throw Error('unexpected egress');
      }) as typeof fetch),
      undefined,
      policy,
    );
    assert.equal((await again.call('amcp_write', execution(r), actor)).data.replayed, true);
    assert.equal(writes, 1);
  } finally {
    store?.close();
    removeTestDirectory(dir, 'amcp-write-');
  }
});
test('unsafe creation, batches, mutation pagination, query mutations and unsupported routes fail before reads', async () => {
  const x = setup();
  try {
    for (const input of [
      {...create, arguments: {...create.arguments, payload: {name: 'Draft'}}},
      {...create, arguments: {...create.arguments, payload: {name: 'Live', status: 'ACTIVE'}}},
      {...create, arguments: {...create.arguments, aggregate_pages: true}},
      {...create, arguments: {...create.arguments, query: {daily_budget: '100'}}},
      {
        gateway: 'meta_native_action',
        arguments: {action: 'meta_batch_create', batch: [{method: 'POST', relative_url: 'act_999/campaigns'}]},
      },
    ])
      assertRefused(await x.service.call('amcp_write', {action: 'prepare', ...input}, actor), [
        'INVALID_META_CAMPAIGN',
        'MUTATION_PAGINATION_FORBIDDEN',
        'WRITE_CONTRACT_UNAVAILABLE',
      ]);
    assert.equal(x.calls.length, 0);
  } finally {
    x.store.close();
  }
});
test('state response validation rejects missing targets, partial failure and next-page indicators', () => {
  const plan = {
    gateway: 'google_ads_native_action',
    accountId: '123',
    body: {
      query:
        "SELECT campaign.resource_name FROM campaign WHERE campaign.resource_name IN ('customers/123/campaigns/1', 'customers/123/campaigns/2')",
    },
  } as any;
  const result = (data: unknown) => ({data, status: 200, headers: {}});
  assert.throws(() => validateState(plan, result({})), {code: 'STATE_READ_FAILED'});
  assert.throws(
    () => validateState(plan, result({results: [{campaign: {resourceName: 'customers/123/campaigns/1'}}]})),
    {code: 'STATE_TARGET_MISMATCH'},
  );
  assert.throws(() => validateState(plan, result({results: [], partialFailureError: {code: 3}})), {
    code: 'STATE_READ_FAILED',
  });
  for (const data of [{paging: {next_link: 'next'}}, {next_cursor: 'x'}, {paging: {links: [{rel: 'next'}]}}])
    assert.throws(() => validateState(plan, result(data)), {code: 'INCOMPLETE_STATE'});
  // Failed outcomes, not refusals: each names the path that failed and is never retried.
  const failed = (data: unknown) => {
    const outcome = writeOutcome(result(data));
    assert.equal(outcome.outcome, 'partial_or_failed');
    assert.equal(outcome.retry_safe, false);
    return (outcome.failures as JsonObject[]).map(f => f.path);
  };
  assert.deepEqual(failed({results: [{status: 400}]}), ['$.results[0].status']);
  assert.deepEqual(failed({}), ['$']);
});
test('Google masks use protobuf JSON casing and LinkedIn empty 201 retains its created ID', async () => {
  let body: any;
  const transport = new NativeTransport((async (_url, init) => {
    body = JSON.parse(String(init!.body));
    return new Response('{"results":[{"resourceName":"customers/123/adGroups/1"}]}');
  }) as typeof fetch);
  const plan = registry.action('google_ads_native_action', 'google_ads_v23_ad_group_mutate_ad_groups')!;
  const compiled = new Compiler(registry).compile(
    'google_ads_native_action',
    {
      action: plan.name,
      account_id: '123',
      payload: {
        operations: [
          {update: {resource_name: 'customers/123/adGroups/1', cpc_bid_micros: '200'}, update_mask: 'cpc_bid_micros'},
        ],
      },
    },
    {mode: 'strict', flags: {}},
  );
  await transport.request(
    compiled,
    {id: 'c', tenantId: 't', gateway: compiled.gateway, accounts: ['123'], label: 'x', enabled: true, scopes: []},
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  assert.equal(body.operations[0].updateMask, 'cpcBidMicros');
  const li = new NativeTransport(
      (async () => new Response(null, {status: 201, headers: {'x-restli-id': '333'}})) as typeof fetch,
    ),
    request = {
      ...compiled,
      gateway: 'linkedin_native_action',
      path: '/rest/adAccounts/123/adCampaigns',
      headers: {},
      body: {name: 'Draft'},
    };
  const outcome = writeOutcome(
    await li.request(
      request,
      {id: 'l', tenantId: 't', gateway: request.gateway, accounts: ['123'], label: 'x', enabled: true, scopes: []},
      {accessToken: 'synthetic'},
    ),
  );
  assert.equal(outcome.success, true);
  assert.equal(outcome.created_id, '333');
});
