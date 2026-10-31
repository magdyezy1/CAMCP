import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService, strictOptions} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {createHttpApp} from '../server/http-app.js';
import {McpOAuth} from '../server/mcp-oauth.js';
import {endMcpGrants} from '../server/mcp-grants.js';
import {WebStore, type WebsiteOptions} from '../server/web-store.js';
import {UserAccounts} from '../server/user-accounts.js';
import type {JsonObject} from '../src/types.js';

/**
 * MCP-08 (review 2026-10-08): the AI-client authorization lifecycle. A just-rotated refresh token presented again
 * within the reuse window keeps the connection; every family revocation is audited with its client and reason;
 * members consent within their role; the consent screen offers read only and names the workspace and return host.
 */
const origin = 'https://amcp.shop',
  redirect = 'https://claude.ai/api/mcp/auth_callback',
  master = Buffer.alloc(32, 84).toString('base64'),
  password = 'synthetic-lifecycle-admin-password';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture(extra: Partial<WebsiteOptions> = {}) {
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store, new NativeTransport(), strictOptions, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
    website: WebsiteOptions = {
      origin,
      masterKey: master,
      adminPassword: password,
      fetcher: async () => {
        throw Error('No provider traffic allowed');
      },
      ...extra,
    };
  const listener = await listenForFetch(createHttpApp(service, store, {publicOrigin: origin, website}));
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  // A second view of the same database creates member accounts and their sessions, as the account routes would.
  const web = new WebStore(store, website),
    accounts = new UserAccounts(web);
  const request = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const form = body instanceof URLSearchParams;
    const response = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {
        Origin: origin,
        ...(body === undefined
          ? {}
          : {'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json'}),
        ...headers,
      },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
    const bytes = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
      status: response.status,
      headers: response.headers,
    });
  };
  const login = await request('/api/session', 'POST', {password});
  assert.equal(login.status, 200);
  const admin = {
    Cookie: login.headers.get('set-cookie')!.split(';')[0]!,
    'X-AMCP-CSRF': (await login.json()).csrf as string,
  };
  /** A member of the deployment's workspace with this role, and the headers of their website session. */
  const member = (role: 'viewer' | 'operator' | 'admin', email = role + '@example.test') => {
    const user = accounts.newUser('Member ' + role, email, null, true);
    store.db
      .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(web.tenantId, user.id, role, Date.now());
    const s = accounts.session(user, web.tenantId);
    return {user, headers: {Cookie: web.cookie(s.id), 'X-AMCP-CSRF': s.csrf}};
  };
  const token = (body: Record<string, string>) => request('/token', 'POST', new URLSearchParams(body));
  /** Registers a client, authorizes it from `headers`'s session and exchanges the code. */
  const connect = async (
    headers: Record<string, string>,
    options: {scope?: string; choose?: string; redirectUri?: string; name?: string} = {},
  ) => {
    const redirectUri = options.redirectUri ?? redirect;
    const registered = await request('/register', 'POST', {
      client_name: options.name ?? 'Claude',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    assert.equal(registered.status, 201);
    const client = await registered.json(),
      verifier = randomBytes(48).toString('base64url');
    const start = await request(
      '/authorize?' +
        new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirectUri,
          response_type: 'code',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          scope: options.scope ?? 'mcp:read mcp:write',
          state: 'lifecycle-state',
          resource: origin + '/mcp',
        }),
    );
    assert.equal(start.status, 303);
    const consentRequest = new URL(start.headers.get('location')!).searchParams.get('request')!;
    const preview = await (
      await request('/api/mcp/consent?request=' + encodeURIComponent(consentRequest), 'GET', undefined, headers)
    ).json();
    const decision = await request(
      '/api/mcp/consent',
      'POST',
      {request: consentRequest, approved: true, ...(options.choose ? {scope: options.choose} : {})},
      headers,
    );
    assert.equal(decision.status, 200, await decision.clone().text());
    const callback = new URL((await decision.json()).url);
    const exchanged = await token({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code: callback.searchParams.get('code')!,
      code_verifier: verifier,
      resource: origin + '/mcp',
    });
    assert.equal(exchanged.status, 200);
    return {client, preview, callback, credentials: await exchanged.json(), consentRequest};
  };
  const refresh = (client: JsonObject, refreshToken: string, scope?: string) =>
    token({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: refreshToken,
      resource: origin + '/mcp',
      ...(scope ? {scope} : {}),
    });
  const mcp = async (access: string) =>
    (
      await request(
        '/mcp',
        'POST',
        {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}},
        {Authorization: 'Bearer ' + access, Accept: 'application/json, text/event-stream'},
      )
    ).status;
  const audit = (event?: string) =>
    (store.db.prepare('SELECT event FROM audit ORDER BY seq').all() as {event: string}[])
      .map(r => JSON.parse(r.event) as JsonObject)
      .filter(e => event === undefined || e.event === event);
  /** Moves a refresh grant's rotation time back, as if `ms` had passed since it was rotated. */
  const age = (refreshToken: string, ms: number) =>
    store.db
      .prepare(
        "UPDATE amcp_mcp_grants SET data=json_set(data,'$.rotated_at',json_extract(data,'$.rotated_at')-?) WHERE hash=?",
      )
      .run(ms, sha(refreshToken));
  return {
    store,
    web,
    accounts,
    request,
    admin,
    member,
    token,
    connect,
    refresh,
    mcp,
    audit,
    age,
    close: async () => {
      const closing = new Promise<void>(r => listener.close(() => r()));
      listener.closeAllConnections();
      await closing;
      store.close();
    },
  };
}

