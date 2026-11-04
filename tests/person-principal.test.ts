// MCP-02 (owner decision D16 (4)): person-scoped work follows the person across the website and that person's AI
// clients. Before this change ownership compared the credential (oauth/<client>, connector/<id>) with the website
// identity, so a website upload was invisible to the same administrator's AI client (sources: [] and FORBIDDEN), and a
// plan created in one client could not be continued from another. Write reviews stay bound to the credential that
// prepared them. Synthetic data only: no provider is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/client';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {MediaSources} from '../src/media-sources.js';
import {createHttpApp} from '../server/http-app.js';
import {listenForFetch} from './http-listener.js';
import {principalOf, ownsRecord} from '../src/actor-identity.js';
import {createPlan, fixture as snapchatFixture, campaignStep, squadPlan} from './snapchat-plan-fixture.js';
import type {Actor, JsonObject} from '../src/types.js';

const origin = 'https://amcp.shop',
  redirect = 'https://claude.ai/api/mcp/auth_callback',
  master = Buffer.alloc(32, 91).toString('base64'),
  password = 'synthetic-principal-test-password',
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );

test('principalOf: the door and its keys share one person; an account and its keys share another', () => {
  const door = {userId: 'workspace-admin'},
    account = {userId: 'person-1', ownerUserId: 'person-1'};
  assert.equal(principalOf(door), 'workspace-admin');
  assert.equal(principalOf({userId: 'oauth/client-a'}), 'workspace-admin');
  assert.equal(principalOf({userId: 'connector/token-a'}), 'workspace-admin');
  assert.equal(principalOf(account), 'person-1');
  assert.equal(principalOf({userId: 'oauth/client-b', ownerUserId: 'person-1'}), 'person-1');
  assert.equal(principalOf({userId: 'cli-key'}), 'cli-key', 'any other key is its own person');
  // The reviewers' door signs in to its own workspace; there it and the keys approved from it are one person too.
  assert.equal(principalOf({userId: 'workspace-test'}), 'workspace-admin');
  assert.equal(principalOf({userId: 'oauth/client-t', ownerUserId: 'workspace-test'}), 'workspace-admin');
  assert.equal(ownsRecord({userId: 'connector/token-t'}, {user_id: 'workspace-test'}), true);
  // A door upload never reaches an account member's client, and the reverse.
  assert.equal(ownsRecord({userId: 'oauth/client-c', ownerUserId: 'person-2'}, {user_id: 'workspace-admin'}), false);
  assert.equal(ownsRecord({userId: 'oauth/client-c', ownerUserId: 'person-2'}, {user_id: 'workspace-test'}), false);
  assert.equal(
    ownsRecord({userId: 'oauth/client-c', ownerUserId: 'person-2'}, {user_id: 'x', principal: 'workspace-admin'}),
    false,
  );
  assert.equal(ownsRecord({userId: 'oauth/client-a'}, {user_id: 'oauth/x', principal: 'person-1'}), false);
  assert.equal(ownsRecord({userId: 'cli-key'}, {user_id: 'oauth/x', principal: 'workspace-admin'}), false);
  // Legacy records without a principal: the credential itself, or the person's website identity.
  assert.equal(ownsRecord({userId: 'oauth/client-a'}, {user_id: 'oauth/client-a'}), true);
  assert.equal(ownsRecord({userId: 'oauth/client-b', ownerUserId: 'person-1'}, {user_id: 'person-1'}), true);
  assert.equal(ownsRecord({userId: 'oauth/client-b', ownerUserId: 'person-1'}, {user_id: 'oauth/client-a'}), false);
});

async function site() {
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store, undefined, undefined, {
      allowWrites: true,
      maxBudgetChange: 0,
      requireBeforeState: true,
    });
  const listener = await listenForFetch(
    createHttpApp(service, store, {
      publicOrigin: origin,
      website: {
        origin,
        masterKey: master,
        adminPassword: password,
        fetcher: async () => {
          throw Error('No provider traffic allowed');
        },
      },
    }),
  );
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const request = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const raw = Buffer.isBuffer(body),
      form = body instanceof URLSearchParams;
    const response = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {
        Origin: origin,
        ...(body === undefined
          ? {}
          : {
              'Content-Type': raw
                ? 'application/octet-stream'
                : form
                  ? 'application/x-www-form-urlencoded'
                  : 'application/json',
            }),
        ...headers,
      },
      body: body === undefined ? undefined : raw || form ? (body as BodyInit) : JSON.stringify(body),
    });
    const bytes = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
      status: response.status,
      headers: response.headers,
    });
  };
  const login = await request('/api/session', 'POST', {password});
  assert.equal(login.status, 200);
  const headers = {
    Cookie: login.headers.get('set-cookie')!.split(';')[0]!,
    'X-AMCP-CSRF': (await login.json()).csrf as string,
  };
  return {
    store,
    base,
    request,
    headers,
    close: async () => {
      const closing = new Promise<void>(r => listener.close(() => r()));
      listener.closeAllConnections();
      await closing;
      store.close();
    },
  };
}
async function mcp(base: string, token: string) {
  const client = new Client({name: 'principal fixture', version: '1'});
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: {headers: {Authorization: 'Bearer ' + token}},
    }),
  );
  return client;
}
const result = (r: any) => JSON.parse(r.content[0].text);

