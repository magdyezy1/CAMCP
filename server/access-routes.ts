import express from 'express';
import {randomUUID} from 'node:crypto';
import {accessSetView, choosableAccessSet, deleteAccessSet, listAccessSets, saveAccessSet} from '../src/access-sets.js';
import {MirrorError} from '../src/errors.js';
import {sha256} from '../src/security.js';
import type {JsonObject} from '../src/types.js';
import {revokeGrantKey} from './mcp-grant-repository.js';
import {accessSetUse} from './website-repository.js';
import {grantOwner, handler, type WebsiteSite} from './website-site.js';

/**
 * Who and what may reach the workspace beyond a session: connector tokens (30-day bearer credentials, capped by the
 * creator's role, owner decision D16), client access sets (SEC-08 phase 2) and the working clients a person may choose
 * (SEC-08 phase 1).
 */
export function accessRoutes({router, store, web, accounts, allowWrites, connections: views}: WebsiteSite) {
  const {workingClientChoices} = views;
  router.get(
    '/api/connector-tokens',
    handler((req, res) => {
      const s = web.requireSession(req),
        owner = grantOwner(s) ?? 'workspace-admin';
      res.json({
        tokens: store
          .documents(s.actor.tenantId, 'website_mcp_token')
          .map(({hash, ...v}) => ({...v, yours: (v.created_by ?? 'workspace-admin') === owner})),
        url: web.origin + '/mcp',
      });
    }),
  );
  router.post(
    '/api/connector-tokens',
    express.json({limit: '4kb'}),
    handler((req, res) => {
      const s = web.requireMutation(req),
        name = String(req.body?.name ?? 'MCP connector').trim();
      if (!name || name.length > 80)
        throw new MirrorError('INVALID_ARGUMENT', 'Use a connector name of 1 to 80 characters.');
      // Any active member may create a token for their own AI tools, capped by their role (owner decision D16):
      // viewers read only; operators, administrators and owners may also create reviewed-write tokens.
      const viewer = s.actor.role === 'reader',
        role = req.body?.role ?? (allowWrites && !viewer ? 'operator' : 'reader');
      if (role !== 'reader' && role !== 'operator')
        throw new MirrorError('INVALID_ROLE', 'Choose reader or operator access.');
      if (role === 'operator' && viewer)
        throw new MirrorError('FORBIDDEN', 'Viewers can create read-only connector tokens only.', {}, 403);
      if (role === 'operator' && !allowWrites)
        throw new MirrorError('WRITES_DISABLED', 'Advertising writes are disabled in this deployment.', {}, 403);
      if (role === 'operator' && req.body?.confirmed !== true)
        throw new MirrorError(
          'WRITE_ACCESS_CONFIRMATION_REQUIRED',
          'Explicitly confirm this connector’s operator access.',
          {},
          400,
        );
      // "Limit to client" (SEC-08): the token reaches only one client access set's accounts. A member limited to a set
      // always hands on that same limit.
      const accessSetId = choosableAccessSet(store, s.actor, req.body?.access_set_id);
      // A connector token is a 30-day bearer credential that outlives this session: recent proof first (SEC-06).
      accounts.fresh(s);
      const {accessSetId: _member, ...actor} = s.actor,
        id = randomUUID(),
        token = store.createKey(
          {
            ...actor,
            userId: 'connector/' + id,
            role,
            ...(s.actor.userId === 'workspace-test' ? {ownerUserId: 'workspace-test'} : {}),
            ...(accessSetId !== undefined ? {accessSetId} : {}),
          },
          30 * 86400000,
        ),
        expiresAt = Date.now() + 30 * 86400000;
      store.putDocument(s.actor.tenantId, 'website_mcp_token', id, {
        name,
        role,
        hash: sha256(token),
        createdAt: Date.now(),
        expiresAt,
        revoked: false,
        created_by: grantOwner(s) ?? 'workspace-admin',
        access_set_id: accessSetId ?? null,
      });
      store.appendAudit(s.actor.tenantId, id, {
        event: 'website_mcp_token_created',
        name,
        role,
        ...(grantOwner(s) ? {owner_user_id: grantOwner(s)} : {}),
        ...(accessSetId !== undefined ? {access_set_id: accessSetId} : {}),
      });
      res.json({id, token, role, expiresAt, access_set_id: accessSetId ?? null});
    }),
  );
  router.delete(
    '/api/connector-tokens/:id',
    handler((req, res) => {
      const s = web.requireMutation(req),
        record = store.document(s.actor.tenantId, 'website_mcp_token', String(req.params.id));
      // Administrators revoke any token of the workspace; a member revokes the tokens they created.
      if (s.actor.role !== 'admin' && (record.created_by ?? 'workspace-admin') !== (grantOwner(s) ?? 'workspace-admin'))
        throw new MirrorError(
          'FORBIDDEN',
          'You can revoke only the connector tokens you created. Ask a workspace administrator to revoke this one.',
          {},
          403,
        );
      revokeGrantKey(store, s.actor.tenantId, record.hash);
      store.putDocument(s.actor.tenantId, 'website_mcp_token', record.id, {...record, revoked: true});
      store.appendAudit(s.actor.tenantId, randomUUID(), {event: 'website_mcp_token_revoked', token_id: record.id});
      res.json({success: true});
    }),
  );
  // Client access sets (SEC-08 phase 2): an administrator names the accounts of one client, and a connector token, an
  // AI client or a member can be limited to them. Administrators also see how much access each set limits.
  router.get(
    '/api/access-sets',
    handler((req, res) => {
      const s = web.requireSession(req),
        listed = listAccessSets(store, s.actor);
      if (s.actor.role === 'admin') {
        const now = Date.now(),
          inUse = accessSetUse(store);
        for (const set of listed.sets as JsonObject[]) set.in_use = inUse(s.actor.tenantId, set.id, now);
      }
      res.json(listed);
    }),
  );
  router.post(
    '/api/access-sets',
    express.json({limit: '64kb'}),
    handler((req, res) => {
      const s = web.requireAdminMutation(req);
      // A set decides what limited access reaches, so a change needs recent proof of identity (SEC-06).
      accounts.fresh(s);
      res.json(saveAccessSet(store, s.actor, req.body && typeof req.body === 'object' ? req.body : {}));
    }),
  );
  router.delete(
    '/api/access-sets/:id',
    express.json({limit: '4kb'}),
    handler((req, res) => {
      const s = web.requireAdminMutation(req);
      // Removing a set cuts off every member, token and AI client limited to it at once: an authority change of the same
      // weight as editing it, so it needs the same recent proof of identity (SEC-06).
      accounts.fresh(s);
      res.json(deleteAccessSet(store, s.actor, {...(req.body ?? {}), id: String(req.params.id)}));
    }),
  );
  // The working client (SEC-08 phase 1): client profiles with their accounts within this person's current access. It
  // is a view filter for pickers and lists, never a grant. The session lists them too; this reads them again after a
  // playbook changes.
  router.get(
    '/api/working-clients',
    handler((req, res) => {
      const s = web.requireSession(req);
      res.json({clients: workingClientChoices(s.actor), access_set: accessSetView(store, s.actor)});
    }),
  );
}
