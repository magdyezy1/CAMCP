import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import {MirrorError} from './errors.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
/**
 * Reddit's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: reports, plus
 * the PRV-07 planning and history reads (src/reddit-extensions.ts), are POST reads.
 */
export const redditHooks: ProviderHooks = Object.freeze({
  gateway: 'reddit_native_action',
  reads: Object.freeze({
    postRead: (_plan: CompiledRequest, pathname: string) =>
      /^\/api\/v3\/ad_accounts\/[^/]+\/(?:reports|history|forecasting\/audience_and_delivery_estimates)$/.test(
        pathname,
      ) || ['/api/v3/forecasting/bid_suggestions', '/api/v3/targeting/keyword_suggestions'].includes(pathname),
  }),
  paging: Object.freeze({
    nextPage(plan: CompiledRequest, response: unknown, next: CompiledRequest) {
      const d = obj(response);
      const link = d.pagination?.next_url;
      if (!link) return null;
      let url: URL;
      try {
        url = new URL(link);
      } catch {
        throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Reddit pagination must supply a valid absolute URL.');
      }
      if (
        url.origin !== 'https://ads-api.reddit.com' ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== plan.path
      )
        throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Reddit pagination changed upstream scope.');
      const keys = new Set<string>();
      for (const [key, value] of url.searchParams) {
        if (keys.has(key))
          throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Reddit pagination contains duplicate parameters.');
        keys.add(key);
        if (key === 'page.token') {
          next.query[key] = value;
          continue;
        }
        if (plan.query[key] === undefined || String(plan.query[key]) !== value)
          throw new MirrorError(
            'UNSAFE_PAGINATION_LINK',
            'Reddit pagination changed account scope, page size or report filters.',
            {parameter: key},
          );
      }
      if (!keys.has('page.token'))
        throw new MirrorError('UNKNOWN_PAGINATION', 'Reddit supplied a next URL without a page token.');
      return next;
    },
  }),
  accountRead: Object.freeze({
    plan(read: CompiledRequest, id: string) {
      read.path = '/api/v3/ad_accounts/' + id;
      return read;
    },
  }),
  wire: Object.freeze({
    // Reddit requires a descriptive application User-Agent on every request.
    connectionHeaders(headers: Record<string, string>, connection: Connection) {
      if (!connection.userAgent || /[\r\n]/.test(connection.userAgent))
        throw new MirrorError(
          'USER_AGENT_REQUIRED',
          'Configure a descriptive Reddit application userAgent on the connection.',
        );
      headers['User-Agent'] = connection.userAgent;
    },
  }),
});
