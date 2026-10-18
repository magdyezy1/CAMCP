import type {ExpectState, ProviderHooks, StateTarget, WireHeaders} from './provider-adapter.js';
import type {CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {MirrorError} from './errors.js';
// The write-shape and state refusals keep the write stages' own helpers (src/write-common.ts).
import {fail, object} from './write-common.js';
import {stable} from './security.js';
import {
  assertGoogleGenerationScope,
  googleGenerationKind,
  googleGenerationResult,
  validateGoogleGeneration,
} from './google-generation.js';
import {googleJson, validateGoogleRequest} from './google-contracts.js';
import {googleAdsCustomers} from './google-version.js';
import {boundedWait, errorObject, errorToken} from './provider-error-core.js';
import type {ProviderErrorClass, ProviderErrorContext, ProviderErrorInput} from './provider-error-taxonomy.js';

/**
 * Google Ads' provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * documented read RPCs a POST may carry (src/execution-risk.ts keeps the generic rules). The account read is a GAQL
 * customer query. On the wire, bodies are ProtoJSON, the login customer header names the manager route, and quota
 * errors are documented throttles.
 */

/** The first errorCode token of a Google Ads failure (GoogleAdsFailure details), else the RPC status. */
function googleErrorCode(body: unknown): string | number | undefined {
  const error = errorObject(errorObject(body).error);
  for (const detail of Array.isArray(error.details) ? error.details.slice(0, 10) : [])
    for (const row of Array.isArray(errorObject(detail).errors) ? errorObject(detail).errors.slice(0, 10) : []) {
      const found = Object.values(errorObject(errorObject(row).errorCode))
        .map(errorToken)
        .find(Boolean);
      if (found) return found;
    }
  return errorToken(error.status);
}
/** Google Ads QuotaErrorDetails.retryDelay ("30s", "1.5s"), as milliseconds. */
function googleRetryDelay(row: Record<string, any>): number | undefined {
  const value = errorObject(errorObject(row.details).quotaErrorDetails).retryDelay,
    match = typeof value === 'string' ? /^(\d{1,6}(?:\.\d{1,9})?)s$/.exec(value) : null;
  return match ? Math.ceil(Number(match[1]) * 1000) : undefined;
}
/** RESOURCE_TEMPORARILY_EXHAUSTED is a documented throttle of the whole login; anything else is classified generically. */
function classifyGoogleError(input: ProviderErrorInput, context: ProviderErrorContext): ProviderErrorClass | undefined {
  const error = errorObject(errorObject(input.body).error);
  for (const detail of Array.isArray(error.details) ? error.details.slice(0, 10) : [])
    for (const row of Array.isArray(errorObject(detail).errors) ? errorObject(detail).errors.slice(0, 10) : [])
      if (errorObject(errorObject(row).errorCode).quotaError === 'RESOURCE_TEMPORARILY_EXHAUSTED')
        return {
          ...context.base,
          code: 'PLATFORM_RATE_LIMIT',
          layer: 'rate_limit',
          retryable: input.readOnly || context.legacyRetryable,
          retryAfterMs: boundedWait(Math.max(googleRetryDelay(errorObject(row)) ?? 30000, input.retryAfterMs ?? 0)),
          cooldownScope: 'login',
          documented: true,
        };
  return undefined;
}

// Read-only metadata is a compatibility observation, never sufficient execution authorization: POST reads must match
// this separately maintained list of documented read methods.
const googleReadMethods = new Set([
  'search',
  'searchStream',
  'suggest',
  'generateAudienceCompositionInsights',
  'generateAudienceDefinition',
  'generateAudienceOverlapInsights',
  'generateInsightsFinderReport',
  'generateSuggestedTargetingInsights',
  'generateTargetingSuggestionMetrics',
  'searchAudienceInsightsAttributes',
  'listInsightsEligibleDates',
  'generateBenchmarksMetrics',
  'listBenchmarksAvailableDates',
  'listBenchmarksLocations',
  'listBenchmarksProducts',
  'listBenchmarksSources',
  'suggestBrands',
  'generateCreatorInsights',
  'generateTrendingInsights',
  'generateAdGroupThemes',
  'generateKeywordForecastMetrics',
  'generateKeywordHistoricalMetrics',
  'generateKeywordIdeas',
  'generateConversionRates',
  'generateReachForecast',
  'listPlannableLocations',
  'listPlannableProducts',
  'listPlannableUserInterests',
  'listPlannableUserLists',
  'quoteCampaigns',
  'suggestKeywordThemes',
  'suggestSmartCampaignAd',
  'suggestSmartCampaignBudgetOptions',
  'suggestTravelAssets',
]);
// Root-level RPCs are /vNN:method, not /vNN/customers/...:method. These documented planning metadata reads create no
// customer-owned resources.
const googleGlobalReadMethods = new Set([
  'generateConversionRates',
  'listBenchmarksAvailableDates',
  'listBenchmarksLocations',
  'listBenchmarksProducts',
  'listBenchmarksSources',
  'listPlannableLocations',
  'listPlannableProducts',
  'listPlannableUserInterests',
  'listPlannableUserLists',
]);
// Two documented planning reads sit under a service rather than the root: /vNN/audienceInsights:listInsightsEligibleDates
// and /vNN/keywordThemeConstants:suggest. Neither names a customer.
const googleGlobalServiceReads = new Set([
  'audienceInsights:listInsightsEligibleDates',
  'keywordThemeConstants:suggest',
]);
/** A documented Google Ads planning read outside any customer (a decoded path). */
export function googleGlobalRead(pathname: string): boolean {
  const m = /^\/v\d+(?::([A-Za-z]+)|\/([A-Za-z]+:[A-Za-z]+))$/.exec(pathname);
  return !!m && (m[1] ? googleGlobalReadMethods.has(m[1]) : googleGlobalServiceReads.has(m[2]!));
}

/** A documented planning read outside any customer: in scope for every bound account (ScopeGuard, after the families). */
function googleGlobalPlanningRead(p: CompiledRequest): boolean {
  if (p.gateway !== 'google_ads_native_action' || !p.readOnly || p.method !== 'POST') return false;
  try {
    return googleGlobalRead(decodeURIComponent(p.path));
  } catch {
    return false;
  }
}

/** A server-derived optional association query (googleState.allowMissing), whose empty result ProtoJSON omits. */
const optionalState = (read: CompiledRequest) => read.googleState?.allowMissing === true;
/** ProtoJSON omits an empty repeated `results`: only an optional association query reads that as absence. */
function emptyOptionalState(read: CompiledRequest, result: TransportResult, data: JsonObject) {
  return (
    optionalState(read) &&
    result.status === 200 &&
    result.data !== null &&
    typeof result.data === 'object' &&
    !Array.isArray(result.data) &&
    data.results === undefined &&
    (Object.keys(data).length === 0 ||
      typeof data.fieldMask === 'string' ||
      typeof data.queryResourceConsumption === 'string')
  );
}
/** A Google state query must return exactly its requested resources (an optional one, at most them, once each). */
function googleStateTarget(
  read: CompiledRequest,
  result: TransportResult,
  data: JsonObject,
  {id, sameIds}: StateTarget,
) {
  const optionalGoogle = optionalState(read);
  if (emptyOptionalState(read, result, data)) data.results = [];
  if (!Array.isArray(data.results) || (!data.results.length && !optionalGoogle))
    fail('STATE_NOT_FOUND', 'Google state query returned no target rows.');
  const q = String(object(read.body).query),
    type = q.match(/ FROM ([a-z_]+)/)?.[1];
  if (type === 'customer') {
    sameIds(
      data.results.map((r: JsonObject) => r.customer?.id),
      [id],
    );
    return;
  }
  if (!type) fail('STATE_READ_FAILED', 'Unrecognized Google state query.');
  const expected = [...q.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]),
    camel = type!.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    actual = data.results.map(
      (r: JsonObject) => (r[camel] ?? r[type!])?.resourceName ?? (r[camel] ?? r[type!])?.resource_name,
    );
  if (optionalGoogle) {
    if (
      read.googleState!.resource !== type ||
      stable(read.googleState!.names) !== stable(expected) ||
      new Set(actual).size !== actual.length ||
      actual.some((name: unknown) => typeof name !== 'string' || !expected.includes(name))
    )
      fail(
        'STATE_TARGET_MISMATCH',
        'Optional state must contain only unique, exactly requested association identities.',
      );
  } else sameIds(actual, expected);
}
/**
 * Google's write shape: 1–25 homogeneous native operations, atomic and applied (never partial or validate-only), each
 * one create, update or remove. A new campaign starts PAUSED; its ad groups, ads and asset groups may start ENABLED
 * only under a parent the review reads as PAUSED (google-paused-parents.ts, the owner's item 6).
 */
