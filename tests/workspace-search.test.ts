import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {createHttpApp} from '../server/http-app.js';
import {workspaceSearch, workspaceSearchLimit} from '../server/workspace-search.js';
import {saveAccessSet, setMemberAccessSet} from '../src/access-sets.js';
import type {Actor, JsonObject} from '../src/types.js';

/**
 * WEB-09 (owner opt-in): the website palette's workspace search. It finds plans, saved reports, report snapshots,
 * uploaded media and accounts already stored in AMCP, as the searching person: another person's unshared plan and
 * another workspace's records never appear, at most five results of each kind are returned, and a search sends no
 * provider request and changes nothing. Synthetic store only; the transport refuses every request.
 */
const master = Buffer.alloc(32, 41).toString('base64'),
  connection = 'aaaaaaaa-3333-4333-8333-333333333333',
  payload = {name: 'Draft', objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: []};
function fixture(store = new Store(':memory:', master)) {
  const requests: string[] = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport((async (url: string) => {
      requests.push(String(url));
      throw Error('No provider request is expected in a workspace search.');
    }) as typeof fetch),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {store, service, requests};
}
function seed(store: Store, tenantId: string, users: string[]) {
  for (const user of users)
    store.db
      .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'operator',?)")
      .run(tenantId, user, Date.now());
  store.putConnection(
    {tenantId, userId: 'owner-admin', role: 'admin'},
    {
      id: connection,
      tenantId,
      gateway: 'meta_native_action',
      accounts: ['123', '456'],
      writeAccounts: ['123', '456'],
      enabled: true,
      label: 'Agency login',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  store.putDocument(tenantId, 'website_assets', connection, {
    groups: [
      {
        kind: 'ad_accounts',
        assets: [
          {id: 'act_123', name: 'Acme Main Ads'},
          {id: 'act_456', name: 'Globex'},
        ],
      },
    ],
  });
}
const plan = (service: MirrorService, actor: Actor, name: string, account = '123') =>
  service.call(
    'amcp_campaign',
    {
      action: 'create',
      name,
      brief: 'Synthetic paused traffic draft.',
      steps: [
        {
          id: 'campaign',
          kind: 'write',
          gateway: 'meta_native_action',
          connection_id: connection,
          account_id: account,
          arguments: {action: 'meta_campaign_create', payload: {...payload, name}},
        },
      ],
    },
    actor,
  ) as Promise<JsonObject>;
const search = (f: ReturnType<typeof fixture>, actor: Actor, q: unknown, profileId?: unknown) =>
  workspaceSearch(
    f.store,
    actor,
    q,
    (tool, input) => f.service.call(tool, input, actor) as Promise<JsonObject>,
    profileId,
  );
const kinds = (r: JsonObject) => (r.results as JsonObject[]).map(h => h.kind + ':' + h.label);

test('workspace search finds this person’s plans, saved reports and accounts, and nothing of another person or workspace', async () => {
  const f = fixture(),
    alice: Actor = {tenantId: 'acme', userId: 'alice', role: 'operator'},
    bob: Actor = {tenantId: 'acme', userId: 'bob', role: 'operator'},
    admin: Actor = {tenantId: 'acme', userId: 'owner-admin', role: 'admin'},
    carol: Actor = {tenantId: 'globex', userId: 'carol', role: 'operator'};
  try {
    seed(f.store, 'acme', ['alice', 'bob']);
    seed(f.store, 'globex', ['carol']);
    const created = await plan(f.service, alice, 'Acme spring launch');
    assert.equal(created.success, true, JSON.stringify(created));
    f.store.putDocument('acme', 'overview_view', 'view-spring', {
      config: {name: 'Spring weekly', client_name: 'Acme', sources: []},
    });
    // Before the search: what is stored, so the search can be shown to change nothing. The per-tool timing metrics every
    // first-party call records (service_timings, shown in workspace health) are operational counters, not workspace data.
    const before = f.store.db
        .prepare("SELECT count(*) AS n, sum(revision) AS r FROM documents WHERE kind <> 'service_timings'")
        .get() as JsonObject,
      audits = (f.store.db.prepare('SELECT count(*) AS n FROM audit').get() as JsonObject).n;

    const own = await search(f, alice, 'spring');
    assert.deepEqual(kinds(own), ['plan:Acme spring launch', 'report:Acme · Spring weekly']);
    const hit = (own.results as JsonObject[])[0]!;
    assert.equal(hit.href, '/campaigns?id=' + encodeURIComponent(String(created.data.id)));
    assert.equal(own.provider_requests, 0);
    // Every source answered: plans, snapshots and media through their list operations, reports and accounts locally.
    assert.deepEqual(own.sources, {plan: 'ok', snapshot: 'ok', media: 'ok', report: 'ok', account: 'ok'});
    // Another operator does not see Alice's unshared plan; the workspace's saved reports are listed to every member.
    assert.deepEqual(kinds(await search(f, bob, 'spring')), ['report:Acme · Spring weekly']);
    // The workspace administrator sees every plan of the workspace.
    assert.deepEqual(kinds(await search(f, admin, 'spring')), [
      'plan:Acme spring launch',
      'report:Acme · Spring weekly',
    ]);
    // Another workspace sees none of it.
    assert.deepEqual((await search(f, carol, 'spring')).results, []);
    // Accounts are found by their saved name or their ID, and open the login's Connections view.
    const byName = await search(f, alice, 'acme main');
    assert.deepEqual(kinds(byName), ['account:Acme Main Ads']);
    assert.equal((byName.results as JsonObject[])[0]!.href, '/connections?connection_id=' + connection);
    assert.deepEqual(kinds(await search(f, alice, '456')), ['account:Globex']);

    assert.deepEqual(f.requests, [], 'no provider request');
    const after = f.store.db
      .prepare("SELECT count(*) AS n, sum(revision) AS r FROM documents WHERE kind <> 'service_timings'")
      .get() as JsonObject;
    assert.deepEqual(after, before, 'no document was saved or changed');
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM audit').get() as JsonObject).n, audits);
  } finally {
    f.store.close();
  }
});

test('workspace search is bounded per kind, refuses a malformed query and reports a failing source', async () => {
  const f = fixture(),
    alice: Actor = {tenantId: 'acme', userId: 'alice', role: 'operator'};
  try {
    seed(f.store, 'acme', ['alice']);
    for (let i = 1; i <= 7; i++) assert.equal((await plan(f.service, alice, 'Bulk plan ' + i)).success, true);
    const found = await search(f, alice, 'bulk');
    assert.equal((found.results as JsonObject[]).filter(h => h.kind === 'plan').length, workspaceSearchLimit);
    assert.equal(found.sources.plan, 'ok');
    for (const q of ['', 'a', 'x'.repeat(101), 'tab\there', 42, undefined])
      await assert.rejects(
        search(f, alice, q),
        (e: JsonObject) => e.code === 'INVALID_ARGUMENT' && e.details.field === 'q',
      );
    // A source that refuses is reported unavailable; the others still answer.
    const partial = await workspaceSearch(f.store, alice, 'bulk', async (tool, input) =>
      tool === 'amcp_campaign'
        ? {success: false, error: {code: 'FORBIDDEN', message: 'Synthetic refusal.'}}
        : (f.service.call(tool, input, alice) as Promise<JsonObject>),
    );
    assert.equal(partial.sources.plan, 'unavailable');
    assert.equal(partial.sources.account, 'ok');
    assert.deepEqual(partial.results, []);
    assert.deepEqual(f.requests, []);
  } finally {
    f.store.close();
  }
});

test('workspace search stays within a client access set and the working client (SEC-08; regression: tenant-wide)', async () => {
  const f = fixture(),
    admin: Actor = {tenantId: 'acme', userId: 'owner-admin', role: 'admin'},
    bob: Actor = {tenantId: 'acme', userId: 'bob', role: 'operator'};
  try {
    seed(f.store, 'acme', ['alice', 'bob']);
    // Client A is account 123 ("Acme Main Ads"), client B account 456 ("Globex"), both under one login.
    const source = (account: string) => ({platform: 'meta', connection_id: connection, account_id: account});
    f.store.putDocument('acme', 'overview_view', 'view-a', {
      config: {name: 'Spring weekly', client_name: 'Acme', sources: [source('123')]},
    });
    f.store.putDocument('acme', 'overview_view', 'view-b', {
      config: {name: 'Spring weekly', client_name: 'Globex', sources: [source('456')]},
    });
    const bindings = (account: string) => [
      {gateway: 'meta_native_action', connection_id: connection, account_id: account},
    ];
    f.store.putDocument('acme', 'client_profile', 'profile-a', {name: 'Acme', bindings: bindings('123')});
    f.store.putDocument('acme', 'client_profile', 'profile-b', {name: 'Globex', bindings: bindings('456')});
    for (const [name, account] of [
      ['Acme spring launch', '123'],
      ['Globex spring launch', '456'],
    ] as const)
      assert.equal((await plan(f.service, admin, name, account)).success, true);
    const set = saveAccessSet(f.store, admin, {name: 'Client A', bindings: bindings('123')});
    setMemberAccessSet(f.store, 'acme', 'alice', String(set.id));
    const alice: Actor = {tenantId: 'acme', userId: 'alice', role: 'operator', accessSetId: String(set.id)};

    // A member limited to client A finds neither client B's saved report nor its account ID or name. Before, the saved
    // reports and the accounts were read workspace-wide and both appeared.
    assert.deepEqual(kinds(await search(f, alice, 'globex')), []);
    assert.deepEqual(kinds(await search(f, alice, '456')), []);
    assert.deepEqual(kinds(await search(f, alice, 'spring')), ['report:Acme · Spring weekly']);
    assert.deepEqual(kinds(await search(f, alice, 'agency login')), ['account:Acme Main Ads']);
    // A member without a set still finds the whole workspace's saved reports and accounts, as before.
    assert.deepEqual(kinds(await search(f, bob, 'spring')), [
      'report:Acme · Spring weekly',
      'report:Globex · Spring weekly',
    ]);
    assert.deepEqual(kinds(await search(f, bob, 'agency login')), ['account:Acme Main Ads', 'account:Globex']);

    // The working client narrows every kind to that client's accounts: plans, saved reports and accounts.
    const globex = await search(f, admin, 'spring', 'profile-b');
    assert.deepEqual(kinds(globex), ['plan:Globex spring launch', 'report:Globex · Spring weekly']);
    assert.deepEqual(globex.client, {profile_id: 'profile-b', name: 'Globex'});
    assert.deepEqual(kinds(await search(f, admin, 'agency login', 'profile-b')), ['account:Globex']);
    assert.deepEqual(kinds(await search(f, admin, 'spring')), [
      'plan:Globex spring launch',
      'plan:Acme spring launch',
      'report:Acme · Spring weekly',
      'report:Globex · Spring weekly',
    ]);
    // A profile that does not exist, or one outside the person's access set, is refused rather than ignored.
    await assert.rejects(
      search(f, admin, 'spring', 'profile-missing'),
      (e: JsonObject) => e.code === 'PROFILE_NOT_FOUND',
    );
    await assert.rejects(search(f, alice, 'spring', 'profile-b'), (e: JsonObject) => e.code === 'PROFILE_NOT_FOUND');
    assert.deepEqual(kinds(await search(f, alice, 'spring', 'profile-a')), ['report:Acme · Spring weekly']);
    assert.deepEqual(f.requests, [], 'no provider request');
  } finally {
    f.store.close();
  }
});

test('the website search route needs a signed-in session and its CSRF token, and keeps the query out of the address', async () => {
  const store = new Store(':memory:', master),
    f = fixture(store),
    origin = 'https://amcp.shop',
    password = 'synthetic-test-password-only',
    listener = await listenForFetch(
      createHttpApp(f.service, store, {
        website: {
          origin,
          masterKey: master,
          adminPassword: password,
          fetcher: (async () => {
            throw Error('Unexpected vendor egress');
          }) as typeof fetch,
        },
      }),
    ),
    base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const request = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {Origin: origin, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status: response.status, body: await response.text()};
  };
  try {
    const login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({password}),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!,
      csrf = (await login.json()).csrf as string,
      headers = {Cookie: cookie, 'X-AMCP-CSRF': csrf};
    const session = JSON.parse((await request('/api/session', 'GET', undefined, {Cookie: cookie})).body),
      actor: Actor = {tenantId: session.workspaceId ?? 'local', userId: session.id ?? 'workspace-admin', role: 'admin'};
    seed(store, actor.tenantId, []);
    store.putDocument(actor.tenantId, 'overview_view', 'view-summer', {config: {name: 'Summer review', sources: []}});
    assert.equal((await request('/api/workspace-search', 'POST', {q: 'summer'})).status, 401);
    assert.equal((await request('/api/workspace-search', 'POST', {q: 'summer'}, {Cookie: cookie})).status, 403);
    const found = await request('/api/workspace-search', 'POST', {q: 'summer'}, headers);
    assert.equal(found.status, 200, found.body);
    const result = JSON.parse(found.body);
    assert.deepEqual(
      result.results.map((h: JsonObject) => h.href),
      ['/reporting-overview?view_id=view-summer'],
    );
    assert.equal(result.provider_requests, 0);
    // The working client reaches the search: a profile this workspace does not hold is refused, never ignored.
    const stale = await request('/api/workspace-search', 'POST', {q: 'summer', profile_id: 'profile-missing'}, headers);
    assert.equal(stale.status, 404, stale.body);
    assert.match(stale.body, /PROFILE_NOT_FOUND/);
    const refused = await request('/api/workspace-search', 'POST', {q: 'x'}, headers);
    assert.equal(refused.status, 400);
    assert.match(refused.body, /INVALID_ARGUMENT/);
    assert.deepEqual(f.requests, []);
  } finally {
    const closed = new Promise<void>(r => listener.close(() => r()));
    listener.closeAllConnections();
    await closed;
    store.close();
  }
});
