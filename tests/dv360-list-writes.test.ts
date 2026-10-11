import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {dv360ListOutcome, validateDV360ListState} from '../src/dv360-list-writes.js';
import type {JsonObject} from '../src/types.js';
import type {CompiledRequest} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';

const gateway = 'dv360_native_action',
  registry = new Registry(),
  actor = {tenantId: 'dv360-lists', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const};
const cases = [
  {
    kind: 'channels',
    action: 'CHANNELS',
    id: 'channelId',
    child: 'sites',
    childAction: 'SITES',
    key: 'urlOrAppId',
    root: {displayName: 'Approved publishers'},
    add: {urlOrAppId: 'example.com'},
    next: {urlOrAppId: 'example.org'},
    replace: true,
    removeRoot: false,
  },
  {
    kind: 'negativeKeywordLists',
    action: 'NEGATIVE_KEYWORD_LISTS',
    id: 'negativeKeywordListId',
    child: 'negativeKeywords',
    childAction: 'NEGATIVE_KEYWORDS',
    key: 'keywordValue',
    root: {displayName: 'Brand exclusions'},
    add: {keywordValue: 'free trial'},
    next: {keywordValue: 'cheap flights'},
    replace: true,
    removeRoot: true,
  },
  {
    kind: 'locationLists',
    action: 'LOCATION_LISTS',
    id: 'locationListId',
    child: 'assignedLocations',
    childAction: 'ASSIGNED_LOCATIONS',
    key: 'assignedLocationId',
    root: {displayName: 'Core markets', advertiserId: '123', locationType: 'TARGETING_LOCATION_TYPE_REGIONAL'},
    add: {targetingOptionId: 'geo-1'},
    next: {targetingOptionId: 'geo-2'},
    replace: false,
    removeRoot: false,
  },
] as const;
type Scenario = (typeof cases)[number];
function fixture(s: Scenario) {
  const store = new Store(':memory:', Buffer.alloc(32, 81).toString('base64')),
    calls: JsonObject[] = [],
    root = '/v4/advertisers/123/' + s.kind,
    parent = root + '/100',
    collection = parent + '/' + s.child,
    records = new Map<string, JsonObject>();
  const connection = {
      id: 'dv360',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic DV360',
      scopes: ['https://www.googleapis.com/auth/display-video'],
    },
    credentials = {accessToken: 'synthetic'};
  store.putConnection(owner, connection, credentials);
  records.set('/v4/advertisers/123', {advertiserId: '123', name: 'advertisers/123', displayName: 'Advertiser'});
  records.set(parent, {...s.root, [s.id]: '100', advertiserId: '123', name: parent.slice(4)});
  let rows: JsonObject[] = [],
    writes = 0,
    pages = 0,
    partial = false,
    foreign = false,
    cycle = false,
    revoke = false,
    failPage = 0,
    lost = false,
    omitEmpty = true,
    softIgnore = false;
  const make = (v: JsonObject, index: number) => {
    const row: JsonObject = {...v, ...(s.child === 'assignedLocations' ? {assignedLocationId: String(index)} : {})};
    return {...row, name: collection.slice(4) + '/' + encodeURIComponent(String(row[s.key]))};
  };
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init!.method!,
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, method, query: Object.fromEntries(u.searchParams), body});
      if (method === 'GET') {
        if (path === collection) {
          pages++;
          if (revoke) store.putConnection(owner, {...connection, writeAccounts: []}, credentials);
          if (failPage && pages >= failPage) return Response.json({error: {code: 403}}, {status: 403});
          const offset = Number(u.searchParams.get('pageToken') ?? 0),
            items = rows
              .slice(offset, offset + 1)
              .map(v => (foreign ? {...v, name: v.name.replace('advertisers/123/', 'advertisers/999/')} : v));
          return Response.json({
            ...(!items.length && omitEmpty ? {} : {[s.child]: items}),
            ...(cycle || offset + 1 < rows.length ? {nextPageToken: cycle ? '1' : String(offset + 1)} : {}),
          });
        }
        const value = records.get(path);
        return value
          ? Response.json({...value, requestId: String(calls.length)})
          : Response.json({error: {code: 404}}, {status: 404});
      }
      writes++;
      let response: JsonObject;
      if (path === root) {
        const row = {...body, [s.id]: '900', advertiserId: '123', name: root.slice(4) + '/900'};
        records.set(root + '/900', row);
        response = row;
      } else if (path === parent || path === root + '/900') {
        if (method === 'DELETE') {
          records.delete(path);
          response = {};
        } else {
          const row = {...records.get(path)!, ...body};
          records.set(path, row);
          response = row;
        }
      } else {
        assert.ok(path.startsWith(collection));
        const suffix = s.child[0]!.toUpperCase() + s.child.slice(1),
          replace = path.endsWith(':replace'),
          bulk = path.endsWith(':bulkEdit');
        const adds =
          method === 'DELETE' ? [] : replace ? body['new' + suffix] : bulk ? (body['created' + suffix] ?? []) : [body];
        const removes =
          method === 'DELETE'
            ? [decodeURIComponent(path.slice(collection.length + 1))]
            : bulk
              ? (body['deleted' + suffix] ?? [])
              : [];
        const created = adds.map((v: JsonObject, i: number) => make(v, 800 + writes * 10 + i));
        if (!softIgnore) rows = replace ? created : [...rows.filter(v => !removes.includes(v[s.key])), ...created];
        response =
          method === 'DELETE'
            ? {}
            : replace || bulk
              ? {...(created.length ? {[s.child]: partial ? created.slice(1) : created} : {})}
              : created[0];
      }
      if (lost) throw Error('Synthetic accepted mutation with lost response');
      return Response.json(response);
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const prepare = (verb: string, child: boolean, payload?: JsonObject, id?: string) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: 'DV360_ADVERTISERS_' + s.action + (child ? '_' + s.childAction : '') + '_' + verb,
          params: {
            advertiserId: '123',
            ...(child || verb !== 'CREATE' ? {[s.id]: child ? '100' : (id ?? '100')} : {}),
            ...(child && verb === 'DELETE' ? {[s.key]: id ?? '800'} : {}),
            ...(verb === 'PATCH' ? {updateMask: 'displayName'} : {}),
          },
          ...(payload ? {body: payload} : {}),
        },
      },
      actor,
    );
  const execute = (p: JsonObject, extra: JsonObject = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = (p: JsonObject) =>
    service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {
    store,
    service,
    calls,
    records,
    connection,
    credentials,
    parent,
    collection,
    prepare,
    execute,
    verify,
    seed: (values: JsonObject[]) => {
      rows = values.map((v, i) => make(v, 200 + i));
    },
    rows: () => rows,
    writes: () => writes,
    pages: () => pages,
    partial: () => {
      partial = true;
    },
    foreign: () => {
      foreign = true;
    },
    cycle: () => {
      cycle = true;
    },
    revoke: () => {
      revoke = true;
    },
    failPage: (n: number) => {
      failPage = n;
    },
    lose: () => {
      lost = true;
    },
    ignore: () => {
      softIgnore = true;
    },
  };
}
for (const row of cases)
  test('DV360 ' + row.kind + ' list create/update and membership create/delete/bulk/replace', async () => {
    const f = fixture(row);
    try {
      const create = await f.prepare('CREATE', false, row.root);
      assert.equal(create.success, true, JSON.stringify(create));
      assert.equal((await f.execute(create)).success, true);
      const vc = await f.verify(create);
      assert.equal(vc.data.status, 'verified', JSON.stringify(vc));
      const patch = await f.prepare('PATCH', false, {displayName: 'Updated list'});
      assert.equal(patch.success, true, JSON.stringify(patch));
      assert.equal((await f.execute(patch)).success, true);
      assert.equal((await f.verify(patch)).data.status, 'verified');
      const add = await f.prepare('CREATE', true, row.add);
      assert.equal(add.success, true, JSON.stringify(add));
      assert.equal((await f.execute(add)).success, true);
      const va = await f.verify(add);
      assert.equal(va.data.status, 'verified', JSON.stringify(va));
      const suffix = row.child[0]!.toUpperCase() + row.child.slice(1),
        old = f.rows()[0]![row.key];
      const bulk = await f.prepare('BULK_EDIT', true, {['created' + suffix]: [row.next], ['deleted' + suffix]: [old]});
      assert.equal(bulk.success, true, JSON.stringify(bulk));
      assert.equal((await f.execute(bulk)).success, true);
      assert.equal((await f.verify(bulk)).data.status, 'verified');
      const remove = await f.prepare('DELETE', true, undefined, f.rows()[0]![row.key]);
      assert.equal(remove.success, true, JSON.stringify(remove));
      assert.equal((await f.execute(remove)).success, true);
      assert.equal((await f.verify(remove)).data.status, 'verified');
      if (row.replace) {
        const replace = await f.prepare('REPLACE', true, {['new' + suffix]: [row.add, row.next]});
        assert.equal(replace.success, true, JSON.stringify(replace));
        assert.equal((await f.execute(replace)).success, true);
        assert.equal((await f.verify(replace)).data.status, 'verified');
        assert.equal((await f.execute(replace)).data.replayed, true);
      }
      if (row.removeRoot) {
        const del = await f.prepare('DELETE', false);
        assert.equal(del.success, true);
        assert.equal((await f.execute(del)).success, true);
        assert.equal((await f.verify(del)).data.status, 'verified');
      }
    } finally {
      f.store.close();
    }
  });
