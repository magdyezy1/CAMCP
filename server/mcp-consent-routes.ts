import express from 'express';
import {randomUUID} from 'node:crypto';
import {MirrorError} from '../src/errors.js';
import {ownerChoice} from './mcp-oauth.js';
import {grantOwner, handler, type WebsiteSite} from './website-site.js';

/** AI-client consent and authorizations (MCP-08): the consent decision, and who may end which client's access. */
export function mcpConsentRoutes({router, store, web, mcpOAuth, accounts}: WebsiteSite) {
  router.get(
    '/api/mcp/consent',
    handler((req, res) => {
      const s = web.requireSession(req);
      if (typeof req.query.request !== 'string')
        throw new MirrorError('INVALID_CONSENT', 'Start authorization from your MCP client.');
      const consent = mcpOAuth.consent(req.query.request, s),
        profile = accounts.profile(s);
      res.json({
        ...consent,
        // The workspace the grant binds, named above the decision (MCP-08).
        workspace: {id: profile.workspaceId, name: profile.workspaceName},
        memberRole: profile.workspaceRole ?? null,
      });
    }),
  );
  router.post(
    '/api/mcp/consent',
    express.json({limit: '4kb'}),
    handler((req, res) => {
      const s = web.requireMutation(req);
      if (
        typeof req.body?.request !== 'string' ||
        typeof req.body?.approved !== 'boolean' ||
        (req.body.scope !== undefined && typeof req.body.scope !== 'string') ||
        (req.body.access_set_id !== undefined &&
          req.body.access_set_id !== null &&
          typeof req.body.access_set_id !== 'string')
      )
        throw new MirrorError('INVALID_CONSENT', 'Invalid authorization decision.');
      // An approval issues a 30-day refresh family, so it needs recent proof of identity (SEC-06); a denial does not.
      if (req.body.approved) accounts.fresh(s);
      const consent = mcpOAuth.consent(req.body.request, s),
        url = mcpOAuth.decide(req.body.request, s, req.body.approved, req.body.scope, req.body.access_set_id),
        // The client access set the approval limited the AI client to (SEC-08), as decide chose it.
        accessSetId = req.body.approved ? (s.actor.accessSetId ?? (req.body.access_set_id || undefined)) : undefined,
        // r25-admin-email item 7: owner-level access is a choice, not a scope: the grant's scopes stay read and write.
        ownerLevel = req.body.approved === true && req.body.scope === ownerChoice,
        scope: string = ownerLevel
          ? 'mcp:read mcp:write'
          : req.body.approved
            ? (req.body.scope ?? consent.scope)
            : consent.scope,
        owner = grantOwner(s);
      // Approvals and denials name the client, so they join the later mcp_oauth_family_revoked rows (MCP-08).
      store.appendAudit(s.actor.tenantId, randomUUID(), {
        event: req.body.approved ? 'mcp_oauth_approved' : 'mcp_oauth_denied',
        client_id: consent.clientId,
        client_name: String(consent.name ?? '').slice(0, 120),
        redirect_host: consent.redirectHost,
        requested_scope: consent.requestedScope,
        scope,
        role: ownerLevel ? 'owner' : scope.split(' ').includes('mcp:write') ? 'operator' : 'reader',
        ...(owner ? {owner_user_id: owner} : {}),
        ...(accessSetId ? {access_set_id: accessSetId} : {}),
      });
      // Creating an owner-level credential is its own audit event, with the person and the client (item 7).
      if (ownerLevel)
        store.appendAudit(s.actor.tenantId, randomUUID(), {
          event: 'ai_client_owner_access_granted',
          client_id: consent.clientId,
          client_name: String(consent.name ?? '').slice(0, 120),
          redirect_host: consent.redirectHost,
          ...(owner ? {owner_user_id: owner} : {}),
        });
      res.json({url});
    }),
  );
  router.get(
    '/api/mcp/authorizations',
    handler((req, res) => {
      const s = web.requireSession(req),
        // Administrators see who approved each connection, so they can end one person's (MCP-08 with CIMD).
        owners = s.actor.role === 'admin';
      res.json({
        clients: mcpOAuth.authorizations(s.actor.tenantId, grantOwner(s), {owners}),
        ended: mcpOAuth.endedAuthorizations(s.actor.tenantId, {owners}),
      });
    }),
  );
  router.delete(
    '/api/mcp/authorizations/:id',
    handler((req, res) => {
      const s = web.requireMutation(req),
        id = String(req.params.id),
        administrator = s.actor.role === 'admin',
        // ?owner=<user ID> (or empty for the administrator sign-in) ends one person's connection of this client.
        requested = typeof req.query.owner === 'string' ? req.query.owner || null : undefined,
        owner = administrator ? requested : s.actor.userId;
      // Administrators revoke any connection of the workspace; a member revokes the connections they authorized.
      const ended = mcpOAuth.revokeClient(id, s.actor.tenantId, owner);
      if (!administrator && !ended)
        throw new MirrorError(
          'FORBIDDEN',
          'You can revoke only the AI clients you authorized. Ask a workspace administrator to revoke this one.',
          {},
          403,
        );
      store.appendAudit(s.actor.tenantId, randomUUID(), {
        event: 'mcp_oauth_revoked',
        client_id: id,
        reason: 'workspace_revoke',
        grants: ended,
        ...(owner !== undefined ? {owner_user_id: owner} : {}),
        ...(grantOwner(s) ? {by_user_id: grantOwner(s)} : {}),
      });
      res.json({success: true});
    }),
  );
}