function googleWriteShape(plan: CompiledRequest, body: JsonObject, expect: ExpectState) {
  if (!Array.isArray(body.operations) || !body.operations.length || body.operations.length > 25)
    fail('WRITE_CONTRACT_UNAVAILABLE', 'Reviewed Google mutations require 1–25 homogeneous native operations.');
  if (/\/campaigns:mutate$/.test(plan.path))
    for (const op of body.operations) if (op.create) expect(op.create, 'status', ['PAUSED']);
  if (/\/(adGroups|adGroupAds|assetGroups):mutate$/.test(plan.path))
    for (const op of body.operations) if (op.create) expect(op.create, 'status', ['PAUSED', 'ENABLED']);
  if (body.partial_failure === true || body.partialFailure === true)
    fail(
      'WRITE_CONTRACT_UNAVAILABLE',
      'Execute homogeneous Google mutations atomically; partial_failure must be false.',
    );
  if (body.validate_only === true || body.validateOnly === true)
    fail('WRITE_CONTRACT_UNAVAILABLE', 'This tool executes mutations; use a local dry run for validation-only plans.');
  for (const op of body.operations)
    if (!op || typeof op !== 'object' || ['create', 'update', 'remove'].filter(k => op[k] !== undefined).length !== 1)
      fail('INVALID_MUTATION', 'Each Google operation must contain exactly one create, update or remove.');
}