test('MCP-08: two concurrent refreshes of one token inside the reuse window both succeed and the connection keeps working (regression: strict rotation revoked the family)', async () => {
  const f = await fixture();
  try {
    const {client, credentials} = await f.connect(f.admin);
    const responses = await Promise.all([
      f.refresh(client, credentials.refresh_token),
      f.refresh(client, credentials.refresh_token),
    ]);
    assert.deepEqual(
      responses.map(r => r.status),
      [200, 200],
    );
    const pairs = await Promise.all(responses.map(r => r.json()));
    const statuses = await Promise.all(pairs.map(p => f.mcp(p.access_token)));
    // The later of the two answers holds the connection's current pair; the earlier pair was superseded.
    assert.ok(statuses.includes(200), 'the connection keeps working: ' + statuses.join(','));
    const live = pairs[statuses.indexOf(200)],
      superseded = pairs.find(p => p !== live)!;
    // A client that kept the other answer recovers by refreshing promptly, within the same window.
    const recovered = await f.refresh(client, superseded.refresh_token);
    assert.equal(recovered.status, 200);
    const current = await recovered.json();
    assert.equal(await f.mcp(current.access_token), 200);
    assert.equal(current.scope, 'mcp:read mcp:write');
    // And the connection keeps rotating normally afterwards.
    const next = await f.refresh(client, current.refresh_token);
    assert.equal(next.status, 200);
    assert.equal(await f.mcp((await next.json()).access_token), 200);
    assert.equal(f.audit('mcp_oauth_family_revoked').length, 0);
    assert.ok(f.audit('mcp_oauth_refresh_reused').length >= 1);
    for (const e of f.audit('mcp_oauth_refresh_reused')) assert.equal(e.client_id, client.client_id);
  } finally {
    await f.close();
  }
});

test('MCP-08: reuse after the window, and reuse of the second-to-last token, end the family with one audit row naming the client and reason', async () => {
  const f = await fixture();
  try {
    // After the window: the rotated token presented again ends the connection.
    const first = await f.connect(f.admin);
    const rotated = await (await f.refresh(first.client, first.credentials.refresh_token)).json();
    f.age(first.credentials.refresh_token, 61000);
    const late = await f.refresh(first.client, first.credentials.refresh_token);
    assert.equal(late.status, 400);
    const lateError = await late.json();
    assert.equal(lateError.error, 'invalid_grant');
    assert.match(lateError.error_description, /already used/);
    assert.equal(await f.mcp(rotated.access_token), 401);
    assert.equal((await f.refresh(first.client, rotated.refresh_token)).status, 400);
    // Inside the window, but the token two rotations back: its successor was already used, so it is a replay.
    const second = await f.connect(f.admin, {name: 'Second client'});
    const r1 = await (await f.refresh(second.client, second.credentials.refresh_token)).json();
    const r2 = await (await f.refresh(second.client, r1.refresh_token)).json();
    assert.equal(await f.mcp(r2.access_token), 200);
    assert.equal((await f.refresh(second.client, second.credentials.refresh_token)).status, 400);
    assert.equal(await f.mcp(r2.access_token), 401);
    const ended = f.audit('mcp_oauth_family_revoked');
    assert.deepEqual(
      ended.map(e => [e.client_id, e.reason]),
      [
        [first.client.client_id, 'refresh_replay'],
        [second.client.client_id, 'refresh_replay'],
      ],
    );
    // Audit never carries token material or token hashes.
    const everything = JSON.stringify(f.audit());
    for (const secret of [
      first.credentials.access_token,
      first.credentials.refresh_token,
      rotated.refresh_token,
      r1.refresh_token,
      r2.access_token,
    ]) {
      assert.ok(!everything.includes(secret));
      assert.ok(!everything.includes(sha(secret)));
    }
    // The authorized-clients panel lists them as recently ended, with the reason.
    const listed = await (await f.request('/api/mcp/authorizations', 'GET', undefined, f.admin)).json();
    assert.deepEqual(listed.clients, []);
    assert.deepEqual(listed.ended.map((c: JsonObject) => c.reason).sort(), ['refresh_replay', 'refresh_replay']);
  } finally {
    await f.close();
  }
});

