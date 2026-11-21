// r25-admin-email, item 7 (the owner's decision of 2026-11-21, replacing D16's operator cap for owner accounts only): an AI
// client an owner of the deployment's workspace approves, or a connector token such an owner creates, may carry owner access.
// The consent screen and the token form offer Owner to those owners and preselect it; operator and read-only stay offered;
// administrators, operators, viewers and every other workspace keep today's caps. Nothing escalates silently: a credential
// made before keeps the access it was given. Owner-level credentials need a recent sign-in, are audited, and stop when the
// person stops being an owner. Synthetic data and a fake transport only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {adminAddress, origin, site, type Site} from './helpers/admin-email-site.js';
import type {JsonObject} from '../src/types.js';

const redirect = 'https://claude.ai/api/mcp/auth_callback';
type Headers = Record<string, string>;
/** An AI client's authorization request over the real stack: registers, asks for `scope`, and is sent to the consent screen. */
async function begin(f: Site, options: {scope?: string; name?: string} = {}) {
  const registered = await f.request('/register', 'POST', {
    client_name: options.name ?? 'Synthetic client',
    redirect_uris: [redirect],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  assert.equal(registered.status, 201, await registered.clone().text());
  const client = (await registered.json()) as JsonObject,
    verifier = randomBytes(48).toString('base64url'),
    start = await f.request(
      '/authorize?' +
        new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirect,
          response_type: 'code',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          scope: options.scope ?? 'mcp:read mcp:write',
          state: 'synthetic-state',
          resource: origin + '/mcp',
        }),
    );
  assert.equal(start.status, 303);
  const request = new URL(start.headers.get('location')!).searchParams.get('request')!;
  const tokens = (body: Record<string, string>) =>
    fetch(f.base + '/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: origin},
      body: new URLSearchParams({client_id: client.client_id, resource: origin + '/mcp', ...body}),
    });
  return {
    client,
    request,
    consent: async (headers: Headers) =>
      (await (
        await f.request('/api/mcp/consent?request=' + encodeURIComponent(request), 'GET', undefined, headers)
      ).json()) as JsonObject,
    decide: (headers: Headers, body: JsonObject = {}) =>
      f.request('/api/mcp/consent', 'POST', {request, approved: true, ...body}, headers),
    exchange: async (decision: Response) => {
      assert.equal(decision.status, 200, await decision.clone().text());
      const code = new URL(((await decision.json()) as {url: string}).url).searchParams.get('code')!;
      const response = await tokens({
        grant_type: 'authorization_code',
        redirect_uri: redirect,
        code,
        code_verifier: verifier,
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as JsonObject;
    },
    refresh: async (refreshToken: string) => tokens({grant_type: 'refresh_token', refresh_token: refreshToken}),
  };
}
/** One MCP tool call with a bearer token, in the stateless legacy framing: what the wire answers. */
async function mcp(f: Site, access: string, name: string, args: JsonObject) {
  const response = await fetch(f.base + '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + access,
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}),
    }),
    body = (await response.json().catch(() => ({}))) as JsonObject,
    text = body.result?.content?.[0]?.text;
  return {status: response.status, result: (text ? JSON.parse(text) : undefined) as JsonObject | undefined};
}
/** A refresh-token exchange against a (possibly restarted) site: what the client's next request to /token answers. */
const refreshWith = (f: Site, clientId: string, refreshToken: string) =>
  fetch(f.base + '/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: origin},
    body: new URLSearchParams({
      client_id: clientId,
      resource: origin + '/mcp',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
const health = (f: Site, access: string) => mcp(f, access, 'amcp_workspace', {action: 'health'});
/** The owner's own sessions: the second owner and the AMCP owner in the deployment workspace, a member of each role, and the second owner in their own workspace. */
async function people(f: Site) {
  const original = await f.deploymentOwner('owner@example.test'),
    second = await f.account(adminAddress, 'Second owner'),
    role = async (email: string, role: string) => {
      const account = await f.account(email);
      f.store.db
        .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
        .run(f.tenant, account.id, role, Date.now());
      return (await f.switchTo(await f.signedIn(email))).headers!;
    };
  const personal = await f.signedIn(adminAddress),
    owner = (await f.switchTo(personal)).headers!;
  return {
    original,
    second,
    owner,
    originalOwner: await f.signedIn('owner@example.test'),
    personal: await f.signedIn(adminAddress),
    admin: await role('plain-admin@example.test', 'admin'),
    operator: await role('plain-operator@example.test', 'operator'),
    viewer: await role('plain-viewer@example.test', 'viewer'),
  };
}
const events = (f: Site, name: string) => f.events().filter(e => e.event === name);

test('the consent screen offers Owner to an owner of the deployment, and to nobody else', async () => {
  const f = await site({adminEmail: adminAddress, allowWrites: true});
  try {
    const p = await people(f);
    for (const [who, headers, offered] of [
      ['the second owner', p.owner, true],
      ['the AMCP owner', p.originalOwner, true],
      ['an administrator', p.admin, false],
      ['an operator', p.operator, false],
      ['a viewer', p.viewer, false],
      ['the second owner in their own workspace', p.personal, false],
    ] as const) {
      const info = await (await begin(f)).consent(headers);
      assert.equal(info.choices.includes('owner'), offered, who);
      assert.equal(info.ownerAccess, offered, who);
      // Operator and read-only stay offered to those who could always choose them (a viewer reads only).
      assert.ok(info.choices.includes('mcp:read'), who);
      assert.equal(info.choices.includes('mcp:read mcp:write'), who !== 'a viewer', who);
    }
    // A client that asked only to read is never offered more than it asked for.
    const readOnly = await (await begin(f, {scope: 'mcp:read'})).consent(p.owner);
    assert.deepEqual(readOnly.choices, ['mcp:read']);
    assert.equal(readOnly.ownerAccess, false);
    // The session tells the website whether to offer Owner on the token form.
    const flag = async (headers: Headers) =>
      ((await (await f.request('/api/session', 'GET', undefined, headers)).json()) as JsonObject).ownerCredentials;
    assert.deepEqual(
      [await flag(p.owner), await flag(p.originalOwner), await flag(p.admin), await flag(p.personal)],
      [true, true, false, false],
    );
  } finally {
    await f.close();
  }
});

test('an AI client the owner approves as Owner reaches the owner-gated actions; at operator level it does not, and the choice is audited', async () => {
  const f = await site({adminEmail: adminAddress, allowWrites: true});
  try {
    const p = await people(f);
    const asOwner = await begin(f, {name: 'Owner-level client'}),
      owned = await asOwner.exchange(await asOwner.decide(p.owner, {scope: 'owner', owner_confirmed: true}));
    assert.equal(owned.scope, 'mcp:read mcp:write', 'the OAuth scopes a client sees are unchanged');
    const reached = await health(f, owned.access_token);
    assert.equal(reached.result?.success, true, JSON.stringify(reached).slice(0, 400));
    assert.ok('policies' in reached.result!.data, 'the whole owner view, not the administrator’s');
    assert.equal(
      (await mcp(f, owned.access_token, 'amcp_workspace', {action: 'support_bundle'})).result?.success,
      true,
    );
    // The same owner, approving without choosing Owner (an API client that names no choice), gets what D16 always gave.
    const asOperator = await begin(f, {name: 'Operator-level client'}),
      operator = await asOperator.exchange(await asOperator.decide(p.owner));
    const refused = await health(f, operator.access_token);
    assert.equal(refused.result?.success, false);
    assert.equal(refused.result?.error.code, 'OWNER_REQUIRED');
    assert.equal(
      (await mcp(f, operator.access_token, 'amcp_workspace', {action: 'support_bundle'})).result?.error.code,
      'OWNER_REQUIRED',
    );
    // The keys carry the role: administrator for owner level, operator otherwise.
    const roles = f.store.db
      .prepare("SELECT role FROM api_keys WHERE user_id LIKE 'oauth/%' ORDER BY rowid")
      .all() as JsonObject[];
    assert.deepEqual(
      roles.map(r => r.role),
      ['admin', 'operator'],
    );
    // Audited, with the person and the client, never the address.
    const granted = events(f, 'ai_client_owner_access_granted');
    assert.equal(granted.length, 1);
    assert.equal(granted[0]!.owner_user_id, p.second.id);
    assert.equal(granted[0]!.client_id, asOwner.client.client_id);
    assert.ok(!JSON.stringify(f.events()).toLowerCase().includes('example.test'));
    const approvals = events(f, 'mcp_oauth_approved');
    assert.deepEqual(
      approvals.map(a => a.role),
      ['owner', 'operator'],
    );
    // A refresh keeps the level.
    const refreshed = (await (await asOwner.refresh(owned.refresh_token)).json()) as JsonObject;
    assert.equal((await health(f, refreshed.access_token)).result?.success, true);
  } finally {
    await f.close();
  }
});

test('Owner cannot be chosen by anyone it is not offered to, nor limited to a client', async () => {
  const f = await site({adminEmail: adminAddress, allowWrites: true});
  try {
    const p = await people(f);
    for (const headers of [p.admin, p.operator, p.viewer, p.personal]) {
      const refused = await (await begin(f)).decide(headers, {scope: 'owner'});
      assert.equal(((await refused.json()) as JsonObject).error.code, 'OAUTH_REQUEST_INVALID');
    }
    const limited = await (
      await begin(f)
    ).decide(p.owner, {scope: 'owner', owner_confirmed: true, access_set_id: 'synthetic-set'});
    assert.equal(((await limited.json()) as JsonObject).error.code, 'INVALID_ARGUMENT');
    assert.equal(events(f, 'ai_client_owner_access_granted').length, 0);
  } finally {
    await f.close();
  }
});

// Review S2-1 (the lead's decision of 2026-11-21): Owner is a second, explicit step, never a click on a preselected choice.
// The page asks for the confirmation (tests/admin-email-consent-page.test.mjs); the server refuses without it.
test('owner access needs its own confirmation, checked by the server: without it nothing is granted; operator and read-only are unchanged', async () => {
  const f = await site({adminEmail: adminAddress, allowWrites: true});
  try {
    const p = await people(f);
    const client = await begin(f, {name: 'Owner-level client'});
    for (const confirmed of [undefined, false, 'true', 1, null]) {
      const refused = await client.decide(p.owner, {
        scope: 'owner',
        ...(confirmed === undefined ? {} : {owner_confirmed: confirmed}),
      });
      assert.equal(refused.status, 400, String(confirmed));
      assert.equal(((await refused.json()) as JsonObject).error.code, 'OWNER_ACCESS_CONFIRMATION_REQUIRED');
    }
    assert.equal(events(f, 'ai_client_owner_access_granted').length, 0);
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM amcp_mcp_grants WHERE kind='code'").get()!.n,
      0,
      'no code was issued',
    );
    // A request that was refused is not used up: the same request is approved with the confirmation.
    const owned = await client.exchange(await client.decide(p.owner, {scope: 'owner', owner_confirmed: true}));
    assert.equal((await health(f, owned.access_token)).result?.success, true);
    assert.equal(events(f, 'ai_client_owner_access_granted').length, 1);
    // Operator and read-only approvals need no confirmation, and a stray confirmation on them raises nothing.
    const operator = await begin(f, {name: 'Operator-level client'}),
      reader = await begin(f, {name: 'Read-only client'}),
      stray = await begin(f, {name: 'Operator client with a stray flag'});
    const operatorTokens = await operator.exchange(await operator.decide(p.owner, {scope: 'mcp:read mcp:write'})),
      readerTokens = await reader.exchange(await reader.decide(p.owner, {scope: 'mcp:read'})),
      strayTokens = await stray.exchange(
        await stray.decide(p.owner, {scope: 'mcp:read mcp:write', owner_confirmed: true}),
      );
    for (const tokens of [operatorTokens, readerTokens, strayTokens])
      assert.equal((await health(f, tokens.access_token)).result?.error.code, 'OWNER_REQUIRED');
    assert.deepEqual(
      (
        f.store.db
          .prepare("SELECT role FROM api_keys WHERE user_id LIKE 'oauth/%' ORDER BY rowid")
          .all() as JsonObject[]
      ).map(r => r.role),
      ['admin', 'operator', 'reader', 'operator'],
    );
    assert.equal(events(f, 'ai_client_owner_access_granted').length, 1);
    // Someone who is not offered Owner gets the unchanged refusal, confirmed or not.
    for (const confirmed of [true, undefined]) {
      const refused = await (
        await begin(f)
      ).decide(p.admin, {
        scope: 'owner',
        ...(confirmed ? {owner_confirmed: true} : {}),
      });
      assert.equal(((await refused.json()) as JsonObject).error.code, 'OAUTH_REQUEST_INVALID');
    }
  } finally {
    await f.close();
  }
});

test('connector tokens: an owner may create an owner-level token after confirming; everyone else keeps reader and operator', async () => {
  const f = await site({adminEmail: adminAddress, allowWrites: true});
  try {
    const p = await people(f);
    const create = (headers: Headers, body: JsonObject) =>
      f.request('/api/connector-tokens', 'POST', {name: 'Synthetic connector', ...body}, headers);
    // Owner level needs the explicit confirmation operator level needs, and the server checks it (review S2-1): a missing,
    // false or non-boolean `confirmed` is refused.
    for (const confirmed of [undefined, false, 'true', 1])
      assert.equal(
        (
          (await (
            await create(p.owner, {role: 'owner', ...(confirmed === undefined ? {} : {confirmed})})
          ).json()) as JsonObject
        ).error.code,
        'WRITE_ACCESS_CONFIRMATION_REQUIRED',
        String(confirmed),
      );
    const made = await create(p.owner, {role: 'owner', confirmed: true});
    assert.equal(made.status, 200);
    const minted = (await made.json()) as JsonObject;
    assert.equal(minted.role, 'owner');
    assert.equal(
      (
        f.store.db
          .prepare('SELECT role FROM api_keys WHERE hash=?')
          .get(createHash('sha256').update(minted.token).digest('hex')) as JsonObject
      ).role,
      'admin',
    );
    assert.equal((await health(f, minted.token)).result?.success, true);
    // The same owner's operator token reaches no owner action.
    const operator = (await (await create(p.owner, {role: 'operator', confirmed: true})).json()) as JsonObject;
    assert.equal((await health(f, operator.token)).result?.error.code, 'OWNER_REQUIRED');
    // Owner level is not offered to an administrator, an operator, a viewer or the owner in their own workspace.
    for (const headers of [p.admin, p.operator, p.viewer, p.personal])
      assert.equal(
        ((await (await create(headers, {role: 'owner', confirmed: true})).json()) as JsonObject).error.code,
        'INVALID_ROLE',
      );
    // It is never limited to a client.
    assert.equal(
      (
        (await (
          await create(p.owner, {role: 'owner', confirmed: true, access_set_id: 'synthetic-set'})
        ).json()) as JsonObject
      ).error.code,
      'INVALID_ARGUMENT',
    );
    assert.equal(events(f, 'connector_token_owner_access_granted').length, 1);
    assert.equal(events(f, 'connector_token_owner_access_granted')[0]!.owner_user_id, p.second.id);
  } finally {
    await f.close();
  }
});

test('minting owner access needs a recent sign-in, and a two-step session while the workspace requires one; operator level is not tightened', async () => {
  const f = await site({adminEmail: adminAddress, allowWrites: true});
  try {
    const p = await people(f);
    const create = async (headers: Headers, body: JsonObject) =>
      (
        (await (
          await f.request('/api/connector-tokens', 'POST', {name: 'Synthetic connector', ...body}, headers)
        ).json()) as JsonObject
      ).error?.code;
    // A sign-in older than 15 minutes: the person confirms again first.
    f.store.db.prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.signedInAt',?)").run(Date.now() - 3600000);
    assert.equal(await create(p.owner, {role: 'owner', confirmed: true}), 'REAUTH_REQUIRED');
    f.store.db.prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.signedInAt',?)").run(Date.now());
    // The workspace requires two-step verification of its owners (in its grace period): owner authority needs a two-step session.
    f.store.db
      .prepare("INSERT INTO documents(tenant_id,kind,id,data) VALUES(?,'account_settings','security',?)")
      .run(
        f.tenant,
        JSON.stringify({require_mfa: 'admins', grace_until: Date.now() + 7 * 86400000, invitation_hours: 168}),
      );
    assert.equal(await create(p.owner, {role: 'owner', confirmed: true}), 'MFA_STEP_REQUIRED');
    assert.equal(await create(p.owner, {role: 'operator', confirmed: true}), undefined, 'operator level is as it was');
    const refused = await (await begin(f)).decide(p.owner, {scope: 'owner', owner_confirmed: true});
    assert.equal(((await refused.json()) as JsonObject).error.code, 'MFA_STEP_REQUIRED');
  } finally {
    await f.close();
  }
});

test('credentials made before keep the access they were given, and a read-only deployment offers no Owner', async () => {
  const f = await site({adminEmail: adminAddress, allowWrites: true});
  try {
    const p = await people(f);
    // An operator token and an AI client of the owner, as every earlier release made them.
    const old = f.store.createKey(
      {tenantId: f.tenant, userId: 'connector/earlier', role: 'operator', ownerUserId: String(p.second.id)},
      86400000,
    );
    const earlier = await begin(f, {name: 'Earlier client'}),
      grant = await earlier.exchange(await earlier.decide(p.owner));
    const g = await f.restart({adminEmail: adminAddress, allowWrites: true});
    try {
      assert.equal((await health(g, old)).result?.error.code, 'OWNER_REQUIRED');
      assert.equal((await health(g, grant.access_token)).result?.error.code, 'OWNER_REQUIRED');
      const next = (await (
        await refreshWith(g, String(earlier.client.client_id), grant.refresh_token)
      ).json()) as JsonObject;
      assert.equal(
        (await health(g, next.access_token)).result?.error.code,
        'OWNER_REQUIRED',
        'a refresh never raises the level',
      );
    } finally {
      await g.close();
    }
  } catch (error) {
    await f.close().catch(() => undefined);
    throw error;
  }
  const r = await site({adminEmail: adminAddress});
  try {
    const p = await people(r);
    const info = await (await begin(r, {scope: 'mcp:read'})).consent(p.owner);
    assert.equal(info.ownerAccess, false);
    const created = await r.request(
      '/api/connector-tokens',
      'POST',
      {name: 'x', role: 'owner', confirmed: true},
      p.owner,
    );
    assert.equal(((await created.json()) as JsonObject).error.code, 'WRITES_DISABLED');
  } finally {
    await r.close();
  }
});

test('owner-level credentials stop when the person stops being an owner', async () => {
  const f = await site({adminEmail: adminAddress, allowWrites: true});
  try {
    const p = await people(f);
    const client = await begin(f, {name: 'Owner-level client'}),
      grant = await client.exchange(await client.decide(p.owner, {scope: 'owner', owner_confirmed: true}));
    const token = (
      (await (
        await f.request(
          '/api/connector-tokens',
          'POST',
          {name: 'Synthetic connector', role: 'owner', confirmed: true},
          p.owner,
        )
      ).json()) as JsonObject
    ).token;
    assert.equal((await health(f, grant.access_token)).result?.success, true);
    assert.equal((await health(f, token)).result?.success, true);
    // Demoted without anything else ending (a stale row): the membership check alone stops the owner level.
    f.store.db
      .prepare("UPDATE workspace_memberships SET role='admin' WHERE tenant_id=? AND user_id=?")
      .run(f.tenant, p.second.id);
    assert.throws(() => f.store.authenticate(token), {code: 'MEMBERSHIP_REVOKED'});
    assert.equal((await health(f, grant.access_token)).status, 403);
    // The variable removed and the website restarted: the credentials are ended outright.
    f.store.db
      .prepare("UPDATE workspace_memberships SET role='owner' WHERE tenant_id=? AND user_id=?")
      .run(f.tenant, p.second.id);
    const g = await f.restart({adminEmail: undefined, allowWrites: true});
    try {
      assert.equal((await health(g, token)).status, 401);
      assert.equal((await health(g, grant.access_token)).status, 401);
      assert.equal(
        (await refreshWith(g, String(client.client.client_id), grant.refresh_token)).status,
        400,
        'the refresh token no longer opens a connection',
      );
    } finally {
      await g.close();
    }
  } catch (error) {
    await f.close().catch(() => undefined);
    throw error;
  }
});