export const googleAdsHooks: ProviderHooks = Object.freeze({
  gateway: 'google_ads_native_action',
  checks: Object.freeze({
    // Every reviewed write is checked against its pinned Discovery schema first.
    request: validateGoogleRequest,
    shape: Object.freeze({after: googleWriteShape}),
    state: Object.freeze({
      envelope: (read: CompiledRequest, result: TransportResult, data: JsonObject) =>
        emptyOptionalState(read, result, data) ? {...result, data: {...data, results: []}} : result,
      target: googleStateTarget,
    }),
  }),
  scope: Object.freeze({
    // Generation drafts need the Ads scope on the selected connection.
    assert: assertGoogleGenerationScope,
    authorizers: Object.freeze([
      Object.freeze({
        name: 'google_ads_global_planning_read',
        stage: 'after_families' as const,
        claims: googleGlobalPlanningRead,
        authorize: () => true,
      }),
    ]),
  }),
  reads: Object.freeze({
    // Generation drafts (reviewed as reads), the customer read RPCs and the global planning reads.
    postRead: (plan: CompiledRequest, pathname: string) =>
      !!googleGenerationKind(plan) ||
      (/^\/v\d+\//.test(pathname) && googleReadMethods.has(pathname.split(':').at(-1)!)) ||
      googleGlobalRead(pathname),
  }),
  // The account read is one GAQL row of the customer: its ID, currency and time zone.
  accountRead: Object.freeze({
    plan(read: CompiledRequest, id: string) {
      read.method = 'POST';
      read.path = googleAdsCustomers + id + '/googleAds:search';
      read.body = {query: 'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'};
      return read;
    },
    account: (data: JsonObject) => data.results?.[0]?.customer,
  }),
  wire: Object.freeze({
    // Every request is checked against its pinned Discovery schema, and the generation RPCs against their contract.
    validate: validateGoogleRequest,
    validateRoute: validateGoogleGeneration,
    json(plan: CompiledRequest, url: URL, connection: Connection, credentials: Credentials) {
      let json = googleJson(plan.body);
      // The Data Manager API names the manager login in each destination, where the Google Ads API takes the
      // login-customer-id header; it is the same login, from the same connection settings.
      if (url.origin === 'https://datamanager.googleapis.com') {
        const login = (
          (plan.accountId ? connection.accountLoginCustomers?.[plan.accountId] : undefined) ??
          credentials.loginCustomerId
        )?.replaceAll('-', '');
        if (login && json && Array.isArray((json as JsonObject).destinations))
          json = {
            ...(json as JsonObject),
            destinations: (json as JsonObject).destinations.map((d: JsonObject) =>
              d?.operatingAccount?.accountId && d.operatingAccount.accountId !== login
                ? {...d, loginAccount: {accountType: 'GOOGLE_ADS', accountId: login}}
                : d,
            ),
          };
      }
      return json;
    },
    // The developer token and login customer are Google Ads API headers; the Data Manager API takes neither.
    headers({plan, url, connection, credentials, headers}: WireHeaders) {
      if (url.origin !== 'https://googleads.googleapis.com') return;
      // Google Cloud projects own API access since developer tokens were sunset on September 9, 2026. Google ignores the
      // header today and will reject it in a future major version, so a configured legacy token is never sent (PRV-04;
      // src/google-version.ts warns while AMCP_GOOGLE_DEVELOPER_TOKEN is set).
      const mapped =
        plan.action !== 'AMCP_GOOGLE_DISCOVERY' && plan.accountId
          ? connection.accountLoginCustomers?.[plan.accountId.replaceAll('-', '')]
          : undefined;
      // A website login records the manager route of every selected account when it is synced. An account without one
      // is refused with re-sync guidance: no login header, and never a deployment-wide manager guessed for it (CON-05).
      // Operator-provisioned logins, which have no recorded routes, keep their own provisioned login customer.
      if (
        mapped === undefined &&
        plan.action !== 'AMCP_GOOGLE_DISCOVERY' &&
        plan.accountId &&
        connection.accountLoginCustomers !== undefined
      )
        throw new MirrorError(
          'GOOGLE_LOGIN_CUSTOMER_UNMAPPED',
          'This Google Ads account has no recorded manager route on this login. Sync the Google Ads login in Connections, then try again.',
          {account_id: plan.accountId, connection_id: connection.id, website: '/connections'},
          409,
        );
      const loginCustomerId = mapped ?? credentials.loginCustomerId;
      if (loginCustomerId) headers['login-customer-id'] = loginCustomerId.replaceAll('-', '');
    },
    // Generated drafts may differ on retry and consume provider generation quota: they are sent once.
    singleAttempt: (plan: CompiledRequest) => !!googleGenerationKind(plan),
    // A resumable video upload session answers without a body, with its upload URL in a header.
    emptyWrite: (plan: CompiledRequest, response: Response) =>
      response.status === 200 &&
      plan.method === 'POST' &&
      /^\/resumable\/upload\/v\d+\/customers\/\d+\/youTubeVideoUploads:create$/.test(plan.path) &&
      response.headers.has('x-goog-upload-url'),
    reportData: (plan: CompiledRequest) => /\/googleAds:search$/.test(plan.path),
    sentLogin: (headers: Record<string, string>) => ({login_customer_id: headers['login-customer-id'] ?? null}),
    checkResult: (plan: CompiledRequest, data: unknown) => {
      googleGenerationResult(plan, data);
    },
    sessionHeaders: (plan: CompiledRequest) =>
      plan.path.startsWith('/resumable/upload/') ? ['x-goog-upload-url', 'x-goog-upload-chunk-granularity'] : [],
    errors: Object.freeze({code: googleErrorCode, classify: classifyGoogleError}),
  }),
});
