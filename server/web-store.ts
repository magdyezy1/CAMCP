import {randomBytes, timingSafeEqual, randomUUID} from 'node:crypto';
import type {Request} from 'express';
import {BlockList, isIP} from 'node:net';
import {Store} from '../src/store.js';
import {SecretBox, sha256, scopeKey} from '../src/security.js';
import {MirrorError} from '../src/errors.js';
import type {Actor, JsonObject} from '../src/types.js';
import {endMcpGrants} from './mcp-grants.js';
import type {ClientMetadataOptions} from './client-metadata.js';
import {
  derivePassword,
  passwordHashParts,
  passwordHashSync,
  passwordMatchesSync,
  type PasswordForm,
} from './password-hashes.js';

export interface WebSession {
  id: string;
  actor: Actor;
  csrf: string;
  expiresAt: number;
}
export interface WebsiteOptions {
  origin: string;
  masterKey?: string;
  adminPassword?: string;
  adminPasswordHash?: string;
  testPassword?: string;
  testPasswordHash?: string;
  tenantId?: string;
  fetcher?: typeof fetch;
  staticDirectory?: string;
  trustedProxyCidrs?: string[];
  authEnv?: NodeJS.ProcessEnv;
  /** AMCP_MCP_REFRESH_REUSE_SECONDS: how long a just-rotated MCP refresh token may be presented again (0–60, 60). */
  mcpRefreshReuseSeconds?: number;
  /** Client ID Metadata Documents (MCP-03): `enabled: false` (AMCP_MCP_CLIENT_METADATA=off) turns them off, `hosts`
   * (AMCP_MCP_CLIENT_METADATA_HOSTS) limits them to exact host names. Tests replace the guarded transport. */
  mcpClientMetadata?: {enabled?: boolean} & ClientMetadataOptions;
}
function canonicalIp(value: string): string | undefined {
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6 || value.includes('%')) return;
  const address = new URL('http://[' + value + ']/').hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(address);
  if (mapped) {
    const n = parseInt(mapped[1]!, 16) * 65536 + parseInt(mapped[2]!, 16);
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  return address;
}
/** Walk the proxy chain from the socket, stopping at the nearest untrusted hop. */
export function clientAddressResolver(cidrs: string[] = []): (req: Request) => string {
  const allowed = new BlockList();
  for (const cidr of cidrs) {
    const [raw, prefix, ...extra] = cidr.split('/'),
      address = raw && canonicalIp(raw),
      bits = address && isIP(address) === 4 ? 32 : 128;
    if (
      !address ||
      extra.length ||
      prefix === undefined ||
      !/^\d+$/.test(prefix) ||
      Number(prefix) < 1 ||
      Number(prefix) > bits ||
      (raw !== address && isIP(raw!) !== isIP(address))
    )
      throw Error('AMCP_TRUSTED_PROXY_CIDRS requires explicit IPv4/IPv6 CIDRs with nonzero prefixes.');
    allowed.addSubnet(address, Number(prefix), bits === 32 ? 'ipv4' : 'ipv6');
  }
  const trusted = (address: string) => allowed.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
  return req => {
    const peer = canonicalIp(req.socket.remoteAddress ?? '') ?? 'unknown',
      header = req.headers['x-forwarded-for'];
    if (peer === 'unknown' || !trusted(peer) || typeof header !== 'string' || header.length > 2048) return peer;
    const chain = header.split(',').map(s => canonicalIp(s.trim()));
    if (chain.length > 32 || chain.some(s => !s)) return peer;
    let address = peer;
    for (let i = chain.length - 1; i >= 0 && trusted(address); i--) address = chain[i]!;
    return address;
  };
}
/** A website session that sees no request for this long ends (owner decision, review 2026-09-28). */
export const sessionIdleMs = 2 * 3600000;
/**
 * The two passwords configured on the server are doors: the administrator's opens the deployment's workspace, the
 * reviewer's the shared test workspace. A door's hash is scrypt-v3, or scrypt (Node's defaults) when it comes from an
 * environment configured before the review of 2026-09-28 (F-16).
 */