test('MCP-08: code replay, client revocation and membership change are audited with their reasons, and refresh says why it ended', async () => {
  const f = await fixture();
  try {
    const replayed = await f.connect(f.admin, {name: 'Replayed'});
    // Present the already-exchanged code again: the family it issued ends.
    const replay = await f.token({
      grant_type: 'authorization_code',
      client_id: replayed.client.client_id,
      redirect_uri: redirect,
      code: replayed.callback.searchParams.get('code')!,
      code_verifier: 'x'.repeat(64),
      resource: origin + '/mcp',
    });
    assert.equal(replay.status, 400);
    const revoked = await f.connect(f.admin, {name: 'Revoked by itself'});
    const rfc7009 = await f.request(
      '/revoke',
      'POST',
      new URLSearchParams({client_id: revoked.client.client_id, token: revoked.credentials.refresh_token}),
    );
    assert.equal(rfc7009.status, 200);
    const operator = f.member('operator'),
      demoted = await f.connect(operator.headers, {name: 'Operator client'});
    assert.equal(await f.mcp(demoted.credentials.access_token), 200);
    const change = await f.request(
      '/api/workspaces/member',
      'POST',
      {userId: operator.user.id, role: 'viewer'},
      f.admin,
    );
    assert.equal(change.status, 200, await change.clone().text());
    assert.equal(await f.mcp(demoted.credentials.access_token), 401);
    const after = await (await f.refresh(demoted.client, demoted.credentials.refresh_token)).json();
    assert.equal(after.error, 'invalid_grant');
    assert.match(after.error_description, /membership changed/);
    assert.doesNotMatch(after.error_description, /replay/i);
    const reasons = f.audit('mcp_oauth_family_revoked').map(e => [e.client_id, e.reason]);
    assert.deepEqual(reasons, [
      [replayed.client.client_id, 'code_replay'],
      [revoked.client.client_id, 'client_revoke'],
      [demoted.client.client_id, 'membership_change'],
    ]);
    assert.equal(
      f.audit('mcp_oauth_family_revoked').find(e => e.reason === 'membership_change')!.owner_user_id,
      operator.user.id,
    );
  } finally {
    await f.close();
  }
});

test('MCP-08: approval and denial audits name the client, a bounded name, the return host and the person', async () => {
  const f = await fixture();
  try {
    const operator = f.member('operator');
    const {client} = await f.connect(operator.headers, {name: 'N'.repeat(200)});
    const approved = f.audit('mcp_oauth_approved').at(-1)!;
    assert.equal(approved.client_id, client.client_id);
    assert.equal((approved.client_name as string).length, 120);
    assert.equal(approved.redirect_host, 'claude.ai');
    assert.equal(approved.owner_user_id, operator.user.id);
    assert.equal(approved.scope, 'mcp:read mcp:write');
    assert.equal(approved.role, 'operator');
    // A denial is joinable the same way.
    const registered = await (
      await f.request('/register', 'POST', {
        client_name: 'Denied',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
      })
    ).json();
    const start = await f.request(
      '/authorize?' +
        new URLSearchParams({
          client_id: registered.client_id,
          redirect_uri: redirect,
          response_type: 'code',
          code_challenge: 'a'.repeat(43),
          code_challenge_method: 'S256',
          resource: origin + '/mcp',
        }),
    );
    const consentRequest = new URL(start.headers.get('location')!).searchParams.get('request')!;
    const denied = await f.request('/api/mcp/consent', 'POST', {request: consentRequest, approved: false}, f.admin);
    assert.equal(new URL((await denied.json()).url).searchParams.get('error'), 'access_denied');
    const denial = f.audit('mcp_oauth_denied').at(-1)!;
    assert.equal(denial.client_id, registered.client_id);
    assert.equal(denial.redirect_host, 'claude.ai');
    assert.equal(denial.owner_user_id, undefined, 'the administrator door has no person account');
  } finally {
    await f.close();
  }
});