test('Discovery confirms list methods, writable fields and absence of invented delete endpoints', () => {
  const spec = JSON.parse(fs.readFileSync('.mirror/VENDOR/dv360-v4.json', 'utf8')).document;
  for (const c of cases) {
    const r = spec.resources.advertisers.resources[c.kind];
    assert.equal(r.methods.create.httpMethod, 'POST');
    assert.equal(r.methods.patch.httpMethod, 'PATCH');
    assert.equal(!!r.methods.delete, c.removeRoot);
    assert.equal(!!r.resources[c.child].methods.replace, c.replace);
    assert.equal(r.resources[c.child].methods.bulkEdit.httpMethod, 'POST');
  }
});
test('complete membership snapshots follow every page and freeze sets independently of provider order', async () => {
  const row = cases[1],
    f = fixture(row);
  try {
    f.seed([row.add, row.next]);
    const p = await f.prepare('REPLACE', true, {newNegativeKeywords: [{keywordValue: 'paid only'}]});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(f.pages(), 2);
    f.seed([row.next, row.add]);
    const e = await f.execute(p);
    assert.equal(e.success, true, JSON.stringify(e));
    assert.equal((await f.verify(p)).data.status, 'verified');
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('membership added after review conflicts and duplicate creates stop before mutation', async () => {
  const row = cases[0],
    f = fixture(row);
  try {
    const p = await f.prepare('CREATE', true, row.add);
    assert.equal(p.success, true);
    f.seed([row.add]);
    assert.equal((await f.execute(p)).error.code, 'STATE_CHANGED');
    assert.equal((await f.prepare('CREATE', true, row.add)).error.code, 'CONFIGURATION_EXISTS');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('foreign rows, failed pages, repeated cursors and grant revocation never produce a successful empty state', async () => {
  for (const mode of ['foreign', 'page', 'cycle', 'revoke']) {
    const row = cases[1],
      f = fixture(row);
    try {
      f.seed([row.add, row.next]);
      if (mode === 'foreign') f.foreign();
      if (mode === 'page') f.failPage(2);
      if (mode === 'cycle') f.cycle();
      if (mode === 'revoke') f.revoke();
      const p = await f.prepare('REPLACE', true, {newNegativeKeywords: []});
      assertRefused(p, [
        'STATE_TARGET_MISMATCH',
        'PROVIDER_ACCESS_DENIED',
        'INCOMPLETE_STATE',
        'WRITE_ACCOUNT_FORBIDDEN',
      ]);
      assert.equal(f.writes(), 0);
      if (mode === 'revoke') assert.equal(f.pages(), 1);
    } finally {
      f.store.close();
    }
  }
});
test('partner overrides, output fields, wrong IDs, oversized names and malformed replacements fail locally', async () => {
  const row = cases[1];
  for (const [verb, child, body] of [
    ['CREATE', false, {displayName: 'Good', advertiserId: '999'}],
    ['CREATE', false, {displayName: 'Good', name: 'advertisers/123/negativeKeywordLists/100'}],
    ['CREATE', false, {displayName: 'x'.repeat(256)}],
    ['CREATE', false, {displayName: 'Good', partnerId: '123'}],
    ['REPLACE', true, {}],
    ['BULK_EDIT', true, {}],
    ['CREATE', true, {keywordValue: 'كلمة'}],
    ['CREATE', true, {keywordValue: 'x'.repeat(81)}],
    ['PATCH', false, {displayName: 'Good', advertiserId: '123'}],
  ] as [string, boolean, JsonObject][]) {
    const f = fixture(row);
    try {
      assertRefused(await f.prepare(verb, child, body), ['ACCOUNT_SCOPE_MISMATCH', 'INVALID_VENDOR_BODY']);
      assert.equal(f.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('bulk removal and replace are destructive under owner policy even though they use POST', async () => {
  const row = cases[1],
    f = fixture(row);
  try {
    f.seed([row.add]);
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: false, allow_activation: true},
    });
    for (const [verb, body] of [
      ['REPLACE', {newNegativeKeywords: []}],
      ['BULK_EDIT', {deletedNegativeKeywords: ['free trial']}],
    ] as [string, JsonObject][]) {
      const p = await f.prepare(verb, true, body);
      assert.equal(p.error.code, 'POLICY_DELETION_FORBIDDEN', JSON.stringify(p));
    }
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('shared-list edits require spend acknowledgement, provider scope and unchanged account grants', async () => {
  const row = cases[0],
    f = fixture(row);
  try {
    const p = await f.prepare('CREATE', true, row.add);
    assert.equal(p.success, true);
    assert.equal((await f.execute(p, {spend_change_confirmed: false})).error.code, 'SPEND_CONFIRMATION_REQUIRED');
    f.store.putConnection(owner, {...f.connection, scopes: []}, f.credentials);
    assert.equal((await f.execute(p)).error.code, 'PROVIDER_WRITE_SCOPE_REQUIRED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('partial bulk receipts are retained as failures and cannot cause automatic resubmission', async () => {
  const row = cases[1],
    f = fixture(row);
  try {
    const p = await f.prepare('BULK_EDIT', true, {createdNegativeKeywords: [row.add, row.next]});
    assert.equal(p.success, true);
    f.partial();
    const e = await f.execute(p);
    assertRefused(e, 'WRITE_PARTIAL_OR_FAILED');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('lost responses and concurrent requests preserve one mutation per review', async () => {
  const row = cases[0],
    f = fixture(row);
  try {
    const p = await f.prepare('CREATE', true, row.add);
    f.lose();
    assert.equal((await f.execute(p)).success, false);
    assert.equal((await f.execute(p)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  const g = fixture(row);
  try {
    const p = await g.prepare('CREATE', true, row.add);
    const results = await Promise.all([g.execute(p), g.execute(p)]);
    assert.ok(results.some(r => r.success));
    assert.equal(g.writes(), 1);
  } finally {
    g.store.close();
  }
});
test('successful-looking receipts still require complete read-back to verify membership', async () => {
  const row = cases[0],
    f = fixture(row);
  try {
    const p = await f.prepare('CREATE', true, row.add);
    f.ignore();
    assert.equal((await f.execute(p)).success, true);
    const v = await f.verify(p);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('malformed provider names fail with a scoped error and duplicate option receipts cannot hide a missing assignment', () => {
  const path = '/v4/advertisers/123/locationLists/100/assignedLocations',
    plan = {
      gateway,
      accountId: '123',
      method: 'POST',
      path: path + ':bulkEdit',
      query: {},
      body: {createdAssignedLocations: [{targetingOptionId: 'geo-1'}, {targetingOptionId: 'geo-2'}]},
    } as CompiledRequest;
  const row = (id: string, option: string) => ({
    name: path.slice(4) + '/' + id,
    assignedLocationId: id,
    targetingOptionId: option,
  });
  const receipt = (rows: JsonObject[]) => ({status: 200, headers: {}, data: {assignedLocations: rows}, durationMs: 1});
  assert.equal(dv360ListOutcome(plan, receipt([row('1', 'geo-1'), row('2', 'geo-2')])), true);
  assert.equal(dv360ListOutcome(plan, receipt([row('1', 'geo-1'), row('2', 'geo-1')])), false);
  const malformed = {...row('1', 'geo-1'), name: path.slice(4) + '/%invalid'};
  assert.equal(dv360ListOutcome(plan, receipt([malformed, row('2', 'geo-2')])), false);
  assert.throws(
    () =>
      validateDV360ListState(
        {...plan, path, dv360ListState: {kind: 'locationLists', collection: true}},
        receipt([malformed]),
      ),
    (e: unknown) => (e as JsonObject).code === 'STATE_TARGET_MISMATCH',
  );
});

test('negative keyword whitespace encoding is compared semantically and duplicate aliases are rejected', async () => {
  const f = fixture(cases[1]);
  try {
    f.seed([{keywordValue: 'free trial'}]);
    assert.equal((await f.prepare('CREATE', true, {keywordValue: 'free%20trial'})).error.code, 'CONFIGURATION_EXISTS');
    assert.equal(
      (
        await f.prepare('BULK_EDIT', true, {
          createdNegativeKeywords: [{keywordValue: 'cheap flights'}, {keywordValue: 'cheap%20flights'}],
        })
      ).error.code,
      'INVALID_VENDOR_BODY',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
