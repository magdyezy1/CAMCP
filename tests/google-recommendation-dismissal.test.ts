import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {Compiler} from '../src/compiler.js';
import {actionContracts} from '../src/action-contracts.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {
  readGoogleDismissalState,
  googleDismissalKind,
  googleDismissalOutcome,
} from '../src/google-recommendation-dismissal.js';
import {removeTestDirectory} from './temp.js';
import {disconnectLocalConnection} from '../src/connection-disconnect.js';
import type {Actor, Connection, JsonObject} from '../src/types.js';

const gateway = 'google_ads_native_action',
  rpc = 'google_ads_v23_recommendation_dismiss_recommendation',
  id = '7763366c-99a6-493c-ae0d-2ba1c77ba5dd',
  registry = new Registry();
const actor: Actor = {tenantId: 'dismissal', userId: 'operator', role: 'operator'},
  owner: Actor = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 62).toString('base64');
const rn = (n = 'Budget_bid_1', collection = 'recommendations') => 'customers/123/' + collection + '/' + n;
const input = (names = [rn()], extra: JsonObject = {}) => ({
  action: rpc,
  account_id: '123',
  connection_id: id,
  payload: {operations: names.map(resourceName => ({resourceName})), partialFailure: false},
  ...extra,
});
function fixture(file = ':memory:') {
  const store = new Store(file, key),
    calls: JsonObject[] = [],
    customer: JsonObject = {id: '123', currencyCode: 'EGP', timeZone: 'Africa/Cairo'};
  const connection: Connection = {
    id,
    tenantId: actor.tenantId,
    gateway,
    accounts: ['123'],
    writeAccounts: ['123'],
    enabled: true,
    label: 'Synthetic customer',
    scopes: ['https://www.googleapis.com/auth/adwords'],
  };
  const provision = (change: Partial<Connection> = {}) =>
    store.putConnection(owner, {...connection, ...change}, {accessToken: 'synthetic', developerToken: 'synthetic'});
  if (!store.listConnections(actor.tenantId).length) provision();
  const rows = new Map<string, JsonObject>(),
    seed = (name = rn(), extra: JsonObject = {}) =>
      rows.set(name, {
        resourceName: name,
        type: 'CAMPAIGN_BUDGET',
        campaignBudget: rn('10', 'campaignBudgets'),
        campaigns: [rn('100', 'campaigns'), rn('200', 'campaigns')],
        ...extra,
      });
  seed();
  let mode = 'success',
    reads = 0,
    hook: ((kind: string) => void) | undefined,
    entered: (() => void) | undefined,
    gate: Promise<void> | undefined;
  const hold = () => {
    let release!: () => void;
    const ready = new Promise<void>(r => (entered = r));
    gate = new Promise<void>(r => (release = r));
    return {ready, release};
  };
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(
      async (url, init) => {
        const path = new URL(String(url)).pathname,
          body = JSON.parse(String(init?.body));
        calls.push({path, body, headers: init?.headers});
        if (path.endsWith('/googleAds:search')) {
          reads++;
          const kind = / FROM ([a-z_]+)/.exec(body.query)![1]!;
          hook?.(kind);
          if (mode === 'denied') return Response.json({error: {code: 403, message: 'Synthetic denied'}}, {status: 403});
          if (mode === 'unknown') return Response.json({rows: []});
          if (mode === 'partial_read') return Response.json({partialFailureError: {code: 3}});
          let list =
            kind === 'customer'
              ? [{...customer}]
              : [...rows.values()].filter(v => body.query.includes("'" + v.resourceName + "'")).map(v => ({...v}));
          if (kind === 'recommendation') {
            if (mode === 'missing') list = [];
            if (mode === 'foreign') list = [{...list[0], resourceName: 'customers/999/recommendations/other'}];
            if (mode === 'duplicate') list = [...list, ...list];
            if (mode === 'moving' && reads > 2) list = list.map(v => ({...v, type: 'KEYWORD'}));
            if (mode === 'telemetry')
              list = list.reverse().map(v => ({
                ...v,
                campaigns: [...v.campaigns].reverse(),
                impact: {baseMetrics: {costMicros: String(reads)}},
              }));
          }
          const total = list.length;
          let token: string | undefined;
          if (kind === 'recommendation' && mode === 'pages' && list.length > 1) {
            const at = Number(body.pageToken ?? 0);
            list = list.slice(at, at + 1);
            if (at + 1 < total) token = String(at + 1);
          }
          if (mode === 'loop' && kind === 'recommendation') token = 'again';
          return Response.json({
            ...(list.length ? {results: list.map(v => ({[kind]: v}))} : {}),
            queryResourceConsumption: String(reads),
            requestId: 'read-' + reads,
            fieldMask: 'native_mask',
            ...(token ? {nextPageToken: token} : {}),
            ...(mode === 'count' ? {totalResultsCount: '100'} : {}),
          });
        }
        assert.equal(path, '/v25/customers/123/recommendations:dismiss');
        if (gate) {
          entered!();
          await gate;
        }
        if (mode !== 'ignored') for (const op of body.operations) rows.get(op.resourceName)!.dismissed = true;
        if (mode === 'lost') throw Error('Synthetic lost response');
        if (mode === 'empty_receipt') return Response.json({});
        let results = body.operations.map((op: JsonObject) => ({resourceName: op.resourceName}));
        if (mode === 'foreign_receipt') results = [{resourceName: 'customers/999/recommendations/other'}];
        if (mode === 'partial_receipt') return Response.json({results, partialFailureError: {code: 3}});
        if (mode === 'short_receipt') results = results.slice(1);
        if (mode === 'duplicate_receipt') results = [results[0], results[0]];
        return Response.json({results: results.reverse()});
      },
      async () => {},
      30000,
      8 * 1024 * 1024,
      10000,
    ),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const prepare = (request = input(), who = actor) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: request}, who);
  const execute = (p: JsonObject, extra: JsonObject = {}, who = actor) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      who,
    );
  return {
    store,
    service,
    calls,
    customer,
    rows,
    seed,
    provision,
    connection,
    prepare,
    execute,
    hold,
    mode: (m: string) => {
      mode = m;
    },
    onRead: (h: (kind: string) => void) => {
      hook = h;
    },
    writes: () => calls.filter(c => !c.path.endsWith('/googleAds:search')),
  };
}
for (const action of [rpc, 'DISMISS_RECOMMENDATION'])
  test(
    action + ' executes one scoped dismissal and verifies its saved state without applying a suggestion',
    async () => {
      const f = fixture();
      try {
        const p = await f.prepare(input([rn()], {action}));
        assert.equal(p.success, true, JSON.stringify(p));
        assert.equal(p.data.request.destructive, true);
        assert.equal(f.writes().length, 0);
        const out = await f.execute(p);
        assert.equal(out.success, true, JSON.stringify(out));
        assert.equal(f.writes().length, 1);
        assert.equal((await f.execute(p)).success, true);
        assert.equal(f.writes().length, 1);
        const v = await f.service.verifyWrite(actor, p.data.review_id);
        assert.equal(v.status, 'verified', JSON.stringify(v));
        assert.equal(v.checks[0].dismissal_observed, true);
        assert.equal(v.checks[0].configuration_applied, false);
        assert.equal(f.writes()[0]!.body.partialFailure, false);
        assert.equal(f.store.verifyAudit(), true);
      } finally {
        f.store.close();
      }
    },
  );
