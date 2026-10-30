import type {
  CompileDraft,
  CompileHooks,
  ContractHooks,
  ContractLegacy,
  ContractNote,
  ContractRow,
  ExpectState,
  ProviderHooks,
  ProviderVerificationRead,
  StateTarget,
  WireHeaders,
} from './provider-adapter.js';
import type {Action, CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import type {Registry} from './catalog.js';
import type {TransportResult} from './transport.js';
import {MirrorError} from './errors.js';
// The write-shape and state refusals keep the write stages' own helpers (src/write-common.ts), and the verification
// reads the workspace's (src/workspace-core.ts).
import {fail, object, snake} from './write-common.js';
import {bad, obj} from './workspace-core.js';
import {stable} from './security.js';
import {keywordPlanObserved} from './google-keyword-plan-writes.js';
import {assetSetCanonical} from './google-asset-set-writes.js';
import {googleSegmentResource, googleSegmentCanonical} from './google-custom-segments.js';
import {googleUserListCanonical} from './google-user-lists.js';
import {googleValueRuleCanonical} from './google-value-rules.js';
import {googleConfigurationObserved} from './google-configuration-writes.js';
import {
  assertGoogleGenerationScope,
  googleGenerationKind,
  googleGenerationPlan,
  googleGenerationResult,
  validateGoogleGeneration,
} from './google-generation.js';
import {googleContractEvidence, googleJson, validateGoogleRequest} from './google-contracts.js';
import {
  currentGoogleAdsCapture,
  extendGoogleAdsTool,
  googleAdsActionVersion,
  googleAdsCustomers,
  googleAdsRequestChange,
  googleAdsVersion,
} from './google-version.js';
import {adaptGoogleLegacy, googleLegacyCoverage} from './google-legacy.js';
import legacyMapping from './google-legacy-mapping.json' with {type: 'json'};
import {dataManagerActions} from './google-data-manager-routes.js';
import {boundedWait, errorObject, errorToken} from './provider-error-core.js';
import type {ProviderErrorClass, ProviderErrorContext, ProviderErrorInput} from './provider-error-taxonomy.js';
// Writes and campaigns (wave 4c).
import {
  buildGoogleSearchRecipe,
  googleRecipeLookup,
  googleSearchDependencyEvidence,
  googleSearchRecipeContext,
  googleSearchRecipes,
} from './google-search-recipes.js';
import {
  buildGooglePmaxRecipe,
  googlePmaxContext,
  googlePmaxDependencyEvidence,
  googlePmaxRecipe,
} from './google-pmax-recipe.js';
import {validateGoogleTargetingState} from './google-targeting-writes.js';
import {validateGooglePausedParents} from './google-paused-parents.js';
import {googleStateReads} from './google-state-reads.js';
import {googleClone} from './google-campaign-clone.js';
import {composeGoogleBuild} from './google-atomic-builds.js';
import {googleActivationGates, googleActivationRecord, googleActivationSteps} from './google-recipe-activation.js';
import {googlePreflight} from './google-preflight.js';
import type {DependencyEvidenceContext, MutationResponse} from './provider-adapter.js';
import {googleRejectionIsNonApplied} from './google-write-rejection.js';
import {googleCreated, googleNamedTargets} from './google-write-reconciliation.js';
// Writes and campaigns (wave 4c): the spending policy's Google Ads parts.
import {assertGoogleAccessPolicy} from './google-user-access.js';
import {pinnedJson} from './pinned-json.js';

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

/**
 * The state a review keeps of a Google state query: its rows, each named resource once and exactly the requested ones
 * (an optional association query: no others), sorted, each in its canonical configuration.
 */
function googleSnapshot(read: CompiledRequest, d: JsonObject): unknown {
  const query = String((read.body as JsonObject)?.query ?? ''),
    resource = /\bFROM\s+([a-z_]+)/i.exec(query)?.[1];
  const rows = d.results ?? (read.googleState?.allowMissing ? [] : undefined);
  if (!Array.isArray(rows)) return d;
  // Even customer reads without resource_name must exclude query cost, field
  // masks, summary metrics and future envelope metadata. Never ignore a nonempty
  // nextPageToken here instead of rejecting the incomplete raw response first.
  if (!resource || !query.includes(resource + '.resource_name')) return {results: rows};
  const key = resource.replace(/_([a-z])/g, (_m, c) => c.toUpperCase()),
    seen = new Set<string>();
  const items = rows.map((row: JsonObject) => {
    const value = row[resource] ?? row[key],
      id = value?.resourceName ?? value?.resource_name;
    if (typeof id !== 'string' || !id || seen.has(id))
      throw new MirrorError(
        'STATE_RESOURCE_INVALID',
        'The state response contains missing or duplicate resource identities.',
        {},
        502,
      );
    seen.add(id);
    return {id, row};
  });
  const expected = [...new Set([...query.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]!))];
  if (
    expected.length &&
    (read.googleState?.allowMissing
      ? items.some(item => !expected.includes(item.id))
      : expected.length !== seen.size || expected.some(id => !seen.has(id)))
  )
    throw new MirrorError(
      'STATE_RESOURCE_MISMATCH',
      'The state response does not cover exactly the requested resources.',
      {},
      409,
    );
  items.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const state = {
    results: items.map(item =>
      resource.startsWith('keyword_plan')
        ? {...item.row, [key]: keywordPlanObserved(resource, item.row[key])}
        : googleSegmentResource(resource)
          ? {
              ...item.row,
              [item.row[resource] ? resource : key]: googleSegmentCanonical(
                resource,
                item.row[resource] ?? item.row[key],
                true,
              ),
            }
          : resource === 'user_list'
            ? {
                ...item.row,
                [item.row[resource] ? resource : key]: googleUserListCanonical(item.row[resource] ?? item.row[key]),
              }
            : resource === 'conversion_value_rule'
              ? {
                  ...item.row,
                  [item.row[resource] ? resource : key]: googleValueRuleCanonical(
                    resource,
                    item.row[resource] ?? item.row[key],
                  ),
                }
              : item.row,
    ),
  };
  return [
    'asset',
    'asset_set',
    'asset_set_asset',
    'campaign_asset_set',
    'ad_group_asset_set',
    'customer_asset_set',
  ].includes(resource)
    ? assetSetCanonical(state)
    : state;
}
/**
 * The reads that show Google mutations took effect: each operation's resource, read back with its state query; a
 * removal reads as absent, and a bidding strategy proves its oneof through Google's selectable native enum.
 */