test('MCP-08: a viewer may connect an AI client with read access only, even when the client asked for write', async () => {
  const f = await fixture();
  try {
    const viewer = f.member('viewer');
    const {preview, credentials, client, consentRequest} = await f.connect(viewer.headers);
    assert.equal(preview.scope, 'mcp:read');
    assert.equal(preview.requestedScope, 'mcp:read mcp:write');
    assert.equal(preview.capped, true);
    assert.deepEqual(preview.choices, ['mcp:read']);
    assert.equal(preview.role, 'reader');
    assert.equal(credentials.scope, 'mcp:read', 'the token response says what was granted');
    assert.equal(f.store.authenticate(credentials.access_token).role, 'reader');
    assert.equal(await f.mcp(credentials.access_token), 200);
    // Refresh cannot add what the role did not allow.
    assert.equal((await f.refresh(client, credentials.refresh_token, 'mcp:read mcp:write')).status, 400);
    // The consent request was used once; a fresh one cannot be approved with write by a viewer.
    assert.equal(
      (
        await f.request(
          '/api/mcp/consent',
          'POST',
          {request: consentRequest, approved: true, scope: 'mcp:read mcp:write'},
          viewer.headers,
        )
      ).status,
      400,
    );
    const again = await f.request(
      '/authorize?' +
        new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirect,
          response_type: 'code',
          code_challenge: 'b'.repeat(43),
          code_challenge_method: 'S256',
          scope: 'mcp:read mcp:write',
          resource: origin + '/mcp',
        }),
    );
    const fresh = new URL(again.headers.get('location')!).searchParams.get('request')!;
    const refused = await f.request(
      '/api/mcp/consent',
      'POST',
      {request: fresh, approved: true, scope: 'mcp:read mcp:write'},
      viewer.headers,
    );
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error.message, /read-only access/);
  } finally {
    await f.close();
  }
});

test('MCP-08: an operator receives operator access by default, may choose read only, and refresh cannot add write back', async () => {
  const f = await fixture();
  try {
    const operator = f.member('operator');
    const written = await f.connect(operator.headers);
    assert.deepEqual(written.preview.choices, ['mcp:read', 'mcp:read mcp:write']);
    assert.equal(written.preview.capped, false);
    assert.equal(written.credentials.scope, 'mcp:read mcp:write');
    assert.equal(f.store.authenticate(written.credentials.access_token).role, 'operator');
    const chosen = await f.connect(operator.headers, {choose: 'mcp:read', name: 'Read-only choice'});
    assert.equal(chosen.credentials.scope, 'mcp:read');
    assert.equal(f.store.authenticate(chosen.credentials.access_token).role, 'reader');
    assert.equal((await f.refresh(chosen.client, chosen.credentials.refresh_token, 'mcp:read mcp:write')).status, 400);
    const kept = await f.refresh(chosen.client, chosen.credentials.refresh_token);
    assert.equal((await kept.json()).scope, 'mcp:read');
    // Each approval records the scope it granted.
    assert.equal(
      f
        .audit('mcp_oauth_approved')
        .map(e => e.scope)
        .join('|'),
      'mcp:read mcp:write|mcp:read',
    );
  } finally {
    await f.close();
  }
});

test('MCP-08: the consent payload names the workspace and the return host, and flags loopback return addresses', async () => {
  const f = await fixture();
  try {
    const {preview} = await f.connect(f.admin, {redirectUri: 'http://127.0.0.1:33418/callback', name: 'Local tool'});
    assert.equal(preview.workspace.id, f.web.tenantId);
    assert.equal(typeof preview.workspace.name, 'string');
    assert.equal(preview.redirectHost, '127.0.0.1:33418');
    assert.equal(preview.loopback, true);
    assert.equal(preview.name, 'Local tool');
    const hosted = await f.connect(f.admin);
    assert.equal(hosted.preview.redirectHost, 'claude.ai');
    assert.equal(hosted.preview.loopback, false);
  } finally {
    await f.close();
  }
});