test('a complete 100-operation batch preserves the native maximum and verifies all target IDs', async () => {
  const f = fixture();
  try {
    f.rows.clear();
    const names = Array.from({length: 100}, (_, i) => rn('r' + i));
    for (const name of names) f.seed(name);
    const p = await f.prepare(input(names));
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p)).success, true);
    assert.equal((await f.service.verifyWrite(actor, p.data.review_id)).status, 'verified');
    assert.equal(f.writes().length, 1);
    assert.equal(f.writes()[0]!.body.operations.length, 100);
  } finally {
    f.store.close();
  }
});
test('paginated native recommendations are complete and frozen independent of result order and telemetry', async () => {
  for (const mode of ['pages', 'telemetry']) {
    const f = fixture();
    try {
      f.seed(rn('r2'));
      f.mode(mode);
      const p = await f.prepare(input([rn(), rn('r2')]));
      assert.equal(p.success, true, JSON.stringify(p));
      assert.equal((await f.execute(p)).success, true);
      assert.equal((await f.service.verifyWrite(actor, p.data.review_id)).status, 'verified');
      assert.ok(f.calls.filter(c => c.body.pageToken).length > 0 || mode === 'telemetry');
      assert.equal(JSON.stringify(p.data.before_state).includes('queryResourceConsumption'), false);
      assert.equal(JSON.stringify(p.data.before_state).includes('baseMetrics'), false);
    } finally {
      f.store.close();
    }
  }
});
test('changed dismissal status, type, target budget and target membership retain field diagnostics', async () => {
  for (const change of [
    {dismissed: true},
    {type: 'KEYWORD'},
    {campaignBudget: rn('11', 'campaignBudgets')},
    {campaigns: [rn('200', 'campaigns')]},
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare();
      assert.equal(p.success, true);
      Object.assign(f.rows.get(rn())!, change);
      const out = await f.execute(p);
      assert.equal(out.success, false);
      assert.equal(out.error.code, 'STATE_CHANGED', JSON.stringify(out));
      assert.ok(JSON.stringify(out.error.details.changed_fields).includes(Object.keys(change)[0]!));
      assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('mixed native types and already-dismissed recommendations never reach the mutation', async () => {
  for (const change of [{type: 'KEYWORD'}, {dismissed: true}]) {
    const f = fixture();
    try {
      f.seed(rn('r2'), change);
      const p = await f.prepare(input([rn(), rn('r2')]));
      assert.equal(p.success, false);
      assert.equal(p.error.code, 'INVALID_RECOMMENDATION_DISMISSAL');
      assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('empty, duplicate, foreign, unknown, partial, moving and count-incomplete reads never become an empty success', async () => {
  for (const mode of [
    'missing',
    'duplicate',
    'foreign',
    'unknown',
    'partial_read',
    'moving',
    'count',
    'loop',
    'denied',
  ]) {
    const f = fixture();
    try {
      f.mode(mode);
      const p = await f.prepare();
      assert.equal(p.success, false, mode + ': ' + JSON.stringify(p));
      assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('query injection, duplicate IDs, unsupported flags, foreign resources and oversized requests fail before egress', async () => {
  const f = fixture();
  try {
    const variants = [
      input([rn("x') OR 1=1")]),
      input([rn(), rn()]),
      input(['customers/999/recommendations/x']),
      input([]),
      input(Array.from({length: 101}, (_, i) => rn('r' + i))),
      input(undefined, {payload: {operations: [{resourceName: rn(), remove: true}]}}),
      input(undefined, {payload: {operations: [{resourceName: rn()}], partialFailure: true}}),
      input(undefined, {payload: {operations: [{resourceName: rn()}], partialFailure: null}}),
      input(undefined, {payload: {operations: [{resourceName: rn()}], validateOnly: true}}),
      input(undefined, {query: {fields: 'results'}}),
      input(undefined, {headers: {'login-customer-id': '999'}}),
    ];
    for (const request of variants) {
      const p = await f.prepare(request);
      assert.equal(p.success, false, JSON.stringify(request));
      assert.equal(f.calls.length, 0);
    }
  } finally {
    f.store.close();
  }
});
test('scope, exact current login, read/write grants and current actor are checked before and after each read', async () => {
  for (const mode of [
    'scope',
    'read_grant',
    'write_grant',
    'disabled',
    'reader',
    'tenant',
    'revoke_scope',
    'revoke_write',
    'disconnect',
  ]) {
    const f = fixture();
    try {
      let who = actor;
      if (mode === 'scope') f.provision({scopes: []});
      if (mode === 'read_grant') f.provision({accounts: ['777'], writeAccounts: []});
      if (mode === 'write_grant') f.provision({writeAccounts: []});
      if (mode === 'disabled') f.provision({enabled: false});
      if (mode === 'reader') who = {...actor, role: 'reader'};
      if (mode === 'tenant') who = {...actor, tenantId: 'other'};
      if (mode === 'revoke_scope') f.onRead(() => f.provision({scopes: []}));
      if (mode === 'revoke_write') f.onRead(() => f.provision({writeAccounts: []}));
      if (mode === 'disconnect') f.onRead(() => disconnectLocalConnection(f.store, owner, gateway, id, 'website'));
      const p = await f.prepare(undefined, who);
      assert.equal(p.success, false, mode + ': ' + JSON.stringify(p));
      assert.equal(f.writes().length, 0);
      assert.equal(f.calls.length, mode.startsWith('revoke_') || mode === 'disconnect' ? 1 : 0);
    } finally {
      f.store.close();
    }
  }
});
test('owner deletion policy governs dismissal even under POST; activation and monetary policy do not falsely classify it', async () => {
  for (const allow of [true, false]) {
    const f = fixture();
    try {
      saveSpendPolicy(f.store, owner, {
        gateway,
        account_id: '123',
        confirmed: true,
        policy: {allow_deletion: allow, allow_activation: false, max_budget_native: 0},
      });
      const p = await f.prepare();
      assert.equal(p.success, allow, JSON.stringify(p));
      if (allow) assert.equal((await f.execute(p)).success, true);
      else assert.equal(p.error.code, 'POLICY_DELETION_FORBIDDEN');
      assert.equal(f.writes().length, allow ? 1 : 0);
    } finally {
      f.store.close();
    }
  }
});
test('new owner policy, revoked scope and actor downgrade after review still block execution', async () => {
  for (const mode of ['policy', 'scope', 'reader']) {
    const f = fixture();
    try {
      const p = await f.prepare();
      assert.equal(p.success, true);
      if (mode === 'policy')
        saveSpendPolicy(f.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_deletion: false}});
      if (mode === 'scope') f.provision({scopes: []});
      const out = await f.execute(p, {}, mode === 'reader' ? {...actor, role: 'reader'} : actor);
      assert.equal(out.success, false);
      assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('empty, partial, missing and foreign receipts cannot authorize resubmission or verified success', async () => {
  for (const mode of [
    'empty_receipt',
    'foreign_receipt',
    'short_receipt',
    'partial_receipt',
    'duplicate_receipt',
    'lost',
  ]) {
    const f = fixture();
    try {
      f.seed(rn('r2'));
      const p = await f.prepare(input([rn(), rn('r2')]));
      assert.equal(p.success, true);
      f.mode(mode);
      assert.equal((await f.execute(p)).success, false, mode);
      await f.execute(p);
      assert.equal(f.writes().length, 1);
      assert.equal(
        f.store.documents(actor.tenantId, 'write_verification').filter(d => d.status === 'verified').length,
        0,
      );
    } finally {
      f.store.close();
    }
  }
});
test('ignored mutations and expired recommendations after submission remain inconclusive without retries', async () => {
  for (const expired of [false, true]) {
    const f = fixture();
    try {
      const p = await f.prepare();
      assert.equal(p.success, true);
      f.mode('ignored');
      assert.equal((await f.execute(p)).success, true);
      if (expired) f.rows.clear();
      const v = await f.service.verifyWrite(actor, p.data.review_id);
      assert.equal(v.status, 'inconclusive', JSON.stringify(v));
      assert.equal(v.checks[0].dismissal_observed, false);
      assert.equal(v.automatic_retry_of_mutation, false);
      assert.equal(f.writes().length, 1);
    } finally {
      f.store.close();
    }
  }
});
test('current scope revocation during independent verification cannot produce verified dismissal', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal((await f.execute(p)).success, true);
    const count = f.calls.length;
    f.onRead(() => f.provision({scopes: []}));
    const v = await f.service.verifyWrite(actor, p.data.review_id);
    assert.notEqual(v.status, 'verified');
    assert.equal(f.calls.length, count + 1);
    assert.equal(f.writes().length, 1);
  } finally {
    f.store.close();
  }
});
test('manager routing stays on the selected customer and login even when another connection has the same account', async () => {
  const f = fixture();
  try {
    f.provision({accountLoginCustomers: {'123': '456'}});
    f.provision({
      id: '905be905-2356-4e85-8016-d7052c13f537',
      isDefault: true,
      accountLoginCustomers: {'123': '999'},
      scopes: [],
    });
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p)).success, true);
    assert.equal((await f.service.verifyWrite(actor, p.data.review_id)).status, 'verified');
    assert.ok(f.calls.every(c => new Headers(c.headers).get('login-customer-id') === '456'));
    assert.ok(f.calls.every(c => c.path.startsWith('/v25/customers/123/')));
  } finally {
    f.store.close();
  }
});
test('foreign native parents, malformed state and manager customers are never eligible for dismissal', async () => {
  for (const change of [
    {type: 'UNKNOWN'},
    {dismissed: 'false'},
    {campaign: 'customers/999/campaigns/1'},
    {campaignBudget: false},
    {campaigns: [rn('100', 'campaigns'), rn('100', 'campaigns')]},
  ]) {
    const f = fixture();
    try {
      Object.assign(f.rows.get(rn())!, change);
      const p = await f.prepare();
      assert.equal(p.success, false, JSON.stringify(change));
      assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    f.customer.manager = true;
    const p = await f.prepare();
    assert.equal(p.success, false);
    assert.equal(f.writes().length, 0);
  } finally {
    f.store.close();
  }
});
test('another actor, expired review and tampered stored request cannot submit the dismissal', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true);
    assert.equal((await f.execute(p, {}, {...actor, userId: 'other'})).success, false);
    let doc = structuredClone(f.store.document(actor.tenantId, 'write_review', p.data.review_id));
    doc.expires_at = Date.now() - 1;
    f.store.putDocument(actor.tenantId, 'write_review', p.data.review_id, doc);
    assert.equal((await f.execute(p)).error.code, 'REVIEW_EXPIRED');
    doc.expires_at = Date.now() + 60000;
    doc.plan.body.operations[0].resourceName = rn('changed');
    f.store.putDocument(actor.tenantId, 'write_review', p.data.review_id, doc);
    assert.equal((await f.execute(p)).error.code, 'REVIEW_CHANGED');
    assert.equal(f.writes().length, 0);
  } finally {
    f.store.close();
  }
});
test('deterministic concurrent execute and SQLite restart preserve one successful or uncertain submission', async () => {
  for (const mode of ['success', 'lost']) {
    const directory = mkdtempSync(join(tmpdir(), 'amcp-dismissal-')),
      file = join(directory, 'test.sqlite');
    let f = fixture(file),
      release: (() => void) | undefined;
    try {
      const p = await f.prepare();
      assert.equal(p.success, true);
      f.mode(mode);
      const held = f.hold();
      release = held.release;
      const first = f.execute(p);
      await held.ready;
      const duplicate = await f.execute(p);
      assert.equal(duplicate.error.code, 'WRITE_OUTCOME_UNCERTAIN');
      held.release();
      assert.equal((await first).success, mode === 'success');
      assert.equal(f.writes().length, 1);
      f.store.close();
      f = fixture(file);
      assert.equal((await f.execute(p)).success, mode === 'success');
      assert.equal(f.writes().length, 0);
    } finally {
      release?.();
      f.store.close();
      removeTestDirectory(directory, 'amcp-dismissal-');
    }
  }
});
test('native direct calls and frozen request tampering cannot bypass reviewed dismissal', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true);
    const direct = await f.service.call(
      gateway,
      {...input(), dry_run: false, confirmed: true, idempotency_key: 'fake', before_state: p.data.before_state},
      actor,
    );
    assert.equal(direct.success, false);
    assert.equal(direct.error.code, 'INVALID_ARGUMENT');
    await assert.rejects(
      () =>
        f.service.runPlan(
          new Compiler(registry).compile(gateway, input(), {mode: 'strict', flags: {}}),
          {
            connection_id: id,
            dry_run: false,
            confirmed: true,
            idempotency_key: 'fake',
            before_state: p.data.before_state,
          },
          actor,
        ),
      {code: 'WRITE_REVIEW_REQUIRED'},
    );
    const bad = await f.service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        arguments: input([rn('other')]),
      },
      actor,
    );
    assert.equal(bad.success, false);
    assert.equal(f.writes().length, 0);
  } finally {
    f.store.close();
  }
});
test('byte, row and monotonic deadline bounds apply to native dismissal snapshots', async t => {
  const p = new Compiler(registry).compile(gateway, input(), {mode: 'strict', flags: {}});
  await assert.rejects(
    () =>
      readGoogleDismissalState(p, async () => ({
        status: 200,
        headers: {},
        data: {results: [], queryResourceConsumption: 'x'.repeat(2 * 1024 * 1024)},
      })),
    {code: 'RECOMMENDATION_STATE_UNVERIFIED'},
  );
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  try {
    await assert.rejects(
      () =>
        readGoogleDismissalState(p, async () => {
          now = 60001;
          return {status: 200, headers: {}, data: {}};
        }),
      {code: 'RECOMMENDATION_STATE_UNVERIFIED'},
    );
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(googleDismissalOutcome(p, {status: 204, headers: {}, data: {results: [{resourceName: rn()}]}}), false);
});
test('native request, response, projection fields and both catalog surfaces match the pinned v23 contract', () => {
  const rows = actionContracts(registry).filter(r => r.family === 'google_recommendation_dismissal');
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.status === 'reviewed_write_family'));
  const spec = JSON.parse(readFileSync('.mirror/VENDOR/google-ads-v25.json', 'utf8')).document,
    s = spec.schemas;
  assert.deepEqual(Object.keys(s.GoogleAdsGoogleadsV25Services__DismissRecommendationRequest.properties).sort(), [
    'operations',
    'partialFailure',
  ]);
  assert.deepEqual(
    Object.keys(s.GoogleAdsGoogleadsV25Services_DismissRecommendationRequest_DismissRecommendationOperation.properties),
    ['resourceName'],
  );
  for (const field of ['resourceName', 'type', 'dismissed', 'campaign', 'campaigns', 'campaignBudget', 'adGroup'])
    assert.ok(s.GoogleAdsGoogleadsV25Resources__Recommendation.properties[field]);
  assert.equal(spec.resources.customers.resources.recommendations.methods.dismiss.httpMethod, 'POST');
  assert.equal(
    googleDismissalKind(
      new Compiler(registry).compile(gateway, input(undefined, {action: 'APPLY_RECOMMENDATION'}), {
        mode: 'strict',
        flags: {},
      }),
    ),
    false,
  );
});
test('opaque native recommendation IDs are preserved without coercion or accidental query interpretation', async () => {
  const f = fixture();
  try {
    const name = rn('aB_C-1.2~3==');
    f.rows.clear();
    f.seed(name);
    const p = await f.prepare(input([name]));
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p)).success, true);
    assert.equal((await f.service.verifyWrite(actor, p.data.review_id)).status, 'verified');
    assert.equal(f.writes()[0]!.body.operations[0].resourceName, name);
  } finally {
    f.store.close();
  }
});
