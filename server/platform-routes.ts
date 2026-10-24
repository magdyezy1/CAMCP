import express, {type Request, type Response, type NextFunction} from 'express';
import {randomUUID} from 'node:crypto';
import {recordAuthorized} from '../src/connection-health.js';
import {MirrorError} from '../src/errors.js';
import {providerLifecycle} from '../src/provider-adapters.js';
import {providerRevocationOffer} from '../src/provider-revocation.js';
import type {Connection, JsonObject} from '../src/types.js';
import {wooCommerceSources} from '../src/woocommerce-source.js';
import {reauthorizeConnection} from './connection-reauthorization.js';
import {reauthorizeGoogleConnection} from './google-reauthorization.js';
import {platform, platforms} from './platform-oauth.js';
import {handler, type WebsiteSite} from './website-site.js';

/**
 * Platform logins: the platforms and their logins a person may see, an administrator starting a connection (browser
 * OAuth or a server-owned API connection), the provider's return with its session-bound state (CON-05: a refused
 * return gets the localized result page), and the progress of an authorization and its first sync.
 */
export function platformRoutes({
  router,
  store,
  web,
  options,
  allowWrites,
  oauth,
  discovery,
  connections: views,
}: WebsiteSite) {
  const {connection, readDocument, sameIdentity, actorConnections, visibleConnection, sync} = views;
  router.get(
    '/api/platforms',
    handler((req, res) => {
      const session = web.session(req),
        // The logins this person may reach (SEC-08): narrowed to a client access set when the person has one.
        connections = session ? actorConnections(session.actor) : [];
      res.json({
        platforms: oauth.publicConfig().map(p => ({
          ...p,
          // CON-05 sub-item 10: whether this session's disconnect dialog may offer revocation at the provider.
          ...(session
            ? {provider_revocation: providerRevocationOffer(p.gateway, options.authEnv ?? process.env, session.actor)}
            : {}),
          connections: connections.filter(c => c.gateway === p.gateway).map(c => visibleConnection(session!.actor, c)),
        })),
        authenticated: !!session,
        // Stored store connections stay listed while WooCommerce is parked, so an administrator can still remove one.
        commerce_sources: session ? wooCommerceSources(store, session.actor).items : [],
        // Parked providers this deployment does not offer (ARC-01, P9): Commerce hides their panels.
        providers_not_offered: providerLifecycle()
          .filter(p => !p.offered)
          .map(p => p.provider),
      });
    }),
  );
  router.post(
    '/api/auth/:platform/start',
    express.json({limit: '4kb'}),
    handler(async (req, res) => {
      const session = web.requireAdminMutation(req),
        id = String(req.params.platform),
        p = platform(id);
      if (!p.authType) {
        res.json(await oauth.start(session, id));
        return;
      }
      if (session.actor.tenantId !== web.tenantId)
        throw new MirrorError(
          'SERVICE_CONNECTION_RESTRICTED',
          'This server-owned API connection is available only in the deployment administrator workspace.',
          {},
          403,
        );
      const result = await oauth.connectService(id),
        connectionId = randomUUID(),
        attemptId = randomUUID(),
        tenant = session.actor.tenantId;
      // Browser sessions may be revoked while the token service is responding.
      web.requireAdminMutation(req);
      const c: Connection = {
        id: connectionId,
        tenantId: tenant,
        gateway: p.gateway,
        accounts: [],
        // What the provider's logins keep on their connection (Reddit's User-Agent: src/reddit-login.ts).
        ...oauth.connectionFields(p),
        defaultWriteAccess: allowWrites,
        label: result.label,
        enabled: false,
        scopes: result.scopes,
        isDefault: !store.listConnections(tenant).some(c => c.gateway === p.gateway && c.isDefault),
      };
      store.putConnection(session.actor, c, result.credentials);
      store.putDocument(tenant, 'website_connection', connectionId, {
        platform: id,
        expiresAt: result.credentials.expiresAt ?? null,
        createdAt: Date.now(),
      });
      recordAuthorized(store, connection(tenant, connectionId), result.credentials);
      store.appendAudit(tenant, attemptId, {
        event: 'website_api_connected',
        platform: id,
        connection_id: connectionId,
        vendor_writes: 0,
      });
      let error: string | null = null;
      try {
        error = (
          await sync(tenant, c, () => {
            web.requireAdminMutation(req);
          })
        ).error;
      } catch (e) {
        error =
          e instanceof MirrorError
            ? e.message
            : 'Asset sync could not be completed. Retry from the connection manager.';
      }
      store.putDocument(tenant, 'oauth_progress', attemptId, {
        platform: id,
        state: error ? 'sync_attention' : 'complete',
        authorization: true,
        exchange: true,
        sync: !error,
        connectionId,
        createdAt: Date.now(),
        message: error ?? 'Connection secured. Choose the assets AMCP can use.',
      });
      res.json({url: '/oauth/result?attempt=' + encodeURIComponent(attemptId), attemptId});
    }),
  );
  const callback = handler(async (req, res) => {
    const session = web.requireSession(req),
      id = String(req.params.platform),
      query: Record<string, string> = {};
    platform(id);
    const assertActive = () => {
      const current = web.requireSession(req);
      if (
        current.actor.role !== 'admin' ||
        current.actor.tenantId !== session.actor.tenantId ||
        current.actor.userId !== session.actor.userId
      )
        throw new MirrorError('FORBIDDEN', 'A current workspace administrator session is required.', {}, 403);
    };
    assertActive();
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v !== 'string' || v.length > 8192)
        throw new MirrorError('OAUTH_CALLBACK_INVALID', 'The provider returned invalid callback parameters.', {}, 400);
      query[k] = v;
    }
    if (!query.state)
      throw new MirrorError('OAUTH_STATE_INVALID', 'The callback is missing its security state.', {}, 400);
    const pending = web.consumeOAuth(session, id, query.state),
      attemptId = String(pending.attemptId),
      tenant = session.actor.tenantId,
      p = platform(id);
    const progress = (data: JsonObject) =>
      store.putDocument(tenant, 'oauth_progress', attemptId, {platform: id, createdAt: Date.now(), ...data});
    let securedConnectionId: string | undefined;
    try {
      progress({state: 'exchange', authorization: true, exchange: false, sync: false});
      const result = await oauth.exchange(id, pending, query, assertActive),
        connectionId = pending.reauthorization?.connectionId ?? randomUUID();
      // A completed token exchange must not restore access after the initiating session ended.
      assertActive();
      if (pending.reauthorization) {
        // The state names the platform it was started for; a callback on another platform's route cannot use it.
        if ((pending.reauthorization.platform ?? 'google') !== id)
          throw new MirrorError('OAUTH_STATE_INVALID', 'This reauthorization does not match this platform.', {}, 400);
        progress({state: 'sync', authorization: true, exchange: true, sync: false, connectionId});
        const renewalInput = {
          store,
          actor: session.actor,
          connectionId,
          revision: pending.reauthorization.revision ?? null,
          credentials: result.credentials,
          scopes: result.scopes,
          allowWrites: allowWrites && pending.requestedWriteAccess === true,
          assertActive,
        };
        if (id === 'google')
          await reauthorizeGoogleConnection({
            ...renewalInput,
            fetcher: options.fetcher,
            providerId: result.providerId,
            displayName: result.displayName,
          });
        else
          await reauthorizeConnection({
            ...renewalInput,
            platform: p,
            providerId: result.providerId,
            loginExpiresAt: result.loginExpiresAt ?? null,
            grants: result.grants,
            discovery,
          });
        securedConnectionId = connectionId;
        progress({
          state: 'complete',
          authorization: true,
          exchange: true,
          sync: true,
          connectionId,
          message:
            id === 'google'
              ? 'Google authorization renewed and account access verified. Your account selections, saved reports and schedules are preserved.'
              : 'Authorization renewed and account access verified. Your account selections, saved reports and schedules are preserved.',
        });
        res.redirect(303, '/oauth/result?attempt=' + encodeURIComponent(attemptId));
        return;
      }
      const c: Connection = {
        id: connectionId,
        tenantId: tenant,
        gateway: p.gateway,
        accounts: [],
        // What the provider's logins keep on their connection (Reddit's User-Agent: src/reddit-login.ts).
        ...oauth.connectionFields(p),
        defaultWriteAccess: p.reviewedWrites !== false && allowWrites && pending.requestedWriteAccess === true,
        label: result.label,
        enabled: false,
        scopes: result.scopes,
        isDefault: !store.listConnections(tenant).some(c => c.gateway === p.gateway && c.isDefault),
      };
      // The same provider user already has a login here (CON-05): the result page offers to renew that one instead.
      const duplicate = sameIdentity(tenant, p.gateway, result.providerId, connectionId);
      store.putConnection(session.actor, c, result.credentials);
      securedConnectionId = connectionId;
      store.putDocument(tenant, 'website_connection', connectionId, {
        platform: id,
        expiresAt: result.credentials.expiresAt ?? null,
        providerId: result.providerId ?? null,
        ...(result.displayName ? {displayName: result.displayName} : {}),
        ...(duplicate ? {duplicateOf: duplicate} : {}),
        ...(result.grants ? {grants: result.grants} : {}),
        createdAt: Date.now(),
      });
      recordAuthorized(store, connection(tenant, connectionId), result.credentials, result.loginExpiresAt ?? null);
      store.appendAudit(tenant, attemptId, {
        event: 'website_oauth_connected',
        platform: id,
        connection_id: connectionId,
        ...(duplicate ? {same_identity_as: duplicate} : {}),
      });
      progress({state: 'sync', authorization: true, exchange: true, sync: false, connectionId});
      const synced = await sync(tenant, c, assertActive),
        sameAs = readDocument(tenant, 'website_connection', connectionId, {}).duplicateOf;
      progress({
        state: synced.error ? 'sync_attention' : 'complete',
        authorization: true,
        exchange: true,
        sync: !synced.error,
        connectionId,
        ...(typeof sameAs === 'string' ? {duplicateOf: sameAs} : {}),
        message: synced.error ?? 'Connection secured. Choose the assets AMCP can use.',
      });
    } catch (e) {
      const diagnostics = e instanceof MirrorError && Array.isArray(e.details.diagnostics) ? e.details.diagnostics : [];
      progress({
        state: securedConnectionId ? 'sync_attention' : 'failed',
        authorization: !query.error && !query.denied,
        exchange: !!securedConnectionId,
        sync: false,
        connectionId: securedConnectionId ?? pending.reauthorization?.connectionId,
        message: e instanceof MirrorError ? e.message : 'The connection could not be completed. Start again from AMCP.',
        ...(diagnostics.length ? {diagnostics} : {}),
      });
      if (pending.reauthorization)
        store.appendAudit(tenant, attemptId, {
          event: 'website_oauth_reauthorization_failed',
          platform: id,
          connection_id: pending.reauthorization.connectionId,
          error: {
            code: e instanceof MirrorError ? e.code : 'REAUTHORIZATION_FAILED',
            message: e instanceof MirrorError ? e.message : 'Reauthorization failed.',
          },
          diagnostics,
          vendor_writes: 0,
        });
    }
    res.redirect(303, '/oauth/result?attempt=' + encodeURIComponent(attemptId));
  });
  // A browser that returns from the provider after its session ended, without administrator rights, with an expired or
  // reused state or with malformed parameters gets the localized result page instead of raw JSON (CON-05). Only these
  // fixed codes and a known platform ID reach the page; no provider parameter is echoed. Other callers keep the JSON
  // refusal.
  const callbackRefusals = new Set(['SIGN_IN_REQUIRED', 'FORBIDDEN', 'OAUTH_STATE_INVALID', 'OAUTH_CALLBACK_INVALID']);
  const callbackPage = (req: Request, res: Response, next: NextFunction) =>
    callback(req, res, (e?: unknown) => {
      if (
        !(e instanceof MirrorError) ||
        !callbackRefusals.has(e.code) ||
        !/\btext\/html\b/i.test(req.headers.accept ?? '') ||
        res.headersSent
      )
        return next(e);
      const id = String(req.params.platform),
        query = new URLSearchParams({error: e.code});
      if (platforms.some(p => p.id === id)) query.set('platform', id);
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(303, '/oauth/result?' + query);
    });
  router.get('/api/auth/:platform/callback', callbackPage);
  router.get('/api/:platform/callback', callbackPage);
  router.get(
    '/api/oauth/progress/:id',
    handler((req, res) => {
      const session = web.requireSession(req);
      res.json(store.document(session.actor.tenantId, 'oauth_progress', String(req.params.id)));
    }),
  );
}
