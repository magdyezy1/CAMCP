import {auditHistoryPage} from '../src/audit-history.js';
import type {JsonObject} from '../src/types.js';
import {handler, type WebsiteSite} from './website-site.js';

/** Audit activity: a bounded page of the workspace's safe audit metadata within current access (SEC-08). */
export function activityRoutes({router, store, web}: WebsiteSite) {
  router.get(
    '/api/activity',
    handler((req, res) => {
      const s = web.requireSession(req);
      const page = auditHistoryPage(store, s.actor, {
        limit: req.query.limit === undefined ? 100 : Number(req.query.limit),
        ...(req.query.cursor !== undefined ? {cursor: req.query.cursor} : {}),
        ...Object.fromEntries(
          // profile_id: the working client (SEC-08), a view filter within current access.
          ['search', 'gateway', 'account_id', 'connection_id', 'profile_id']
            .filter(k => req.query[k] !== undefined)
            .map(k => [k, req.query[k]]),
        ),
      });
      res.json({
        ...page,
        events: page.events.map(({id, at, diagnostics, ...event}: JsonObject) => ({id, at, event, diagnostics})),
      });
    }),
  );
}