test('a website upload is listed and usable by the same administrator’s OAuth client and connector token', async () => {
  const s = await site(),
    clients: Client[] = [];
  try {
    // 1. The administrator uploads on the website.
    const started = await s.request(
      '/api/media/sources',
      'POST',
      {filename: 'creative.png', size: png.length},
      s.headers,
    );
    assert.equal(started.status, 201);
    const sourceId = (await started.json()).source_id;
    assert.equal((await s.request('/api/media/sources/' + sourceId + '/parts/0', 'PUT', png, s.headers)).status, 200);
    const completed = await s.request('/api/media/sources/' + sourceId + '/complete', 'POST', undefined, s.headers);
    assert.equal(completed.status, 200, await completed.clone().text());
    assert.equal((await (await s.request('/api/media/sources', 'GET', undefined, s.headers)).json()).sources.length, 1);
    // 2. They authorize an AI client with the real OAuth flow, and create a connector token.
    const client = await (
      await s.request('/register', 'POST', {
        client_name: 'Claude',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'mcp:read mcp:write',
      })
    ).json();
    const verifier = randomBytes(48).toString('base64url');
    const start = await s.request(
      '/authorize?' +
        new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirect,
          response_type: 'code',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          scope: 'mcp:read mcp:write',
          resource: origin + '/mcp',
        }),
    );
    const consent = new URL(start.headers.get('location')!).searchParams.get('request')!;
    const decision = await s.request('/api/mcp/consent', 'POST', {request: consent, approved: true}, s.headers);
    assert.equal(decision.status, 200);
    const exchanged = await s.request(
      '/token',
      'POST',
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: redirect,
        code: new URL((await decision.json()).url).searchParams.get('code')!,
        code_verifier: verifier,
        resource: origin + '/mcp',
      }),
    );
    assert.equal(exchanged.status, 200);
    const oauthToken = (await exchanged.json()).access_token as string;
    const connector = await s.request(
      '/api/connector-tokens',
      'POST',
      {name: 'Claude Code', role: 'operator', confirmed: true},
      s.headers,
    );
    assert.equal(connector.status, 200);
    const connectorToken = (await connector.json()).token as string;
    // 3. Each of the administrator's AI credentials lists the upload and passes its ownership check.
    for (const token of [oauthToken, connectorToken]) {
      assert.equal(principalOf(s.store.authenticate(token)), 'workspace-admin');
      const ai = await mcp(s.base, token);
      clients.push(ai);
      const listed = result(await ai.callTool({name: 'amcp_media', arguments: {action: 'list'}}));
      assert.equal(listed.success, true, JSON.stringify(listed));
      assert.deepEqual(
        listed.data.sources.map((x: JsonObject) => x.source_id),
        [sourceId],
      );
      const planned = result(
        await ai.callTool({
          name: 'amcp_media',
          arguments: {action: 'plan', source_id: sourceId, destinations: [{platform: 'meta', account_id: '123'}]},
        }),
      );
      assert.notEqual(planned.error?.code, 'FORBIDDEN', JSON.stringify(planned));
      assert.equal(planned.success, true, JSON.stringify(planned));
    }
  } finally {
    for (const c of clients) await c.close();
    await s.close();
  }
});

/** An account member with an active membership, as the website records them. */
function member(store: Store, tenant: string, id: string, role: 'admin' | 'operator' | 'viewer' = 'operator') {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS amcp_users(id TEXT PRIMARY KEY,version INTEGER,approved INTEGER,disabled INTEGER)',
  );
  store.db.prepare('INSERT OR IGNORE INTO amcp_users VALUES(?,1,1,0)').run(id);
  store.db
    .prepare('INSERT OR REPLACE INTO workspace_memberships VALUES(?,?,?,?,?)')
    .run(tenant, id, role, 1, Date.now());
}