function googleVerification(
  plan: CompiledRequest,
  result: JsonObject,
  _read: (path: string, query?: JsonObject) => CompiledRequest,
  snapshots: (plan: CompiledRequest) => CompiledRequest[],
): ProviderVerificationRead[] {
  const b = (plan.body ?? {}) as JsonObject,
    d = result.data ?? {};
  const leaves = (value: JsonObject, prefix = ''): string[] =>
    Object.entries(value).flatMap(([k, v]) => (obj(v) ? leaves(v, prefix + snake(k) + '.') : [prefix + snake(k)]));
  return (d.results ?? []).map((r: JsonObject, i: number) => {
    const op = b.operations[i],
      record = op.create ?? op.update,
      expected = op.remove
        ? {status: 'REMOVED'}
        : Object.fromEntries(Object.entries(record).filter(([k]) => !['resource_name', 'resourceName'].includes(k)));
    // An empty bidding message has no scalar leaves. Prove its oneof through Google's selectable native enum,
    // rather than letting an empty object compare successfully with any or no strategy (F-185).
    if (/\/campaigns:mutate$/.test(plan.path) && !op.remove) {
      const schemes: Record<string, string> = {
        manual_cpc: 'MANUAL_CPC',
        target_spend: 'TARGET_SPEND',
        maximize_conversions: 'MAXIMIZE_CONVERSIONS',
        maximize_conversion_value: 'MAXIMIZE_CONVERSION_VALUE',
      };
      const chosen = Object.keys(expected).find(key => Object.hasOwn(schemes, snake(key)));
      if (chosen) {
        expected.bidding_strategy_type = schemes[snake(chosen)];
        // MaximizeConversions.target_cpa_micros is an implicit-presence proto3 int64. Selecting it establishes
        // zero when ProtoJSON omits the default; a positive unexpected target must not verify an untargeted plan.
        if (
          snake(chosen) === 'maximize_conversions' &&
          obj(expected[chosen]) &&
          !Object.keys(expected[chosen]).some(key => snake(key) === 'target_cpa_micros')
        )
          expected[chosen] = {...expected[chosen], target_cpa_micros: '0'};
        // MaximizeConversionValue.target_roas is likewise an implicit-presence proto3 double in v25.
        if (
          snake(chosen) === 'maximize_conversion_value' &&
          obj(expected[chosen]) &&
          !Object.keys(expected[chosen]).some(key => snake(key) === 'target_roas')
        )
          expected[chosen] = {...expected[chosen], target_roas: 0};
      }
    }
    const fake = {
      ...plan,
      body: {
        operations: [
          op.remove
            ? {remove: op.remove}
            : {update: {resource_name: r.resourceName, ...expected}, update_mask: leaves(expected).join(',')},
        ],
      },
    };
    const p = snapshots(fake)[0]!;
    if (Object.keys(expected).some(key => snake(key) === 'maximize_conversion_value'))
      // Added after GAQL compilation: this local typed proof marker is never a native request field.
      expected.amcp_conversion_value_target_shape_valid = true;
    if (op.remove) {
      const resource = String((p.body as JsonObject).query).match(/ FROM ([a-z_]+)/)?.[1];
      if (!resource) bad('Removal has no exact state read.', 'VERIFICATION_UNSUPPORTED');
      p.googleState = {resource, names: [r.resourceName], allowMissing: true, removedAsAbsent: true};
    }
    return {read: p, expected, id: r.resourceName};
  });
}
/**
 * What a Google verification read shows: a removed resource reads as REMOVED once its read finds nothing (only Google's
 * state reads carry googleState); otherwise the first row's resource as observed, with the implicit zero targets of
 * Maximize Conversions and Maximize Conversion Value made explicit and the value target's shape checked.
 */
