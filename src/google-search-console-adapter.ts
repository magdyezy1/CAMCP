import type {DelegatedHooks, DelegatedScopeContext, ProviderHooks, ScopeContext} from './provider-adapter.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
// The write-shape and state refusals keep the write stages' own helper (src/write-common.ts).
import {fail} from './write-common.js';
import {assertMeasurementWrite, validateMeasurementState} from './measurement-writes.js';

const record = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
const inspectionFields = Object.freeze(['siteUrl', 'inspectionUrl', 'languageCode']);
/**
 * Wave 4c (transport and catalog): Search Console's part of the delegated compiler (src/delegated-native.ts). A URL
 * inspection takes its site, URL and language from the top-level arguments into its body; a request is scoped by
 * its site, given once under any of its names.
 */
const searchConsoleDelegated: DelegatedHooks = Object.freeze({
  bodyFields: (action: string) => (action === 'INSPECT_URL' ? inspectionFields : undefined),
  scope: Object.freeze({
    own: ({args, body, singleValue}: DelegatedScopeContext) =>
      singleValue('siteUrl', [args, record(args.params), record(args.path_params), body]) as string | undefined,
  }),
});

/**
 * Search Console's sitemap `errors` is a documented content-error count, not a failed API envelope: the success check
 * reads it as no error. Real error objects and malformed counts still fail.
 */
function sitemapEnvelope(read: CompiledRequest, result: TransportResult, data: JsonObject): TransportResult {
  const sitemap = read.path.includes('/sitemaps/');
  const sitemapCount =
    sitemap &&
    ((typeof data.errors === 'number' && Number.isSafeInteger(data.errors) && data.errors >= 0) ||
      (typeof data.errors === 'string' && /^\d+$/.test(data.errors)));
  if (sitemap && Object.hasOwn(data, 'errors') && !sitemapCount)
    fail('STATE_READ_FAILED', 'Search Console sitemap content-error counts must be nonnegative integers.');
  return sitemapCount ? {...result, data: {...data, errors: 0}} : result;
}
/** A sitemap's crawl and processing fields, which a review does not keep. */
const sitemapProcessing = new Set(['lastDownloaded', 'isPending', 'warnings', 'errors', 'contents']);

/**
 * Search Console's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: a site
 * or sitemap URL in the path is an identifier, and the search analytics query and URL inspection are POST reads. Its
 * scope: a request names its site in its path, or in the body's siteUrl, which must be the bound site. Its writes
 * follow the measurement resource contract (src/measurement-writes.ts); a resource's 404 is its documented absence,
 * and the resource checks every state read's target.
 */
export const searchConsoleHooks: ProviderHooks = Object.freeze({
  gateway: 'google_search_console_native_action',
  delegated: searchConsoleDelegated,
  checks: Object.freeze({
    routeWrite: assertMeasurementWrite,
    state: Object.freeze({
      settled(read: CompiledRequest, result: TransportResult) {
        if (result.status !== 404) return false;
        validateMeasurementState(read, result);
        return true;
      },
      envelope: sitemapEnvelope,
      ownTarget: true as const,
      target: (read: CompiledRequest, result: TransportResult) => validateMeasurementState(read, result),
    }),
  }),
  review: Object.freeze({
    // Crawl/processing observations are not a sitemap submission change. Keep
    // lastSubmitted, type, path, index identity and unknown configuration fields.
    snapshot: (read: CompiledRequest, d: JsonObject) =>
      read.path.includes('/sitemaps/') && d.amcp_absent !== true
        ? Object.fromEntries(Object.entries(d).filter(([key]) => !sitemapProcessing.has(key)))
        : d,
  }),
  scope: Object.freeze({
    resource(plan: CompiledRequest, _c: Connection, _id: string, {compare}: ScopeContext) {
      const site = /\/sites\/([^/]+)/.exec(plan.path)?.[1];
      const value = site ? decodeURIComponent(site) : (plan.body as JsonObject)?.siteUrl;
      if (value === undefined) return false;
      compare(value, 'siteUrl');
      return true;
    },
  }),
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
  // A measurement asset sync read carries the sync's deadline; a site or sitemap edit answers 200 without a body.
  wire: Object.freeze({
    deadline: (plan: CompiledRequest) =>
      plan.action === 'AMCP_MEASUREMENT_ASSET_SYNC' && plan.readOnly && plan.method === 'GET'
        ? plan.measurementSyncDeadline
        : undefined,
    emptyWrite: (plan: CompiledRequest, response: Response) =>
      response.status === 200 &&
      ['PUT', 'DELETE'].includes(plan.method) &&
      /^\/webmasters\/v3\/sites\//.test(plan.path),
  }),
});
