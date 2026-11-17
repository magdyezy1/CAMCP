import type {DelegatedHooks, DelegatedScopeContext, ProviderHooks, ScopeContext} from './provider-adapter.js';
import type {CompiledRequest, Connection, DeclaredOperation, JsonObject} from './types.js';
import type {ReviewVolatile} from './review-state-core.js';
import {flatResourceTelemetry} from './review-flat-telemetry.js';
import type {TransportResult} from './transport.js';
// The write-shape and state refusals keep the write stages' own helper (src/write-common.ts).
import {fail} from './write-common.js';
import {assertMeasurementWrite, validateMeasurementState} from './measurement-writes.js';
// Writes and campaigns (wave 4c).
import {assertMeasurementScopes} from './measurement-writes.js';
import {usageNotExposed} from './provider-usage.js';

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
/**
 * What changes by itself in a Search Console answer (R2.5 M1, L5-02). Its resources are flat, so the flat-resource names
 * apply; beyond them a sitemap's crawl and processing observations (`lastDownloaded`, `isPending`, `warnings`, `errors`,
 * `contents`: Google downloads and counts it on its own schedule), which are not a sitemap submission change. A submission's
 * own fields (`path`, `lastSubmitted`, `type`, the index identity) and any field not listed stay protected.
 */
const searchConsoleReviewVolatile: ReviewVolatile = Object.freeze([
  ...flatResourceTelemetry,
  'last_downloaded',
  'is_pending',
  'warnings',
  'errors',
  'contents',
]);

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
  // Crawl/processing observations are not a sitemap submission change: they are in the table. lastSubmitted, type, path,
  // index identity and unknown configuration fields stay in the state.
  review: Object.freeze({volatile: searchConsoleReviewVolatile}),
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
    // Its APIs send no usage header: the rate governor’s view says "not exposed" (R2.5 M2, MT3; src/provider-usage.ts).
    usage: usageNotExposed,
    deadline: (plan: CompiledRequest) =>
      plan.action === 'AMCP_MEASUREMENT_ASSET_SYNC' && plan.readOnly && plan.method === 'GET'
        ? plan.measurementSyncDeadline
        : undefined,
    emptyWrite: (plan: CompiledRequest, response: Response) =>
      response.status === 200 &&
      ['PUT', 'DELETE'].includes(plan.method) &&
      /^\/webmasters\/v3\/sites\//.test(plan.path),
  }),
  // Workbook reporting (ARC-01, reporting; src/report-resource-scope.ts): a saved query names its property by a site
  // selector, a domain property or a URL-prefix property without credentials.
  reportScope: Object.freeze({
    account(kind: unknown, value: string) {
      if (kind !== 'site' || value.length > 200) return undefined;
      if (/^sc-domain:[^/?#]+$/.test(value)) return value;
      if (/^https?:\/\//.test(value)) {
        try {
          const url = new URL(value);
          if (!url.username && !url.password) return value; // Preserve prefix-property bytes, including trailing slash.
        } catch {}
      }
      return undefined;
    },
    // Wave 4c round 6 (w4c-arc6-reporting): the selectors src/workbook-repository.ts projects: a site URL, site or
    // property URL field of the arguments, their params, path_params or payload, the body.
    selectors: Object.freeze({
      order: 2,
      groups: Object.freeze([
        Object.freeze({
          paths: Object.freeze(['$', '$.params', '$."path_params"', '$.payload']),
          keys: Object.freeze(['siteurl', 'site', 'propertyurl']),
        }),
      ]),
      otherwise: 'site',
      body: 'payload',
    }),
  }),
  // Writes and campaigns (wave 4c): a review's write needs the Search Console write permission (src/write-review.ts).
  writes: Object.freeze({
    writePermission: assertMeasurementScopes,
    // A sitemap submission takes effect for everyone at once (src/write-effects.ts).
    publishesLive: (plan: CompiledRequest) => plan.method === 'PUT' && plan.path.includes('/sitemaps/'),
    // A PUT to a site's own URL adds the site (sites.add); a PUT below it submits a sitemap (R2.5 S2-2).
    operation: (plan: CompiledRequest): DeclaredOperation | undefined =>
      plan.method === 'PUT' && /\/sites\/[^/]+$/.test(plan.path) ? {operation: 'create', entity: 'site'} : undefined,
  }),
  // Wave 4c round 6 (w4c-arc6-versions): what tools/list and amcp_tool_help say of its gateway (src/tool-notes.ts); its
  // catalog has write actions, which its gateway previews or refuses.
  notes: Object.freeze({
    description: 'Google Search Console gateway for sites, sitemaps, URL inspection and search analytics.',
    connectedOnWebsite: true as const,
    delegatedWrites: true as const,
  }),
  // Wave 4c round 6 (w4c-arc6-tables): its rows of the shared tables (src/provider-hooks.ts orders them). Its connection
  // operation, whose OAuth steps run on the website (src/unavailable-operations.ts, src/connection-diagnostics.ts).
  connection: Object.freeze({operation: 'gsc_connection_ops', provider: 'Search Console'}),
  // Its wire contract (src/wire-contracts.ts): each route's request schema in its pinned Google Discovery document.
  wireContract: Object.freeze({routes: Object.freeze({label: 'Google'})}),
});