function googleObserved(plan: CompiledRequest, data: JsonObject): JsonObject {
  if (plan.googleState?.removedAsAbsent && !data.results?.length) return {status: 'REMOVED'};
  let observed = googleConfigurationObserved(plan, Object.values(data.results?.[0] ?? {})[0] as JsonObject);
  const query = (plan.body as JsonObject)?.query ?? '';
  if (
    obj(observed) &&
    observed.biddingStrategyType === 'MAXIMIZE_CONVERSIONS' &&
    /\bcampaign\.maximize_conversions\.target_cpa_micros\b/.test(query) &&
    / FROM campaign(?: |$)/.test(query) &&
    (observed.maximizeConversions === undefined || obj(observed.maximizeConversions)) &&
    !Object.hasOwn(observed.maximizeConversions ?? {}, 'targetCpaMicros')
  )
    observed = {...observed, maximizeConversions: {...observed.maximizeConversions, targetCpaMicros: '0'}};
  if (
    obj(observed) &&
    observed.biddingStrategyType === 'MAXIMIZE_CONVERSION_VALUE' &&
    /\bcampaign\.maximize_conversion_value\.target_roas\b/.test(query) &&
    / FROM campaign(?: |$)/.test(query)
  ) {
    const value = observed.maximizeConversionValue,
      shape = value === undefined || obj(value),
      absent = shape && !Object.hasOwn(value ?? {}, 'targetRoas');
    if (absent) observed = {...observed, maximizeConversionValue: {...value, targetRoas: 0}};
    observed = {
      ...observed,
      amcpConversionValueTargetShapeValid:
        shape && (absent || (typeof value.targetRoas === 'number' && Number.isFinite(value.targetRoas))),
    };
  }
  return observed;
}
/** Retire older value-bidding cache proofs: a campaign mutation that sets Maximize Conversion Value. */
function googleVerificationVersion(plan: CompiledRequest): string | undefined {
  const body = plan.body as JsonObject | undefined;
  return plan.method === 'POST' &&
    /\/campaigns:mutate$/.test(plan.path) &&
    Array.isArray(body?.operations) &&
    body.operations.some((op: JsonObject) =>
      Object.keys(op.create ?? op.update ?? {}).some(key => snake(key) === 'maximize_conversion_value'),
    )
    ? 'google-campaign-value-roas-v1'
    : undefined;
}

