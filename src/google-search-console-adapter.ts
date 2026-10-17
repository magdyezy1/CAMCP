import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Search Console's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: a site
 * or sitemap URL in the path is an identifier, and the search analytics query and URL inspection are POST reads.
 */
export const searchConsoleHooks: ProviderHooks = Object.freeze({
  gateway: 'google_search_console_native_action',
  reads: Object.freeze({
    // Search Console encodes full property and sitemap URLs as resource segments. Their escaped query delimiters and
    // path words are identifiers, not HTTP method overrides; only the documented fixed route structures are masked.
    classifiedPath: (plan: CompiledRequest) =>
      /^\/webmasters\/v3\/sites\/[^/?#\r\n\\]+(?:\/sitemaps(?:\/[^/?#\r\n\\]+)?|\/searchAnalytics\/query)?$/.test(
        plan.path,
      )
        ? plan.path
            .replace(/^(\/webmasters\/v3\/sites\/)[^/]+/, '$1PROPERTY')
            .replace(/(\/sitemaps\/)[^/]+$/, '$1SITEMAP')
        : undefined,
    postRead: (_plan: CompiledRequest, pathname: string) =>
      /\/searchAnalytics\/query$/.test(pathname) || pathname === '/v1/urlInspection/index:inspect',
  }),
  // Readiness reads the selected site (CON-03); a restricted user still reads its own site, an unverified one does not.
  accountRead: Object.freeze({
    readiness: (id: string, read: (path: string, origin: string) => CompiledRequest) =>
      read('/webmasters/v3/sites/' + encodeURIComponent(id), 'https://www.googleapis.com'),
    names: (id: string, data: JsonObject) =>
      data.siteUrl === id && typeof data.permissionLevel === 'string' && data.permissionLevel !== 'siteUnverifiedUser',
  }),
});
