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
import {ScopeGuard} from '../src/scope.js';
import {writeOutcome} from '../src/write-outcome.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {actionContracts} from '../src/action-contracts.js';
import {
  placeActionSnapshots,
  readPlaceActionState,
  placeActionTypes,
  placeActionUri,
} from '../src/google-place-action-links.js';
import {removeTestDirectory} from './temp.js';
import type {Connection, JsonObject, CompiledRequest} from '../src/types.js';

const gateway = 'google_business_native_action',
  operation = 'gmb_engagement_ops',
  registry = new Registry(),
  actor = {tenantId: 'place-links', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const},
  key = Buffer.alloc(32, 42).toString('base64');
const location = 'locations/456',
  name = location + '/placeActionLinks/100',
  other = location + '/placeActionLinks/200';
const args = (
  action = 'CREATE_PLACE_ACTION_LINK',
  payload: JsonObject = {uri: 'https://example.com/book-new', placeActionType: 'APPOINTMENT', isPreferred: true},
  extra: JsonObject = {},
) => ({
  operation,
  arguments: {
    action,
    location_id: '456',
    ...(action.startsWith('CREATE') ? {} : {place_action_link_id: '100'}),
    ...(action.startsWith('DELETE') ? {} : {payload}),
    ...(action.startsWith('PATCH')
      ? {
          query: {
            updateMask: Object.keys(payload)
              .filter(k => k !== 'name')
              .join(','),
          },
        }
      : {}),
    ...extra,
  },
});
function fixture(file = ':memory:') {
  const store = new Store(file, key),
    calls: JsonObject[] = [],
    links = new Map<string, JsonObject>([
      [
        name,
        {
          name,
          providerType: 'MERCHANT',
          isEditable: true,
          uri: 'https://example.com/book',
          placeActionType: 'APPOINTMENT',
          isPreferred: true,
        },
      ],
      [
        other,
        {
          name: other,
          providerType: 'AGGREGATOR_3P',
          isEditable: false,
          uri: 'https://partner.example.com/book',
          placeActionType: 'APPOINTMENT',
          isPreferred: false,
        },
      ],
    ]),
    business: JsonObject = {
      name: location,
      title: 'Synthetic Clinic',
      storeCode: 'clinic-a',
      categories: {primaryCategory: {name: 'gcid:medical_clinic', displayName: 'Clinic'}, additionalCategories: []},
      websiteUri: 'https://example.com/',
      openInfo: {status: 'OPEN'},
    },
    types: JsonObject[] = [
      {placeActionType: 'APPOINTMENT', displayName: 'Book appointment'},
      {placeActionType: 'ONLINE_APPOINTMENT', displayName: 'Book online'},
    ];
  const connection: Connection = {
    id: 'c727e045-3c22-4ccb-8d92-580d6ec363fa',
    tenantId: actor.tenantId,
    gateway,
    label: 'Synthetic',
    enabled: true,
    accounts: [location],
    writeAccounts: [location],
    scopes: ['https://www.googleapis.com/auth/business.manage'],
  };
  const provision = (change: Partial<Connection> = {}) =>
    store.putConnection(owner, {...connection, ...change}, {accessToken: 'synthetic'});
  if (!store.listConnections(actor.tenantId).length) provision();
  let mode = 'success',
    reads = 0,
    businessReads = 0,
    created = 300;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init?.method ?? 'GET',
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({origin: u.origin, path, method, query: Object.fromEntries(u.searchParams), body});
      if (method === 'GET') {
        reads++;
        if (mode === 'revoke_scope') provision({scopes: []});
        if (mode === 'revoke_account') provision({accounts: ['locations/999'], writeAccounts: ['locations/999']});
        if (mode === 'revoke_write') provision({writeAccounts: []});
        if (mode === 'error') return Response.json({error: {code: 403, message: 'Synthetic denied'}});
        if (mode === 'forbidden')
          return Response.json({error: {code: 403, message: 'Synthetic denied'}}, {status: 403});
        if (path === '/v1/' + location) {
          businessReads++;
          assert.equal(u.origin, 'https://mybusinessbusinessinformation.googleapis.com');
          return Response.json({
            ...business,
            ...(mode === 'wrong_location' ? {name: 'locations/999'} : {}),
            ...(mode === 'moving' && businessReads % 2 === 0 ? {title: 'Changed'} : {}),
            ...(mode === 'oversize' ? {title: 'x'.repeat(3 * 1024 * 1024)} : {}),
          });
        }
        assert.equal(u.origin, 'https://mybusinessplaceactions.googleapis.com');
        const metadata = path === '/v1/placeActionTypeMetadata';
        if (metadata) assert.equal(u.searchParams.get('filter'), 'location=' + location);
        else assert.equal(path, '/v1/' + location + '/placeActionLinks');
        const key = metadata ? 'placeActionTypeMetadata' : 'placeActionLinks';
        let values = structuredClone(metadata ? types : [...links.values()]);
        if (!metadata) {
          values = values.map(v => ({
            ...v,
            createTime: '2026-01-01T00:00:00Z',
            updateTime: '2026-09-20T00:00:' + String(reads % 60).padStart(2, '0') + 'Z',
          }));
          if (mode === 'default_false')
            values = values.map(v => {
              if (!v.isPreferred) delete v.isPreferred;
              return v;
            });
        }
        if (reads % 2 === 0 && mode !== 'pages') values.reverse();
        if (mode === 'duplicate') values = [...values, ...values];
        if (mode === 'foreign_link' && !metadata) values[0]!.name = 'locations/999/placeActionLinks/1';
        let token: string | undefined;
        if (mode === 'pages' && values.length > 1) {
          if (u.searchParams.has('pageToken')) values = values.slice(1);
          else {
            values = values.slice(0, 1);
            token = 'second';
          }
        }
        if (mode === 'repeat_page') token = 'again';
        if (mode === 'missing_page') {
          values = [];
          token = 'more';
        }
        return Response.json({
          ...(values.length ? {[key]: values} : {}),
          ...(token ? {nextPageToken: token} : {}),
          ...(mode === 'unknown_envelope' ? {warnings: ['partial']} : {}),
        });
      }
      assert.equal(u.origin, 'https://mybusinessplaceactions.googleapis.com');
      if (mode === 'lost') throw Error('Synthetic lost response');
      if (mode === 'unknown_receipt') return Response.json({});
      if (mode === 'error_receipt') return Response.json({error: {code: 3, message: 'Synthetic refusal'}});
      const id = method === 'POST' ? location + '/placeActionLinks/' + created++ : path.slice(4),
        value =
          method === 'DELETE'
            ? {}
            : {
                ...(method === 'POST'
                  ? {providerType: 'MERCHANT', isEditable: true, isPreferred: false}
                  : links.get(id)),
                ...body,
                name: id,
              };
      if (mode !== 'ignored') {
        if (method === 'DELETE') links.delete(id);
        else {
          if (value.isPreferred && mode !== 'wrong_preference')
            for (const v of links.values()) if (v.placeActionType === value.placeActionType) v.isPreferred = false;
          // The provider keeps another query value than the one it was sent (the write was not applied as sent).
          links.set(
            id,
            structuredClone(
              mode === 'other_query' && typeof value.uri === 'string'
                ? {...value, uri: value.uri.replace('=NEW', '=OLD')}
                : value,
            ),
          );
        }
      }
      if (mode === 'foreign_receipt') value.name = 'locations/999/placeActionLinks/1';
      if (mode === 'existing_receipt') value.name = name;
      if (mode === 'wrong_value') value.uri = 'https://wrong.example.com/';
      if (method === 'DELETE' && mode === 'empty_receipt') return new Response(null, {status: 204});
      return Response.json(value);
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
  const prepare = (input: JsonObject = args()) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: input}, actor);
  const execute = (r: JsonObject, extra: JsonObject = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: r.data.review_id,
        idempotency_key: r.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  return {
    store,
    service,
    calls,
    connection,
    provision,
    links,
    business,
    types,
    prepare,
    execute,
    mode: (v: string) => {
      mode = v;
    },
    writes: () => calls.filter(c => c.method !== 'GET').length,
  };
}
async function prepared(f: ReturnType<typeof fixture>, input: JsonObject = args()) {
  const r = await f.prepare(input);
  assert.equal(r.success, true, JSON.stringify(r));
  return r;
}

