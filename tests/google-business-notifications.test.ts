import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {DelegatedNativeCompiler} from '../src/delegated-native.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {actionContracts} from '../src/action-contracts.js';
import {applyExecutionRisk} from '../src/execution-risk.js';
import {
  businessNotificationTypes,
  retiredBusinessNotificationTypes,
  readBusinessNotificationState,
} from '../src/google-business-notifications.js';
import {removeTestDirectory} from './temp.js';
import type {Connection, JsonObject} from '../src/types.js';

const gateway = 'google_business_native_action',
  operation = 'gmb_notification_ops',
  registry = new Registry(),
  actor = {tenantId: 'business-notifications', userId: 'owner', role: 'admin' as const},
  key = Buffer.alloc(32, 43).toString('base64'),
  name = 'accounts/123/notificationSetting';
const input = (
  body: JsonObject = {
    pubsubTopic: 'projects/amcp-test/topics/new-reviews',
    notificationTypes: ['NEW_REVIEW', 'UPDATED_REVIEW'],
  },
  extra: JsonObject = {},
) => ({
  operation,
  arguments: {
    action: 'UPDATE_NOTIFICATION_SETTING',
    account_id: '123',
    payload: {name, ...body},
    query: {
      updateMask: Object.keys(body)
        .filter(k => k !== 'name')
        .join(','),
    },
    ...extra,
  },
});
const clear = () => input({pubsubTopic: '', notificationTypes: []});
function fixture(file = ':memory:') {
  const store = new Store(file, key),
    calls: JsonObject[] = [],
    account: JsonObject = {
      name: 'accounts/123',
      accountName: 'Synthetic Group',
      type: 'LOCATION_GROUP',
      role: 'OWNER',
      permissionLevel: 'OWNER_LEVEL',
      verificationState: 'VERIFIED',
    },
    setting: JsonObject = {
      name,
      pubsubTopic: 'projects/amcp-test/topics/existing-reviews',
      notificationTypes: ['NEW_REVIEW'],
    };
  const connection: Connection = {
    id: 'bbf65e69-9655-438c-8f8f-7b29252d5448',
    tenantId: actor.tenantId,
    gateway,
    label: 'Synthetic',
    enabled: true,
    accounts: ['123'],
    writeAccounts: ['123'],
    scopes: ['https://www.googleapis.com/auth/business.manage'],
  };
  const provision = (change: Partial<Connection> = {}) =>
    store.putConnection(actor, {...connection, ...change}, {accessToken: 'synthetic'});
  if (!store.listConnections(actor.tenantId).length) provision();
  let mode = 'success',
    reads = 0;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        method = init?.method ?? 'GET',
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({origin: u.origin, path: u.pathname, method, query: Object.fromEntries(u.searchParams), body});
      if (method === 'GET') {
        reads++;
        if (mode === 'revoke_scope') provision({scopes: []});
        if (mode === 'revoke_write') provision({writeAccounts: []});
        if (mode === 'revoke_account') provision({accounts: ['999'], writeAccounts: ['999']});
        if (mode === 'forbidden')
          return Response.json({error: {code: 403, message: 'Synthetic denied'}}, {status: 403});
        if (mode === 'missing') return Response.json({error: {code: 404, message: 'Synthetic missing'}}, {status: 404});
        if (mode === 'error') return Response.json({error: {code: 3, message: 'Synthetic failure'}});
        if (mode === 'empty') return Response.json({});
        if (u.pathname === '/v1/accounts/123') {
          assert.equal(u.origin, 'https://mybusinessaccountmanagement.googleapis.com');
          return Response.json({
            ...account,
            ...(mode === 'telemetry'
              ? {
                  verificationState: reads % 2 ? 'VERIFIED' : 'UNVERIFIED',
                  organizationInfo: {address: {addressLines: ['Unrelated provider address ' + reads]}},
                }
              : {}),
            ...(mode === 'foreign' ? {name: 'accounts/999'} : {}),
            ...(mode === 'moving' && reads % 4 === 3 ? {role: 'MANAGER'} : {}),
            ...(mode === 'oversize' ? {accountName: 'x'.repeat(2 * 1024 * 1024)} : {}),
          });
        }
        assert.equal(u.origin, 'https://mybusinessnotifications.googleapis.com');
        assert.equal(u.pathname, '/v1/' + name);
        const value = structuredClone(setting);
        if (reads % 4 === 0) value.notificationTypes?.reverse();
        if (mode === 'defaults') {
          if (value.pubsubTopic === '') delete value.pubsubTopic;
          if (!value.notificationTypes?.length) delete value.notificationTypes;
        }
        return Response.json({
          ...value,
          ...(mode === 'unknown' ? {warnings: ['incomplete']} : {}),
          ...(mode === 'partial' ? {nextPageToken: 'unread'} : {}),
        });
      }
      assert.equal(method, 'PATCH');
      assert.equal(u.origin, 'https://mybusinessnotifications.googleapis.com');
      assert.equal(u.pathname, '/v1/' + name);
      if (mode === 'lost') throw Error('Synthetic lost response');
      if (mode === 'empty_receipt') return Response.json({});
      if (mode === 'error_receipt') return Response.json({error: {code: 3, message: 'Synthetic failed write'}});
      const result = {...structuredClone(setting), ...body};
      if (mode !== 'ignored') Object.assign(setting, structuredClone(result));
      if (mode === 'foreign_receipt') result.name = 'accounts/999/notificationSetting';
      if (mode === 'wrong_receipt') result.pubsubTopic = 'projects/amcp-test/topics/wrong';
      if (mode === 'defaults') {
        if (!result.pubsubTopic) delete result.pubsubTopic;
        if (!result.notificationTypes.length) delete result.notificationTypes;
      }
      return Response.json(result);
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
  const prepare = (args: JsonObject = input(), who: JsonObject = actor) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: args}, who as any);
  const execute = (r: JsonObject, extra: JsonObject = {}, who: JsonObject = actor) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: r.data.review_id,
        idempotency_key: r.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      who as any,
    );
  return {
    store,
    service,
    calls,
    account,
    setting,
    connection,
    provision,
    prepare,
    execute,
    mode: (v: string) => {
      mode = v;
    },
    writes: () => calls.filter(c => c.method !== 'GET').length,
  };
}
async function prepared(f: ReturnType<typeof fixture>, args: JsonObject = input()) {
  const r = await f.prepare(args);
  assert.equal(r.success, true, JSON.stringify(r));
  return r;
}