test('MCP-08: members create role-capped connector tokens and revoke only their own tokens and clients', async () => {
  const f = await fixture();
  try {
    const viewer = f.member('viewer'),
      operator = f.member('operator');
    const create = (headers: Record<string, string>, role: string) =>
      f.request('/api/connector-tokens', 'POST', {name: 'Tool', role, confirmed: role === 'operator'}, headers);
    assert.equal((await create(viewer.headers, 'operator')).status, 403);
    const viewerToken = await create(viewer.headers, 'reader');
    assert.equal(viewerToken.status, 200);
    const viewerSecret = (await viewerToken.json()).token;
    assert.equal(f.store.authenticate(viewerSecret).ownerUserId, viewer.user.id);
    const operatorToken = await create(operator.headers, 'operator');
    assert.equal(operatorToken.status, 200);
    const operatorId = (await operatorToken.json()).id;
    const listed = await (await f.request('/api/connector-tokens', 'GET', undefined, viewer.headers)).json();
    assert.equal(listed.tokens.find((t: JsonObject) => t.id === operatorId).yours, false);
    assert.equal(listed.tokens.find((t: JsonObject) => t.id !== operatorId).yours, true);
    assert.ok(!JSON.stringify(listed).includes(viewerSecret));
    assert.equal(
      (await f.request('/api/connector-tokens/' + operatorId, 'DELETE', undefined, viewer.headers)).status,
      403,
    );
    assert.equal(
      (await f.request('/api/connector-tokens/' + operatorId, 'DELETE', undefined, operator.headers)).status,
      200,
    );
    // AI clients: a member revokes the ones they authorized; an administrator revokes any.
    const operatorClient = await f.connect(operator.headers, {name: 'Operator client'});
    const viewerClient = await f.connect(viewer.headers, {name: 'Viewer client'});
    assert.equal(
      (
        await f.request(
          '/api/mcp/authorizations/' + operatorClient.client.client_id,
          'DELETE',
          undefined,
          viewer.headers,
        )
      ).status,
      403,
    );
    assert.equal(await f.mcp(operatorClient.credentials.access_token), 200);
    assert.equal(
      (await f.request('/api/mcp/authorizations/' + viewerClient.client.client_id, 'DELETE', undefined, viewer.headers))
        .status,
      200,
    );
    assert.equal(await f.mcp(viewerClient.credentials.access_token), 401);
    assert.equal(
      (await f.request('/api/mcp/authorizations/' + operatorClient.client.client_id, 'DELETE', undefined, f.admin))
        .status,
      200,
    );
    assert.equal(await f.mcp(operatorClient.credentials.access_token), 401);
    const revocations = f.audit('mcp_oauth_revoked');
    assert.deepEqual(
      revocations.map(e => [e.client_id, e.reason]),
      [
        [viewerClient.client.client_id, 'workspace_revoke'],
        [operatorClient.client.client_id, 'workspace_revoke'],
      ],
    );
  } finally {
    await f.close();
  }
});

test('reviewer AI clients keep operator access, workspace isolation and password-change revocation', async () => {
  const testPassword = 'synthetic-reviewer-client-password',
    f = await fixture({testPassword});
  try {
    const reviewer = await f.web.signInTest(testPassword, '127.0.0.1'),
      headers = {Cookie: f.web.cookie(reviewer.id), 'X-AMCP-CSRF': reviewer.csrf},
      {client, credentials} = await f.connect(headers),
      actor = f.store.authenticate(credentials.access_token);
    assert.equal(actor.role, 'operator');
    assert.equal(actor.testAccount, true);
    assert.equal(actor.ownerUserId, 'workspace-test');
    assert.equal(actor.tenantId, f.web.testTenantId);
    assert.notEqual(actor.tenantId, f.web.tenantId);
    assert.equal(await f.mcp(credentials.access_token), 200);
    const refreshed = await f.refresh(client, credentials.refresh_token);
    assert.equal(refreshed.status, 200);
    const next = await refreshed.json();
    assert.equal(f.store.authenticate(next.access_token).testAccount, true);
    assert.throws(() => f.store.createKey({...actor, role: 'admin'}), /administrator/);
    const scoped = await f.web.signInTest(testPassword, '127.0.0.1');
    const policy = await f.request(
      '/api/workspace/workspace',
      'POST',
      {action: 'save_retention', days: 30, confirmed: true},
      {Cookie: f.web.cookie(scoped.id), 'X-AMCP-CSRF': scoped.csrf},
    );
    assert.equal((await policy.json()).error.code, 'OWNER_REQUIRED');
    new WebStore(f.store, {
      origin,
      masterKey: master,
      adminPassword: password,
      testPassword: testPassword + '-changed',
    });
    assert.equal(await f.mcp(next.access_token), 401);
    assert.equal((await f.refresh(client, next.refresh_token)).status, 400);
  } finally {
    await f.close();
  }
});

