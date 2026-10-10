import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ownershipReads} from '../dist/src/scope.js';
import {MirrorError, errorResult} from '../dist/src/errors.js';

// MCP-09: refusals that pointed at reviews that did not exist, a read-only deployment that validated before refusing,
// a generic refusal for read-only clients, inspect misreporting formatted grants, next_call hints with undeclared
// effects and handoff links that were relative or named the wrong ID.
const registry = new Registry(),
  key = Buffer.alloc(32, 91).toString('base64'),
  writes = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  meta = '00000000-0000-4000-8000-000000000091',
  google = '00000000-0000-4000-8000-000000000092',
  reddit = '00000000-0000-4000-8000-000000000093';
function fixture({
  allowWrites = true,
  role = 'operator',
  metaAccounts = ['act_123'],
  googleAccounts = ['123-456-7890'],
  respond = () => ({data: []}),
} = {}) {
  const store = new Store(':memory:', key),
    admin = {tenantId: 'refusals', userId: 'owner', role: 'admin'},
    actor = {...admin, userId: 'person', role},
    requests = [];
  store.ensureTenant(admin.tenantId);
  for (const [id, gateway, accounts] of [
    [meta, 'meta_native_action', metaAccounts],
    [google, 'google_ads_native_action', googleAccounts],
    [reddit, 'reddit_native_action', ['t2_1']],
  ])
    store.putConnection(
      admin,
      {
        id,
        tenantId: admin.tenantId,
        gateway,
        accounts,
        writeAccounts: accounts,
        enabled: true,
        label: gateway,
        scopes: [],
        userAgent: 'synthetic-refusals/1.0',
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
  const transport = new NativeTransport(async (url, init = {}) => {
    requests.push({method: init.method ?? 'GET', url: String(url)});
    return Response.json(respond(new URL(String(url)), init));
  });
  const service = new MirrorService(registry, store, transport, undefined, allowWrites ? writes : undefined);
  return {store, admin, actor, service, requests, close: () => store.close()};
}
const campaign = {
  action: 'meta_campaign_create',
  account_id: '123',
  connection_id: meta,
  payload: {
    name: 'Synthetic',
    status: 'PAUSED',
    objective: 'OUTCOME_TRAFFIC',
    special_ad_categories: [],
    is_adset_budget_sharing_enabled: false,
  },
};

test('a native write with dry_run:false is refused first with a next_call amcp_write inspect accepts', async () => {
  const f = fixture();
  try {
    // The three inputs an assistant tried in turn: each used to fail on a check written for a review that did not exist.
    for (const extra of [
      {dry_run: false},
      {dry_run: false, confirmed: true},
      {dry_run: false, confirmed: true, idempotency_key: 'synthetic-key'},
    ]) {
      const r = await f.service.call('meta_native_action', {...campaign, ...extra}, f.actor);
      assert.equal(r.success, false);
      assert.equal(r.error.code, 'WRITE_REVIEW_REQUIRED', JSON.stringify(r.error));
      assert.match(r.error.next_action, /details\.next_call/);
      const next = r.error.details.next_call;
      assert.equal(next.tool, 'amcp_write');
      assert.equal(next.arguments.action, 'inspect');
      assert.equal(next.arguments.gateway, 'meta_native_action');
      for (const flag of ['dry_run', 'confirmed', 'idempotency_key'])
        assert.equal(next.arguments.arguments[flag], undefined, flag);
      const inspected = await f.service.call(next.tool, next.arguments, f.actor);
      assert.equal(inspected.success, true, JSON.stringify(inspected.error));
      assert.equal(inspected.data.review_contract_supported, true);
    }
    // Without dry_run the write is still a preview, and nothing reached the provider.
    const preview = await f.service.call('meta_native_action', campaign, f.actor);
    assert.equal(preview.data.dry_run, true);
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});
test('a delegated native write is refused the same way, with the operation kept in next_call', async () => {
  const f = fixture();
  try {
    const r = await f.service.call(
      'reddit_native_action',
      {
        operation: 'reddit_campaign_ops',
        arguments: {
          action: 'UPDATE_CAMPAIGN',
          account_id: 't2_1',
          connection_id: reddit,
          params: {campaign_id: '1'},
          payload: {data: {name: 'Synthetic'}},
          dry_run: false,
          confirmed: true,
        },
      },
      f.actor,
    );
    assert.equal(r.error.code, 'WRITE_REVIEW_REQUIRED', JSON.stringify(r.error));
    const next = r.error.details.next_call;
    assert.equal(next.arguments.gateway, 'reddit_native_action');
    assert.equal(next.arguments.arguments.operation, 'reddit_campaign_ops');
    assert.equal(next.arguments.arguments.arguments.dry_run, undefined);
    assert.equal(next.arguments.arguments.arguments.confirmed, undefined);
    const inspected = await f.service.call(next.tool, next.arguments, f.actor);
    assert.equal(inspected.success, true, JSON.stringify(inspected.error));
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});
test('a workflow mutation (amcp_native_action) is refused first with the inspect call of its compiled request', async () => {
  const f = fixture();
  try {
    const r = await f.service.call(
      'amcp_native_action',
      {
        operation: 'update_entities',
        arguments: {
          platform: 'google',
          account_id: '1234567890',
          entity_type: 'campaign',
          entity_id: '222',
          updates: {name: 'Draft'},
          dry_run: false,
        },
      },
      f.actor,
    );
    // It used to stop at DRY_RUN or CONFIRMATION checks written for a review that does not exist here.
    assert.equal(r.error.code, 'WRITE_REVIEW_REQUIRED', JSON.stringify(r.error));
    const next = r.error.details.next_call;
    assert.equal(next.arguments.action, 'inspect');
    assert.equal(next.arguments.gateway, 'google_ads_native_action');
    assert.equal(next.arguments.arguments.dry_run, undefined);
    const inspected = await f.service.call(next.tool, next.arguments, f.actor);
    assert.equal(inspected.success, true, JSON.stringify(inspected.error));
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});
test('a read-only deployment refuses prepare and execute first, names no setting, and lists inspect only', async () => {
  const f = fixture({allowWrites: false});
  try {
    for (const input of [
      {action: 'prepare', gateway: 'meta_native_action', arguments: {action: 'meta_campaign_create'}},
      {action: 'prepare', gateway: 'meta_native_action', arguments: campaign},
      {action: 'prepare', invented: true},
      {action: 'execute', review_id: 'none'},
    ]) {
      const r = await f.service.call('amcp_write', input, f.actor);
      assert.equal(r.error.code, 'LIVE_WRITES_DISABLED', JSON.stringify(r.error));
      assert.doesNotMatch(r.error.message, /MIRROR_|ALLOW_WRITES|=/);
      assert.match(r.error.message, /read-only; its operator can enable reviewed writes/);
    }
    const refused = await f.service.call(
      'amcp_write',
      {action: 'prepare', gateway: 'meta_native_action', arguments: campaign},
      f.actor,
    );
    assert.equal(refused.error.details.next_call.arguments.action, 'inspect');
    const native = await f.service.call('meta_native_action', {...campaign, dry_run: false}, f.actor);
    assert.equal(native.error.code, 'LIVE_WRITES_DISABLED');
    assert.equal(native.error.details.next_call.arguments.action, 'inspect');
    // Owner decision D15: the tool is listed, truthfully, with inspect only; inspect still works.
    const listed = f.service.listTools().find(t => t.name === 'amcp_write');
    assert.deepEqual(listed.inputSchema.properties.action.enum, ['inspect']);
    assert.equal(listed.annotations.readOnlyHint, true);
    const inspected = await f.service.call(
      'amcp_write',
      {action: 'inspect', gateway: 'meta_native_action', arguments: campaign},
      f.actor,
    );
    assert.equal(inspected.success, true, JSON.stringify(inspected.error));
    assert.equal(inspected.data.requirements.deployment_writes_enabled, false);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents WHERE kind<>'service_timings'").get().n, 0);
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});
test('a read-only client gets CONNECTOR_READ_ONLY before its payload is checked', async () => {
  const f = fixture({role: 'reader'});
  try {
    for (const input of [
      {action: 'prepare', gateway: 'meta_native_action', arguments: {action: 'meta_campaign_create'}},
      {action: 'prepare', gateway: 'meta_native_action', arguments: campaign},
      {action: 'execute', review_id: 'none'},
    ]) {
      const r = await f.service.call('amcp_write', input, f.actor);
      assert.equal(r.error.code, 'CONNECTOR_READ_ONLY', JSON.stringify(r.error));
      assert.deepEqual(r.error.details, {granted_scope: 'mcp:read', required_scope: 'mcp:write'});
      assert.equal(r.error.category, 'grant');
      assert.match(r.error.next_action, /Reconnect the AI client with write access/);
    }
    const native = await f.service.call('meta_native_action', {...campaign, dry_run: false}, f.actor);
    assert.equal(native.error.code, 'CONNECTOR_READ_ONLY');
    const viewer = await f.service.call(
      'amcp_write',
      {action: 'prepare', gateway: 'meta_native_action', arguments: campaign},
      {...f.actor, membershipRole: 'viewer'},
    );
    assert.equal(viewer.error.details.membership_role, 'viewer');
    // A read-only client may still inspect.
    const inspected = await f.service.call(
      'amcp_write',
      {action: 'inspect', gateway: 'meta_native_action', arguments: campaign},
      f.actor,
    );
    assert.equal(inspected.success, true);
    assert.equal(inspected.data.requirements.operator_role, false);
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});
test('inspect reports a formatted account ID as granted the way enforcement compares it', async () => {
  for (const granted of [true, false]) {
    const f = fixture({metaAccounts: ['act_123'], googleAccounts: ['123-456-7890']});
    try {
      if (!granted)
        for (const [id, gateway, account] of [
          [meta, 'meta_native_action', 'act_123'],
          [google, 'google_ads_native_action', '123-456-7890'],
        ])
          f.store.putConnection(
            f.admin,
            {
              id,
              tenantId: f.admin.tenantId,
              gateway,
              accounts: [account],
              writeAccounts: [],
              enabled: true,
              label: gateway,
              scopes: [],
            },
            {accessToken: 'synthetic', developerToken: 'synthetic'},
          );
      const metaInspect = await f.service.call(
        'amcp_write',
        {action: 'inspect', gateway: 'meta_native_action', arguments: campaign},
        f.actor,
      );
      assert.equal(metaInspect.data.account_capability.write_granted, granted, JSON.stringify(metaInspect.data));
      const googleInspect = await f.service.call(
        'amcp_write',
        {
          action: 'inspect',
          gateway: 'google_ads_native_action',
          arguments: {
            action: 'google_ads_v23_campaign_asset_mutate_campaign_assets',
            account_id: '1234567890',
            connection_id: google,
            payload: {
              operations: [
                {
                  create: {
                    campaign: 'customers/1234567890/campaigns/1',
                    asset: 'customers/1234567890/assets/2',
                    fieldType: 'SITELINK',
                  },
                },
              ],
            },
          },
        },
        f.actor,
      );
      assert.equal(googleInspect.success, true, JSON.stringify(googleInspect.error));
      assert.equal(
        googleInspect.data.account_capability.write_granted,
        granted,
        JSON.stringify(googleInspect.data.account_capability),
      );
    } finally {
      f.close();
    }
  }
});
test('an ownership refusal for a typed Meta action names its one list read, which leads to a review', async () => {
  const f = fixture({
    respond: url =>
      url.pathname.endsWith('/act_123/campaigns')
        ? {data: [{id: '999'}]}
        : url.pathname.endsWith('/act_123')
          ? {id: 'act_123', account_id: '123', currency: 'USD', account_status: 1}
          : {id: '999', account_id: '123', name: 'Before', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC'},
  });
  try {
    const update = {
      action: 'prepare',
      gateway: 'meta_native_action',
      arguments: {
        action: 'meta_campaign_update',
        account_id: '123',
        connection_id: meta,
        path_params: {campaign_id: '999'},
        payload: {name: 'After'},
      },
    };
    const refused = await f.service.call('amcp_write', update, f.actor);
    assert.equal(refused.error.code, 'RESOURCE_SCOPE_REQUIRED', JSON.stringify(refused.error));
    // It used to offer five candidate lists and point at a next_call it did not carry.
    assert.equal(refused.error.details.ownership_reads.length, 1);
    assert.equal(refused.error.details.next_call.arguments.action, 'meta_campaign_list');
    assert.match(refused.error.next_action, /details\.next_call/);
    const next = refused.error.details.next_call,
      read = await f.service.call(next.tool, next.arguments, f.actor);
    assert.equal(read.success, true, JSON.stringify(read.error));
    const prepared = await f.service.call('amcp_write', update, f.actor);
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    assert.equal(typeof prepared.data.review_id, 'string');
    // An ID whose type the route does not name still lists every candidate, and the remedy says to choose by type.
    const candidates = ownershipReads('meta_native_action', '/v26.0/555', '123', meta, '/v26.0/{ad_label_id}');
    assert.equal(candidates.length, 5);
    assert.equal(ownershipReads('meta_native_action', '/v26.0/555', '123', meta, '/v26.0/{ad_set_id}').length, 1);
    const ambiguous = errorResult(
      new MirrorError('RESOURCE_SCOPE_REQUIRED', 'Resource ownership is not established.', {
        ownership_reads: candidates,
      }),
      'synthetic',
      0,
    );
    assert.match(ambiguous.error.next_action, /details\.ownership_reads that matches the object/);
    assert.doesNotMatch(ambiguous.error.next_action, /details\.next_call/);
    assert.ok(
      f.requests.every(r => r.method === 'GET'),
      JSON.stringify(f.requests),
    );
  } finally {
    f.close();
  }
});
/** Every next_call object in a result, however deep. */
function nextCalls(value, found = []) {
  if (Array.isArray(value)) value.forEach(v => nextCalls(v, found));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (k === 'next_call' && v && typeof v === 'object') found.push(v);
      nextCalls(v, found);
    }
  return found;
}
/** Document rows by kind and ID, so a rewritten record counts as saved too. */
const rows = store =>
  new Map(
    store.db
      .prepare("SELECT kind, id, data FROM documents WHERE kind<>'service_timings'")
      .all()
      .map(r => [r.kind + '/' + r.id, r.data]),
  );
const savedKinds = (before, after) =>
  [...new Set([...after].filter(([key, data]) => before.get(key) !== data).map(([key]) => key.split('/')[0]))].sort();
test('suggested check and program_check calls declare their effects, and check saves exactly what it declares', async () => {
  const f = fixture({
    metaAccounts: ['123'],
    respond: url =>
      url.pathname.endsWith('/act_123')
        ? {id: 'act_123', account_id: '123', name: 'Synthetic account', currency: 'USD', timezone_name: 'UTC'}
        : {data: []},
  });
  try {
    const listed = await f.service.call(
      'amcp_platform_workspace',
      {operation: 'list_accounts', arguments: {}},
      f.actor,
    );
    const suggested = nextCalls(listed.data).filter(c => c.arguments?.action === 'check');
    assert.ok(suggested.length >= 1);
    for (const call of suggested)
      assert.deepEqual(call.effects, {
        provider_requests: 'read_only',
        saves: ['readiness', 'account_metadata'],
        advertising_writes: 0,
      });
    const summary = await f.service.call('amcp_workspace', {action: 'capabilities'}, f.actor);
    assert.deepEqual(summary.data.account_next_call.effects.check, {
      provider_requests: 'none',
      saves: [],
      advertising_writes: 0,
    });
    assert.deepEqual(summary.data.account_next_call.effects.program_check, {
      provider_requests: 'none',
      saves: [],
      advertising_writes: 0,
    });
    for (const view of [{connection_id: meta, account_id: '123'}, {view: 'graph'}]) {
      const capabilities = await f.service.call('amcp_workspace', {action: 'capabilities', ...view}, f.actor),
        calls = nextCalls(capabilities.data).filter(c => ['check', 'program_check'].includes(c.arguments?.action));
      assert.ok(calls.length > 0, JSON.stringify(view));
      for (const call of calls) {
        assert.equal(call.effects.advertising_writes, 0);
        assert.equal(call.effects.provider_requests, call.arguments.live === true ? 'read_only' : 'none');
        assert.deepEqual(
          call.effects.saves,
          call.arguments.live !== true
            ? []
            : call.arguments.action === 'check'
              ? ['readiness', 'account_metadata']
              : ['conditional_program_observation'],
        );
      }
    }
    // The declared effects are what check does: compare the records saved and the provider requests made.
    for (const live of [false, true]) {
      const before = rows(f.store),
        requests = f.requests.length,
        args = {...suggested.find(s => s.arguments.connection_id === meta).arguments, live},
        declared = nextCalls({next_call: {tool: 'amcp_workspace', arguments: args}})[0],
        result = await f.service.call('amcp_workspace', args, f.actor);
      assert.equal(result.success, true, JSON.stringify(result.error));
      const saved = savedKinds(before, rows(f.store)),
        expected = live ? ['account_metadata', 'readiness'] : [];
      assert.deepEqual(saved, expected);
      assert.equal(f.requests.length > requests, live);
      assert.ok(f.requests.slice(requests).every(r => r.method === 'GET'));
      const {callEffects} = await import('../dist/src/workflow-outcomes.js');
      assert.deepEqual([...callEffects(declared).saves].sort(), expected);
      assert.equal(callEffects(declared).provider_requests, live ? 'read_only' : 'none');
    }
    const program = await f.service.call(
      'amcp_workspace',
      {action: 'program_check', workflow_id: 'program:linkedin_forecast', live: false},
      f.actor,
    );
    for (const call of nextCalls(program.data ?? {}))
      if (call.tool === 'amcp_workspace') assert.equal(call.effects?.advertising_writes, 0, JSON.stringify(call));
  } finally {
    f.close();
  }
});