test('an account member’s uploads follow them to their own AI clients and never to another member’s', async () => {
  const store = new Store(':memory:', master),
    tenant = 'members';
  try {
    store.ensureTenant(tenant);
    member(store, tenant, 'person-1');
    member(store, tenant, 'person-2');
    const website: Actor = {tenantId: tenant, userId: 'person-1', ownerUserId: 'person-1', role: 'operator'},
      own: Actor = {tenantId: tenant, userId: 'oauth/client-a', ownerUserId: 'person-1', role: 'operator'},
      other: Actor = {tenantId: tenant, userId: 'oauth/client-b', ownerUserId: 'person-2', role: 'operator'},
      sources = new MediaSources(store, true, async () => new Response(png));
    const fromWebsite = await sources.importLink(website, 'https://cdn.example.test/website.png'),
      fromClient = await sources.importLink(own, 'https://cdn.example.test/client.png');
    // Website upload, then MCP use by the same person; MCP upload, then website use by the same person.
    assert.deepEqual(sources.file(own, fromWebsite.source_id).bytes, png);
    assert.deepEqual(sources.file(website, fromClient.source_id).bytes, png);
    assert.deepEqual(
      sources
        .list(own)
        .map(x => x.source_id)
        .sort(),
      [fromWebsite.source_id, fromClient.source_id].sort(),
    );
    // Another non-admin member's client is still refused, and lists nothing of theirs.
    for (const id of [fromWebsite.source_id, fromClient.source_id])
      assert.throws(() => sources.file(other, id), {code: 'FORBIDDEN'});
    assert.deepEqual(sources.list(other), []);
    assert.equal(store.document(tenant, 'media_source', fromClient.source_id).user_id, 'oauth/client-a');
    assert.equal(store.document(tenant, 'media_source', fromClient.source_id).principal, 'person-1');
  } finally {
    store.close();
  }
});

/** Client A and client B of person-1, and a client of another operator, person-2, in the Snapchat plan fixture. */
function persons(f: ReturnType<typeof snapchatFixture>) {
  const tenant = 'snap-plan';
  member(f.store, tenant, 'person-1');
  member(f.store, tenant, 'person-2');
  const a: Actor = {tenantId: tenant, userId: 'oauth/client-a', ownerUserId: 'person-1', role: 'operator'},
    b: Actor = {tenantId: tenant, userId: 'connector/token-b', ownerUserId: 'person-1', role: 'operator'},
    other: Actor = {tenantId: tenant, userId: 'oauth/client-c', ownerUserId: 'person-2', role: 'operator'},
    call = (actor: Actor, input: JsonObject) => f.service.call('amcp_campaign', input, actor) as Promise<any>,
    approved = (prepared: any) => ({
      ...prepared.data.next_call.arguments,
      ...prepared.data.next_call.add_after_user_approval,
    });
  return {tenant, a, b, other, call, approved};
}

test('a plan created in client A continues in client B of the same person; reviews stay with their credential', async () => {
  const f = snapchatFixture();
  try {
    const {tenant, a, b, other, call, approved} = persons(f);
    const created = await call(a, {
      action: 'create',
      name: 'Snapchat plan',
      brief: 'Synthetic plan',
      steps: squadPlan(2),
    });
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 2000));
    const id = created.data.id;
    assert.equal(f.store.document(tenant, 'campaign_run', id).principal, 'person-1');
    // Before MCP-02 client B was refused FORBIDDEN here and listed nothing: the plan was keyed on client A's key.
    assert.equal((await call(b, {action: 'get', id})).success, true);
    assert.ok((await call(b, {action: 'list'})).data.campaigns.some((p: JsonObject) => p.id === id));
    // Another non-admin member's client is still refused and lists nothing of person-1's.
    assert.equal((await call(other, {action: 'get', id})).error.code, 'FORBIDDEN');
    assert.ok(!(await call(other, {action: 'list'})).data.campaigns.some((p: JsonObject) => p.id === id));
    assert.equal((await call(other, {action: 'prepare_next', id})).error.code, 'FORBIDDEN');

    // A review prepared in client A is executed only by client A's credential. Client B's attempt is refused before
    // the plan changes: the step keeps its review (it used to be marked failed by the refused write).
    const preparedInA = await call(a, {action: 'prepare_next', id});
    assert.equal(preparedInA.success, true, JSON.stringify(preparedInA).slice(0, 2000));
    const crossed = await call(b, approved(preparedInA));
    assert.equal(crossed.success, false, 'executing another credential’s review is still refused');
    assert.equal(crossed.error.code, 'REVIEW_HELD_ELSEWHERE');
    assert.equal(crossed.error.details.step_id, 'campaign');
    assert.equal(crossed.error.details.review_expires_at, preparedInA.data.review.expires_at);
    assert.deepEqual(crossed.error.details.next_call, {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id}});
    const held = await call(b, {action: 'prepare_next', id});
    assert.equal(held.error?.code, 'REVIEW_HELD_ELSEWHERE', 'client B is not handed a review it cannot execute');
    // The write review itself still refuses another credential, as before.
    const direct = (await f.service.call(
      'amcp_write',
      {action: 'execute', review_id: preparedInA.data.review.review_id, confirmed: true},
      b,
    )) as any;
    assert.equal(direct.error.code, 'FORBIDDEN');
    const step = f.store.document(tenant, 'campaign_run', id).steps[0];
    assert.equal(step.status, 'review_ready');
    assert.equal(step.review_id, preparedInA.data.review.review_id);
    assert.equal(f.writes.length, 0);

    // Client A executes its own review; client B continues the plan with a review of its own.
    const executedInA = await call(a, approved(preparedInA));
    assert.equal(executedInA.success, true, JSON.stringify(executedInA).slice(0, 2000));
    assert.equal(f.writes.length, 1);
    const preparedInB = await call(b, {action: 'prepare_next', id});
    assert.equal(preparedInB.success, true, JSON.stringify(preparedInB).slice(0, 2000));
    assert.equal(preparedInB.data.step_id, 'squad_1');
    const executedInB = await call(b, approved(preparedInB));
    assert.equal(executedInB.success, true, JSON.stringify(executedInB).slice(0, 2000));
    assert.equal(executedInB.data.state, 'complete');
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

