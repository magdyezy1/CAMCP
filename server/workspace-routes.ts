import express from 'express';
import {disconnectLocalConnection} from '../src/connection-disconnect.js';
import {mediaType} from '../src/drive-media.js';
import {MirrorError} from '../src/errors.js';
import {MediaUploadService} from '../src/media-upload.js';
import {sha256, stable} from '../src/security.js';
import {mediaSourceRoutes} from './media-source-routes.js';
import {workspaceSearch} from './workspace-search.js';
import {commerceGateway, handler, type WebsiteSite} from './website-site.js';

/**
 * The workspace's tools on the website, as the signed-in person: the AMCP tool proxy (the same MirrorService.call as
 * MCP), the workspace search, media sources, WooCommerce store setup and removal, and media variant previews. Only
 * where the MCP service runs.
 */
export function workspaceRoutes({router, store, web, options, service}: WebsiteSite) {
  if (!service) return;
  router.post(
    '/api/workspace/:tool',
    express.json({limit: '512kb'}),
    handler(async (req, res) => {
      const session = web.requireMutation(req),
        tools: Record<string, string> = {
          workspace: 'amcp_workspace',
          campaign: 'amcp_campaign',
          reporting: 'amcp_reporting',
          overview: 'amcp_reporting_overview',
          media: 'amcp_media',
          write: 'amcp_write',
          previews: 'amcp_ad_previews',
        };
      const tool = tools[String(req.params.tool)];
      if (!tool) throw new MirrorError('NOT_FOUND', 'Unknown workspace operation.', {}, 404);
      const actor = {
        ...session.actor,
        role: session.actor.testAccount && session.actor.role === 'admin' ? ('operator' as const) : session.actor.role,
      };
      store.bindActorCheck(actor, () => {
        web.requireMutation(req);
      });
      const result = await service.call(tool, req.body, actor);
      web.requireMutation(req);
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    }),
  );
  // WEB-09: the command palette's workspace search, as the signed-in person; local reads only, never a provider
  // request. A POST keeps the search text out of addresses. Reviewers search only their isolated workspace.
  // The session's client access set applies to every source (SEC-08), and profile_id, the working client, narrows it.
  router.post(
    '/api/workspace-search',
    express.json({limit: '1kb'}),
    handler(async (req, res) => {
      const session = web.requireMutation(req),
        actor = {
          ...session.actor,
          role:
            session.actor.testAccount && session.actor.role === 'admin' ? ('operator' as const) : session.actor.role,
        };
      store.bindActorCheck(actor, () => {
        web.requireMutation(req);
      });
      const result = await workspaceSearch(
        store,
        actor,
        req.body?.q,
        (tool, input) => service.call(tool, input, actor),
        req.body?.profile_id,
      );
      web.requireMutation(req);
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    }),
  );
  router.use(mediaSourceRoutes(web, store, () => service.mediaSources()));
  router.post(
    '/api/commerce/stores',
    express.json({limit: '4kb'}),
    handler(async (req, res) => {
      const session = web.requireAdminMutation(req),
        actor = {...session.actor},
        controller = new AbortController();
      const current = () => {
        const now = web.requireAdminMutation(req);
        if (now.id !== session.id || now.csrf !== session.csrf || stable(now.actor) !== stable(actor))
          throw new MirrorError(
            'CONNECTION_CHANGED',
            'Workspace access changed during setup. Refresh Commerce and sign in again.',
            {},
            403,
          );
      };
      store.bindActorCheck(actor, current);
      const closed = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', closed);
      try {
        current();
        const result = await service.connectWooCommerce(actor, req.body, controller.signal);
        current();
        res.status(result.replayed ? 200 : 201).json(result);
      } finally {
        res.off('close', closed);
      }
    }),
  );
  router.delete(
    '/api/commerce/stores/:id',
    express.json({limit: '1kb'}),
    handler((req, res) => {
      const session = web.requireAdminMutation(req),
        id = String(req.params.id);
      if (
        !/^[A-Za-z0-9_-]{1,160}$/.test(id) ||
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body) ||
        Object.keys(req.body).length !== 1 ||
        req.body.confirmed !== true
      )
        throw new MirrorError(
          'WOOCOMMERCE_DISCONNECT_CONFIRMATION_REQUIRED',
          'Confirm removal of this local WooCommerce connection. The store key and products are not changed.',
        );
      const receipt = disconnectLocalConnection(store, session.actor, commerceGateway, id, 'website');
      res.json(receipt);
    }),
  );
  router.get(
    '/api/media/variants/:id/preview',
    handler((req, res) => {
      const session = web.requireSession(req),
        media = new MediaUploadService(
          service.registry,
          store,
          service.transport,
          service.credentials,
          service.policy,
          options.fetcher,
        ),
        v = media.variant(session.actor, String(req.params.id)),
        bytes = store.stagedMedia(session.actor.tenantId, v.id);
      if (sha256(bytes) !== v.sha256 || mediaType(bytes).mime !== v.mime)
        throw new MirrorError('MEDIA_CHANGED', 'Preview integrity check failed.');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type(v.mime).send(bytes);
    }),
  );
}
