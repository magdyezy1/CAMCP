import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import type {Request} from 'express';
import {MirrorError} from '../src/errors.js';
import {sha256} from '../src/security.js';
import type {JsonObject} from '../src/types.js';
import {WebStore, type WebSession} from './web-store.js';
import {endMcpGrants, type GrantEndReason} from './mcp-grants.js';
import {derivePassword, passwordHashParts} from './password-hashes.js';
import {
  authorizeMonitorNotice,
  cancelMonitorNotice,
  monitorMailId,
  nextMonitorNotice,
  pruneMonitorNotices,
} from '../src/monitor-delivery.js';

const opaque = () => randomBytes(32).toString('base64url');
export async function hashUserPassword(password: unknown) {
  if (typeof password !== 'string' || password.length < 15 || password.length > 128)
    throw new MirrorError('PASSWORD_LENGTH', 'Use a password between 15 and 128 characters.');
  const salt = randomBytes(16).toString('hex');
  return 'scrypt-v3$' + salt + '$' + (await derivePassword(password, salt)).toString('hex');
}
export async function verifyPassword(password: unknown, hash?: string | null) {
  if (typeof password !== 'string' || password.length > 128) return false;
  // Without a hash a key is still derived, so an unknown account takes as long as a wrong password.
  const parts = passwordHashParts(hash ?? 'scrypt-v3$' + '0'.repeat(32) + '$' + '0'.repeat(64), [
    'scrypt-v2',
    'scrypt-v3',
  ]);
  return !!parts && timingSafeEqual(await derivePassword(password, parts.salt, parts.form), parts.key) && !!hash;
}
export function accountEmail(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !/^([^\s@<>]+)@([^\s@<>]+\.[^\s@<>]+)$/.test(value.trim()))
    throw new MirrorError('INVALID_EMAIL', 'Enter a valid email address.');
  return value.trim().toLowerCase();
}
export function accountName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value))
    throw new MirrorError('INVALID_NAME', 'Use a name between 1 and 80 characters.');
  return value.trim();
}
export class UserAccounts {
  readonly env: NodeJS.ProcessEnv;
  readonly fetcher: typeof fetch;
  constructor(readonly web: WebStore) {
    this.env = web.options.authEnv ?? process.env;
    this.fetcher = web.options.fetcher ?? fetch;
  }
  get emailConfigured() {
    return !!(this.env.AMCP_EMAIL_API_KEY && this.env.AMCP_EMAIL_FROM && this.web.options.masterKey);
  }
  get signupEnabled() {
    return this.env.AMCP_ALLOW_SIGNUP !== 'false' && !!this.web.options.masterKey;
  }
  /** Signups need an owner's approval unless a deployment opts out of the review step. */
  get autoApprove() {
    return this.env.AMCP_AUTO_APPROVE_SIGNUPS === 'true';
  }
  limit(req: Request, action: string, identity = '', max = 8) {
    const now = Date.now(),
      db = this.web.store.db,
      keys = [sha256('user-auth:' + action + ':' + this.web.limitAddress(req))];
    if (identity) keys.push(sha256('user-auth-identity:' + action + ':' + identity));
    this.web.store.transaction(() => {
      db.prepare('DELETE FROM amcp_login_limits WHERE until_at<=?').run(now);
      for (const key of keys) {
        const row = db.prepare('SELECT attempts FROM amcp_login_limits WHERE key=?').get(key) as JsonObject | undefined;
        if (row && row.attempts >= max)
          throw new MirrorError('LOGIN_RATE_LIMIT', 'Too many attempts. Please try again in 15 minutes.', {}, 429);
      }
      for (const key of keys)
        db.prepare(
          'INSERT INTO amcp_login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1',
        ).run(key, now + 900000);
    });
  }
  /** A proven identity no longer counts toward its own limit, so a person who keeps signing in is never locked out.
   * Address counters stay: they are what limits guessing across many identities. */
  forgive(action: string, identity: string) {
    this.web.store.db
      .prepare('DELETE FROM amcp_login_limits WHERE key=?')
      .run(sha256('user-auth-identity:' + action + ':' + identity));
  }
  user(id: string): JsonObject {
    const user = this.web.store.db.prepare('SELECT * FROM amcp_users WHERE id=? AND disabled=0').get(id) as
      JsonObject | undefined;
    if (!user) throw new MirrorError('ACCOUNT_UNAVAILABLE', 'This account is unavailable.', {}, 401);
    return user;
  }
  /** Sign-in and session paths must refuse an account that has not been granted access. */
  assertApproved(user: JsonObject) {
    if (!user.approved)
      throw new MirrorError(
        'ACCOUNT_PENDING_APPROVAL',
        'Your account is awaiting approval. You will be able to sign in once an administrator grants access.',
        {},
        403,
      );
  }
  profile(session: WebSession) {
    if (session.actor.userId === 'workspace-test')
      return {
        id: 'workspace-test',
        name: 'Test reviewer',
        email: null,
        hasPassword: true,
        identities: [],
        administrator: false,
        workspaceName: 'AMCP test workspace',
        workspaceId: session.actor.tenantId,
        workspaceRole: 'owner',
        mfaEnabled: false,
        testAccount: true,
      };
    if (session.actor.userId === 'workspace-admin')
      return {
        id: 'workspace-admin',
        name: 'Workspace administrator',
        email: null,
        hasPassword: true,
        identities: [],
        administrator: true,
        workspaceName: 'AMCP workspace',
        workspaceId: session.actor.tenantId,
        workspaceRole: 'owner',
        mfaEnabled: false,
      };
    const u = this.user(session.actor.userId),
      identities = this.web.store.db
        .prepare('SELECT provider,created_at FROM amcp_identities WHERE user_id=?')
        .all(u.id);
    let workspaceName = u.name + '’s workspace';
    try {
      workspaceName = this.web.store.document(session.actor.tenantId, 'account_settings', 'workspace').name;
    } catch {}
    const membership = this.web.store.db
      .prepare('SELECT role FROM workspace_memberships WHERE tenant_id=? AND user_id=? AND active=1')
      .get(session.actor.tenantId, u.id) as JsonObject | undefined;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      hasPassword: !!u.password_hash,
      identities,
      administrator: false,
      workspaceName,
      workspaceId: session.actor.tenantId,
      workspaceRole: membership?.role,
      mfaEnabled: this.hasMfa(u.id),
      testAccount: !!u.test_account,
    };
  }
  /** Self-service signups are created unapproved: an owner grants access before first use.
   * Invited members are already vetted by the workspace that invited them.
   *
   * `approved` is required rather than defaulting. A default of true meant a caller that simply
   * omitted the argument would create an approved account, and the failure mode — access that
   * works when it should not — is invisible. Callers must now state which case they are in. */
  newUser(
    name: string,
    email: string | null,
    passwordHash: string | null,
    approved: boolean,
    testAccount = false,
  ): JsonObject {
    const id = randomUUID(),
      tenant = 'user-' + randomUUID(),
      now = Date.now();
    this.web.store.ensureTenant(tenant);
    this.web.store.db
      .prepare(
        'INSERT INTO amcp_users(id,email,name,tenant_id,password_hash,approved,test_account,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(id, email, name, tenant, passwordHash, approved ? 1 : 0, testAccount ? 1 : 0, now);
    this.web.store.db
      .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'owner',?)")
      .run(tenant, id, now);
    this.web.store.putDocument(tenant, 'account_settings', 'workspace', {name: name + '’s workspace'});
    this.web.store.appendAudit(tenant, randomUUID(), {event: 'account_created', user_id: id, approved});
    if (!approved)
      this.queueNotice(
        this.web.tenantId,
        this.ownerEmail() ?? '',
        'AMCP access request from ' + (email ?? name),
        name +
          ' (' +
          (email ?? 'no email address') +
          ') created an AMCP account and is waiting for access.\n\nReview pending requests in Settings:\n' +
          this.web.origin +
          '/settings\n\nNobody can sign in until you grant access.\n',
        'signup:' + id,
      );
    return this.user(id);
  }
  hasMfa(id: string) {
    return !!this.web.store.db.prepare('SELECT 1 FROM amcp_mfa WHERE user_id=?').get(id);
  }
  session(user: JsonObject, tenant = user.tenant_id, mfaVerified = false, signedInAt = Date.now()) {
    if (this.hasMfa(user.id) && !mfaVerified)
      throw new MirrorError('MFA_REQUIRED', 'Complete two-step verification.', {}, 401);
    const m = this.web.store.db
      .prepare('SELECT role FROM workspace_memberships WHERE tenant_id=? AND user_id=? AND active=1')
      .get(tenant, user.id) as JsonObject | undefined;
    if (!m) throw new MirrorError('MEMBERSHIP_REQUIRED', 'You no longer have access to this workspace.', {}, 403);
    return this.web.createSession(
      {
        userId: user.id,
        ownerUserId: user.id,
        tenantId: tenant,
        membershipRole: m.role,
        role: m.role === 'viewer' ? 'reader' : m.role === 'operator' ? 'operator' : 'admin',
        ...(user.test_account ? {testAccount: true} : {}),
      },
      signedInAt,
    );
  }
  loginResult(user: JsonObject) {
    if (this.hasMfa(user.id))
      return {mfaRequired: true, ticket: this.challenge('mfa_login', {userId: user.id, version: user.version}, 300000)};
    return this.session(user);
  }
  async login(req: Request, input: JsonObject) {
    const email = accountEmail(input.email);
    this.limit(req, 'login', email, 10);
    const user = this.web.store.db.prepare('SELECT * FROM amcp_users WHERE email=? AND disabled=0').get(email) as
      JsonObject | undefined;
    if (!(await verifyPassword(input.password, user?.password_hash)))
      throw new MirrorError('INVALID_LOGIN', 'Email or password is incorrect.', {}, 401);
    // The password may have changed while the asynchronous KDF was running.
    const current = this.user(user!.id);
    if (current.version !== user!.version) throw new MirrorError('INVALID_LOGIN', 'Please sign in again.', {}, 401);
    this.assertApproved(current);
    this.forgive('login', email);
    if (
      user!.password_hash?.startsWith('scrypt-v2$') &&
      typeof input.password === 'string' &&
      input.password.length >= 15
    ) {
      const hash = await hashUserPassword(input.password);
      const changed = this.web.store.db
        .prepare('UPDATE amcp_users SET password_hash=? WHERE id=? AND version=?')
        .run(hash, current.id, current.version);
      if (!changed.changes) throw new MirrorError('INVALID_LOGIN', 'Please sign in again.', {}, 401);
    }
    this.web.store.appendAudit(current.tenant_id, randomUUID(), {event: 'account_sign_in', method: 'password'});
    return this.loginResult(current);
  }
  challenge(kind: string, data: JsonObject, ttl = 1800000) {
    const token = opaque(),
      hash = sha256(token),
      db = this.web.store.db;
    db.prepare('DELETE FROM amcp_account_challenges WHERE expires_at<=?').run(Date.now());
    // Each kind has its own cap, so anonymous social starts or registrations cannot use up the room resets, MFA and invitations need.
    const total = (db.prepare('SELECT count(*) AS n FROM amcp_account_challenges WHERE kind=?').get(kind) as JsonObject)
      .n;
    if (total >= 10000) throw new MirrorError('AUTH_BUSY', 'Please try again later.', {}, 429);
    db.prepare('INSERT INTO amcp_account_challenges VALUES(?,?,?,?)').run(
      hash,
      kind,
      this.web.sealAccount(hash, data),
      Date.now() + ttl,
    );
    return token;
  }
  readChallenge(token: unknown, kind: string, consume = false): JsonObject {
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token))
      throw new MirrorError('LINK_EXPIRED', 'This link expired or was already used. Request a new one.');
    const hash = sha256(token),
      row = this.web.store.db
        .prepare('SELECT secret FROM amcp_account_challenges WHERE hash=? AND kind=? AND expires_at>?')
        .get(hash, kind, Date.now()) as JsonObject | undefined;
    if (!row) throw new MirrorError('LINK_EXPIRED', 'This link expired or was already used. Request a new one.');
    if (consume) this.web.store.db.prepare('DELETE FROM amcp_account_challenges WHERE hash=?').run(hash);
    return this.web.openAccount(hash, row.secret);
  }
  async sendEmail(email: string, kind: string, token: string) {
    if (!this.emailConfigured)
      throw new MirrorError(
        'EMAIL_SETUP_REQUIRED',
        'Email sign-in is not available yet. Use a configured social account or contact the administrator.',
        {},
        503,
      );
    const route = kind === 'register' ? 'verify-email' : kind === 'reset' ? 'reset-password' : 'verify-email',
      link = this.web.origin + '/' + route + '#token=' + encodeURIComponent(token) + '&kind=' + kind;
    const title =
      kind === 'register'
        ? 'Create your AMCP account'
        : kind === 'reset'
          ? 'Reset your AMCP password'
          : 'Verify your AMCP email';
    const row = this.web.store.db
      .prepare('SELECT expires_at FROM amcp_account_challenges WHERE hash=?')
      .get(sha256(token)) as JsonObject | undefined;
    if (!row) throw new MirrorError('LINK_EXPIRED', 'Request a fresh link.');
    const pending = this.readChallenge(token, kind),
      tenant = pending.tenantId ?? (pending.userId ? this.user(pending.userId).tenant_id : this.web.tenantId);
    const id = sha256(token),
      now = Date.now(),
      secret = this.web.sealAccount('mail:' + id, {
        from: this.env.AMCP_EMAIL_FROM,
        to: [email],
        subject: title,
        text:
          title +
          '\n\n' +
          link +
          '\n\nThis link is single-use and expires at ' +
          new Date(row.expires_at).toISOString() +
          '. If you did not request it, ignore this email.',
      });
    this.web.store.db
      .prepare(
        "INSERT OR IGNORE INTO amcp_email_outbox(id,tenant_id,secret,state,available_at,expires_at,created_at) VALUES(?,?,?,'queued',?,?,?)",
      )
      .run(id, tenant, secret, now, row.expires_at, now);
    // Delivery starts now but is not awaited: register and requestReset send only for some addresses, so a response that
    // waited on the email provider would tell the caller whether an account exists. The worker retries what stays queued.
    void this.deliverEmails(id).catch(() => {});
  }
  /**
   * Tells a person their sign-in security changed, so a change they did not make is noticed (owner decision, review
   * 2026-09-28). Queued in the transaction that makes the change; the worker delivers it. `to` defaults to the
   * account's address; an email change notifies the previous one.
   */
  securityNotice(user: JsonObject, change: string, to: unknown = user.email) {
    if (typeof to !== 'string' || !to) return false;
    return this.queueNotice(
      String(user.tenant_id ?? this.web.tenantId),
      to,
      'Security change on your AMCP account',
      change +
        ' (' +
        new Date().toUTCString() +
        ').\n\nIf this was you, there is nothing to do. If it was not, reset your password now and tell your workspace owner:\n' +
        this.web.origin +
        '/forgot-password\n',
      'security:' + user.id + ':' + randomUUID(),
    );
  }
  /** Queues a notification that carries no single-use link. The worker drains the outbox
   * every second, so callers need not await delivery inside a transaction. */
  queueNotice(tenant: string, to: string, subject: string, text: string, key: string, monitorNotice?: JsonObject) {
    if (!this.emailConfigured || !to) return false;
    const id = sha256('notice:' + key),
      now = Date.now();
    const secret = this.web.sealAccount('mail:' + id, {
      from: this.env.AMCP_EMAIL_FROM,
      to: [to],
      subject,
      text,
      ...(monitorNotice ? {_amcp_monitor: monitorNotice.id} : {}),
    });
    // The deterministic id makes a repeated event idempotent at the outbox and at the provider.
    this.web.store.db
      .prepare(
        "INSERT OR IGNORE INTO amcp_email_outbox(id,tenant_id,secret,state,available_at,expires_at,created_at) VALUES(?,?,?,'queued',?,?,?)",
      )
      .run(id, tenant, secret, now, monitorNotice?.expires_at ?? now + 86400000, now);
    return true;
  }
  /** Names the exact variables an operator must set. Owner-gated: never shown to a visitor,
   * because "temporarily unavailable" tells neither the visitor nor the operator anything. */
  setupGaps() {
    return {
      email: [
        ...(this.web.options.masterKey ? [] : ['MIRROR_MASTER_KEY']),
        ...(this.env.AMCP_EMAIL_API_KEY ? [] : ['AMCP_EMAIL_API_KEY']),
        ...(this.env.AMCP_EMAIL_FROM ? [] : ['AMCP_EMAIL_FROM']),
      ],
      signup: this.signupEnabled ? [] : [this.web.options.masterKey ? 'AMCP_ALLOW_SIGNUP' : 'MIRROR_MASTER_KEY'],
      ownerNotice: this.ownerEmail() ? [] : ['AMCP_OWNER_EMAIL'],
      reviewer:
        this.web.testPasswordProblem ??
        (this.web.testConfigured ? null : 'Set AMCP_TEST_PASSWORD to give reviewers a sign-in button.'),
    };
  }
  /** Access requests go to the instance owner, or to an explicitly configured address. */
  ownerEmail() {
    const row = this.web.store.db
      .prepare(
        "SELECT u.email AS email FROM amcp_users u JOIN workspace_memberships m ON m.user_id=u.id WHERE m.tenant_id=? AND m.role='owner' AND m.active=1 AND u.disabled=0 AND u.email IS NOT NULL LIMIT 1",
      )
      .get(this.web.tenantId) as JsonObject | undefined;
    return (this.env.AMCP_OWNER_EMAIL ?? row?.email) as string | undefined;
  }
  async deliverEmails(onlyId?: string) {
    pruneMonitorNotices(this.web.store);
    if (!this.emailConfigured) return false;
    if (!onlyId)
      this.web.store.transaction(() => {
        const pending = nextMonitorNotice(this.web.store);
        if (!pending) return;
        const {tenant, notice, email} = pending;
        this.queueNotice(
          tenant,
          email,
          notice.event === 'resolved' ? 'AMCP monitor incident resolved' : 'AMCP monitor needs attention',
          (notice.event === 'resolved'
            ? 'New retained evidence resolved a monitor incident.'
            : 'A monitor incident needs your attention.') +
            '\n\nSign in to inspect its evidence:\n' +
            this.web.origin +
            '/monitors?incident_id=' +
            encodeURIComponent(notice.incident_id) +
            '\n\nManage your email notices from the monitor rule in the workspace. No advertising change was made.\n',
          'monitor:' + notice.id,
          notice,
        );
        this.web.store.putDocument(tenant, 'monitor_notice', notice.id, {...notice, state: 'queued'});
      });
    const db = this.web.store.db,
      now = Date.now(),
      lease = randomUUID();
    const row = this.web.store.transaction(() => {
      db.prepare(
        "UPDATE amcp_email_outbox SET state='expired',secret='',lease_token=NULL WHERE state IN ('queued','sending','failed') AND expires_at<=?",
      ).run(now + 60000);
      const r = db
        .prepare(
          "SELECT * FROM amcp_email_outbox WHERE expires_at>? AND available_at<=? AND (state='queued' OR (state='sending' AND lease_until<?)) AND (? IS NULL OR id=?) ORDER BY created_at LIMIT 1",
        )
        .get(now + 60000, now, now, onlyId ?? null, onlyId ?? null) as JsonObject | undefined;
      if (r)
        db.prepare(
          "UPDATE amcp_email_outbox SET state='sending',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=?",
        ).run(lease, now + 30000, r.id);
      return r;
    });
    if (!row) return false;
    let notice: JsonObject | undefined;
    try {
      const {_amcp_monitor, ...payload} = this.web.openAccount('mail:' + row.id, row.secret);
      if (_amcp_monitor !== undefined) {
        notice = this.web.store.document(row.tenant_id, 'monitor_notice', _amcp_monitor);
        if (row.id !== monitorMailId(notice!.id))
          throw new MirrorError('NOTIFICATION_CHANGED', 'The notice identity changed.');
        try {
          const checked = authorizeMonitorNotice(this.web.store, row.tenant_id, notice!);
          if (payload.to?.length !== 1 || payload.to[0] !== checked.user.email)
            throw new MirrorError('NOTIFICATION_RECIPIENT_CHANGED', 'The original email recipient changed.');
          if (checked.defer_until) {
            db.prepare(
              "UPDATE amcp_email_outbox SET state='queued',available_at=?,attempts=attempts-1,lease_token=NULL WHERE id=? AND lease_token=?",
            ).run(Math.min(checked.defer_until, row.expires_at), row.id, lease);
            return true;
          }
          if (row.attempts >= notice!.attempt_limit) {
            this.web.store.transaction(() => {
              const changed = db
                .prepare(
                  "UPDATE amcp_email_outbox SET state='failed',attempts=attempts-1,lease_token=NULL,last_error='NOTIFICATION_ATTEMPT_LIMIT' WHERE id=? AND lease_token=?",
                )
                .run(row.id, lease);
              if (changed.changes)
                this.web.store.putDocument(row.tenant_id, 'monitor_notice', notice!.id, {...notice!, retryable: true});
            });
            return true;
          }
        } catch (e) {
          cancelMonitorNotice(
            this.web.store,
            row.tenant_id,
            notice!,
            e instanceof MirrorError ? e.code : 'NOTIFICATION_ACCESS_REQUIRED',
          );
          return true;
        }
      }
      const r = await this.fetcher('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
        headers: {
          Authorization: 'Bearer ' + this.env.AMCP_EMAIL_API_KEY,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'amcp-' + row.id,
        },
        body: JSON.stringify(payload),
      });
      await r.body?.cancel();
      if (!r.ok)
        throw new MirrorError(
          'EMAIL_PROVIDER_REJECTED',
          'Email provider returned ' + r.status,
          {retryAfter: r.headers.get('retry-after')},
          r.status,
          r.status === 429 || r.status >= 500 || (!!notice && r.status === 409),
        );
      db.prepare(
        "UPDATE amcp_email_outbox SET state='sent',secret='',lease_token=NULL,last_error=NULL WHERE id=? AND lease_token=?",
      ).run(row.id, lease);
    } catch (e) {
      this.web.store.transaction(() => {
        // Another worker, opt-out or expiry may have fenced this attempt while fetch was pending.
        if (!db.prepare('SELECT 1 FROM amcp_email_outbox WHERE id=? AND lease_token=?').get(row.id, lease)) return;
        const retryable = !(e instanceof MirrorError) || e.retryable;
        const retry = retryable && (!notice || row.attempts + 1 < notice.attempt_limit);
        if (notice) this.web.store.putDocument(row.tenant_id, 'monitor_notice', notice.id, {...notice, retryable});
        const seconds = e instanceof MirrorError ? Number(e.details.retryAfter) : NaN,
          wait =
            Number.isFinite(seconds) && seconds > 0
              ? Math.min(seconds * 1000, 1800000)
              : Math.min(120000, 10000 * 2 ** Math.min(row.attempts, 5));
        db.prepare(
          'UPDATE amcp_email_outbox SET state=?,available_at=?,lease_token=NULL,last_error=? WHERE id=? AND lease_token=?',
        ).run(
          retry ? 'queued' : 'failed',
          Date.now() + wait,
          e instanceof MirrorError ? e.code : 'EMAIL_NETWORK_ERROR',
          row.id,
          lease,
        );
        if (notice && !retryable)
          db.prepare("UPDATE amcp_email_outbox SET secret='' WHERE id=? AND state='failed'").run(row.id);
      });
    }
    return true;
  }
  async register(req: Request, input: JsonObject) {
    if (!this.signupEnabled)
      throw new MirrorError('SIGNUP_DISABLED', 'New account registration is currently closed.', {}, 403);
    if (!this.emailConfigured)
      throw new MirrorError(
        'EMAIL_SETUP_REQUIRED',
        'Email registration is not available yet. Choose an available social sign-in.',
        {},
        503,
      );
    const email = accountEmail(input.email),
      name = accountName(input.name);
    this.limit(req, 'email', email, 5);
    if (!this.web.store.db.prepare('SELECT id FROM amcp_users WHERE email=?').get(email))
      await this.sendEmail(email, 'register', this.challenge('register', {email, name}));
    return {
      message:
        'If this email can be registered, an account setup link is on its way. Already a member? Sign in instead.',
    };
  }
  async requestReset(req: Request, input: JsonObject) {
    if (!this.emailConfigured)
      throw new MirrorError(
        'EMAIL_SETUP_REQUIRED',
        'Email recovery is not configured. Use your linked social account.',
        {},
        503,
      );
    const email = accountEmail(input.email);
    this.limit(req, 'email', email, 5);
    const user = this.web.store.db.prepare('SELECT * FROM amcp_users WHERE email=? AND disabled=0').get(email) as
      JsonObject | undefined;
    if (user) await this.sendEmail(email, 'reset', this.challenge('reset', {userId: user.id, version: user.version}));
    return {message: 'If an account uses this email, a password reset link is on its way.'};
  }
  /** Ends a person's sessions, API keys and MCP grants after a security change; `reason` is recorded on each ended
   * MCP grant and in audit (MCP-08). */
  revokeAccess(user: JsonObject, reason: GrantEndReason = 'password_change') {
    const db = this.web.store.db;
    db.prepare("DELETE FROM amcp_web_sessions WHERE json_extract(actor,'$.userId')=?").run(user.id);
    db.prepare('UPDATE api_keys SET revoked=1 WHERE hash IN (SELECT hash FROM credential_owners WHERE user_id=?)').run(
      user.id,
    );
    endMcpGrants(this.web.store, "json_extract(data,'$.ownerUserId')=?", [user.id], reason);
    // Legacy connectors belonged to the sole owner before memberships existed.
    db.prepare(
      'UPDATE api_keys SET revoked=1 WHERE tenant_id=? AND hash NOT IN (SELECT hash FROM credential_owners)',
    ).run(user.tenant_id);
    endMcpGrants(this.web.store, "tenant_id=? AND json_extract(data,'$.ownerUserId') IS NULL", [user.tenant_id], reason);
  }
  async finishEmail(req: Request, input: JsonObject) {
    this.limit(req, 'verify', '', 15);
    const kind = input.kind;
    if (!['register', 'reset', 'email'].includes(kind))
      throw new MirrorError('LINK_EXPIRED', 'Use the complete link from your email.');
    if (kind === 'register' && !this.signupEnabled)
      throw new MirrorError('SIGNUP_DISABLED', 'New account registration is currently closed.', {}, 403);
    const data = this.readChallenge(input.token, kind);
    const hash = kind === 'email' ? null : await hashUserPassword(input.password);
    this.web.store.transaction(() => {
      this.readChallenge(input.token, kind, true);
      if (kind === 'register') {
        if (this.web.store.db.prepare('SELECT id FROM amcp_users WHERE email=?').get(data.email))
          throw new MirrorError(
            'ACCOUNT_EXISTS',
            'An account already uses this email. Sign in or reset your password.',
          );
        this.newUser(data.name, data.email, hash, this.autoApprove || data.test === true, data.test === true);
      } else {
        const user = this.user(data.userId);
        if (user.version !== data.version)
          throw new MirrorError('LINK_EXPIRED', 'Your account changed. Request a fresh link.');
        if (kind === 'email') {
          if (this.web.store.db.prepare('SELECT id FROM amcp_users WHERE email=? AND id<>?').get(data.email, user.id))
            throw new MirrorError('ACCOUNT_EXISTS', 'This email is already used by another account.');
          this.web.store.db
            .prepare('UPDATE amcp_users SET email=?,version=version+1 WHERE id=?')
            .run(data.email, user.id);
          this.securityNotice(user, 'The sign-in email of your AMCP account was changed to ' + data.email);
        } else {
          this.web.store.db
            .prepare('UPDATE amcp_users SET password_hash=?,version=version+1 WHERE id=?')
            .run(hash, user.id);
          this.securityNotice(user, 'The password of your AMCP account was reset through an emailed link');
        }
        this.revokeAccess(user, kind === 'email' ? 'email_change' : 'password_change');
        this.web.store.appendAudit(user.tenant_id, randomUUID(), {
          event: kind === 'email' ? 'account_email_verified' : 'account_password_reset',
        });
      }
    });
    return {
      message:
        kind === 'register'
          ? this.autoApprove || data.test === true
            ? 'Your account is ready. Sign in to open your workspace.'
            : 'Your account has been created and is awaiting approval. You will be able to sign in once an administrator grants access.'
          : 'Account updated. Sign in again; previous sessions and MCP access have been revoked.',
    };
  }
  async requestEmail(req: Request, input: JsonObject) {
    const s = this.web.requireMutation(req),
      u = this.user(s.actor.userId),
      email = accountEmail(input.email);
    this.limit(req, 'email', email, 5);
    this.fresh(s);
    await this.sendEmail(email, 'email', this.challenge('email', {email, userId: u.id, version: u.version}));
    return {
      message:
        'Check your inbox to verify this email. Confirmation signs out existing sessions and revokes old MCP access.',
    };
  }
  fresh(s: WebSession) {
    const data = this.web.store.db.prepare('SELECT actor FROM amcp_web_sessions WHERE hash=?').get(sha256(s.id)) as
      JsonObject | undefined;
    if (!data || Number(JSON.parse(data.actor).signedInAt ?? s.expiresAt - 8 * 3600000) < Date.now() - 900000)
      throw new MirrorError('REAUTH_REQUIRED', 'Sign out and sign in again before changing account security.', {}, 403);
  }
  update(req: Request, input: JsonObject) {
    const s = this.web.requireMutation(req),
      u = this.user(s.actor.userId),
      name = accountName(input.name),
      workspace = accountName(input.workspaceName);
    const old = this.profile(s);
    if (s.actor.role !== 'admin' && workspace !== old.workspaceName)
      throw new MirrorError('FORBIDDEN', 'Only workspace administrators can rename the workspace.', {}, 403);
    this.web.store.transaction(() => {
      this.web.store.db.prepare('UPDATE amcp_users SET name=? WHERE id=?').run(name, u.id);
      if (s.actor.role === 'admin')
        this.web.store.putDocument(s.actor.tenantId, 'account_settings', 'workspace', {name: workspace});
    });
    return this.profile(s);
  }
  async changePassword(req: Request, input: JsonObject) {
    const s = this.web.requireMutation(req),
      u = this.user(s.actor.userId);
    this.limit(req, 'password', u.id, 8);
    this.fresh(s);
    if (u.password_hash && !(await verifyPassword(input.currentPassword, u.password_hash)))
      throw new MirrorError('INVALID_LOGIN', 'Your current password is incorrect.', {}, 401);
    if (!u.email) throw new MirrorError('EMAIL_REQUIRED', 'Verify an email address before adding a password.');
    const hash = await hashUserPassword(input.password);
    this.web.requireMutation(req);
    return this.web.store.transaction(() => {
      if (this.user(u.id).version !== u.version)
        throw new MirrorError('ACCOUNT_CHANGED', 'Sign in again before retrying.');
      this.web.store.db.prepare('UPDATE amcp_users SET password_hash=?,version=version+1 WHERE id=?').run(hash, u.id);
      this.revokeAccess(u);
      this.securityNotice(u, 'The password of your AMCP account was changed');
      return this.session(this.user(u.id), s.actor.tenantId, true);
    });
  }
  unlink(req: Request, provider: string) {
    const s = this.web.requireMutation(req),
      u = this.user(s.actor.userId);
    this.fresh(s);
    this.web.store.transaction(() => {
      const count = (
        this.web.store.db.prepare('SELECT count(*) AS n FROM amcp_identities WHERE user_id=?').get(u.id) as JsonObject
      ).n;
      if (!u.password_hash && count <= 1)
        throw new MirrorError('LAST_SIGN_IN_METHOD', 'Add another sign-in method before removing this one.');
      const removed = this.web.store.db
        .prepare('DELETE FROM amcp_identities WHERE user_id=? AND provider=?')
        .run(u.id, provider).changes;
      this.web.store.appendAudit(u.tenant_id, randomUUID(), {event: 'account_identity_removed', provider});
      if (removed) this.securityNotice(u, 'A ' + provider + ' sign-in was removed from your AMCP account');
    });
  }
}
