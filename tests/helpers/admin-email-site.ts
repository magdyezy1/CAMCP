// The website of r25-admin-email's tests: a store, the HTTP app over it, synthetic e-mail and social providers, and a way
// to restart the app over the same database with another AMCP_ADMIN_EMAIL (the variable is read once, at start-up).
// Synthetic addresses and a fake transport only; nothing leaves the process.
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {SignJWT, exportJWK} from 'jose';
import {Store} from '../../src/store.js';
import {Registry} from '../../src/catalog.js';
import {MirrorService, strictOptions} from '../../src/service.js';
import {createHttpApp} from '../../server/http-app.js';
import {hashUserPassword, type UserAccounts} from '../../server/user-accounts.js';
import {AccountSecurity} from '../../server/account-security.js';
import type {McpOAuth} from '../../server/mcp-oauth.js';
import type {WebStore, WebsiteOptions} from '../../server/web-store.js';
import type {JsonObject} from '../../src/types.js';
import {listenForFetch} from '../http-listener.js';

export const master = Buffer.alloc(32, 66).toString('base64'),
  password = 'synthetic-member-password',
  origin = 'https://amcp.shop',
  adminAddress = 'admin@example.test';
const rsa = generateKeyPairSync('rsa', {modulusLength: 2048}),
  json = (body: unknown) => new Response(JSON.stringify(body), {headers: {'Content-Type': 'application/json'}});

export interface SiteOptions {
  /** AMCP_ADMIN_EMAIL as loadConfig would hand it to the website. */
  adminEmail?: string;
  /** Environment of the website (AMCP_ALLOW_SIGNUP, AMCP_REQUIRE_MFA, ...). */
  env?: NodeJS.ProcessEnv;
  /** Another start over the same database. */
  store?: Store;
  tenantId?: string;
  allowWrites?: boolean;
  /** The social provider's answers: the verified flag of the e-mail claim and the subject. */
  social?: {verified?: boolean | string; subject?: string; email?: string};
}
export type Site = Awaited<ReturnType<typeof site>>;