// Wave 4c (transport and catalog): Google Ads' part of the catalog compiler (src/compiler.ts).
const plain = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? {...v} : {});
/**
 * Its legacy actions compile as the routed requests they stand for; the account sets customer_id without dashes; its
 * required fields are checked in every mode, under their camelCase names too, except the content the Drive importer
 * supplies after review, and a missing one names its action's version change; a request's body is the field its RPC
 * maps; its requests carry their Discovery route evidence and the generation drafts' checks.
 */
const googleAdsCompile: CompileHooks = Object.freeze({
  legacy: adaptGoogleLegacy,
  accountValues(values: JsonObject, accountId: string) {
    values.customer_id = accountId.replaceAll('-', '');
  },
  required: Object.freeze({
    always: true as const,
    alias: (values: JsonObject, key: string) => values[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())],
    // The AMCP Drive importer supplies the binary payload after review. Only its
    // exact upload routes may omit their ordinary native content container.
    supplied: (key: string, route: string, values: JsonObject) =>
      ['operations', 'you_tube_video_upload'].includes(key) &&
      /\/(?:assets:mutate|youTubeVideoUploads:create)$/.test(route) &&
      ['drive_url', 'url', 'image_url', 'video_url', 'file_url', 'source'].some(k => typeof values[k] === 'string'),
    missing(action: Action, key: string) {
      const change = googleAdsRequestChange(action.name);
      return new MirrorError(
        'MISSING_PARAMETER',
        action.name +
          " requires request field '" +
          key +
          "'. Pass path values in path_params and all other native request fields in params or payload.",
        {parameter: key, ...(change ? {version_change: change} : {})},
      );
    },
  }),
  request(draft: CompileDraft, _input: JsonObject, registry: Registry) {
    const desc = registry.data.descriptions[draft.gateway + '/' + draft.action.name];
    if (desc?.body_mapping && desc.body_mapping !== '*')
      draft.body = plain(draft.body)[desc.body_mapping] ?? draft.body;
    return undefined;
  },
  beforeJob: (plan: CompiledRequest) => googleGenerationPlan(googleContractEvidence(plan)),
});

/**
 * Wave 4c (transport and catalog): Google Ads' part of the action contract ledger (src/action-contracts.ts). A draft
 * generation RPC's row names its contract; a legacy action the catalog lists without a route is the GAQL search or
 * the RPC its mapping names (an explicit adapter's own row when its route depends on the request).
 */
const generationNote: ContractNote = Object.freeze({
  implementation: 'src/google-generation.ts',
  test: 'tests/google-generation.test.ts',
  reason:
    'Fixed draft-generation RPC: native required inputs and oneofs, selected Ads scope, one attempt and explicit no-output semantics. It does not save assets or apply recommendations. Text/image generation requires provider closed-beta access.',
});
const legacyAdapterRow: ContractRow = Object.freeze({
  status: 'adapter_requires_input' as const,
  implementation: 'src/google-legacy.ts',
  reason:
    'An explicit legacy adapter exists, but its route depends on the requested scope/type. Inspect the exact payload; each selected destination retains its own reviewed contract.',
  tests: Object.freeze(['tests/google-legacy.test.ts']),
});
const googleAdsContracts: ContractHooks = Object.freeze({
  readNotes: (plan: CompiledRequest) => (googleGenerationKind(plan) ? [generationNote] : []),
  legacy(registry: Registry): ContractLegacy {
    const coverage = googleLegacyCoverage(),
      search = (a: Action): Action => ({
        ...a,
        method: 'POST',
        path: googleAdsCustomers + '{customer_id}/googleAds:search',
        read_only: true,
      });
    return {
      route(a: Action, route: Action, source: string) {
        const entry = legacyMapping.entries.find(e => e.name === a.name) as JsonObject | undefined;
        if (entry?.kind === 'GAQL') route = search(a);
        else {
          const hint = coverage.entries.find(e => e.action === a.name)?.destination;
          const mapped = hint
            ? registry.catalogs
                .get('google_ads_native_action')
                ?.actions.find(x => x.path && (x.name === hint || x.raw.service + '.' + x.raw.rpc === hint))
            : undefined;
          if (mapped) route = mapped;
          else if (hint && /^[a-z_]+$/.test(hint)) route = search(a);
        }
        return {route, source: entry ? 'src/google-legacy-mapping.json' : source};
      },
      adapted: (a: Action) => coverage.entries.some(e => e.action === a.name),
      row: legacyAdapterRow,
    };
  },
});