type Door = 'workspace-admin' | 'workspace-test';
const doorForms: PasswordForm[] = ['scrypt-v3', 'scrypt'],
  doorHash = /^scrypt(?:-v3)?\$[a-f0-9]{32}\$[a-f0-9]{64}$/,
  doorVariables: Record<Door, string> = {
    'workspace-admin': 'AMCP_ADMIN_PASSWORD_HASH',
    'workspace-test': 'AMCP_TEST_PASSWORD_HASH',
  };
/** The sessions and MCP grants a door issued: grants approved from its sessions carry no owner account of their own.
 * The reviewer door's clause matches nothing today: test accounts cannot consent (route gate and McpOAuth.consent),
 * and a grant owned by 'workspace-test' would fail assertActorActive. It stays so a reviewer password change would
 * still end such a grant if consent were ever opened to test accounts. */
const doorGrants: Record<Door, string> = {
  'workspace-admin': "json_extract(data,'$.ownerUserId') IS NULL",
  'workspace-test': "json_extract(data,'$.ownerUserId')='workspace-test'",
};
/** A door's hash of a password from the environment (and `admin password-hash`): scrypt-v3. */
export const passwordHash = passwordHashSync;
/** Whether a password opens a door with this hash. The key is derived off the event loop. */
export async function checkPassword(password: unknown, hash: string): Promise<boolean> {
  const parts = passwordHashParts(hash, doorForms);
  if (typeof password !== 'string' || password.length > 1024 || !parts) return false;
  return timingSafeEqual(await derivePassword(password, parts.salt, parts.form), parts.key);
}
export function cookieValue(req: Request, name: string): string | undefined {
  const entries = (req.headers.cookie ?? '')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.startsWith(name + '='));
  return entries.length === 1 ? entries[0]!.slice(name.length + 1) : undefined;
}
/** Rate-limit key of an address. An IPv6 client usually controls a whole /64, so one /64 shares one key. */
export function rateLimitAddress(address: string): string {
  if (isIP(address) !== 6) return address;
  const [head = '', tail] = address.split('::'),
    h = head ? head.split(':') : [],
    t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return (
    groups
      .slice(0, 4)
      .map(g => parseInt(g, 16).toString(16))
      .join(':') + '::/64'
  );
}
export class WebStore {
  readonly clientAddress: (req: Request) => string;
  /** The client address as a rate-limit key: the resolved address, with IPv6 reduced to its /64. */
  readonly limitAddress = (req: Request) => rateLimitAddress(this.clientAddress(req));
  readonly tenantId: string;
  readonly origin: string;
  readonly secure: boolean;
  readonly cookieName: string;
  readonly administratorHash?: string;
  private reviewerHash?: string;
  readonly testPasswordProblem?: string;
  private box?: SecretBox;
  constructor(
    readonly store: Store,
    readonly options: WebsiteOptions,
  ) {
    this.clientAddress = clientAddressResolver(options.trustedProxyCidrs);
    const origin = new URL(options.origin);
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      (origin.protocol !== 'https:' &&
        !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))
    )
      throw Error('AMCP origin must be HTTPS, except for loopback development.');
    this.origin = origin.origin;
    this.secure = origin.protocol === 'https:';
    this.cookieName = this.secure ? '__Host-amcp_session' : 'amcp_local_session';
    this.tenantId = options.tenantId ?? 'local';
    if (options.masterKey) this.box = new SecretBox(options.masterKey);
    if (options.adminPasswordHash) {
      if (!doorHash.test(options.adminPasswordHash)) throw Error('Invalid AMCP administrator password hash.');
    } else if (options.adminPassword && options.adminPassword.length < 16)
      throw Error('AMCP administrator password must contain at least 16 characters.');
    // The reviewer door is optional, so a bad value closes that one door and says why on stderr.
    // Refusing to boot would take a working deployment down over a feature nobody must enable.
    const testProblem =
      options.testPasswordHash !== undefined && !doorHash.test(options.testPasswordHash)
        ? 'AMCP_TEST_PASSWORD_HASH is not a valid scrypt hash.'
        : options.testPasswordHash === undefined &&
            options.testPassword !== undefined &&
            options.testPassword.length < 16
          ? 'AMCP_TEST_PASSWORD must contain at least 16 characters.'
          : undefined;
    const sharedPassword =
      !testProblem &&
      !!(options.adminPasswordHash || options.adminPassword) &&
      (options.testPasswordHash
        ? options.testPasswordHash === options.adminPasswordHash
        : !!options.testPassword &&
          (options.adminPasswordHash
            ? passwordMatchesSync(options.testPassword, options.adminPasswordHash, doorForms)
            : options.testPassword === options.adminPassword));
    store.transaction(() =>
      store.db.exec(`
   CREATE TABLE IF NOT EXISTS amcp_web_sessions(hash TEXT PRIMARY KEY,actor TEXT NOT NULL,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS amcp_login_limits(key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,until_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS amcp_oauth_states(hash TEXT PRIMARY KEY,session_hash TEXT NOT NULL,platform TEXT NOT NULL,secret TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS amcp_mcp_clients(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS amcp_mcp_grants(hash TEXT PRIMARY KEY,kind TEXT NOT NULL,client_id TEXT NOT NULL,tenant_id TEXT NOT NULL,data TEXT NOT NULL,expires_at INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS amcp_users(id TEXT PRIMARY KEY,email TEXT UNIQUE COLLATE NOCASE,name TEXT NOT NULL,tenant_id TEXT UNIQUE NOT NULL,password_hash TEXT,version INTEGER NOT NULL DEFAULT 1,disabled INTEGER NOT NULL DEFAULT 0,approved INTEGER NOT NULL DEFAULT 1,test_account INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS amcp_identities(provider TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(provider,subject),UNIQUE(user_id,provider));
   CREATE TABLE IF NOT EXISTS amcp_account_challenges(hash TEXT PRIMARY KEY,kind TEXT NOT NULL,secret TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS amcp_email_outbox(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,secret TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,lease_until INTEGER,lease_token TEXT,expires_at INTEGER NOT NULL,last_error TEXT,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS amcp_mfa(user_id TEXT PRIMARY KEY,secret TEXT NOT NULL,recovery TEXT NOT NULL,last_step INTEGER NOT NULL DEFAULT -1,enabled_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS amcp_web_doors(door TEXT PRIMARY KEY,hash TEXT NOT NULL,changed_at INTEGER NOT NULL);
   INSERT OR IGNORE INTO workspace_memberships(tenant_id,user_id,role,created_at) SELECT tenant_id,id,'owner',created_at FROM amcp_users;
  `),
    );
    this.administratorHash = this.openDoor(
      'workspace-admin',
      this.tenantId,
      options.adminPassword,
      options.adminPasswordHash,
    );
    if (!testProblem && !sharedPassword)
      this.reviewerHash = this.openDoor(
        'workspace-test',
        this.testTenantId,
        options.testPassword,
        options.testPasswordHash,
      );
    this.testPasswordProblem =
      testProblem ?? (sharedPassword ? 'AMCP_TEST_PASSWORD must differ from the administrator password.' : undefined);
    if (this.testPasswordProblem)
      process.stderr.write('AMCP: reviewer sign-in is disabled. ' + this.testPasswordProblem + '\n');
    if (!this.store.db.prepare("SELECT 1 FROM pragma_table_info('amcp_users') WHERE name='approved'").get())
      this.store.db.exec('ALTER TABLE amcp_users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1');
    if (!this.store.db.prepare("SELECT 1 FROM pragma_table_info('amcp_users') WHERE name='test_account'").get())
      this.store.db.exec('ALTER TABLE amcp_users ADD COLUMN test_account INTEGER NOT NULL DEFAULT 0');
  }
  get configured() {
    return !!this.administratorHash;
  }
  get testConfigured() {
    return !!this.reviewerHash;
  }
  /** Whether this deployment's workspace moved to its owner's email account; the administrator door then refuses. */
  get ownerMigrated() {
    return !!this.store.db
      .prepare("SELECT 1 FROM documents WHERE tenant_id=? AND kind='account_settings' AND id='owner_migration'")
      .get(this.tenantId);
  }
  /** Whether anyone holds an approved account here (reviewer test accounts aside). The public sign-in page then leaves
   * the administrator door out; the owner opens it at /login?owner=1 (SEC-05). */
  get accountsExist() {
    return !!this.store.db
      .prepare('SELECT 1 FROM amcp_users WHERE approved=1 AND disabled=0 AND test_account=0 LIMIT 1')
      .get();
  }
  /** Reviewers share one workspace that is not the owner's, so no connection of yours is in reach. */
  get testTenantId() {
    return this.tenantId + '-test';
  }
  /**
   * Opens a door configured on the server and returns its hash. A password from the environment is hashed with a salt
   * derived from the master key, so every process of the deployment computes the same hash. amcp_web_doors records the
   * hash each door was last opened with: a process that starts with a new password ends the door's sessions and the MCP
   * access approved from them, and a process still running the old password stops issuing either (doorOpen). A process
   * without the password (the report worker) opens no door and changes nothing.
   */
  private openDoor(door: Door, tenant: string, password?: string, configured?: string): string | undefined {
    if (!configured && !password) return;
    const db = this.store.db,
      key = door + ':' + tenant,
      stored = (db.prepare('SELECT hash FROM amcp_web_doors WHERE door=?').get(key) as {hash: string} | undefined)
        ?.hash,
      // Without a master key (local development) the recorded salt is reused, so a restart keeps the same hash.
      salt = this.options.masterKey
        ? sha256('amcp-door-salt:' + this.options.masterKey + ':' + key).slice(0, 32)
        : stored?.startsWith('scrypt-v3$')
          ? stored.split('$')[1]
          : undefined,
      hash = configured || passwordHash(password!, salt);
    if (configured?.startsWith('scrypt$'))
      process.stderr.write(
        'AMCP: ' +
          doorVariables[door] +
          ' uses the older scrypt parameters. Replace it with the output of `npm run admin -- password-hash`.\n',
      );
    if (hash === stored) return hash;
    this.store.transaction(() => {
      if (stored !== undefined) {
        const grants = doorGrants[door];
        db.prepare(
          "DELETE FROM amcp_web_sessions WHERE json_extract(actor,'$.tenantId')=? AND json_extract(actor,'$.userId')=?",
        ).run(tenant, door);
        db.prepare(
          'DELETE FROM amcp_oauth_states WHERE session_hash NOT IN (SELECT hash FROM amcp_web_sessions)',
        ).run();
        endMcpGrants(this.store, 'tenant_id=? AND ' + grants, [tenant], 'door_password_change');
        this.store.appendAudit(tenant, randomUUID(), {
          event: door === 'workspace-admin' ? 'administrator_password_changed' : 'reviewer_password_changed',
        });
      }
      db.prepare(
        'INSERT INTO amcp_web_doors VALUES(?,?,?) ON CONFLICT(door) DO UPDATE SET hash=excluded.hash,changed_at=excluded.changed_at',
      ).run(key, hash, Date.now());
    });
    return hash;
  }
  /** The door that signs this subject in to this workspace: the administrator's or the reviewer's, or none. */
  private doorFor(subject: unknown, tenant: unknown): Door | undefined {
    return subject === 'workspace-admin' && tenant === this.tenantId
      ? 'workspace-admin'
      : subject === 'workspace-test' && tenant === this.testTenantId
        ? 'workspace-test'
        : undefined;
  }
  /** Whether a door subject's session may be used or created here: the door is configured in this process, with the
   * password amcp_web_doors last recorded for it. False for a door subject of a workspace no door here signs in to. */
  doorOpen(subject: unknown, tenant: unknown): boolean {
    const door = this.doorFor(subject, tenant),
      hash = door === 'workspace-admin' ? this.administratorHash : door && this.reviewerHash;
    return (
      !!hash &&
      (
        this.store.db.prepare('SELECT hash FROM amcp_web_doors WHERE door=?').get(door + ':' + tenant) as
          {hash: string} | undefined
      )?.hash === hash
    );
  }
  /** Whether MCP access approved in this workspace with this owner (none: the administrator) may be used here. Access
   * approved from a door's session lasts while doorOpen holds; access of an owner account is not a door's to end. */
  doorGrantUsable(ownerUserId: unknown, tenant: unknown): boolean {
    const subject = ownerUserId ?? 'workspace-admin';
    return !this.doorFor(subject, tenant) || this.doorOpen(subject, tenant);
  }
  consumeMcpAttempt(req: Request) {
    const key = sha256('mcp-auth:' + this.limitAddress(req)),
      now = Date.now();
    this.store.db.prepare('DELETE FROM amcp_login_limits WHERE until_at<=?').run(now);
    const row = this.store.db.prepare('SELECT attempts FROM amcp_login_limits WHERE key=?').get(key) as
      {attempts: number} | undefined;
    if (row && row.attempts >= 50)
      throw new MirrorError('OAUTH_RATE_LIMIT', 'Too many OAuth requests. Try again in 15 minutes.', {}, 429);
    this.store.db
      .prepare('INSERT INTO amcp_login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1')
      .run(key, now + 900000);
  }
  sealClientSecret(id: string, secret: string) {
    if (!this.box)
      throw new MirrorError(
        'ENCRYPTION_REQUIRED',
        'Configure credential encryption before registering confidential MCP clients.',
        {},
        503,
      );
    return this.box.seal(secret, scopeKey('mcp-client', this.tenantId, id));
  }
  openClientSecret(id: string, sealed: string) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Credential encryption is unavailable.', {}, 503);
    return this.box.open<string>(sealed, scopeKey('mcp-client', this.tenantId, id));
  }
  sealAccount(id: string, data: JsonObject) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Account security is not configured.', {}, 503);
    return this.box.seal(data, scopeKey('account-auth', id));
  }
  openAccount(id: string, data: string) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Account security is not configured.', {}, 503);
    return this.box.open<JsonObject>(data, scopeKey('account-auth', id));
  }
  /** signedInAt is when the person last proved who they are; a workspace switch keeps it (recent sign-in checks). */
  createSession(actor: Actor, signedInAt = Date.now()): WebSession {
    const now = Date.now(),
      s: WebSession = {
        id: randomBytes(32).toString('base64url'),
        csrf: randomBytes(32).toString('base64url'),
        actor,
        expiresAt: now + 8 * 3600000,
      };
    this.store.db.prepare('DELETE FROM amcp_web_sessions WHERE expires_at<=?').run(now);
    this.store.ensureTenant(actor.tenantId);
    const user = this.store.db
      .prepare('SELECT version FROM amcp_users WHERE id=? AND disabled=0 AND approved=1')
      .get(actor.userId) as JsonObject | undefined;
    this.store.transaction(() => {
      if (
        (actor.userId === 'workspace-admin' || actor.userId === 'workspace-test') &&
        !this.doorOpen(actor.userId, actor.tenantId)
      )
        throw new MirrorError(
          'SIGN_IN_CHANGED',
          'This sign-in was reconfigured on the server. Reload the page and sign in again.',
          {},
          503,
        );
      this.store.db.prepare('INSERT INTO amcp_web_sessions VALUES(?,?,?,?)').run(
        sha256(s.id),
        JSON.stringify(
          Object.assign(actor, {
            ...(user ? {accountVersion: user.version} : {}),
            signedInAt: Math.min(signedInAt, now),
          }),
        ),
        s.csrf,
        s.expiresAt,
      );
    });
    return s;
  }
  /** Password sign-in for a reviewer. Mirrors the administrator door but lands in the test
   * workspace with the evaluator scope, separate from the deployment owner's connections. */
  async signInTest(password: string, address: string): Promise<WebSession> {
    if (!this.reviewerHash)
      throw new MirrorError(
        'SETUP_REQUIRED',
        'Configure the AMCP test password on the server before signing in.',
        {},
        503,
      );
    await this.passDoor(this.reviewerHash, password, 'test:' + address, 'That password is incorrect.');
    this.store.ensureTenant(this.testTenantId, 'AMCP test workspace');
    const session = this.createSession({
      tenantId: this.testTenantId,
      userId: 'workspace-test',
      role: 'admin',
      testAccount: true,
    });
    this.store.appendAudit(this.testTenantId, randomUUID(), {event: 'test_sign_in'});
    return session;
  }
  /** A door's password check. The attempt is counted before the key is derived, so guesses sent in parallel cannot
   * pass the limit; a correct password clears the count. */
  private async passDoor(hash: string, password: string, attempt: string, wrong: string) {
    const db = this.store.db,
      key = sha256(attempt),
      now = Date.now();
    db.prepare('DELETE FROM amcp_login_limits WHERE until_at<?').run(now);
    const row = db.prepare('SELECT attempts FROM amcp_login_limits WHERE key=?').get(key) as JsonObject | undefined;
    if (row && row.attempts >= 8)
      throw new MirrorError('LOGIN_RATE_LIMIT', 'Too many sign-in attempts. Try again in 15 minutes.', {}, 429);
    db.prepare('INSERT INTO amcp_login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1').run(
      key,
      now + 900000,
    );
    if (!(await checkPassword(password, hash))) throw new MirrorError('INVALID_LOGIN', wrong, {}, 401);
    db.prepare('DELETE FROM amcp_login_limits WHERE key=?').run(key);
  }
  async signIn(password: string, address: string): Promise<WebSession> {
    // Checked again after the password, which takes a while: owner setup may have finished meanwhile.
    const migrated = () => {
      if (this.ownerMigrated)
        throw new MirrorError(
          'OWNER_LOGIN_REQUIRED',
          'This workspace now uses its owner email account. Use email sign-in or account recovery.',
          {},
          403,
        );
    };
    migrated();
    if (!this.administratorHash)
      throw new MirrorError(
        'SETUP_REQUIRED',
        'Configure the AMCP administrator password on the server before signing in.',
        {},
        503,
      );
    await this.passDoor(this.administratorHash, password, address, 'The password is incorrect.');
    migrated();
    const session = this.createSession({tenantId: this.tenantId, userId: 'workspace-admin', role: 'admin'});
    this.store.appendAudit(this.tenantId, randomUUID(), {event: 'website_sign_in'});
    return session;
  }
  session(req: Request): WebSession | undefined {
    const id = cookieValue(req, this.cookieName);
    if (!id || !/^[\w-]{43}$/.test(id)) return;
    const row = this.store.db
      .prepare('SELECT * FROM amcp_web_sessions WHERE hash=? AND expires_at>?')
      .get(sha256(id), Date.now()) as JsonObject | undefined;
    if (!row) return;
    const actor = JSON.parse(row.actor),
      now = Date.now(),
      seen = Number(actor.seenAt);
    // A door's sessions last only while its password stays the one they were opened with.
    if (
      (actor.userId === 'workspace-admin' || actor.userId === 'workspace-test') &&
      !this.doorOpen(actor.userId, actor.tenantId)
    )
      return;
    // Idle sign-out (owner decision, review 2026-09-28): a session unused for sessionIdleMs ends, within the 8-hour
    // limit. Activity is recorded at most every five minutes; a session from before this rule starts counting now.
    if (Number.isFinite(seen) && now - seen > sessionIdleMs) {
      this.store.db.prepare('DELETE FROM amcp_web_sessions WHERE hash=?').run(sha256(id));
      return;
    }
    if (!Number.isFinite(seen) || now - seen > 300000)
      this.store.db
        .prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.seenAt',?) WHERE hash=?")
        .run(now, sha256(id));
    if (actor.userId !== 'workspace-admin' && actor.userId !== 'workspace-test') {
      const user = this.store.db
        .prepare('SELECT version,test_account FROM amcp_users WHERE id=? AND disabled=0 AND approved=1')
        .get(actor.userId) as JsonObject | undefined;
      if (user) actor.testAccount = !!user.test_account;
      const membership = this.store.db
        .prepare('SELECT role FROM workspace_memberships WHERE tenant_id=? AND user_id=? AND active=1')
        .get(actor.tenantId, actor.userId) as JsonObject | undefined;
      if (!user || user.version !== actor.accountVersion || !membership) return;
      actor.role = membership.role === 'viewer' ? 'reader' : membership.role === 'operator' ? 'operator' : 'admin';
      actor.membershipRole = membership.role;
      actor.ownerUserId = actor.userId;
    }
    return {id, actor, csrf: row.csrf, expiresAt: row.expires_at};
  }
  requireSession(req: Request): WebSession {
    const session = this.session(req);
    if (!session) throw new MirrorError('SIGN_IN_REQUIRED', 'Sign in to your AMCP workspace.', {}, 401);
    return session;
  }
  requireOrigin(req: Request) {
    if (req.headers.origin !== this.origin || req.headers['sec-fetch-site'] === 'cross-site')
      throw new MirrorError('FORBIDDEN_ORIGIN', 'This request must come from your AMCP website.', {}, 403);
  }
  requireMutation(req: Request): WebSession {
    this.requireOrigin(req);
    const session = this.requireSession(req),
      csrf = req.headers['x-amcp-csrf'];
    if (typeof csrf !== 'string' || csrf !== session.csrf)
      throw new MirrorError('CSRF_INVALID', 'Refresh the page and try again.', {}, 403);
    return session;
  }
  requireAdminMutation(req: Request): WebSession {
    const s = this.requireMutation(req);
    if (s.actor.role !== 'admin')
      throw new MirrorError('FORBIDDEN', 'A workspace owner or administrator is required.', {}, 403);
    return s;
  }
  signOut(id: string) {
    this.store.db.prepare('DELETE FROM amcp_web_sessions WHERE hash=?').run(sha256(id));
    this.store.db.prepare('DELETE FROM amcp_oauth_states WHERE session_hash=?').run(sha256(id));
  }
  cookie(id: string, maxAge = 28800) {
    return `${this.cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
  }
  beginOAuth(
    session: WebSession,
    platform: string,
    data: JsonObject,
    state = randomBytes(32).toString('base64url'),
  ): string {
    if (!this.box)
      throw new MirrorError(
        'ENCRYPTION_REQUIRED',
        'Configure credential encryption before connecting a platform.',
        {},
        503,
      );
    const hash = sha256(state);
    this.store.db.prepare('DELETE FROM amcp_oauth_states WHERE expires_at<?').run(Date.now());
    this.store.db
      .prepare('INSERT INTO amcp_oauth_states VALUES(?,?,?,?,?)')
      .run(
        hash,
        sha256(session.id),
        platform,
        this.box.seal(data, scopeKey('website-oauth', hash)),
        Date.now() + 600000,
      );
    return state;
  }
  consumeOAuth(session: WebSession, platform: string, state: string): JsonObject {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Credential encryption is unavailable.', {}, 503);
    return this.store.transaction(() => {
      const hash = sha256(state),
        row = this.store.db
          .prepare('SELECT * FROM amcp_oauth_states WHERE hash=? AND session_hash=? AND platform=? AND expires_at>?')
          .get(hash, sha256(session.id), platform, Date.now()) as JsonObject | undefined;
      if (!row)
        throw new MirrorError(
          'OAUTH_STATE_INVALID',
          'This connection link expired or was already used. Start again from AMCP.',
          {},
          400,
        );
      this.store.db.prepare('DELETE FROM amcp_oauth_states WHERE hash=?').run(hash);
      return this.box!.open<JsonObject>(row.secret, scopeKey('website-oauth', hash));
    });
  }
}