export async function site(options: SiteOptions = {}) {
  const store = options.store ?? new Store(':memory:', master),
    env: NodeJS.ProcessEnv = {
      AMCP_EMAIL_API_KEY: 'synthetic-mail-secret',
      AMCP_EMAIL_FROM: 'AMCP <accounts@example.test>',
      AMCP_SIGNIN_GOOGLE_CLIENT_ID: 'google-client',
      AMCP_SIGNIN_GOOGLE_CLIENT_SECRET: 'google-secret',
      AMCP_SIGNIN_APPLE_CLIENT_ID: 'apple-client',
      AMCP_SIGNIN_APPLE_CLIENT_SECRET: 'synthetic-apple-secret',
      AMCP_SIGNIN_FACEBOOK_CLIENT_ID: 'facebook-client',
      AMCP_SIGNIN_FACEBOOK_CLIENT_SECRET: 'facebook-secret',
      ...options.env,
    },
    emails: JsonObject[] = [],
    state = {
      nonce: '',
      subject: options.social?.subject ?? 'person-1',
      email: options.social?.email ?? 'member@example.test',
      verified: (options.social?.verified ?? true) as boolean | string,
      facebookEmail: 'do-not-trust@example.test',
    };
  const jwk = {...(await exportJWK(rsa.publicKey)), alg: 'RS256', kid: 'test-key', use: 'sig'};
  const fetcher: typeof fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.href === 'https://api.resend.com/emails') {
      emails.push(JSON.parse(String(init.body)));
      return json({id: 'email-test'});
    }
    if (u.pathname.endsWith('/certs') || u.pathname.endsWith('/keys')) return json({keys: [jwk]});
    if (u.hostname === 'graph.facebook.com') {
      if (u.pathname.endsWith('/access_token')) return json({access_token: 'facebook-access-only'});
      return json({id: '123456', name: 'Facebook member', email: state.facebookEmail});
    }
    if (u.hostname === 'oauth2.googleapis.com' || u.hostname === 'appleid.apple.com') {
      const apple = u.hostname === 'appleid.apple.com',
        claims: JsonObject = {nonce: state.nonce, email: state.email, email_verified: state.verified};
      const token = await new SignJWT(claims)
        .setProtectedHeader({alg: 'RS256', kid: 'test-key'})
        .setIssuer(apple ? 'https://appleid.apple.com' : 'https://accounts.google.com')
        .setAudience(apple ? 'apple-client' : 'google-client')
        .setSubject(state.subject)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(rsa.privateKey);
      return json({access_token: 'social-access-only', id_token: token});
    }
    throw Error('Unexpected provider egress ' + u.origin);
  };
  const website: WebsiteOptions = {
    origin,
    masterKey: master,
    adminPassword: password,
    authEnv: env,
    fetcher,
    ...(options.adminEmail !== undefined ? {adminEmail: options.adminEmail} : {}),
    ...(options.tenantId !== undefined ? {tenantId: options.tenantId} : {}),
  };
  const service = new MirrorService(
      new Registry(),
      store,
      undefined,
      options.allowWrites ? strictOptions : undefined,
      options.allowWrites ? {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0} : undefined,
    ),
    app = createHttpApp(service, store, {website, mcpLimits: {perMinute: 0}}),
    listener = await listenForFetch(app);
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port,
    live = app.locals.website as {web: WebStore; accounts: UserAccounts; mcpOAuth: McpOAuth},
    tenant = live.web.tenantId;
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, {
        method,
        redirect: 'manual',
        headers: {Origin: origin, ...(body ? {'Content-Type': 'application/json'} : {}), ...headers},
        body: body ? JSON.stringify(body) : undefined,
      }),
      bytes = await r.arrayBuffer();
    return new Response(bytes, {status: r.status, headers: r.headers});
  };
  const hash = () => hashUserPassword(password);
  const account = async (email: string, name = 'Test member', approved = true, test = false) => {
    const created = store.transaction(() => live.accounts.newUser(name, email, null, approved, test));
    store.db.prepare('UPDATE amcp_users SET password_hash=? WHERE id=?').run(await hash(), created.id);
    return store.db.prepare('SELECT * FROM amcp_users WHERE id=?').get(created.id) as JsonObject;
  };
  /** The deployment's own owner account: the one whose workspace IS the deployment workspace (owner migration). */
  const deploymentOwner = async (email = 'owner@example.test') => {
    const id = randomUUID(),
      now = Date.now();
    store.ensureTenant(tenant);
    store.db
      .prepare('INSERT INTO amcp_users(id,email,name,tenant_id,password_hash,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, email, 'Original owner', tenant, await hash(), now);
    store.db
      .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'owner',?)")
      .run(tenant, id, now);
    return store.db.prepare('SELECT * FROM amcp_users WHERE id=?').get(id) as JsonObject;
  };
  const login = async (email: string, extra: JsonObject = {}) => {
    const r = await request('/api/account/login', 'POST', {email, password, ...extra}),
      body = (await r.json()) as JsonObject;
    return {
      status: r.status,
      body,
      headers:
        r.status === 200 && body.csrf
          ? {Cookie: r.headers.get('set-cookie')!.split(';')[0]!, 'X-AMCP-CSRF': String(body.csrf)}
          : undefined,
    };
  };
  const signedIn = async (email: string) => {
    const r = await login(email);
    if (r.status !== 200 || !r.headers) throw Error('sign-in refused: ' + r.status + ' ' + JSON.stringify(r.body));
    return r.headers;
  };
  /** Opens the deployment workspace in a signed-in browser, as the workspace switcher does. */
  const switchTo = async (headers: Record<string, string>, workspaceId = tenant) => {
    const r = await request('/api/workspaces/switch', 'POST', {workspaceId}, headers),
      body = (await r.json()) as JsonObject;
    return {
      status: r.status,
      body,
      headers:
        r.status === 200 && body.csrf
          ? {Cookie: r.headers.get('set-cookie')!.split(';')[0]!, 'X-AMCP-CSRF': String(body.csrf)}
          : undefined,
    };
  };
  /** The member_grant documents: who made a role (AMCP_ADMIN_EMAIL) and the role held before it. */
  const grants = () =>
    (
      store.db
        .prepare("SELECT tenant_id,id,data FROM documents WHERE kind='member_grant' ORDER BY tenant_id,id")
        .all() as JsonObject[]
    ).map(r => ({tenant_id: r.tenant_id, user_id: r.id, ...JSON.parse(r.data)}));
  /** A membership with the marker its grant document holds (null where there is none), as one object. */
  const membership = (userId: unknown, workspace = tenant) => {
    const row = store.db
      .prepare('SELECT role,active,created_at FROM workspace_memberships WHERE tenant_id=? AND user_id=?')
      .get(workspace, userId as string) as JsonObject | undefined;
    if (!row) return undefined;
    const grant = grants().find(g => g.tenant_id === workspace && g.user_id === userId);
    return {...row, granted_by: grant?.granted_by ?? null, granted_from: grant?.granted_from ?? null} as JsonObject;
  };
  /** What a process still holding the variable writes after a start-up pass: an owner membership and its grant document. */
  const regrant = (userId: unknown, workspace = tenant) => {
    store.db
      .prepare("UPDATE workspace_memberships SET role='owner',active=1 WHERE tenant_id=? AND user_id=?")
      .run(workspace, userId as string);
    store.putDocument(workspace, 'member_grant', String(userId), {granted_by: 'env:AMCP_ADMIN_EMAIL'});
  };
  const events = (workspace = tenant) =>
    (
      store.db.prepare('SELECT event FROM audit WHERE tenant_id=? ORDER BY rowid').all(workspace) as {event: string}[]
    ).map(r => JSON.parse(r.event) as JsonObject);
  const link = () => {
    const url = new URL(/https:\/\/\S+/.exec(String(emails.at(-1)!.text))![0]!);
    return Object.fromEntries(new URLSearchParams(url.hash.slice(1))) as {token: string; kind: string};
  };
  const begin = async (provider: string, headers: Record<string, string> = {}) => {
    const r = await request('/api/signin/' + provider + '/start', 'POST', {link: false}, headers),
      url = new URL(((await r.json()) as {url: string}).url);
    state.nonce = url.searchParams.get('nonce') ?? '';
    return {flow: r.headers.get('set-cookie')!.split(';')[0]!, state: url.searchParams.get('state')!};
  };
  const social = async (provider: 'google' | 'facebook') => {
    const start = await begin(provider);
    return request(
      '/api/signin/' + provider + '/callback?' + new URLSearchParams({state: start.state, code: 'synthetic-code'}),
      'GET',
      undefined,
      {Cookie: start.flow},
    );
  };
  return {
    store,
    base,
    service,
    tenant,
    env,
    state,
    emails,
    web: live.web,
    accounts: live.accounts,
    mcpOAuth: live.mcpOAuth,
    security: new AccountSecurity(live.accounts),
    request,
    account,
    deploymentOwner,
    login,
    signedIn,
    switchTo,
    membership,
    grants,
    regrant,
    events,
    link,
    social,
    password,
    /** The same database started again, as a deployment restarts after a variable changes. */
    restart: async (next: SiteOptions = {}) => {
      await closeListener();
      return site({...options, ...next, store});
    },
    close: async () => {
      await closeListener();
      store.close();
    },
  };
  async function closeListener() {
    const closing = new Promise<void>(resolve => listener.close(() => resolve()));
    listener.closeAllConnections();
    await closing;
  }
}
