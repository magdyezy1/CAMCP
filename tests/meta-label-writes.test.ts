import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {
  metaLabelSnapshots,
  readMetaLabels,
  validateMetaLabelPrerequisites,
  metaLabelIdentities,
} from '../src/meta-label-writes.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {ScopeGuard} from '../src/scope.js';
import {Introspection} from '../src/introspection.js';
import {removeTestDirectory} from './temp.js';
import type {Connection, JsonObject} from '../src/types.js';
import {currentMetaRecord} from '../src/meta-version.js';

const gateway = 'meta_native_action',
  registry = new Registry(),
  actor = {tenantId: 'labels', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const},
  key = Buffer.alloc(32, 23).toString('base64');
const cases: [string, JsonObject, JsonObject?][] = [
  ['meta_ad_account_id_adlabels_create', {}, {name: 'New label'}],
  ['meta_ad_label_id_update', {ad_label_id: '41'}, {name: 'Renamed label'}],
  ['meta_ad_label_id_delete', {ad_label_id: '41'}],
  ['meta_ad_id_adlabels_create', {ad_id: '77'}, {adlabels: [{id: '42'}]}],
  ['meta_campaign_id_adlabels_create', {campaign_id: '77'}, {adlabels: [{id: '42'}]}],
  ['meta_creative_id_adlabels_create', {creative_id: '77'}, {adlabels: [{id: '42'}]}],
];
function fixture(file = ':memory:') {
  const store = new Store(file, key),
    calls: JsonObject[] = [],
    labels: JsonObject[] = [
      {id: '41', name: 'Existing', account: {id: 'act_123'}},
      {id: '42', name: 'Attach me', account: {id: 'act_123'}},
    ],
    target: JsonObject = {
      id: '77',
      account_id: '123',
      name: 'Selected target',
      status: 'PAUSED',
      adlabels: [{id: '41', name: 'Existing'}],
    };
  const c: Connection = {
    id: 'c',
    tenantId: actor.tenantId,
    gateway,
    accounts: ['123'],
    writeAccounts: ['123'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['ads_management'],
    resourceBindings: [
      {accountId: '123', pathPrefix: '/v26.0/41'},
      {accountId: '123', pathPrefix: '/v26.0/77'},
    ],
  };
  if (!store.listConnections(actor.tenantId).length) store.putConnection(owner, c, {accessToken: 'synthetic'});
  let mode = 'success',
    pages = false,
    reads = 0;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        method = init!.method!;
      calls.push({url: u.href, method, body: init!.body?.toString()});
      if (method === 'GET') {
        reads++;
        if (mode === 'revoked') store.putConnection(owner, {...c, writeAccounts: []}, {accessToken: 'synthetic'});
        if (u.pathname === '/v26.0/act_123') return Response.json({id: 'act_123', account_status: 1, currency: 'USD'});
        if (u.pathname === '/v26.0/act_123/adlabels') {
          if (mode === 'error') return Response.json({error: {message: 'Synthetic denied'}});
          if (mode === 'partial')
            return Response.json({
              data: labels,
              paging: {next: 'https://graph.facebook.com/v26.0/act_123/adlabels?after=x'},
            });
          if (mode === 'foreign_page')
            return Response.json({
              data: [labels[0]],
              paging: {cursors: {after: 'x'}, next: 'https://graph.facebook.com/v26.0/act_999/adlabels?after=x'},
            });
          if (mode === 'repeat_page')
            return Response.json({
              data: [labels[0]],
              paging: {cursors: {after: 'x'}, next: 'https://graph.facebook.com/v26.0/act_123/adlabels?after=x'},
            });
          const selected = pages ? (u.searchParams.has('after') ? labels.slice(1) : labels.slice(0, 1)) : labels;
          return Response.json({
            data: [...selected].reverse().map(l => ({...l, updated_time: String(reads)})),
            request_id: String(reads),
            ...(pages && !u.searchParams.has('after')
              ? {
                  paging: {
                    cursors: {after: 'second'},
                    next: 'https://graph.facebook.com/v26.0/act_123/adlabels?after=second&access_token=must-not-forward',
                  },
                }
              : {}),
          });
        }
        if (u.pathname === '/v26.0/77')
          return Response.json({
            ...target,
            adlabels: target.adlabels ? [...target.adlabels].reverse() : target.adlabels,
            updated_time: String(reads),
            effective_status: reads % 2 ? 'ACTIVE' : 'PAUSED',
          });
        throw Error('Unexpected read ' + u.pathname);
      }
      if (mode === 'lost') throw Error('Synthetic lost response');
      if (mode === 'failed') return Response.json({success: true, errors: [{message: 'Synthetic partial mutation'}]});
      if (mode === 'empty') return Response.json({});
      const payload = Object.fromEntries(new URLSearchParams(String(init!.body ?? '')));
      if (u.pathname === '/v26.0/act_123/adlabels') {
        if (mode !== 'ignored' && mode !== 'existing_id')
          labels.push({id: '43', name: payload.name, account: {id: 'act_123'}});
        return Response.json({id: mode === 'existing_id' ? '41' : '43'});
      }
      if (mode !== 'ignored') {
        if (method === 'DELETE')
          labels.splice(
            labels.findIndex(l => l.id === '41'),
            1,
          );
        else if (/^\/v26\.0\/\d+$/.test(u.pathname))
          labels.find(l => l.id === u.pathname.split('/').at(-1))!.name = payload.name;
        else
          for (const l of JSON.parse(payload.adlabels!))
            if (!target.adlabels.some((v: JsonObject) => v.id === l.id))
              target.adlabels.push({...labels.find(v => v.id === l.id)});
      }
      return Response.json({success: true});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  return {
    store,
    service,
    labels,
    target,
    c,
    calls,
    transport,
    mode: (v: string) => {
      mode = v;
    },
    paginate: () => {
      pages = true;
    },
    writes: () => calls.filter(c => c.method !== 'GET').length,
  };
}
function arguments_(row = cases[0]!): JsonObject {
  const [action, params, payload] = row;
  return {action, account_id: '123', params, ...(payload ? {payload} : {})};
}
async function prepare(f: ReturnType<typeof fixture>, row = cases[0]!) {
  const r = await f.service.call('amcp_write', {action: 'prepare', gateway, arguments: arguments_(row)}, actor);
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
}
const execution = (review: JsonObject) => ({
  action: 'execute',
  review_id: review.review_id,
  idempotency_key: review.idempotency_key,
  confirmed: true,
});
for (const row of cases)
  test(row[0] + ' reviews, executes once and verifies exact account label state', async () => {
    const f = fixture();
    try {
      f.paginate();
      const r = await prepare(f, row),
        out = await f.service.call('amcp_write', execution(r), actor);
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(f.writes(), 1);
      const verified = await f.service.verifyWrite(actor, r.review_id);
      assert.equal(verified.status, 'verified', JSON.stringify(verified));
      const replay = await f.service.call('amcp_write', execution(r), actor);
      assert.equal(replay.data.replayed, true);
      assert.equal(f.writes(), 1);
      assert.ok(f.calls.every(c => !c.url.includes('must-not-forward')));
      if (row[0].endsWith('_adlabels_create') && row[0] !== 'meta_ad_account_id_adlabels_create')
        assert.deepEqual(f.target.adlabels.map((l: JsonObject) => l.id).sort(), ['41', '42']);
      if (row[0] === 'meta_ad_account_id_adlabels_create') assert.equal(f.store.ownsResource(f.c, '123', '43'), true);
    } finally {
      f.store.close();
    }
  });
test('native label discovery uses act_ID and binds returned labels to this connection only', async () => {
  const f = fixture();
  try {
    f.store.putConnection(owner, {...f.c, resourceBindings: []}, {accessToken: 'synthetic'});
    assert.equal(f.store.ownsResource(f.c, '123', '41'), false);
    const r = await f.service.call(
      gateway,
      {action: 'meta_ad_account_id_adlabels_get', account_id: '123', params: {fields: 'id,name,account{id}'}},
      actor,
    );
    assert.equal(r.success, true, JSON.stringify(r));
    assert.match(f.calls[0]!.url, /\/act_123\/adlabels/);
    assert.equal(f.store.ownsResource(f.c, '123', '41'), true);
    const other = {...f.c, id: 'other'};
    f.store.putConnection(owner, other, {accessToken: 'synthetic'});
    assert.equal(f.store.ownsResource(other, '123', '41'), false);
  } finally {
    f.store.close();
  }
});

test('label route correction preserves captured raw evidence and describes the executable mapping', () => {
  const captured = registry.data.catalogs
      .find(c => c.gateway === gateway)!
      .actions.find(a => a.name === 'meta_ad_account_id_adlabels_get')!,
    effective = registry.action(gateway, captured.name)!;
  // The capture recorded v25.0; AMCP lists and sends the captured record at the current version.
  assert.equal(captured.path, '/v25.0/{ad_account_id}/adlabels');
  assert.equal(effective.path, '/v26.0/act_{ad_account_id}/adlabels');
  assert.deepEqual(effective.raw, currentMetaRecord(captured.raw));
  const described = new Introspection(registry).describe(gateway, {target_action: captured.name});
  assert.equal(described.path, effective.path);
  assert.deepEqual(described.captured_mapping, currentMetaRecord(captured.raw));
  assert.match(described.source, /facebook-python-business-sdk/);
});
test('label names, actual membership and account changes conflict; telemetry and returned order do not', async () => {
  for (const change of ['label', 'membership', 'account'] as const) {
    const f = fixture();
    try {
      const r = await prepare(f, cases[3]);
      if (change === 'label') f.labels[0]!.name = 'Concurrent';
      if (change === 'membership') f.target.adlabels.push({id: '42'});
      if (change === 'account') f.target.account_id = '999';
      const e = await f.service.call('amcp_write', execution(r), actor);
      assert.equal(e.success, false);
      assert.equal(f.writes(), 0);
      if (change !== 'account') {
        assert.equal(e.error.code, 'STATE_CHANGED');
        assert.ok(e.error.details.changed_fields.some((p: string) => /name|labelIds/.test(p)));
      }
    } finally {
      f.store.close();
    }
  }
});
test('invalid label payloads and native bypasses are blocked before mutation', async () => {
  const f = fixture();
  try {
    for (const payload of [
      {adlabels: []},
      {adlabels: [{id: '42'}, {id: '42'}]},
      {adlabels: [{id: '42', name: 'Implicit creation'}]},
      {adlabels: [{id: 42}]},
      {adlabels: [{id: '42'}], execution_options: ['validate_only']},
      {adlabels: [{id: '42'}], status: 'ACTIVE'},
    ]) {
      const r = await f.service.call(
        'amcp_write',
        {action: 'prepare', gateway, arguments: {...arguments_(cases[3]), payload}},
        actor,
      );
      assert.equal(r.success, false);
    }
    for (const row of cases) {
      const r = await f.service.call(
        gateway,
        {...arguments_(row), dry_run: false, confirmed: true, before_state: {id: '41'}, idempotency_key: 'bypass'},
        actor,
      );
      assert.equal(r.error.code, 'WRITE_REVIEW_REQUIRED');
    }
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('foreign labels, omitted membership, incomplete pagination and failed reads cannot authorize a label write', async () => {
  for (const mode of [
    'foreign_label',
    'missing_label',
    'missing_membership',
    'error',
    'partial',
    'foreign_page',
    'repeat_page',
  ] as const) {
    const f = fixture();
    try {
      if (mode === 'foreign_label') f.labels[1]!.account = {id: 'act_999'};
      else if (mode === 'missing_label') f.labels.splice(1, 1);
      else if (mode === 'missing_membership') delete f.target.adlabels;
      else f.mode(mode);
      const r = await f.service.call(
        'amcp_write',
        {action: 'prepare', gateway, arguments: arguments_(cases[3])},
        actor,
      );
      assert.equal(r.success, false, mode);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('revoked write grants and Ads scopes block execution including revocation during state reads', async () => {
  for (const mode of ['write', 'scope', 'inflight'] as const) {
    const f = fixture();
    try {
      const r = await prepare(f);
      if (mode === 'inflight') f.mode('revoked');
      else
        f.store.putConnection(
          owner,
          {...f.c, ...(mode === 'scope' ? {scopes: ['ads_read']} : {writeAccounts: []})},
          {accessToken: 'synthetic'},
        );
      const e = await f.service.call('amcp_write', execution(r), actor);
      assert.equal(e.success, false);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('unknown and partial receipts and lost responses retain their single durable mutation claim', async () => {
  for (const mode of ['failed', 'empty', 'lost', 'existing_id'] as const) {
    const f = fixture();
    try {
      const r = await prepare(f);
      f.mode(mode);
      assert.equal((await f.service.call('amcp_write', execution(r), actor)).success, false);
      assert.equal((await f.service.call('amcp_write', execution(r), actor)).success, false);
      assert.equal(f.writes(), 1);
      assert.equal(f.store.ownsResource(f.c, '123', '43'), false);
    } finally {
      f.store.close();
    }
  }
});
test('unchanged label state cannot verify a provider success receipt or grant an unverified created ID', async () => {
  const f = fixture();
  try {
    const r = await prepare(f);
    f.mode('ignored');
    assert.equal((await f.service.call('amcp_write', execution(r), actor)).success, true);
    const v = await f.service.verifyWrite(actor, r.review_id);
    assert.equal(v.status, 'inconclusive');
    assert.equal(f.store.ownsResource(f.c, '123', '43'), false);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('label claims survive SQLite reopen and concurrent execution still dispatches once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amcp-meta-labels-')),
    file = join(dir, 'test.sqlite');
  let f = fixture(file);
  try {
    const r = await prepare(f);
    const all = await Promise.all([
      f.service.call('amcp_write', execution(r), actor),
      f.service.call('amcp_write', execution(r), actor),
    ]);
    assert.ok(all.some(v => v.success));
    assert.equal(f.writes(), 1);
    f.store.close();
    f = fixture(file);
    const replay = await f.service.call('amcp_write', execution(r), actor);
    assert.equal(replay.data.replayed, true);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
    removeTestDirectory(dir, 'amcp-meta-labels-');
  }
});
test('label review bounds reject a full account before another create can exceed verification capacity', async () => {
  const f = fixture();
  try {
    f.labels.splice(
      0,
      f.labels.length,
      ...Array.from({length: 1000}, (_, i) => ({id: String(i + 1000), name: 'Label ' + i, account: {id: 'act_123'}})),
    );
    const p = f.service.compiler.compile(gateway, arguments_(), {mode: 'strict', flags: {}}),
      read = metaLabelSnapshots(p)[0]!;
    let count = 0;
    const result = await readMetaLabels(read, async request => {
      count++;
      if (request.path === '/v26.0/act_123')
        return {status: 200, headers: {}, data: {id: 'act_123', account_status: 1, currency: 'USD'}};
      const offset = Number(request.query.after ?? 0),
        next = offset + 100;
      return {
        status: 200,
        headers: {},
        data: {
          data: f.labels.slice(offset, next),
          ...(next < f.labels.length
            ? {
                paging: {
                  cursors: {after: String(next)},
                  next: 'https://graph.facebook.com/v26.0/act_123/adlabels?after=' + next,
                },
              }
            : {}),
        },
      };
    });
    assert.equal(count, 11);
    assert.equal(Object.keys((result.data as JsonObject).labels).length, 1000);
    assert.throws(() => validateMetaLabelPrerequisites(p, [result.data]), {code: 'META_LABEL_INVALID'});
    delete (result.data as JsonObject).labels['1999'];
    assert.doesNotThrow(() => validateMetaLabelPrerequisites(p, [result.data]));
  } finally {
    f.store.close();
  }
});

test('label state bounds cover distinct oversized pages, bytes, continuation ambiguity and monotonic deadlines', async t => {
  const f = fixture();
  try {
    const p = f.service.compiler.compile(gateway, arguments_(), {mode: 'strict', flags: {}}),
      read = metaLabelSnapshots(p)[0]!;
    for (const mode of ['1001', 'pages', 'response_bytes', 'total_bytes', 'has_more', 'next_token', 'deadline']) {
      let calls = 0,
        elapsed = 0;
      t.mock.method(performance, 'now', () => elapsed);
      await assert.rejects(
        () =>
          readMetaLabels(read, async request => {
            calls++;
            if (request.path === '/v26.0/act_123')
              return {status: 200, headers: {}, data: {id: 'act_123', account_status: 1, currency: 'USD'}};
            const offset = Number(request.query.after ?? 0),
              size = mode === '1001' ? Math.min(100, 1001 - offset) : 1,
              next = offset + size;
            const data: JsonObject = {
              data: Array.from({length: size}, (_, i) => ({
                id: String(offset + i + 1),
                name: 'Label',
                ...(mode.includes('bytes')
                  ? {metadata: 'x'.repeat((mode === 'response_bytes' ? 4 : 3) * 1024 * 1024)}
                  : {}),
              })),
            };
            if (mode === 'has_more') data.has_more = 'true';
            else if (mode === 'next_token') data.next_page_token = 'hidden';
            else if (mode === 'deadline') elapsed = 60001;
            else if (mode !== 'response_bytes' && (mode !== '1001' || next < 1001))
              data.paging = {
                cursors: {after: String(next)},
                next: 'https://graph.facebook.com/v26.0/act_123/adlabels?after=' + next,
              };
            return {status: 200, headers: {}, data};
          }),
        {code: 'META_LABEL_STATE_UNVERIFIED'},
        mode,
      );
      if (mode === '1001') assert.equal(calls, 12);
      if (mode === 'pages') assert.equal(calls, 26);
      if (mode === 'total_bytes') assert.equal(calls, 4);
      if (['has_more', 'next_token', 'response_bytes', 'deadline'].includes(mode)) assert.equal(calls, 2);
      t.mock.restoreAll();
    }
  } finally {
    t.mock.restoreAll();
    f.store.close();
  }
});

test('malformed discovery never records partial ownership from a successful-looking page', () => {
  const f = fixture();
  try {
    const p = f.service.compiler.compile(
        gateway,
        {action: 'meta_ad_account_id_adlabels_get', account_id: '123'},
        {mode: 'strict', flags: {}},
      ),
      scope = new ScopeGuard(registry, f.store);
    for (const d of [
      {data: [{id: '51'}], errors: []},
      {data: [{id: '51'}, {id: '51'}]},
      {data: [{id: '51'}, {id: '52', account: '123'}]},
      {data: [{id: '51'}, {id: '0'}]},
      {data: [{id: '51'}, {id: '52', account: {id: 'act_999'}}]},
    ]) {
      assert.throws(() => scope.observe(p, f.c, d), {code: 'META_LABEL_STATE_UNVERIFIED'});
      assert.equal(f.store.ownsResource(f.c, '123', '51'), false);
    }
    assert.deepEqual(metaLabelIdentities({data: [{id: '51'}]}, '123'), ['51']);
  } finally {
    f.store.close();
  }
});

test('verified labels can be immediately renamed but stale verification and revoked identities cannot be reused', async () => {
  const f = fixture();
  try {
    const r = await prepare(f);
    assert.equal((await f.service.call('amcp_write', execution(r), actor)).success, true);
    assert.equal((await f.service.verifyWrite(actor, r.review_id)).status, 'verified');
    const rename = await prepare(f, ['meta_ad_label_id_update', {ad_label_id: '43'}, {name: 'Next name'}]);
    assert.equal((await f.service.call('amcp_write', execution(rename), actor)).success, true);
    assert.equal((await f.service.verifyWrite(actor, rename.review_id)).status, 'verified');
    const calls = f.calls.length;
    f.store.putConnection(owner, {...f.c, scopes: []}, {accessToken: 'synthetic'});
    await assert.rejects(() => f.service.verifyWrite(actor, rename.review_id), {code: 'INSUFFICIENT_SCOPE'});
    assert.equal(f.calls.length, calls);
  } finally {
    f.store.close();
  }
});

test('label deletion follows current owner policy and reviews remain private to their workspace', async () => {
  const f = fixture();
  try {
    const r = await prepare(f, cases[2]);
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_deletion: false}});
    const denied = await f.service.call('amcp_write', execution(r), actor);
    assert.equal(denied.error.code, 'POLICY_DELETION_FORBIDDEN');
    const foreign = await f.service.call('amcp_write', execution(r), {...actor, tenantId: 'unrelated'});
    assert.equal(foreign.success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('ignored rename, deletion and attachment remain inconclusive and do not trigger mutation retries', async () => {
  for (const row of [cases[1]!, cases[2]!, cases[3]!]) {
    const f = fixture();
    try {
      const r = await prepare(f, row);
      f.mode('ignored');
      assert.equal((await f.service.call('amcp_write', execution(r), actor)).success, true);
      assert.equal((await f.service.verifyWrite(actor, r.review_id)).status, 'inconclusive');
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});

test('a lost label receipt remains claimed after SQLite reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amcp-meta-labels-')),
    file = join(dir, 'test.sqlite');
  let f = fixture(file);
  try {
    const r = await prepare(f);
    f.mode('lost');
    assert.equal((await f.service.call('amcp_write', execution(r), actor)).success, false);
    assert.equal(f.writes(), 1);
    f.store.close();
    f = fixture(file);
    const replay = await f.service.call('amcp_write', execution(r), actor);
    assert.equal(replay.success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
    removeTestDirectory(dir, 'amcp-meta-labels-');
  }
});