/**
 * Google Ads' provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * documented read RPCs a POST may carry (src/execution-risk.ts keeps the generic rules). The account read is a GAQL
 * customer query. On the wire, bodies are ProtoJSON, the login customer header names the manager route, and quota
 * errors are documented throttles. A review keeps a state query's rows, each resource in its canonical configuration,
 * and verifies each operation by its resource's state query.
 */
export const googleAdsHooks: ProviderHooks = Object.freeze({
  gateway: 'google_ads_native_action',
  compile: googleAdsCompile,
  // Wave 4c (transport and catalog): Customer Match and offline conversions through the Data Manager API, documented
  // beyond the captured catalog; its captured catalog is read at the API version AMCP sends (src/catalog-versions.ts).
  catalog: Object.freeze({
    supplemental: Object.freeze({actions: dataManagerActions, requires: 'catalog' as const}),
    version: Object.freeze({
      version: googleAdsVersion,
      action: googleAdsActionVersion,
      capture: currentGoogleAdsCapture,
      tool: extendGoogleAdsTool,
    }),
  }),
  // Its requests are compiled by its own compiler with ProtoJSON validation (src/compiler.ts): a vendor snapshot's
  // Google Ads routes are never delegated.
  delegated: Object.freeze({direct: true as const}),
  contracts: googleAdsContracts,
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
  review: Object.freeze({
    snapshot: googleSnapshot,
    verification: googleVerification,
    observed: googleObserved,
    verificationVersion: googleVerificationVersion,
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
  // Writes and campaigns (wave 4c): the guided Search recipes, then Performance Max (CMP-07).
  campaign: Object.freeze({
    recipes: Object.freeze([
      ...googleSearchRecipes.map(definition =>
        Object.freeze({
          definition,
          build: (b: JsonObject) => buildGoogleSearchRecipe(definition.id, b),
          context: googleSearchRecipeContext(definition.id),
        }),
      ),
      Object.freeze({definition: googlePmaxRecipe, build: buildGooglePmaxRecipe, context: googlePmaxContext}),
    ]),
    // A Search campaign, read and recreated paused; one all-or-nothing build by default (src/campaign-clone.ts,
    // src/campaign-runner.ts), whose customer is compared without the dashes of its display form.
    clone: Object.freeze({
      build: googleClone,
      allOrNothing: (steps: JsonObject[], accountId: unknown) =>
        composeGoogleBuild(steps, String(accountId).replace(/-/g, '')),
    }),
    // A launch's campaign enabled, a conversion launch gated on its account-default goals.
    activation: Object.freeze({
      steps: googleActivationSteps,
      record: googleActivationRecord,
      gates: googleActivationGates,
    }),
    // A plan step's predecessor resource names (src/campaign-preflight.ts).
    preflight: googlePreflight,
    // A build Google refused outright created nothing, and recipe_lookup's country and language constants
    // (src/campaign-runner.ts).
    refusedBuild: googleRefusedBuild,
    lookups: Object.freeze({
      country: Object.freeze({search: googleRecipeLookup}),
      language: Object.freeze({search: googleRecipeLookup}),
    }),
    // Its recipes' explicit bidding settings and Performance Max asset counts, as their eligibility shows them
    // (src/recipe-eligibility.ts).
    dependencyEvidence: (id: string, context: DependencyEvidenceContext) =>
      googleSearchDependencyEvidence(id, context) ?? googlePmaxDependencyEvidence(id, context),
  }),
  // Its parts of the reviewed write lifecycle (src/write-review.ts): targeting and the paused parents of new entities are
  // checked against the state, in that order, before the review's paused-parent check.
  writes: Object.freeze({
    // Its response contract for the one mutation (src/write-outcome.ts).
    confirms: googleConfirms,
    // A long mutation's parts of 25 under one approval (src/write-groups.ts).
    batch: googleBatch,
    // A mutation's state reads: its targets, the customer of a create, and each existing parent.
    snapshots: googleStateReads,
    prerequisites(plan: CompiledRequest, values: unknown[]) {
      validateGoogleTargetingState(plan, values);
      validateGooglePausedParents(plan, values);
    },
    // A per-service mutate refused outright applied nothing (src/write-rejection.ts, the rejected outcome).
    rejectionIsNonApplied: googleRejectionIsNonApplied,
    // An uncertain write's reconciliation (src/write-reconciliation.ts): its named creates found by name, the
    // operations' resources as the receipt of an update or removal.
    createdLookup: googleCreated,
    namedTargets: googleNamedTargets,
    // The owner's spending policy (src/spend-policy.ts): its switches over the user access a write grants, and the
    // money fields of the pinned Discovery document.
    accessPolicy: assertGoogleAccessPolicy,
    moneyFields: googleMoneyFields,
  }),
  // Wave 4c round 6 (w4c-arc6-tables): its rows of the shared tables (src/provider-hooks.ts orders them). Its account
  // aliases (src/parameters.ts).
  parameters: Object.freeze({accountAliases: Object.freeze(['account_id', 'customer_id'])}),
});

// Writes and campaigns (wave 4c): moved verbatim from rejectedBuild (src/campaign-runner.ts), after the runner's own
// failed-write checks.
/**
 * A build Google refused outright (HTTP 4xx other than a timeout or rate limit). The pinned v25 contract applies a
 * partialFailure-false googleAds:mutate "if and only if" every operation is valid, so a refused build created nothing
 * (the owner's decision 5, 2026-09-29).
 */
function googleRefusedBuild(step: JsonObject): boolean {
  return (
    /_google_ads_mutate$/.test(String(step.arguments?.action ?? '')) &&
    step.arguments?.payload?.partial_failure !== true &&
    step.arguments?.payload?.partialFailure !== true &&
    [400, 401, 403, 404, 409, 412, 422].includes(Number(step.error?.details?.http_status))
  );
}

// Writes and campaigns (wave 4c): moved verbatim from src/spend-policy.ts.
/**
 * Google Ads money fields classified from the pinned Discovery document (tools/google-bid-fields.mjs, WRT-01 stage B):
 * bid ceilings, floors and targets join the bid cap, and money that is neither a bid nor a measured budget is refused
 * as unsupported under a numeric policy. Ratios such as location_fraction_micros stay out.
 */
type GoogleMoneyFields = {bid: string[]; unsupported: string[]};
let googleMoney: GoogleMoneyFields | undefined;
export function googleMoneyFields(): GoogleMoneyFields {
  return (googleMoney ??= (() => {
    const fields = pinnedJson<{fields: GoogleMoneyFields}>('generated/google-bid-fields.json').fields;
    return {bid: [...fields.bid], unsupported: [...fields.unsupported]};
  })());
}

// Writes and campaigns (wave 4c): moved verbatim from confirmedMutationResult (src/write-outcome.ts).
/** One result per operation, each naming its target or a new resource of the mutated collection in the account. */
function googleConfirms(
  plan: CompiledRequest,
  _result: TransportResult,
  {data: d, body: b, last}: MutationResponse,
): boolean {
  return (
    Array.isArray(d.results) &&
    d.results.length === b.operations.length &&
    d.results.every((r: JsonObject, i: number) => {
      const op = b.operations[i],
        expected = op.remove ?? op.update?.resource_name ?? op.update?.resourceName;
      return (
        typeof r.resourceName === 'string' &&
        (expected
          ? r.resourceName === expected
          : r.resourceName.startsWith('customers/' + plan.accountId + '/' + last.replace(':mutate', '') + '/'))
      );
    })
  );
}

// Writes and campaigns (wave 4c): moved verbatim from splittableBatch (src/write-groups.ts).
/** A mutation's operations, unless temporary resource IDs link them. */
function googleBatch(payload: JsonObject): {key: string; items: unknown[]} | undefined {
  if (Array.isArray(payload.operations)) {
    // Temporary resource IDs (customers/1/campaigns/-1) link operations inside one request; they cannot be split.
    if (/"[^"]*customers\/[^"/]+\/[A-Za-z]+\/-\d/.test(JSON.stringify(payload.operations))) return undefined;
    return {key: 'operations', items: payload.operations};
  }
  return undefined;
}