test('invited reviewer AI clients inherit the account reviewer flag and cannot use owner controls', async () => {
  const f = await fixture();
  try {
    const user = f.accounts.newUser('Invited reviewer', 'reviewer-client@example.test', null, true, true),
      session = f.accounts.session(user),
      {credentials} = await f.connect({Cookie: f.web.cookie(session.id), 'X-AMCP-CSRF': session.csrf}),
      actor = f.store.authenticate(credentials.access_token);
    assert.equal(actor.role, 'operator');
    assert.equal(actor.testAccount, true);
    assert.equal(actor.ownerUserId, user.id);
    assert.equal(actor.tenantId, user.tenant_id);
    assert.equal(await f.mcp(credentials.access_token), 200);
    const policy = await f.request(
      '/api/workspace/workspace',
      'POST',
      {action: 'save_retention', confirmed: true, days: 30},
      {Cookie: f.web.cookie(session.id), 'X-AMCP-CSRF': session.csrf},
    );
    assert.equal((await policy.json()).error.code, 'OWNER_REQUIRED');
  } finally {
    await f.close();
  }
});

test('MCP-08: the reuse window is configurable from 0 to 60 seconds, and 0 restores strict rotation', async () => {
  const store = new Store(':memory:', master);
  try {
    const web = new WebStore(store, {origin, masterKey: master, adminPassword: password});
    assert.equal(new McpOAuth(web, true).refreshReuseMs, 60000);
    assert.equal(new McpOAuth(web, true, {refreshReuseSeconds: 30}).refreshReuseMs, 30000);
    for (const bad of [-1, 61, 1.5, Number.NaN])
      assert.throws(() => new McpOAuth(web, true, {refreshReuseSeconds: bad}), /0 to 60/);
  } finally {
    store.close();
  }
  const f = await fixture({mcpRefreshReuseSeconds: 0});
  try {
    const {client, credentials} = await f.connect(f.admin);
    assert.equal((await f.refresh(client, credentials.refresh_token)).status, 200);
    assert.equal((await f.refresh(client, credentials.refresh_token)).status, 400);
    assert.deepEqual(
      f.audit('mcp_oauth_family_revoked').map(e => e.reason),
      ['refresh_replay'],
    );
  } finally {
    await f.close();
  }
});

