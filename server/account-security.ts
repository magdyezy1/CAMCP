import {randomBytes, randomUUID, createHmac, timingSafeEqual} from 'node:crypto';
import type {Request} from 'express';
import {
  UserAccounts,
  accountEmail,
  accountName,
  hashUserPassword,
  recentProofMs,
  verifyPassword,
} from './user-accounts.js';
import {checkPassword} from './web-store.js';
import {
  assertPolicyOwnerEnrolled,
  defaultInvitationHours,
  mfaScopes,
  securitySettings,
  type MfaScope,
} from './mfa-policy.js';
import {endMcpGrants} from './mcp-grants.js';
import {MirrorError} from '../src/errors.js';
import {sha256} from '../src/security.js';
import {accountRetention} from '../src/account-erasure.js';
import type {JsonObject} from '../src/types.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Buffer) {
  let value = 0,
    bits = 0,
    out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
export function totp(secret: string, step = Math.floor(Date.now() / 30000)) {
  let value = 0,
    bits = 0;
  const bytes: number[] = [];
  for (const c of secret) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw Error('Invalid TOTP key');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(),
    offset = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class AccountSecurity {
  readonly web;
  readonly db;
  constructor(readonly accounts: UserAccounts) {
    this.web = accounts.web;
    this.db = this.web.store.db;
  }
  owner(req: Request) {
    const s = this.web.requireAdminMutation(req);
    if (s.actor.userId !== 'workspace-admin' && s.actor.membershipRole !== 'owner')
      throw new MirrorError('OWNER_REQUIRED', 'Only the workspace owner can perform this action.', {}, 403);
    return s;
  }
  /** Instance-level authority. Every self-service signup owns its own workspace, so workspace
   * ownership alone must never confer the right to approve or revoke other people's accounts. */
  private instanceOwner(req: Request, mutation = true) {
    const s = mutation ? this.web.requireAdminMutation(req) : this.web.requireSession(req);
    if (
      s.actor.userId !== 'workspace-admin' &&
      !(s.actor.membershipRole === 'owner' && s.actor.tenantId === this.web.tenantId)
    )
      throw new MirrorError('OWNER_REQUIRED', 'Only the AMCP owner can manage account access.', {}, 403);
    return s;
  }
  /** Owner-initiated setup for an evaluator. The recipient chooses their own password, and the
   * account arrives approved and scoped, because inviting it is the vetting step. */
  async inviteTestAccount(req: Request, input: JsonObject) {
    // Inviting grants an approved account, so it needs recent proof of identity (SEC-06).
    this.accounts.fresh(this.instanceOwner(req));
    if (!this.accounts.emailConfigured)
      throw new MirrorError('EMAIL_SETUP_REQUIRED', 'Configure email delivery before sending a setup link.', {}, 503);
    const email = accountEmail(input.email),
      name = accountName(input.name);
    this.accounts.limit(req, 'invite', email, 10);
    if (this.db.prepare('SELECT 1 FROM amcp_users WHERE email=?').get(email))
      throw new MirrorError(
        'ACCOUNT_EXISTS',
        'An account already uses this email. Change its access from the list instead.',
      );
    await this.accounts.sendEmail(email, 'register', this.accounts.challenge('register', {email, name, test: true}));
    return {
      message: 'A setup link is on its way. The account will have test access as soon as they choose a password.',
    };
  }
  accessRequests(req: Request) {
    const s = this.instanceOwner(req, false);
    const rows = this.db
      .prepare(
        'SELECT u.id,u.email,u.name,u.approved,u.disabled,u.test_account,u.created_at,(SELECT group_concat(provider) FROM amcp_identities i WHERE i.user_id=u.id) AS providers,u.password_hash IS NOT NULL AS has_password FROM amcp_users u ORDER BY u.approved ASC,u.created_at DESC LIMIT 500',
      )
      .all() as JsonObject[];
    const accounts = rows.map(r => ({
      id: r.id,
      email: r.email,
      name: r.name,
      state: r.disabled ? 'revoked' : r.approved ? 'approved' : 'pending',
      test: !!r.test_account,
      created_at: r.created_at,
      methods: [
        ...(r.has_password ? ['email'] : []),
        ...String(r.providers ?? '')
          .split(',')
          .filter(Boolean),
      ],
      // WEB-08: the caller's own row, whose access setAccess always refuses to change, is marked so the list offers
      // no action on it.
      self: r.id === s.actor.userId,
    }));
    // Requests left pending this many days are erased by the worker (SEC-07 S4); null when retention is off.
    let pendingMs: number | null = null;
    try {
      pendingMs = accountRetention(this.accounts.env).pendingMs;
    } catch {
      /* An unknown value stops the worker at start-up; the list itself still shows. */
    }
    return {
      accounts,
      pending: accounts.filter(a => a.state === 'pending').length,
      emailEnabled: this.accounts.emailConfigured,
      ownerEmail: this.accounts.ownerEmail() ?? null,
      pendingRetentionDays: pendingMs === null ? null : pendingMs / 86400000,
    };
  }
  setAccess(req: Request, input: JsonObject) {
    const s = this.instanceOwner(req),
      id = String(input.user_id ?? ''),
      grant = input.grant === true;
    const user = this.db.prepare('SELECT * FROM amcp_users WHERE id=?').get(id) as JsonObject | undefined;
    if (!user) throw new MirrorError('NOT_FOUND', 'Account not found.', {}, 404);
    if (user.id === s.actor.userId) throw new MirrorError('FORBIDDEN', 'You cannot change your own access.', {}, 403);
    // Granting access needs recent proof of identity (SEC-06); revoking does not, so an owner can end access at once.
    if (grant) this.accounts.fresh(s);
    return this.web.store.transaction(() => {
      this.db
        .prepare('UPDATE amcp_users SET approved=?,disabled=?,test_account=?,version=version+1 WHERE id=?')
        .run(
          grant ? 1 : 0,
          grant ? 0 : 1,
          input.test === true ? 1 : input.test === false ? 0 : user.test_account ? 1 : 0,
          id,
        );
      // Revoking ends live access now rather than at session expiry: sessions, API keys and MCP grants.
      if (!grant) this.accounts.revokeAccess(user, 'account_access_revoked');
      this.web.store.appendAudit(this.web.tenantId, randomUUID(), {
        event: grant ? 'account_access_granted' : 'account_access_revoked',
        user_id: id,
      });
      // The person is told either way; a silent revocation just looks like a broken product.
      if (user.email)
        this.accounts.queueNotice(
          this.web.tenantId,
          String(user.email),
          grant ? 'Your AMCP access is ready' : 'Your AMCP access has been removed',
          grant
            ? 'An administrator granted your AMCP account access.\n\nSign in:\n' + this.web.origin + '/login\n'
            : 'An administrator removed access for this AMCP account. Existing sessions and connector access have ended.\n',
          (grant ? 'granted:' : 'revoked:') + id + ':' + Date.now(),
        );
      return {
        success: true,
        state: grant ? 'approved' : 'revoked',
        test: input.test === true || (input.test === undefined && !!user.test_account),
      };
    });
  }
  async beginOwner(req: Request, input: JsonObject) {
    const s = this.web.requireMutation(req);
    if (s.actor.userId !== 'workspace-admin' || s.actor.tenantId !== this.web.tenantId)
      throw new MirrorError(
        'OWNER_MIGRATION_FORBIDDEN',
        'Start owner setup from the existing administrator workspace.',
        {},
        403,
      );
    this.accounts.limit(req, 'owner-migration', '', 5);
    if (
      !this.web.administratorHash ||
      typeof input.administratorPassword !== 'string' ||
      !(await checkPassword(input.administratorPassword, this.web.administratorHash))
    )
      throw new MirrorError('INVALID_LOGIN', 'Confirm your existing administrator password.', {}, 401);
    const email = accountEmail(input.email),
      name = accountName(input.name);
    if (this.db.prepare('SELECT id FROM amcp_users WHERE email=?').get(email))
      throw new MirrorError(
        'ACCOUNT_EXISTS',
        'This address already has a separate account. Use an unused verified owner address; accounts are never silently merged.',
      );
    await this.accounts.sendEmail(
      email,
      'owner',
      this.accounts.challenge('owner', {email, name, tenantId: s.actor.tenantId, sessionHash: sha256(s.id)}),
    );
    return {
      message:
        'Verify the email in this browser, then choose your owner password. Existing workspace data will be preserved.',
    };
  }
  async finishOwner(req: Request, input: JsonObject) {
    const s = this.web.requireMutation(req),
      pending = this.accounts.readChallenge(input.token, 'owner');
    if (
      s.actor.userId !== 'workspace-admin' ||
      pending.sessionHash !== sha256(s.id) ||
      pending.tenantId !== s.actor.tenantId
    )
      throw new MirrorError(
        'OWNER_MIGRATION_FORBIDDEN',
        'Finish owner setup in the administrator browser that started it.',
        {},
        403,
      );
    const password = await hashUserPassword(input.password, pending);
    this.web.requireMutation(req);
    return this.web.store.transaction(() => {
      this.accounts.readChallenge(input.token, 'owner', true);
      if (
        this.db
          .prepare("SELECT 1 FROM documents WHERE tenant_id=? AND kind='account_settings' AND id='owner_migration'")
          .get(s.actor.tenantId)
      )
        throw new MirrorError('OWNER_ALREADY_CONFIGURED', 'The owner account is already configured.');
      if (this.db.prepare('SELECT 1 FROM amcp_users WHERE email=? OR tenant_id=?').get(pending.email, s.actor.tenantId))
        throw new MirrorError('ACCOUNT_EXISTS', 'An account already uses this email or workspace.');
      const id = randomUUID(),
        now = Date.now();
      this.db
        .prepare('INSERT INTO amcp_users(id,email,name,tenant_id,password_hash,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, pending.email, pending.name, s.actor.tenantId, password, now);
      this.db
        .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'owner',?)")
        .run(s.actor.tenantId, id, now);
      this.web.store.putDocument(s.actor.tenantId, 'account_settings', 'owner_migration', {
        user_id: id,
        completed_at: now,
      });
      this.accounts.revokeAccess(this.accounts.user(id), 'owner_migration');
      this.db
        .prepare(
          "DELETE FROM amcp_web_sessions WHERE json_extract(actor,'$.tenantId')=? AND json_extract(actor,'$.userId')='workspace-admin'",
        )
        .run(s.actor.tenantId);
      this.db
        .prepare('DELETE FROM amcp_oauth_states WHERE session_hash NOT IN (SELECT hash FROM amcp_web_sessions)')
        .run();
      this.web.store.appendAudit(s.actor.tenantId, randomUUID(), {event: 'owner_account_migrated', user_id: id});
      return {
        message:
          'Your owner account is ready. Sign in with your email and password, then enable two-step verification in Account. Your workspace and connections are preserved. Reauthorize existing MCP clients and resume schedules with your owner account.',
      };
    });
  }
  beginMfa(req: Request) {
    const s = this.web.requireMutation(req),
      u = this.accounts.user(s.actor.userId);
    this.accounts.fresh(s);
    if (this.accounts.hasMfa(u.id))
      throw new MirrorError('MFA_ALREADY_ENABLED', 'Two-step verification is already enabled.');
    const secret = base32(randomBytes(20)),
      ticket = this.accounts.challenge(
        'mfa_setup',
        {userId: u.id, version: u.version, sessionHash: sha256(s.id), secret},
        600000,
      );
    return {
      ticket,
      secret,
      uri:
        'otpauth://totp/' +
        encodeURIComponent('AMCP:' + (u.email ?? u.name)) +
        '?' +
        new URLSearchParams({secret, issuer: 'AMCP', algorithm: 'SHA1', digits: '6', period: '30'}),
      message: 'Add this key to your authenticator and enter its six-digit code. Keep the recovery codes offline.',
    };
  }
  /**
   * "Confirm it's you" (SEC-06): proves the person behind this session again without signing out, with the account
   * password or a two-step code (a door session: its door's password). Every attempt counts against the person's own
   * budget (8 per 15 minutes) and the address's; a success clears the person's count. Only the session's recent-proof
   * time changes, so UserAccounts.fresh accepts it for 15 minutes; the session's expiry never moves.
   */
  async reauthenticate(req: Request, input: JsonObject) {
    const s = this.web.requireMutation(req),
      code = typeof input.code === 'string' && input.code.trim() ? input.code.trim() : undefined;
    let method: string;
    if (s.actor.userId === 'workspace-admin' || s.actor.userId === 'workspace-test') {
      if (code !== undefined)
        throw new MirrorError('INVALID_ARGUMENT', 'Confirm this sign-in with its password.', {}, 400);
      await this.web.confirmDoor(s.actor.userId, s.actor.tenantId, input.password, this.web.limitAddress(req));
      method = 'door_password';
    } else {
      const u = this.accounts.user(s.actor.userId);
      this.accounts.limit(req, 'reauth', u.id, 8);
      if (code !== undefined) {
        this.verifyCode(u.id, code);
        method = 'mfa_code';
      } else {
        if (!u.password_hash)
          throw new MirrorError(
            'PASSWORD_NOT_SET',
            'This account has no password. Confirm with a two-step code or with your linked sign-in.',
            {},
            400,
          );
        if (!(await verifyPassword(input.password, u.password_hash)))
          throw new MirrorError('INVALID_LOGIN', 'That password is incorrect.', {}, 401);
        method = 'password';
      }
      if (this.accounts.user(u.id).version !== u.version)
        throw new MirrorError('ACCOUNT_CHANGED', 'Sign in again before retrying.');
      this.accounts.forgive('reauth', u.id);
    }
    // The key derivation is asynchronous: the session must still be this one, unchanged, when the proof is recorded.
    const current = this.web.requireMutation(req);
    if (current.id !== s.id) throw new MirrorError('SIGN_IN_REQUIRED', 'Sign in to your AMCP workspace.', {}, 401);
    const at = Date.now();
    this.web.markReauthenticated(s.id, at);
    this.web.store.appendAudit(s.actor.tenantId, randomUUID(), {event: 'account_reauthenticated', method});
    return {reauthenticated: true, until: at + recentProofMs};
  }
  verifyCode(userId: string, code: unknown) {
    if (typeof code !== 'string' || code.length > 80)
      throw new MirrorError('MFA_INVALID', 'Enter a valid authenticator or recovery code.', {}, 401);
    const row = this.db.prepare('SELECT * FROM amcp_mfa WHERE user_id=?').get(userId) as JsonObject | undefined;
    if (!row) throw new MirrorError('MFA_REQUIRED', 'Two-step verification is not configured.', {}, 401);
    const now = Math.floor(Date.now() / 30000),
      secret = this.web.openAccount('mfa:' + userId, row.secret).secret;
    const match = [now - 1, now, now + 1].find(step => step > row.last_step && equal(totp(secret, step), code));
    if (match !== undefined) {
      this.db.prepare('UPDATE amcp_mfa SET last_step=? WHERE user_id=?').run(match, userId);
      return;
    }
    const recovery: string[] = JSON.parse(row.recovery),
      hash = sha256('mfa-recovery:' + userId + ':' + code.trim().toLowerCase()),
      index = recovery.findIndex(x => equal(x, hash));
    if (index >= 0) {
      recovery.splice(index, 1);
      this.db.prepare('UPDATE amcp_mfa SET recovery=? WHERE user_id=?').run(JSON.stringify(recovery), userId);
      this.accounts.securityNotice(
        this.accounts.user(userId),
        'A recovery code of your AMCP account was used; ' + recovery.length + ' remain',
      );
      return;
    }
    throw new MirrorError('MFA_INVALID', 'The code is invalid or was already used.', {}, 401);
  }
  enableMfa(req: Request, input: JsonObject) {
    const s = this.web.requireMutation(req),
      u = this.accounts.user(s.actor.userId);
    this.accounts.limit(req, 'mfa', u.id, 10);
    this.accounts.fresh(s);
    return this.web.store.transaction(() => {
      const pending = this.accounts.readChallenge(input.ticket, 'mfa_setup');
      if (pending.userId !== u.id || pending.version !== u.version || pending.sessionHash !== sha256(s.id))
        throw new MirrorError('MFA_INVALID', 'Start setup again.', {}, 401);
      const now = Math.floor(Date.now() / 30000),
        step = [now - 1, now, now + 1].find(n => equal(totp(pending.secret, n), String(input.code)));
      if (step === undefined) throw new MirrorError('MFA_INVALID', 'The authenticator code is incorrect.', {}, 401);
      if (this.accounts.hasMfa(u.id))
        throw new MirrorError('MFA_ALREADY_ENABLED', 'Two-step verification is already enabled.');
      this.accounts.readChallenge(input.ticket, 'mfa_setup', true);
      const codes = Array.from({length: 10}, () => randomBytes(10).toString('hex'));
      this.db
        .prepare('INSERT INTO amcp_mfa VALUES(?,?,?,?,?)')
        .run(
          u.id,
          this.web.sealAccount('mfa:' + u.id, {secret: pending.secret}),
          JSON.stringify(codes.map(c => sha256('mfa-recovery:' + u.id + ':' + c))),
          step,
          Date.now(),
        );
      this.db.prepare('UPDATE amcp_users SET version=version+1 WHERE id=?').run(u.id);
      const ended = this.accounts.revokeAccess(u, 'mfa_change');
      this.accounts.securityNotice(
        u,
        'Two-step verification was turned on for your AMCP account' + this.accounts.revokedSummary(ended),
      );
      const session = this.accounts.session(this.accounts.user(u.id), s.actor.tenantId, true);
      return {session, recoveryCodes: codes};
    });
  }
  finishMfa(req: Request, input: JsonObject) {
    // The per-address limit alone let a caller with many addresses keep guessing one person's codes; the ticket names
    // the person, so the attempts also count against them (5 per 15 minutes) and a success clears only their count.
    this.accounts.limit(req, 'mfa-login', '', 10);
    const pending = this.accounts.readChallenge(input.ticket, 'mfa_login');
    this.accounts.limit(req, 'mfa-login-user', String(pending.userId), 5);
    return this.web.store.transaction(() => {
      const data = this.accounts.readChallenge(input.ticket, 'mfa_login'),
        u = this.accounts.user(data.userId);
      if (u.version !== data.version) throw new MirrorError('LINK_EXPIRED', 'Sign in again.');
      this.verifyCode(u.id, input.code);
      this.accounts.readChallenge(input.ticket, 'mfa_login', true);
      this.accounts.forgive('mfa-login-user', u.id);
      return this.accounts.session(u, undefined, true);
    });
  }
  disableMfa(req: Request, input: JsonObject) {
    const s = this.web.requireMutation(req),
      u = this.accounts.user(s.actor.userId);
    this.accounts.fresh(s);
    this.accounts.limit(req, 'mfa', u.id, 10);
    return this.web.store.transaction(() => {
      this.verifyCode(u.id, input.code);
      this.db.prepare('DELETE FROM amcp_mfa WHERE user_id=?').run(u.id);
      this.db.prepare('UPDATE amcp_users SET version=version+1 WHERE id=?').run(u.id);
      const ended = this.accounts.revokeAccess(u, 'mfa_change');
      this.accounts.securityNotice(
        u,
        'Two-step verification was turned off for your AMCP account' + this.accounts.revokedSummary(ended),
      );
      return this.accounts.session(this.accounts.user(u.id), s.actor.tenantId);
    });
  }
  workspaces(req: Request) {
    const s = this.web.requireSession(req);
    const rows: JsonObject[] =
      s.actor.userId === 'workspace-admin'
        ? [{id: s.actor.tenantId, role: 'owner', name: 'AMCP workspace'}]
        : (this.db
            .prepare(
              'SELECT m.tenant_id AS id,m.role,t.name FROM workspace_memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND m.active=1',
            )
            .all(s.actor.userId) as JsonObject[]);
    return {
      workspaces: rows.map(r => {
        let name = r.name;
        try {
          name = this.web.store.document(r.id, 'account_settings', 'workspace').name;
        } catch {}
        return {...r, id: r.id, name, current: r.id === s.actor.tenantId};
      }),
    };
  }
  switchWorkspace(req: Request, input: JsonObject) {
    const s = this.web.requireMutation(req),
      u = this.accounts.user(s.actor.userId);
    if (typeof input.workspaceId !== 'string') throw new MirrorError('INVALID_ARGUMENT', 'Choose a workspace.');
    const next = this.accounts.session(
      u,
      input.workspaceId,
      true,
      Number(s.actor.signedInAt ?? s.expiresAt - 8 * 3600000),
    );
    this.web.signOut(s.id);
    return next;
  }
  members(req: Request) {
    const s = this.web.requireSession(req);
    if (s.actor.role !== 'admin') throw new MirrorError('FORBIDDEN', 'A workspace administrator is required.', {}, 403);
    const now = Date.now();
    return {
      members: (
        this.db
          .prepare(
            'SELECT u.id,u.name,u.email,m.role,EXISTS(SELECT 1 FROM amcp_mfa f WHERE f.user_id=u.id) AS mfa FROM workspace_memberships m JOIN amcp_users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.active=1',
          )
          .all(s.actor.tenantId) as JsonObject[]
      ).map(m => ({...m, mfa: !!m.mfa})),
      // Pending invitations that have not expired, newest first; the email and its link stay private (SEC-06 S4).
      invitations: this.web.store
        .documents(s.actor.tenantId, 'workspace_invite')
        .filter(v => v.state === 'pending' && v.expires_at > now)
        .sort((a, b) => b.created_at - a.created_at)
        .map(({emailHash: _email, challengeHash: _link, ...v}) => v),
      security: securitySettings(this.web.store, s.actor.tenantId),
      baseline: this.web.mfaBaseline
        ? {require_mfa: this.web.mfaBaseline.scope, grace_days: this.web.mfaBaseline.graceMs / 86400000}
        : {require_mfa: 'off'},
    };
  }
  /**
   * The owner's workspace security settings (SEC-06 S3/S4): whether two-step verification is required of
   * administrators or of everyone, the grace period before it is enforced, and how long invitations last. A change
   * needs a recent sign-in; requiring two-step verification needs the owner's own account to use it.
   */
  saveSecurityPolicy(req: Request, input: JsonObject) {
    const s = this.owner(req);
    const scope = input.require_mfa,
      graceDays = input.grace_days ?? 7,
      hours = input.invitation_hours ?? defaultInvitationHours;
    if (!mfaScopes.includes(scope))
      throw new MirrorError('INVALID_ARGUMENT', 'Choose off, administrators or everyone for two-step verification.');
    if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 30)
      throw new MirrorError('INVALID_ARGUMENT', 'Choose a grace period of 0 to 30 days.');
    if (!Number.isInteger(hours) || hours < 1 || hours > 168)
      throw new MirrorError('INVALID_ARGUMENT', 'Choose an invitation lifetime of 1 to 168 hours.');
    this.accounts.fresh(s);
    if (s.actor.userId !== 'workspace-admin')
      assertPolicyOwnerEnrolled(this.accounts.hasMfa(s.actor.userId), scope as MfaScope);
    else if (scope !== 'off')
      // The administrator door has no second factor; the workspace moves to an owner account first.
      throw new MirrorError(
        'MFA_ENROLLMENT_REQUIRED',
        'Turn on two-step verification for your own account before requiring it of others.',
        {},
        403,
      );
    const previous = securitySettings(this.web.store, s.actor.tenantId),
      now = Date.now(),
      // Tightening starts a new grace period; keeping the same scope keeps the deadline members were told.
      graceUntil =
        scope === 'off'
          ? null
          : previous.require_mfa === scope && previous.grace_until !== null
            ? previous.grace_until
            : now + graceDays * 86400000;
    return this.web.store.transaction(() => {
      this.web.store.putDocument(s.actor.tenantId, 'account_settings', 'security', {
        require_mfa: scope,
        grace_until: graceUntil,
        invitation_hours: hours,
        updated_at: now,
        updated_by: s.actor.userId,
      });
      this.web.store.appendAudit(s.actor.tenantId, randomUUID(), {
        event: 'workspace_security_policy_saved',
        require_mfa: scope,
        grace_until: graceUntil,
        invitation_hours: hours,
        previous_require_mfa: previous.require_mfa,
      });
      return securitySettings(this.web.store, s.actor.tenantId);
    });
  }
  /** Replaces the ten recovery codes after a recent sign-in and a current code (SEC-06 S3); the old ones stop working. */
  regenerateRecoveryCodes(req: Request, input: JsonObject) {
    const s = this.web.requireMutation(req),
      u = this.accounts.user(s.actor.userId);
    this.accounts.fresh(s);
    this.accounts.limit(req, 'mfa', u.id, 10);
    return this.web.store.transaction(() => {
      this.verifyCode(u.id, input.code);
      const codes = Array.from({length: 10}, () => randomBytes(10).toString('hex'));
      this.db
        .prepare('UPDATE amcp_mfa SET recovery=? WHERE user_id=?')
        .run(JSON.stringify(codes.map(c => sha256('mfa-recovery:' + u.id + ':' + c))), u.id);
      this.accounts.forgive('mfa', u.id);
      this.accounts.securityNotice(
        u,
        'New recovery codes were created for your AMCP account; the previous recovery codes no longer work',
      );
      this.web.store.appendAudit(s.actor.tenantId, randomUUID(), {event: 'account_recovery_codes_regenerated'});
      return {recoveryCodes: codes};
    });
  }
  /**
   * The AMCP owner turns off a member's two-step verification after they lost their authenticator and recovery codes
   * (SEC-06 S3): after a recent sign-in, never for the owner's own account. Every session, connector token and AI-client
   * connection of the member ends, and they are emailed; they set it up again at their next sign-in.
   */
  resetMemberMfa(req: Request, input: JsonObject) {
    const s = this.instanceOwner(req),
      id = String(input.user_id ?? '');
    if (id === s.actor.userId)
      throw new MirrorError(
        'FORBIDDEN',
        'Use your own account settings to change your two-step verification.',
        {},
        403,
      );
    const user = this.db.prepare('SELECT * FROM amcp_users WHERE id=?').get(id) as JsonObject | undefined;
    if (!user) throw new MirrorError('NOT_FOUND', 'Account not found.', {}, 404);
    this.accounts.fresh(s);
    return this.web.store.transaction(() => {
      if (!this.db.prepare('DELETE FROM amcp_mfa WHERE user_id=?').run(id).changes)
        throw new MirrorError('MFA_NOT_ENABLED', 'This account does not use two-step verification.', {}, 409);
      this.db.prepare('UPDATE amcp_users SET version=version+1 WHERE id=?').run(id);
      const ended = this.accounts.revokeAccess(user, 'mfa_change');
      this.accounts.securityNotice(
        user,
        'The AMCP owner reset two-step verification on your account. Sign in and set it up again' +
          this.accounts.revokedSummary(ended),
      );
      this.web.store.appendAudit(this.web.tenantId, randomUUID(), {
        event: 'account_mfa_reset',
        user_id: id,
        by: s.actor.userId,
      });
      return {success: true, mfaEnabled: false};
    });
  }
  /** Withdraws a pending invitation (SEC-06 S4): its link stops working at once. Resending is a new invitation. */
  revokeInvitation(req: Request, id: string) {
    const s = this.web.requireAdminMutation(req);
    return this.web.store.transaction(() => {
      let invitation: JsonObject;
      try {
        invitation = this.web.store.document(s.actor.tenantId, 'workspace_invite', id);
      } catch {
        throw new MirrorError('NOT_FOUND', 'Invitation not found.', {}, 404);
      }
      if (invitation.state !== 'pending')
        throw new MirrorError('INVITATION_NOT_PENDING', 'This invitation was already accepted or withdrawn.', {}, 409);
      if (invitation.challengeHash)
        this.db
          .prepare("DELETE FROM amcp_account_challenges WHERE hash=? AND kind='invite'")
          .run(invitation.challengeHash);
      const {id: _id, revision: _revision, ...data} = invitation;
      this.web.store.putDocument(s.actor.tenantId, 'workspace_invite', id, {
        ...data,
        state: 'revoked',
        revoked_at: Date.now(),
        revoked_by: s.actor.userId,
      });
      this.web.store.appendAudit(s.actor.tenantId, randomUUID(), {
        event: 'workspace_invitation_revoked',
        invitation_id: id,
        role: invitation.role,
      });
      return {success: true};
    });
  }
  async invite(req: Request, input: JsonObject) {
    const s = this.web.requireAdminMutation(req),
      role = input.role ?? 'viewer';
    if (
      !['admin', 'operator', 'viewer'].includes(role) ||
      (role === 'admin' && s.actor.userId !== 'workspace-admin' && s.actor.membershipRole !== 'owner')
    )
      throw new MirrorError('FORBIDDEN', 'Only owners can invite administrators.', {}, 403);
    // An invitation grants workspace access, so it needs recent proof of identity (SEC-06).
    this.accounts.fresh(s);
    const email = accountEmail(input.email);
    this.accounts.limit(req, 'invite', s.actor.tenantId, 20);
    const members = this.db
      .prepare('SELECT count(*) AS n FROM workspace_memberships WHERE tenant_id=? AND active=1')
      .get(s.actor.tenantId) as JsonObject;
    if (members.n >= 100) throw new MirrorError('WORKSPACE_QUOTA', 'This workspace has reached its 100-member limit.');
    // The owner sets how long invitations last: 72 hours by default, 1 hour to 7 days (SEC-06 S4).
    const lifetime = Number(securitySettings(this.web.store, s.actor.tenantId).invitation_hours) * 3600000,
      id = randomUUID(),
      createdAt = Date.now(),
      token = this.accounts.challenge(
        'invite',
        {tenantId: s.actor.tenantId, email, role, id, inviter: s.actor.userId},
        lifetime,
      );
    this.web.store.putDocument(s.actor.tenantId, 'workspace_invite', id, {
      emailHash: sha256(email),
      // The link's hash, so withdrawing the invitation deletes the link itself; never shown.
      challengeHash: sha256(token),
      role,
      state: 'pending',
      created_at: createdAt,
      expires_at: createdAt + lifetime,
    });
    await this.accounts.sendEmail(email, 'invite', token);
    return {message: 'A private invitation link is on its way.', id, expires_at: createdAt + lifetime};
  }
  async accept(req: Request, input: JsonObject) {
    const data = this.accounts.readChallenge(input.token, 'invite'),
      existing = this.db.prepare('SELECT id FROM amcp_users WHERE email=?').get(data.email) as JsonObject | undefined,
      s = this.web.session(req);
    let hash: string | undefined;
    if (existing) {
      if (s?.actor.userId !== existing.id)
        throw new MirrorError(
          'SIGN_IN_REQUIRED',
          'Sign in to the invited email account, then reopen this invitation.',
          {},
          401,
        );
      this.web.requireMutation(req);
    } else hash = await hashUserPassword(input.password, {email: data.email, name: input.name});
    return this.web.store.transaction(() => {
      const invitation = this.web.store.document(data.tenantId, 'workspace_invite', data.id);
      if (invitation.state === 'revoked')
        throw new MirrorError(
          'INVITATION_REVOKED',
          'This invitation was withdrawn. Ask the workspace administrator for a new one.',
        );
      if (invitation.state !== 'pending' || invitation.expires_at < Date.now())
        throw new MirrorError('LINK_EXPIRED', 'Ask the workspace administrator for a fresh invitation.');
      if (data.inviter && data.inviter !== 'workspace-admin') {
        const inviter = this.db
          .prepare('SELECT role FROM workspace_memberships WHERE tenant_id=? AND user_id=? AND active=1')
          .get(data.tenantId, data.inviter) as JsonObject | undefined;
        if (
          !inviter ||
          !['owner', 'admin'].includes(inviter.role) ||
          (data.role === 'admin' && inviter.role !== 'owner')
        )
          throw new MirrorError(
            'INVITATION_REVOKED',
            'The inviter no longer has permission. Ask the owner for a fresh invitation.',
          );
      }
      const count = this.db
        .prepare('SELECT count(*) AS n FROM workspace_memberships WHERE tenant_id=? AND active=1')
        .get(data.tenantId) as JsonObject;
      if (count.n >= 100) throw new MirrorError('WORKSPACE_QUOTA', 'The workspace member limit has been reached.');
      this.accounts.readChallenge(input.token, 'invite', true);
      // An account created through an invitation is approved only when the instance owner invited it, or sign-ups are
      // approved automatically: a member of another workspace cannot grant access to this instance by inviting someone
      // (owner decision, review 2026-09-28, F-15). The membership exists either way and applies once access is granted.
      const byInstanceOwner =
        data.inviter === 'workspace-admin' ||
        (data.tenantId === this.web.tenantId &&
          !!this.db
            .prepare(
              "SELECT 1 FROM workspace_memberships WHERE tenant_id=? AND user_id=? AND role='owner' AND active=1",
            )
            .get(data.tenantId, data.inviter));
      const u = existing
        ? this.accounts.user(existing.id)
        : this.accounts.newUser(
            accountName(input.name),
            data.email,
            hash!,
            byInstanceOwner || this.accounts.autoApprove,
          );
      const current = this.db
        .prepare('SELECT role FROM workspace_memberships WHERE tenant_id=? AND user_id=? AND active=1')
        .get(data.tenantId, u.id);
      if (!current)
        this.db
          .prepare(
            'INSERT INTO workspace_memberships(tenant_id,user_id,role,active,created_at) VALUES(?,?,?,1,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET active=1,role=excluded.role',
          )
          .run(data.tenantId, u.id, data.role, Date.now());
      this.web.store.putDocument(data.tenantId, 'workspace_invite', data.id, {
        ...invitation,
        state: 'accepted',
        accepted_at: Date.now(),
      });
      return u.approved
        ? {
            message: 'Invitation accepted. Sign in and choose the shared workspace from Account.',
            workspaceId: data.tenantId,
          }
        : {
            message:
              'Invitation accepted. Your account is waiting for the instance owner’s approval; you can sign in once access is granted.',
            workspaceId: data.tenantId,
            pending: true,
          };
    });
  }
  changeMember(req: Request, input: JsonObject) {
    const s = this.owner(req);
    if (typeof input.userId !== 'string' || !['admin', 'operator', 'viewer', 'remove'].includes(input.role))
      throw new MirrorError('INVALID_ARGUMENT', 'Choose a member and role.');
    // A role change needs recent proof of identity (SEC-06); removing a member does not, so access can end at once.
    if (input.role !== 'remove') this.accounts.fresh(s);
    return this.web.store.transaction(() => {
      const row = this.db
        .prepare('SELECT role FROM workspace_memberships WHERE tenant_id=? AND user_id=? AND active=1')
        .get(s.actor.tenantId, input.userId) as JsonObject | undefined;
      if (!row) throw new MirrorError('NOT_FOUND', 'Member not found.', {}, 404);
      if (row.role === 'owner')
        throw new MirrorError('OWNER_REQUIRED', 'The workspace owner cannot be removed or demoted.');
      this.db
        .prepare('UPDATE workspace_memberships SET active=?,role=? WHERE tenant_id=? AND user_id=?')
        .run(
          input.role === 'remove' ? 0 : 1,
          input.role === 'remove' ? row.role : input.role,
          s.actor.tenantId,
          input.userId,
        );
      this.db
        .prepare(
          "DELETE FROM amcp_web_sessions WHERE json_extract(actor,'$.userId')=? AND json_extract(actor,'$.tenantId')=?",
        )
        .run(input.userId, s.actor.tenantId);
      this.db
        .prepare(
          'UPDATE api_keys SET revoked=1 WHERE tenant_id=? AND hash IN (SELECT hash FROM credential_owners WHERE user_id=?)',
        )
        .run(s.actor.tenantId, input.userId);
      endMcpGrants(
        this.web.store,
        "tenant_id=? AND json_extract(data,'$.ownerUserId')=?",
        [s.actor.tenantId, input.userId],
        'membership_change',
      );
      this.web.store.appendAudit(s.actor.tenantId, randomUUID(), {
        event: 'workspace_member_changed',
        user_id: input.userId,
        role: input.role,
      });
      return {success: true};
    });
  }
}