test('public link creation checks and verifies displaced preferences before returning a usable identity', async () => {
  const f = fixture();
  try {
    const r = await prepared(f);
    assert.deepEqual(r.data.creative_impact.displaced_preferred_links, [name]);
    assert.equal(r.data.before_state[0].links[other].isEditable, false);
    assert.equal((await f.execute(r)).success, true);
    const v = await f.service.verifyWrite(actor, r.data.review_id);
    assert.equal(v.status, 'verified', JSON.stringify(v));
    assert.equal(v.verified_resources[0].resource_id, location + '/placeActionLinks/300');
    assert.equal(f.links.get(name)!.isPreferred, false);
    assert.equal((await f.execute(r)).data.replayed, true);
    assert.equal(f.writes(), 1);
    assert.ok(f.calls.every(c => c.origin.endsWith('.googleapis.com')));
  } finally {
    f.store.close();
  }
});
test('PATCH exact masks and DELETE use frozen state and complete link read-back', async () => {
  const f = fixture();
  try {
    for (const input of [
      args('PATCH_PLACE_ACTION_LINK', {uri: 'https://example.com/new-book', isPreferred: false}),
      args('DELETE_PLACE_ACTION_LINK'),
    ]) {
      const r = await prepared(f, input);
      assert.equal((await f.execute(r)).success, true);
      assert.equal((await f.service.verifyWrite(actor, r.data.review_id)).status, 'verified');
    }
    assert.equal(f.writes(), 2);
    assert.equal(f.links.has(name), false);
  } finally {
    f.store.close();
  }
});
test('collection order, localization and update telemetry do not cause false conflicts; real fields do', async () => {
  const f = fixture();
  try {
    let r = await prepared(f);
    f.business.categories.primaryCategory.displayName = 'Translated';
    f.types[0]!.displayName = 'Translated';
    f.mode('default_false');
    assert.equal((await f.execute(r)).success, true);
    for (const change of [
      () => (f.business.title = 'New title'),
      () => (f.links.get(name)!.uri = 'https://example.com/changed'),
      () => f.types.pop(),
    ]) {
      r = await prepared(f, args('PATCH_PLACE_ACTION_LINK', {isPreferred: true}));
      change();
      const out = await f.execute(r);
      assert.equal(out.error.code, 'STATE_CHANGED');
      assert.ok(out.error.details.changed_fields.length > 0);
    }
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('only exact location grants and business.manage authorize all prerequisite and write requests', async () => {
  for (const change of [
    {accounts: ['456'], writeAccounts: ['456']},
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
  const f = fixture();
  try {
    assert.equal((await f.prepare(args(undefined, undefined, {account_id: '123'}))).success, false);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('another login with the same location cannot replace a frozen connection or its current grant', async () => {
  const f = fixture();
  try {
    const r = await prepared(f);
    f.store.putConnection(
      owner,
      {...f.connection, id: '6a9abdbb-a6fc-4038-95cc-e60e8a313ced'},
      {accessToken: 'synthetic'},
    );
    f.provision({enabled: false});
    assert.equal((await f.execute(r)).success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('scope and grant revocation during reads stop preparation, execution and verification', async () => {
  for (const mode of ['revoke_account', 'revoke_scope', 'revoke_write']) {
    const f = fixture();
    try {
      const r = await prepared(f);
      f.mode(mode);
      assert.equal((await f.execute(r)).success, false, mode);
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
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});
test('global action metadata cannot escape the exact location filter through an internal action marker', () => {
  const f = fixture();
  try {
    const p = new DelegatedNativeCompiler().compile(gateway, args()),
      read = placeActionSnapshots(p)[1]!,
      guard = new ScopeGuard(registry, f.store);
    assert.equal(guard.authorize(read, f.connection), location);
    for (const change of [
      {query: {pageSize: 100}},
      {query: {filter: 'location=locations/999', pageSize: 100}},
      {query: {filter: 'region_code=US', pageSize: 100}},
      {method: 'POST'},
      {origin: 'https://example.com'},
      {query: {...read.query, fields: 'placeActionTypeMetadata'}},
    ])
      assert.throws(() => guard.authorize({...read, ...change} as CompiledRequest, f.connection));
  } finally {
    f.store.close();
  }
});
test('immutable fields, unknown types, vague masks and private customer URLs fail before egress', async () => {
  const f = fixture();
  try {
    for (const input of [
      args(undefined, {uri: 'https://example.com/', placeActionType: 'UNKNOWN'}),
      args(undefined, {uri: 'https://example.com/', placeActionType: 'APPOINTMENT', name}),
      args(undefined, {uri: 'https://example.com/', placeActionType: 'APPOINTMENT', providerType: 'MERCHANT'}),
      args('PATCH_PLACE_ACTION_LINK', {uri: 'https://example.com/'}, {query: {updateMask: '*'}}),
      args('PATCH_PLACE_ACTION_LINK', {isPreferred: false}, {query: {updateMask: 'uri'}}),
      args('PATCH_PLACE_ACTION_LINK', {name: other, uri: 'https://example.com/'}),
      args(undefined, undefined, {query: {fields: 'name'}}),
      ...[
        'https://user:pass@example.com/',
        'http://127.1/',
        'https://[::1]/',
        'https://service.internal/',
        'https://example.com/?access_token=synthetic',
        'https://example.com/?X-Amz-Signature=synthetic',
        'javascript:alert(1)',
      ].map(uri => args(undefined, {uri, placeActionType: 'APPOINTMENT'})),
    ])
      assert.equal((await f.prepare(input)).success, false, JSON.stringify(input));
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('private URLs are neither fetched nor echoed by URI-validation errors', () => {
  assert.throws(
    () => placeActionUri('https://example.com/?token=do-not-publish'),
    (e: Error) => !e.message.includes('do-not-publish'),
  );
  assert.equal(
    placeActionUri('https://EXAMPLE.com:443/book?utm_source=ads'),
    'https://example.com/book?utm_source=ads',
  );
});
test('rejected signed URLs are redacted in inspect output, audit input and failed provider receipts', async () => {
  const f = fixture();
  try {
    const privateUri = 'https://example.com/?%74oken=private-link-secret',
      input = args(undefined, {uri: privateUri, placeActionType: 'APPOINTMENT'});
    const preview = await f.service.call('amcp_write', {action: 'inspect', gateway, arguments: input}, actor);
    assert.equal(preview.data.review_contract_supported, false);
    assert.equal(JSON.stringify(preview).includes('private-link-secret'), false);
    assert.equal((await f.prepare(input)).success, false);
    assert.equal(JSON.stringify(f.store.audit(actor.tenantId)).includes('private-link-secret'), false);
    assert.equal(input.arguments.payload!.uri, privateUri);
    assert.equal(f.calls.length, 0);
    const review = await prepared(f),
      raw = {...f.links.get(name), name: location + '/placeActionLinks/300', uri: privateUri};
    const result = writeOutcome(
      {status: 200, headers: {}, data: raw},
      new DelegatedNativeCompiler().compile(gateway, args()),
      review.data.before_state,
    );
    assert.equal(result.success, false);
    assert.equal(JSON.stringify(result).includes('private-link-secret'), false);
    assert.equal(raw.uri, privateUri);
  } finally {
    f.store.close();
  }
});
test('changing a preferred link type displaces only the newly selected type preference', async () => {
  const f = fixture();
  try {
    f.links.get(other)!.placeActionType = 'ONLINE_APPOINTMENT';
    f.links.get(other)!.isPreferred = true;
    const r = await prepared(f, args('PATCH_PLACE_ACTION_LINK', {placeActionType: 'ONLINE_APPOINTMENT'}));
    assert.deepEqual(r.data.creative_impact.displaced_preferred_links, [other]);
    assert.equal((await f.execute(r)).success, true);
    assert.equal((await f.service.verifyWrite(actor, r.data.review_id)).status, 'verified');
    assert.equal(f.links.get(other)!.isPreferred, false);
    assert.equal(f.links.get(name)!.isPreferred, true);
  } finally {
    f.store.close();
  }
});
test('omitted native editability is false and is never treated as a grant', async () => {
  const f = fixture();
  try {
    delete f.links.get(name)!.isEditable;
    assert.equal((await f.prepare(args('DELETE_PLACE_ACTION_LINK'))).success, false);
    assert.equal((await f.prepare(args('PATCH_PLACE_ACTION_LINK', {isPreferred: false}))).success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('duplicate destinations, absent eligibility and noneditable targets fail as prerequisites', async () => {
  const f = fixture();
  try {
    for (const input of [
      args(undefined, {uri: 'https://example.com/book', placeActionType: 'APPOINTMENT'}),
      args(undefined, {uri: 'https://example.com/shop', placeActionType: 'SHOP_ONLINE'}),
      args('PATCH_PLACE_ACTION_LINK', {uri: 'https://partner.example.com/book'}),
      args('PATCH_PLACE_ACTION_LINK', {isPreferred: true}, {place_action_link_id: '200'}),
      args('DELETE_PLACE_ACTION_LINK', undefined, {place_action_link_id: '200'}),
      args('DELETE_PLACE_ACTION_LINK', undefined, {place_action_link_id: '999'}),
    ])
      assert.equal((await f.prepare(input)).success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('SOLOPRENEUR type requires explicit native eligibility despite its pinned discovery enum', async () => {
  const f = fixture();
  try {
    const input = args(undefined, {uri: 'https://example.com/solo', placeActionType: 'SOLOPRENEUR_APPOINTMENT'});
    assert.equal((await f.prepare(input)).success, false);
    f.types.push({placeActionType: 'SOLOPRENEUR_APPOINTMENT'});
    const r = await prepared(f, input);
    assert.equal((await f.execute(r)).success, true);
    assert.equal((await f.service.verifyWrite(actor, r.data.review_id)).status, 'verified');
  } finally {
    f.store.close();
  }
});
test('complete pages work; unknown, moving, partial, foreign, oversized or repeating responses never become empty success', async () => {
  const f = fixture();
  try {
    f.mode('pages');
    const r = await prepared(f);
    assert.equal((await f.execute(r)).success, true);
    assert.equal((await f.service.verifyWrite(actor, r.data.review_id)).status, 'verified');
    assert.ok(f.calls.some(c => c.query.pageToken === 'second'));
  } finally {
    f.store.close();
  }
  for (const mode of [
    'error',
    'forbidden',
    'wrong_location',
    'foreign_link',
    'moving',
    'duplicate',
    'repeat_page',
    'missing_page',
    'unknown_envelope',
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
test('empty native collections allow the first link but never imply an eligible action type', async () => {
  const f = fixture();
  try {
    f.links.clear();
    await prepared(f);
    f.types.length = 0;
    assert.equal((await f.prepare()).success, false);
  } finally {
    f.store.close();
  }
});
test('publication and deletion honor current owner policies without false budget matches in URLs', async () => {
  const f = fixture();
  try {
    const r = await prepared(
      f,
      args(undefined, {uri: 'https://example.com/budget-appointment', placeActionType: 'APPOINTMENT'}),
    );
    assert.equal((await f.execute(r, {spend_change_confirmed: false})).success, true);
    saveSpendPolicy(f.store, owner, {scope: 'workspace', confirmed: true, policy: {allow_activation: false}});
    assert.equal((await f.prepare()).error.code, 'POLICY_ACTIVATION_FORBIDDEN');
    assert.equal(
      (await f.prepare(args('PATCH_PLACE_ACTION_LINK', {uri: 'https://example.com/change'}))).error.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    await prepared(f, args('DELETE_PLACE_ACTION_LINK'));
    saveSpendPolicy(f.store, owner, {scope: 'workspace', confirmed: true, policy: {allow_deletion: false}});
    assert.equal((await f.prepare(args('DELETE_PLACE_ACTION_LINK'))).error.code, 'POLICY_DELETION_FORBIDDEN');
  } finally {
    f.store.close();
  }
});
test('owner policy changes after preparation still block execution before submission', async () => {
  const f = fixture();
  try {
    const r = await prepared(f);
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: location,
      confirmed: true,
      policy: {allow_activation: false},
    });
    assert.equal((await f.execute(r)).error.code, 'POLICY_ACTIVATION_FORBIDDEN');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('ambiguous, foreign, duplicate and lost receipts never authorize another mutation', async () => {
  for (const mode of [
    'unknown_receipt',
    'error_receipt',
    'foreign_receipt',
    'existing_receipt',
    'wrong_value',
    'lost',
  ]) {
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
    const r = await prepared(f, args('DELETE_PLACE_ACTION_LINK'));
    f.mode('empty_receipt');
    assert.equal((await f.execute(r)).success, false);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('ignored writes and incorrect preference side effects remain inconclusive, without replay', async () => {
  for (const input of [
    args(),
    args('PATCH_PLACE_ACTION_LINK', {uri: 'https://example.com/change'}),
    args('DELETE_PLACE_ACTION_LINK'),
  ]) {
    const f = fixture();
    try {
      const r = await prepared(f, input);
      f.mode('ignored');
      assert.equal((await f.execute(r)).success, true);
      assert.equal((await f.service.verifyWrite(actor, r.data.review_id)).status, 'inconclusive');
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const r = await prepared(f);
    f.mode('wrong_preference');
    assert.equal((await f.execute(r)).success, true);
    assert.notEqual((await f.service.verifyWrite(actor, r.data.review_id)).status, 'verified');
  } finally {
    f.store.close();
  }
});
test('a link the provider keeps with another query value than the one sent is inconclusive, whatever the parameter is called (S3-1)', async () => {
  // A link write that was not applied as sent must not verify: the read-back is compared with what was sent, with no rule that
  // treats any query parameter as one that changes by itself.
  for (const parameter of ['ticket', 'expires', 'x-expires', 'utm_term']) {
    const f = fixture();
    try {
      const r = await prepared(
        f,
        args('PATCH_PLACE_ACTION_LINK', {uri: 'https://example.com/book?' + parameter + '=NEW'}),
      );
      f.mode('other_query');
      assert.equal((await f.execute(r)).success, true);
      const verified = await f.service.verifyWrite(actor, r.data.review_id);
      assert.equal(verified.status, 'inconclusive', parameter);
      assert.ok(
        JSON.stringify(verified).includes('uri'),
        'the changed field is named: ' + JSON.stringify(verified).slice(0, 400),
      );
    } finally {
      f.store.close();
    }
  }
});
test('concurrent execute and SQLite reopen retain the original mutation claim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amcp-place-links-')),
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
    removeTestDirectory(directory, 'amcp-place-links-');
  }
});
test('tenant, actor, expiry, request tampering and direct gateway cannot bypass review', async () => {
  const f = fixture();
  try {
    const r = await prepared(f),
      common = {
        action: 'execute',
        review_id: r.data.review_id,
        idempotency_key: r.data.idempotency_key,
        confirmed: true,
      };
    for (const who of [
      {...actor, tenantId: 'other'},
      {...actor, userId: 'other'},
      {...actor, role: 'reader' as const},
    ])
      assert.equal((await f.service.call('amcp_write', common, who)).success, false);
    assert.equal((await f.service.call(gateway, args(undefined, undefined, {dry_run: false}), actor)).success, false);
    let doc = structuredClone(f.store.document(actor.tenantId, 'write_review', r.data.review_id));
    doc.expires_at = Date.now() - 1;
    f.store.putDocument(actor.tenantId, 'write_review', r.data.review_id, doc);
    assert.equal((await f.execute(r)).error.code, 'REVIEW_EXPIRED');
    doc.expires_at = Date.now() + 60000;
    doc.plan.body.uri = 'https://example.com/tampered';
    f.store.putDocument(actor.tenantId, 'write_review', r.data.review_id, doc);
    assert.equal((await f.execute(r)).error.code, 'REVIEW_CHANGED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('action inventory qualifies exactly the three documented place-link writes', () => {
  const rows = actionContracts(registry).filter(
    r => r.gateway === gateway && r.operation === operation && r.status === 'reviewed_write_family',
  );
  assert.deepEqual(rows.map(r => r.action).sort(), [
    'CREATE_PLACE_ACTION_LINK',
    'DELETE_PLACE_ACTION_LINK',
    'PATCH_PLACE_ACTION_LINK',
  ]);
  assert.ok(rows.every(r => r.family === 'google_place_actions'));
  const schema = JSON.parse(readFileSync('.mirror/VENDOR/business-place-actions-v1.json', 'utf8')).document.schemas
    .PlaceActionLink;
  assert.deepEqual(
    [...placeActionTypes].sort(),
    schema.properties.placeActionType.enum.filter((v: string) => v !== 'PLACE_ACTION_TYPE_UNSPECIFIED').sort(),
  );
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    'createTime',
    'isEditable',
    'isPreferred',
    'name',
    'placeActionType',
    'providerType',
    'updateTime',
    'uri',
  ]);
});
test('place-action discovery has finite page, row, byte and monotonic deadline limits', async () => {
  const p = new DelegatedNativeCompiler().compile(gateway, args());
  for (const mode of ['pages', 'rows', 'total_bytes', 'deadline']) {
    let calls = 0;
    const clock = mode === 'deadline' ? mock.method(performance, 'now', () => (++calls === 1 ? 0 : 60001)) : undefined;
    try {
      await assert.rejects(
        () =>
          readPlaceActionState(p, async read => {
            calls++;
            const page = Number(read.query.pageToken ?? 0),
              info = read.origin!.includes('businessinformation'),
              metadata = read.path.endsWith('/placeActionTypeMetadata');
            const data = info
              ? {name: location, title: 'Synthetic'}
              : metadata
                ? {placeActionTypeMetadata: [{placeActionType: 'APPOINTMENT'}]}
                : {
                    placeActionLinks: Array.from(
                      {length: mode === 'rows' ? 1001 : mode === 'total_bytes' ? 100 : 1},
                      (_, i) => ({
                        name: location + '/placeActionLinks/' + page + '-' + i,
                        uri: 'https://example.com/' + 'a'.repeat(mode === 'total_bytes' ? 7500 : 1) + page + '-' + i,
                        placeActionType: 'APPOINTMENT',
                        providerType: 'MERCHANT',
                        isEditable: true,
                      }),
                    ),
                    ...(mode !== 'total_bytes' || page < 5 ? {nextPageToken: String(page + 1)} : {}),
                  };
            return {status: 200, headers: {}, data, attempts: 1, elapsedMs: 0};
          }),
        (e: any) =>
          e.code === 'PLACE_ACTION_STATE_UNVERIFIED' &&
          (mode === 'total_bytes'
            ? /byte\/deadline/.test(e.message)
            : mode === 'pages'
              ? /25 pages/.test(e.message)
              : mode === 'rows'
                ? /capacity/.test(e.message)
                : /deadline/.test(e.message)),
      );
      assert.ok(calls <= 30);
    } finally {
      clock?.mock.restore();
    }
  }
});