test('MCP-08 with CIMD: two members using one metadata-document client keep separate connections, budgets and revocation (regression: one client ID merged everyone)', async () => {
  const documentUrl = 'https://client.example.com/oauth/shared-app.json',
    fetched: string[] = [];
  const f = await fixture({
    mcpClientMetadata: {
      request: async url => {
        fetched.push(url.href);
        return new Response(
          JSON.stringify({
            client_id: documentUrl,
            client_name: 'Shared App',
            redirect_uris: [redirect],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          }),
          {headers: {'content-type': 'application/json', 'cache-control': 'max-age=600'}},
        );
      },
    },
  });
  /** Authorizes the shared app from one member's session, as that person's installation of it would. */
  const connectShared = async (headers: Record<string, string>) => {
    const verifier = randomBytes(48).toString('base64url');
    const start = await f.request(
      '/authorize?' +
        new URLSearchParams({
          client_id: documentUrl,
          redirect_uri: redirect,
          response_type: 'code',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          scope: 'mcp:read',
          state: 'shared-state',
          resource: origin + '/mcp',
        }),
    );
    assert.equal(start.status, 303, await start.clone().text());
    const consentRequest = new URL(start.headers.get('location')!).searchParams.get('request')!;
    const decision = await f.request('/api/mcp/consent', 'POST', {request: consentRequest, approved: true}, headers);
    assert.equal(decision.status, 200, await decision.clone().text());
    const exchanged = await f.token({
      grant_type: 'authorization_code',
      client_id: documentUrl,
      redirect_uri: redirect,
      code: new URL((await decision.json()).url).searchParams.get('code')!,
      code_verifier: verifier,
      resource: origin + '/mcp',
    });
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    return (await exchanged.json()) as {access_token: string; refresh_token: string};
  };
  try {
    const alice = f.member('operator', 'alice@example.test'),
      bob = f.member('viewer', 'bob@example.test');
    const aliceTokens = await connectShared(alice.headers),
      bobTokens = await connectShared(bob.headers);
    assert.equal(await f.mcp(aliceTokens.access_token), 200);
    assert.equal(await f.mcp(bobTokens.access_token), 200);
    // The administrator sees one connection per person, named, under the one shared client ID.
    const listed = await (await f.request('/api/mcp/authorizations', 'GET', undefined, f.admin)).json();
    assert.deepEqual(
      listed.clients.map((c: JsonObject) => [c.id, c.owner, c.ownerName]).sort(),
      [
        [documentUrl, alice.user.id, 'Member operator'],
        [documentUrl, bob.user.id, 'Member viewer'],
      ].sort(),
    );
    // A member sees which one is theirs and no other person's identity.
    const seen = await (await f.request('/api/mcp/authorizations', 'GET', undefined, alice.headers)).json();
    assert.deepEqual(seen.clients.map((c: JsonObject) => c.yours).sort(), [false, true]);
    assert.ok(seen.clients.every((c: JsonObject) => !('owner' in c) && !('ownerName' in c)));
    // Each person's connection has its own budget of 30 successful token responses (SEC-01 with CIMD); the code
    // exchange was the first of Alice's 30.
    let aliceRefresh = aliceTokens.refresh_token;
    for (let i = 0; i < 29; i++) {
      const r = await f.token({grant_type: 'refresh_token', client_id: documentUrl, refresh_token: aliceRefresh});
      assert.equal(r.status, 200, 'refresh ' + (i + 1));
      aliceRefresh = (await r.json()).refresh_token;
    }
    assert.equal(
      (await f.token({grant_type: 'refresh_token', client_id: documentUrl, refresh_token: aliceRefresh})).status,
      429,
    );
    const bobRefreshed = await f.token({
      grant_type: 'refresh_token',
      client_id: documentUrl,
      refresh_token: bobTokens.refresh_token,
    });
    assert.equal(bobRefreshed.status, 200, 'another person using the same app keeps their own budget');
    const bobAccess = (await bobRefreshed.json()).access_token as string;
    // The administrator ends Alice's connection only; Bob's keeps working, and the audit names whose ended.
    const revoked = await f.request(
      '/api/mcp/authorizations/' + encodeURIComponent(documentUrl) + '?owner=' + encodeURIComponent(alice.user.id),
      'DELETE',
      undefined,
      f.admin,
    );
    assert.equal(revoked.status, 200, await revoked.clone().text());
    assert.equal(await f.mcp(bobAccess), 200);
    const after = await (await f.request('/api/mcp/authorizations', 'GET', undefined, f.admin)).json();
    assert.deepEqual(
      after.clients.map((c: JsonObject) => c.owner),
      [bob.user.id],
    );
    assert.deepEqual(
      after.ended.map((c: JsonObject) => [c.id, c.owner, c.reason]),
      [[documentUrl, alice.user.id, 'workspace_revoke']],
    );
    assert.deepEqual(
      f.audit('mcp_oauth_revoked').map(e => [e.client_id, e.owner_user_id]),
      [[documentUrl, alice.user.id]],
    );
    // Ending every connection of the app audits one row per person, not one for the whole client. A third member
    // connects first, so two people have live grants of the app again (Alice's budget is spent for 15 minutes).
    const carol = f.member('operator', 'carol@example.test');
    await connectShared(carol.headers);
    assert.ok(endMcpGrants(f.store, 'client_id=?', [documentUrl], 'workspace_revoke') > 0);
    assert.deepEqual(
      f
        .audit('mcp_oauth_family_revoked')
        .filter(e => e.client_id === documentUrl && e.reason === 'workspace_revoke')
        .map(e => e.owner_user_id)
        .sort(),
      [bob.user.id, carol.user.id].sort(),
    );
    assert.equal(fetched.length, 1, 'the shared document is fetched once and cached');
  } finally {
    await f.close();
  }
});
