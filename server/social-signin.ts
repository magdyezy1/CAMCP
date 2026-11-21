import {randomBytes, createHmac, createHash, randomUUID} from 'node:crypto';
import {createLocalJWKSet, jwtVerify, SignJWT, importPKCS8, type JSONWebKeySet} from 'jose';
import type {Request} from 'express';
import {MirrorError} from '../src/errors.js';
import {sha256} from '../src/security.js';
import type {JsonObject} from '../src/types.js';
import {cookieValue, type WebSession} from './web-store.js';
import {UserAccounts, accountEmail, accountName} from './user-accounts.js';
import {providerById} from '../src/provider-adapters.js';
import {providerLogin} from '../src/provider-logins.js';
import {
  accountWithEmail,
  addIdentity,
  deleteSession,
  hasIdentity,
  identityOwner,
  liveSession,
  liveSessionActor,
  markSessionReauthenticated,
  personIdentity,
  sessionLive,
} from './web-session-repository.js';

const random = () => randomBytes(32).toString('base64url');
/**
 * Facebook Login is Meta's (ARC-01 phase B: its website login steps, src/meta-login.ts): the versioned login dialog,
 * the token endpoint and the signed-in user's Graph API profile.
 */
const facebook = providerLogin(providerById('meta')!.gateway)!.signIn!;
const definitions = {
  google: {
    name: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    scope: 'openid email profile',
  },
  apple: {
    name: 'Apple',
    authorize: 'https://appleid.apple.com/auth/authorize',
    token: 'https://appleid.apple.com/auth/token',
    jwks: 'https://appleid.apple.com/auth/keys',
    issuer: ['https://appleid.apple.com'],
    scope: 'name email',
  },
  facebook: {
    name: 'Facebook',
    authorize: facebook.authorize,
    token: facebook.token,
    jwks: '',
    issuer: [],
    scope: 'public_profile,email',
  },
} as const;
type Provider = keyof typeof definitions;
export class SocialSignIn {
  readonly web;
  readonly env;
  readonly fetcher;
  readonly flowCookie: string;
  constructor(readonly accounts: UserAccounts) {
    this.web = accounts.web;
    this.env = accounts.env;
    this.fetcher = accounts.fetcher;
    this.flowCookie = this.web.secure ? '__Host-amcp_login_flow' : 'amcp_local_login_flow';
  }
  provider(id: string): Provider {
    if (!Object.hasOwn(definitions, id))
      throw new MirrorError('SIGNIN_PROVIDER_UNKNOWN', 'Choose Google, Apple, or Facebook.');
    return id as Provider;
  }
  config(id: Provider) {
    const prefix = 'AMCP_SIGNIN_' + id.toUpperCase(),
      clientId = this.env[prefix + '_CLIENT_ID'],
      secret = this.env[prefix + '_CLIENT_SECRET'];
    return {
      clientId,
      secret,
      callback: this.web.origin + '/api/signin/' + id + '/callback',
      configured: !!(
        this.web.options.masterKey &&
        clientId &&
        (id === 'apple'
          ? this.web.secure &&
            (secret ||
              (this.env.AMCP_SIGNIN_APPLE_TEAM_ID &&
                this.env.AMCP_SIGNIN_APPLE_KEY_ID &&
                this.env.AMCP_SIGNIN_APPLE_PRIVATE_KEY))
          : secret)
      ),
    };
  }
  publicConfig() {
    return Object.entries(definitions).map(([id, p]) => {
      const c = this.config(id as Provider);
      return {id, name: p.name, configured: c.configured, callback: c.callback};
    });
  }
  cookie(value: string, maxAge = 600) {
    return (
      this.flowCookie +
      '=' +
      value +
      '; Path=/; HttpOnly; Max-Age=' +
      maxAge +
      '; SameSite=' +
      (this.web.secure ? 'None; Secure' : 'Lax')
    );
  }
  start(req: Request, id: string, input: JsonObject) {
    this.web.requireOrigin(req);
    this.accounts.limit(req, 'social-start', '', 20);
    const provider = this.provider(id),
      c = this.config(provider),
      p = definitions[provider];
    if (!c.configured)
      throw new MirrorError('SIGNIN_SETUP_REQUIRED', p.name + ' sign-in is not configured yet.', {}, 503);
    if (input.link !== undefined && typeof input.link !== 'boolean')
      throw new MirrorError('INVALID_ARGUMENT', 'link must be a boolean.');
    if (input.reauth !== undefined && typeof input.reauth !== 'boolean')
      throw new MirrorError('INVALID_ARGUMENT', 'reauth must be a boolean.');
    if (input.link && input.reauth)
      throw new MirrorError('INVALID_ARGUMENT', 'Choose linking or confirming, not both.');
    const bound = input.link === true || input.reauth === true,
      session = bound ? this.web.requireMutation(req) : this.web.session(req);
    if (input.reauth) {
      // A social step-up (SEC-06) confirms the person with a provider already linked to this account.
      const user = this.accounts.user(session!.actor.userId);
      if (!hasIdentity(this.web.store, user.id, provider))
        throw new MirrorError(
          'SIGNIN_METHOD_UNAVAILABLE',
          'This sign-in method is not linked to your account. Confirm with your password or a two-step code.',
          {},
          400,
        );
    } else if (input.link) {
      this.accounts.user(session!.actor.userId);
      this.accounts.fresh(session!);
    } else if (!this.accounts.signupEnabled) {
      /* Existing linked identities can still sign in. */
    }
    const browser = random(),
      nonce = random(),
      verifier = random(),
      state = this.accounts.challenge(
        'social',
        {
          provider,
          browserHash: sha256(browser),
          nonce,
          verifier,
          clientId: c.clientId,
          callback: c.callback,
          link: input.link === true,
          ...(input.reauth === true ? {reauth: true} : {}),
          sessionHash: session ? sha256(session.id) : null,
          userId: bound ? session!.actor.userId : null,
        },
        600000,
      );
    const url = new URL(p.authorize);
    for (const [k, v] of Object.entries({
      client_id: c.clientId!,
      redirect_uri: c.callback,
      response_type: 'code',
      scope: p.scope,
      state,
    }))
      url.searchParams.set(k, v);
    if (provider !== 'facebook') url.searchParams.set('nonce', nonce);
    if (provider === 'google') {
      url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('prompt', 'select_account');
    }
    if (provider === 'apple') url.searchParams.set('response_mode', 'form_post');
    return {url: url.href, cookie: this.cookie(browser)};
  }
  async json(url: string, init: RequestInit = {}): Promise<JsonObject> {
    try {
      const response = await this.fetcher(url, {...init, redirect: 'error', signal: AbortSignal.timeout(12000)});
      if (!response.ok) {
        await response.body?.cancel();
        throw Error('provider');
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error('empty');
      let size = 0;
      const buffers: Uint8Array[] = [];
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > 262144) {
          await reader.cancel();
          throw Error('size');
        }
        buffers.push(r.value);
      }
      const data = JSON.parse(Buffer.concat(buffers).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('shape');
      return data;
    } catch {
      throw new MirrorError(
        'SIGNIN_PROVIDER_FAILED',
        'The sign-in provider could not complete this request. Please try again.',
        {},
        502,
      );
    }
  }
  async appleSecret() {
    if (this.env.AMCP_SIGNIN_APPLE_CLIENT_SECRET) return this.env.AMCP_SIGNIN_APPLE_CLIENT_SECRET;
    try {
      const key = await importPKCS8(this.env.AMCP_SIGNIN_APPLE_PRIVATE_KEY!.replaceAll('\\n', '\n'), 'ES256');
      return await new SignJWT({})
        .setProtectedHeader({alg: 'ES256', kid: this.env.AMCP_SIGNIN_APPLE_KEY_ID!})
        .setIssuer(this.env.AMCP_SIGNIN_APPLE_TEAM_ID!)
        .setSubject(this.env.AMCP_SIGNIN_APPLE_CLIENT_ID!)
        .setAudience('https://appleid.apple.com')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(key);
    } catch {
      throw new MirrorError('SIGNIN_SETUP_REQUIRED', 'Apple sign-in credentials need attention.', {}, 503);
    }
  }
  async identity(provider: Provider, pending: JsonObject, code: string) {
    const p = definitions[provider],
      c = this.config(provider);
    if (!c.configured || c.clientId !== pending.clientId || c.callback !== pending.callback)
      throw new MirrorError('SIGNIN_SETUP_REQUIRED', 'Sign-in settings changed. Please start again.');
    const body = new URLSearchParams({
      client_id: c.clientId!,
      client_secret: provider === 'apple' ? await this.appleSecret() : c.secret!,
      code,
      redirect_uri: c.callback,
      grant_type: 'authorization_code',
    });
    if (provider === 'google') body.set('code_verifier', pending.verifier);
    const tokens = await this.json(p.token, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
      body,
    });
    if (provider === 'facebook') {
      if (typeof tokens.access_token !== 'string' || tokens.access_token.length > 8192)
        throw new MirrorError('SIGNIN_IDENTITY_INVALID', 'Facebook did not return a valid identity.');
      const proof = createHmac('sha256', c.secret!).update(tokens.access_token).digest('hex'),
        info = await this.json(facebook.profile + '?fields=id,name&appsecret_proof=' + proof, {
          headers: {Authorization: 'Bearer ' + tokens.access_token},
        });
      if (typeof info.id !== 'string' || !/^\d{1,100}$/.test(info.id))
        throw new MirrorError('SIGNIN_IDENTITY_INVALID', 'Facebook did not return a valid identity.');
      // Facebook email is not treated as a verified local recovery address.
      return {
        subject: info.id,
        name: typeof info.name === 'string' ? info.name.slice(0, 80) : 'AMCP member',
        email: null,
      };
    }
    if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 16384)
      throw new MirrorError('SIGNIN_IDENTITY_INVALID', 'The provider did not return a valid identity.');
    try {
      const jwks = await this.json(p.jwks),
        {payload} = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks as JSONWebKeySet), {
          issuer: [...p.issuer],
          audience: c.clientId,
          algorithms: ['RS256'],
          requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
          clockTolerance: 30,
          maxTokenAge: '10m',
        });
      if (
        payload.nonce !== pending.nonce ||
        typeof payload.sub !== 'string' ||
        payload.sub.length < 1 ||
        payload.sub.length > 255 ||
        (payload.azp !== undefined && payload.azp !== c.clientId) ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== c.clientId)
      )
        throw Error('claims');
      const verified = payload.email_verified === true || payload.email_verified === 'true',
        email = verified && typeof payload.email === 'string' ? accountEmail(payload.email) : null;
      return {
        subject: payload.sub,
        email,
        name:
          typeof payload.name === 'string'
            ? payload.name.slice(0, 80)
            : (email?.split('@')[0]?.slice(0, 80) ?? 'AMCP member'),
      };
    } catch (e) {
      if (e instanceof MirrorError) throw e;
      throw new MirrorError(
        'SIGNIN_IDENTITY_INVALID',
        'The provider identity could not be verified. Start sign-in again.',
        {},
        400,
      );
    }
  }
  async finish(
    req: Request,
    id: string,
    input: JsonObject,
  ): Promise<{session: WebSession; linked: boolean} | {mfaRequired: true; ticket: string} | {reauthenticated: true}> {
    this.accounts.limit(req, 'social-callback', '', 30);
    const provider = this.provider(id),
      browser = cookieValue(req, this.flowCookie);
    const pending = this.web.store.transaction(() => {
      const data = this.accounts.readChallenge(input.state, 'social');
      if (data.provider !== provider || !browser || data.browserHash !== sha256(browser))
        throw new MirrorError(
          'SIGNIN_STATE_INVALID',
          'Sign-in must finish in the browser where it started. Please try again.',
        );
      return this.accounts.readChallenge(input.state, 'social', true);
    });
    if (input.error) throw new MirrorError('SIGNIN_CANCELLED', 'Sign-in was cancelled. You can try again.');
    if (typeof input.code !== 'string' || input.code.length < 1 || input.code.length > 8192)
      throw new MirrorError('SIGNIN_IDENTITY_INVALID', 'The provider did not return an authorization code.');
    const identity = await this.identity(provider, pending, input.code),
      store = this.web.store;
    if (pending.reauth === true)
      // A social step-up (SEC-06): the provider identity must be the one linked to the person of the same, unchanged
      // session that started it. That session keeps its expiry; only its recent-proof time is renewed.
      return this.web.store.transaction(() => {
        const row = liveSessionActor(store, pending.sessionHash, Date.now()),
          actor = row ? JSON.parse(row.actor) : undefined,
          user = this.accounts.user(pending.userId),
          linked = identityOwner(store, provider, identity.subject);
        if (!actor || actor.userId !== user.id || actor.accountVersion !== user.version)
          throw new MirrorError('SIGN_IN_REQUIRED', 'The initiating session ended. Start sign-in again.', {}, 401);
        if (linked?.user_id !== user.id)
          throw new MirrorError(
            'SIGNIN_IDENTITY_MISMATCH',
            'That is not the sign-in linked to your AMCP account. Try again with the linked account.',
          );
        const at = Date.now();
        markSessionReauthenticated(store, pending.sessionHash, at);
        this.web.store.appendAudit(actor.tenantId, randomUUID(), {
          event: 'account_reauthenticated',
          method: provider,
        });
        return {reauthenticated: true as const};
      });
    const result = this.web.store.transaction(() => {
      let user: JsonObject, activeWorkspace: string | undefined;
      if (pending.sessionHash && !sessionLive(store, pending.sessionHash, Date.now()))
        throw new MirrorError('SIGN_IN_REQUIRED', 'The initiating session ended. Start sign-in again.', {}, 401);
      const existing = identityOwner(store, provider, identity.subject);
      if (pending.link) {
        const previous = liveSession(store, pending.sessionHash, Date.now());
        user = this.accounts.user(pending.userId);
        if (
          !previous ||
          JSON.parse(previous.actor).userId !== user.id ||
          JSON.parse(previous.actor).accountVersion !== user.version
        )
          throw new MirrorError('SIGN_IN_REQUIRED', 'Sign in again before linking an account.', {}, 401);
        activeWorkspace = JSON.parse(previous.actor).tenantId;
        if (existing && existing.user_id !== user.id)
          throw new MirrorError('IDENTITY_ALREADY_LINKED', 'That social account belongs to another AMCP account.');
        const sameProvider = personIdentity(store, user.id, provider);
        if (sameProvider && sameProvider.subject !== identity.subject)
          throw new MirrorError(
            'IDENTITY_ALREADY_LINKED',
            'Remove your existing ' + definitions[provider].name + ' connection before linking another.',
          );
      } else if (existing) user = this.accounts.user(existing.user_id);
      else {
        if (!this.accounts.signupEnabled)
          throw new MirrorError('SIGNUP_DISABLED', 'New account registration is currently closed.', {}, 403);
        if (identity.email && accountWithEmail(store, identity.email))
          throw new MirrorError(
            'ACCOUNT_EXISTS',
            'Sign in to your existing AMCP account, then link this provider from Account settings.',
          );
        user = this.accounts.newUser(accountName(identity.name), identity.email, null, this.accounts.autoApprove);
      }
      // r25-admin-email: a provider-verified address that is the configured one is approved and becomes a second owner,
      // before the gates that would stop a pending account; with two-step verification the role waits for the code.
      if (!pending.link && !this.accounts.hasMfa(user.id)) user = this.accounts.adminEmailAccess(user);
      if (pending.link) this.accounts.assertApproved(user);
      if (!existing) {
        addIdentity(store, provider, identity.subject, user.id, Date.now());
        if (pending.link)
          this.accounts.securityNotice(
            user,
            'A ' + definitions[provider].name + ' sign-in was added to your AMCP account',
          );
      }
      // Commit a new pending registration and its owner notice before returning the
      // access error. Throwing here would roll back the request the owner must approve.
      if (!user.approved) return {pendingUser: user};
      if (pending.sessionHash) deleteSession(store, pending.sessionHash);
      this.web.store.appendAudit(activeWorkspace ?? user.tenant_id, randomUUID(), {
        event: pending.link ? 'account_identity_linked' : 'account_sign_in',
        method: provider,
      });
      if (!pending.link && this.accounts.hasMfa(user.id))
        return {
          mfaRequired: true as const,
          ticket: this.accounts.challenge('mfa_login', {userId: user.id, version: user.version}, 300000),
        };
      return {session: this.accounts.session(user, activeWorkspace, pending.link), linked: pending.link};
    });
    if ('pendingUser' in result) {
      this.accounts.assertApproved(result.pendingUser!);
      throw new MirrorError('ACCOUNT_PENDING_APPROVAL', 'Your account is awaiting approval.', {}, 403);
    }
    return result;
  }
}