test('a review left unexecuted in client A expires, then client B of the same person prepares its own', async t => {
  const f = snapchatFixture();
  try {
    const {a, b, call, approved} = persons(f);
    const id = (
      await call(a, {action: 'create', name: 'Snapchat plan', brief: 'Synthetic plan', steps: [campaignStep()]})
    ).data.id;
    const preparedInA = await call(a, {action: 'prepare_next', id});
    assert.equal(preparedInA.success, true, JSON.stringify(preparedInA).slice(0, 2000));
    // Client A disconnected (a reconnect registers a new client): its review lapses after five minutes.
    t.mock.timers.enable({apis: ['Date'], now: Date.parse(preparedInA.data.review.expires_at) + 1000});
    const preparedInB = await call(b, {action: 'prepare_next', id});
    assert.equal(preparedInB.success, true, JSON.stringify(preparedInB).slice(0, 2000));
    assert.notEqual(preparedInB.data.review.review_id, preparedInA.data.review.review_id);
    assert.equal((await call(a, approved(preparedInA))).success, false, 'the lapsed review never executes');
    const executed = await call(b, approved(preparedInB));
    assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 2000));
    assert.equal(executed.data.state, 'complete');
    assert.equal(f.writes.length, 1);
  } finally {
    t.mock.timers.reset();
    f.close();
  }
});

test('a plan approval stays with the connection that recorded it', async () => {
  const f = snapchatFixture();
  try {
    const {a, b, call} = persons(f);
    const id = (
      await call(a, {action: 'create', name: 'Snapchat plan', brief: 'Synthetic plan', steps: [campaignStep()]})
    ).data.id;
    const summary = await call(a, {action: 'approve', id});
    assert.equal(summary.success, true, JSON.stringify(summary).slice(0, 2000));
    const approve = {...summary.data.next_call.arguments, ...summary.data.next_call.add_after_user_approval};
    assert.equal((await call(a, approve)).success, true);
    // Client B sees the plan but runs it only under an approval of its own.
    const refused = await call(b, {action: 'run', id});
    assert.equal(refused.error.code, 'APPROVAL_REQUIRED');
    assert.deepEqual(refused.error.details.next_call, {tool: 'amcp_campaign', arguments: {action: 'approve', id}});
    assert.equal(f.writes.length, 0);
    assert.equal((await call(b, approve)).success, true);
    const ran = await call(b, {action: 'run', id});
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 2000));
    assert.equal(ran.data.state, 'complete');
    assert.equal(f.writes.length, 1);
  } finally {
    f.close();
  }
});

test('a plan saved before principals stays with the credential that made it', async () => {
  const f = snapchatFixture();
  try {
    const created = await createPlan(f, [campaignStep()]);
    const id = created.data.id,
      saved = f.store.document('snap-plan', 'campaign_run', id);
    // The fixture actor is a plain key: its record carries its own name as principal.
    assert.equal(saved.principal, 'operator');
    delete saved.principal;
    f.store.putDocument('snap-plan', 'campaign_run', id, saved);
    const elsewhere: Actor = {tenantId: 'snap-plan', userId: 'oauth/elsewhere', role: 'operator'};
    assert.equal(
      ((await f.service.call('amcp_campaign', {action: 'get', id}, elsewhere)) as any).error.code,
      'FORBIDDEN',
    );
    assert.equal(((await f.call('amcp_campaign', {action: 'get', id})) as any).success, true);
  } finally {
    f.close();
  }
});