test('notification topic/type changes execute once and verify the exact account-wide configuration', async () => {
  const f = fixture();
  try {
    const r = await prepared(f);
    assert.equal(r.data.creative_impact.previous_topic, f.setting.pubsubTopic);
    assert.match(r.data.creative_impact.effect, /future locations/);
    assert.equal((await f.execute(r)).success, true);
    const v = await f.service.verifyWrite(actor, r.data.review_id);
    assert.equal(v.status, 'verified', JSON.stringify(v));
    assert.equal((await f.execute(r)).data.replayed, true);
    assert.equal(f.writes(), 1);
    assert.ok(
      f.calls.every(c =>
        [
          'https://mybusinessnotifications.googleapis.com',
          'https://mybusinessaccountmanagement.googleapis.com',
        ].includes(c.origin),
      ),
    );
  } finally {
    f.store.close();
  }
});
test('both mutable fields work independently without resetting the unmasked configuration', async () => {
  const f = fixture();
  try {
    for (const args of [
      input({pubsubTopic: 'projects/amcp-test/topics/budget-alerts'}),
      input({notificationTypes: ['NEW_REVIEW', 'VOICE_OF_MERCHANT_UPDATED']}),
    ]) {
      const r = await prepared(f, args);
      assert.equal((await f.execute(r, {spend_change_confirmed: false})).success, true);
      assert.equal((await f.service.verifyWrite(actor, r.data.review_id)).status, 'verified');
    }
    assert.equal(f.setting.pubsubTopic, 'projects/amcp-test/topics/budget-alerts');
    assert.deepEqual(f.setting.notificationTypes, ['NEW_REVIEW', 'VOICE_OF_MERCHANT_UPDATED']);
  } finally {
    f.store.close();
  }
});
test('explicit complete clearing is destructive and verifies ProtoJSON omitted defaults', async () => {
  const f = fixture();
  try {
    f.mode('defaults');
    const r = await prepared(f, clear());
    assert.equal(r.data.request.destructive, true);
    assert.equal((await f.execute(r)).success, true);
    assert.equal((await f.service.verifyWrite(actor, r.data.review_id)).status, 'verified');
    assert.equal(f.setting.pubsubTopic, '');
    assert.deepEqual(f.setting.notificationTypes, []);
  } finally {
    f.store.close();
  }
});
test('current empty native settings can be configured, while a failed or unidentified read cannot', async () => {
  const f = fixture();
  try {
    delete f.setting.pubsubTopic;
    delete f.setting.notificationTypes;
    const r = await prepared(f);
    assert.equal((await f.execute(r)).success, true);
    assert.equal((await f.service.verifyWrite(actor, r.data.review_id)).status, 'verified');
  } finally {
    f.store.close();
  }
  for (const mode of [
    'missing',
    'forbidden',
    'error',
    'empty',
    'foreign',
    'moving',
    'unknown',
    'partial',
    'oversize',
  ]) {
    const f = fixture();
    try {
      f.mode(mode);
      assert.equal((await f.prepare()).success, false, mode);
      assert.equal(f.writes(), 0);
      assert.equal(f.store.documents(actor.tenantId, 'write_review').length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('event ordering and unrelated account verification telemetry are stable; topic/events/authority changes conflict', async () => {
  const f = fixture();
  try {
    f.setting.notificationTypes = ['UPDATED_REVIEW', 'NEW_REVIEW'];
    let r = await prepared(f);
    f.mode('telemetry');
    assert.equal((await f.execute(r)).success, true);
    f.mode('success');
    for (const change of [
      () => (f.setting.pubsubTopic = 'projects/amcp-test/topics/changed'),
      () => (f.setting.notificationTypes = ['GOOGLE_UPDATE']),
      () => (f.account.role = 'MANAGER'),
      () => (f.account.accountName = 'Renamed'),
    ]) {
      r = await prepared(f);
      change();
      const out = await f.execute(r);
      assert.equal(out.error.code, 'STATE_CHANGED');
      assert.ok(out.error.details.changed_fields.length);
    }
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('only current workspace administrators can configure account-wide notification destinations', async () => {
  const f = fixture();
  try {
    for (const who of [
      {...actor, role: 'operator'},
      {...actor, role: 'reader'},
      {...actor, testAccount: true},
    ])
      assert.equal((await f.prepare(input(), who)).success, false);
    assert.equal(f.calls.length, 0);
    const r = await prepared(f);
    assert.equal((await f.execute(r, {}, {...actor, role: 'operator'})).error.code, 'ADMIN_REQUIRED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('credential-free inspect states the administrator requirement independently of route support', async () => {
  const f = fixture();
  try {
    const r = await f.service.call(
      'amcp_write',
      {action: 'inspect', gateway, arguments: input()},
      {...actor, role: 'operator'},
    );
    assert.equal(r.data.review_contract_supported, true);
    assert.equal(r.data.requirements.administrator_role_required, true);
    assert.equal(r.data.requirements.administrator_role, false);
    assert.equal(r.data.network_requests, 0);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('exact account grants, current scopes and disabled connections are checked before provider reads', async () => {
  for (const change of [
    {accounts: ['locations/123'], writeAccounts: ['locations/123']},
    {writeAccounts: []},
    {scopes: ['https://www.googleapis.com/auth/adwords']},
    {enabled: false},
  ]) {
    const f = fixture();
    try {
      f.provision(change);
      assert.equal((await f.prepare()).success, false);
      assert.equal(f.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('revocation in flight prevents execution and verification from using stale authority', async () => {
  for (const mode of ['revoke_account', 'revoke_scope', 'revoke_write']) {
    const f = fixture();
    try {
      const r = await prepared(f);
      f.mode(mode);
      assert.equal((await f.execute(r)).success, false);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
  for (const mode of ['revoke_account', 'revoke_scope']) {
    const f = fixture();
    try {
      const r = await prepared(f);
      assert.equal((await f.execute(r)).success, true);
      f.mode(mode);
      assert.notEqual((await f.service.verifyWrite(actor, r.data.review_id)).status, 'verified');
    } finally {
      f.store.close();
    }
  }
});
test('unknown and retired types, injected destinations, foreign names and vague masks fail before egress', async () => {
  const f = fixture();
  try {
    for (const args of [
      input({notificationTypes: ['NEW_QUESTION']}),
      input({notificationTypes: ['LOSS_OF_VOICE_OF_MERCHANT']}),
      input({notificationTypes: ['NOTIFICATION_TYPE_UNSPECIFIED']}),
      input({notificationTypes: ['NEW_REVIEW', 'NEW_REVIEW']}),
      input({pubsubTopic: 'https://example.com/hook'}),
      input({pubsubTopic: 'projects/amcp-test/topics/*'}),
      input({pubsubTopic: 'projects/amcp-test/topics/goog-reserved'}),
      input({pubsubTopic: 'projects/amcp-test/topics/a'}),
      input({name: 'accounts/999/notificationSetting', notificationTypes: ['NEW_REVIEW']}),
      input({notificationTypes: ['NEW_REVIEW']}, {query: {updateMask: '*'}}),
      input({notificationTypes: ['NEW_REVIEW']}, {query: {updateMask: 'pubsubTopic'}}),
      input({pubsubTopic: ''}),
      input({notificationTypes: []}),
      input(undefined, {query: {updateMask: 'pubsubTopic,notificationTypes', fields: 'name'}}),
    ])
      assert.equal((await f.prepare(args)).success, false, JSON.stringify(args));
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('legacy retired subscriptions can be explicitly migrated or disabled but never silently retained on enable', async () => {
  const f = fixture();
  try {
    f.setting.notificationTypes = ['NEW_QUESTION', 'LOSS_OF_VOICE_OF_MERCHANT'];
    assert.equal((await f.prepare(input({pubsubTopic: 'projects/amcp-test/topics/new-reviews'}))).success, false);
    const r = await prepared(f, input({notificationTypes: ['NEW_REVIEW', 'VOICE_OF_MERCHANT_UPDATED']}));
    assert.deepEqual(r.data.before_state[0].setting.notificationTypes, ['LOSS_OF_VOICE_OF_MERCHANT', 'NEW_QUESTION']);
    assert.equal((await f.execute(r)).success, true);
    assert.equal((await f.service.verifyWrite(actor, r.data.review_id)).status, 'verified');
    f.setting.notificationTypes = ['UPDATED_ANSWER'];
    const stopped = await prepared(f, clear());
    assert.equal((await f.execute(stopped)).success, true);
    assert.equal((await f.service.verifyWrite(actor, stopped.data.review_id)).status, 'verified');
  } finally {
    f.store.close();
  }
});
test('owner activation/deletion policies cover PATCH enablement and explicit clearing at prepare and execute', async () => {
  const f = fixture();
  try {
    let r = await prepared(f);
    saveSpendPolicy(f.store, actor, {scope: 'workspace', confirmed: true, policy: {allow_activation: false}});
    assert.equal((await f.execute(r)).error.code, 'POLICY_ACTIVATION_FORBIDDEN');
    assert.equal((await f.prepare()).error.code, 'POLICY_ACTIVATION_FORBIDDEN');
    r = await prepared(f, clear());
    saveSpendPolicy(f.store, actor, {scope: 'workspace', confirmed: true, policy: {allow_deletion: false}});
    assert.equal((await f.execute(r)).error.code, 'POLICY_DELETION_FORBIDDEN');
    assert.equal((await f.prepare(clear())).error.code, 'POLICY_DELETION_FORBIDDEN');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('ignored writes are inconclusive and unrecognized or lost receipts are durably non-retryable', async () => {
  for (const mode of ['lost', 'empty_receipt', 'error_receipt', 'foreign_receipt', 'wrong_receipt']) {
    const f = fixture();
    try {
      const r = await prepared(f);
      f.mode(mode);
      assert.equal((await f.execute(r)).success, false, mode);
      await f.execute(r);
      assert.equal(f.writes(), 1);
      await assert.rejects(() => f.service.verifyWrite(actor, r.data.review_id));
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const r = await prepared(f);
    f.mode('ignored');
    assert.equal((await f.execute(r)).success, true);
    assert.equal((await f.service.verifyWrite(actor, r.data.review_id)).status, 'inconclusive');
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('concurrent execution and database reopen preserve a single durable PATCH claim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amcp-business-notices-')),
    file = join(directory, 'test.sqlite');
  let f = fixture(file);
  try {
    const r = await prepared(f),
      out = await Promise.all([f.execute(r), f.execute(r)]);
    assert.ok(out.some(o => o.success));
    assert.equal(f.writes(), 1);
    f.store.close();
    f = fixture(file);
    assert.equal((await f.execute(r)).data.replayed, true);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
    removeTestDirectory(directory, 'amcp-business-notices-');
  }
});
test('frozen reviews cannot switch connections, actors, tenants, destinations or bypass expiry', async () => {
  const f = fixture();
  try {
    let r = await prepared(f);
    for (const who of [
      {...actor, tenantId: 'other'},
      {...actor, userId: 'other'},
    ])
      assert.equal((await f.execute(r, {}, who)).success, false);
    let doc = structuredClone(f.store.document(actor.tenantId, 'write_review', r.data.review_id));
    doc.expires_at = Date.now() - 1;
    f.store.putDocument(actor.tenantId, 'write_review', r.data.review_id, doc);
    assert.equal((await f.execute(r)).error.code, 'REVIEW_EXPIRED');
    r = await prepared(f);
    doc = structuredClone(f.store.document(actor.tenantId, 'write_review', r.data.review_id));
    doc.plan.body.pubsubTopic = 'projects/amcp-test/topics/switched';
    f.store.putDocument(actor.tenantId, 'write_review', r.data.review_id, doc);
    assert.equal((await f.execute(r)).error.code, 'REVIEW_CHANGED');
    r = await prepared(f);
    f.store.putConnection(
      actor,
      {...f.connection, id: 'd13fa1e3-e62c-48af-8c0a-301fa2f8f056'},
      {accessToken: 'synthetic'},
    );
    f.provision({enabled: false});
    assert.equal((await f.execute(r)).success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('direct native and method-tunneled requests cannot replace the reviewed notification flow', async () => {
  const f = fixture();
  try {
    assert.equal((await f.service.call(gateway, input(undefined, {dry_run: false}), actor)).success, false);
    assert.equal((await f.prepare(input(undefined, {method: 'POST'}))).success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('notification snapshot discovery enforces explicit body and monotonic time bounds', async () => {
  const p = new DelegatedNativeCompiler().compile(gateway, input());
  for (const mode of ['deadline', 'bytes']) {
    let tick = 0;
    const clock = mode === 'deadline' ? mock.method(performance, 'now', () => (tick++ === 0 ? 0 : 30001)) : undefined;
    try {
      await assert.rejects(
        () =>
          readBusinessNotificationState(p, async () => ({
            status: 200,
            headers: {},
            data: {name: 'accounts/123', accountName: 'x'.repeat(1024 * 1024 + 1)},
          })),
        (e: any) => e.code === 'BUSINESS_NOTIFICATION_STATE_UNVERIFIED',
      );
    } finally {
      clock?.mock.restore();
    }
  }
});
test('notification schema coverage distinguishes every current and retired enum without changing captured evidence', () => {
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.operation === operation);
  assert.equal(rows.find(r => r.action === 'UPDATE_NOTIFICATION_SETTING')!.family, 'google_business_notifications');
  assert.equal(rows.find(r => r.action === 'GET_NOTIFICATION_SETTING')!.status, 'native_read');
  const d = JSON.parse(readFileSync('.mirror/VENDOR/business-notifications-v1.json', 'utf8')).document.schemas
    .NotificationSetting;
  assert.deepEqual(Object.keys(d.properties).sort(), ['name', 'notificationTypes', 'pubsubTopic']);
  assert.deepEqual(
    [...businessNotificationTypes, ...retiredBusinessNotificationTypes].sort(),
    d.properties.notificationTypes.items.enum.filter((s: string) => s !== 'NOTIFICATION_TYPE_UNSPECIFIED').sort(),
  );
  const p = new DelegatedNativeCompiler().compile(gateway, clear());
  assert.equal(applyExecutionRisk(p).destructive, true);
});
