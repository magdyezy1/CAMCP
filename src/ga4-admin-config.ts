import {nativeAuthority} from './native-authority.js';
import {ScopeGuard} from './scope.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {storedLogin} from './connection-authority.js';
import {bad, fingerprint, obj, validate} from './workspace-core.js';
import {MirrorError} from './errors.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';

/**
 * GA4 Admin configuration reads (MSR-03 slice B): key events, custom dimensions and metrics, data streams with their
 * type and measurement ID, Google Ads links and data retention of one exact property, through fixed GET routes of the
 * pinned Admin API v1beta (.mirror/VENDOR/ga4-admin-v1beta.json) under the existing analytics read permission.
 * Every list is read completely (bounded pages, no repeated token), every row must belong to the selected property and
 * match the pinned schema, and the actor, login and permissions are rechecked before and after each request. Nothing is
 * saved; configuration is not proof that events are sent, counted, consented or attributed.
 */
const gateway = 'ga4_native_action',
  origin = 'https://analyticsadmin.googleapis.com',
  source = 'https://developers.google.com/analytics/devguides/config/admin/v1/rest';
export const ga4AdminConfigLimits = Object.freeze({
  requests: 60,
  rows: 5000,
  bytes: 4 * 1024 * 1024,
  elapsed_ms: 60000,
});
export const ga4AdminConfigSections = [
  'key_events',
  'custom_dimensions',
  'custom_metrics',
  'data_streams',
  'google_ads_links',
  'data_retention',
] as const;
type Section = (typeof ga4AdminConfigSections)[number];
const lists: Record<Exclude<Section, 'data_retention'>, {path: string; key: string; resource: string}> = {
  key_events: {path: 'keyEvents', key: 'keyEvents', resource: 'keyEvents'},
  custom_dimensions: {path: 'customDimensions', key: 'customDimensions', resource: 'customDimensions'},
  custom_metrics: {path: 'customMetrics', key: 'customMetrics', resource: 'customMetrics'},
  data_streams: {path: 'dataStreams', key: 'dataStreams', resource: 'dataStreams'},
  google_ads_links: {path: 'googleAdsLinks', key: 'googleAdsLinks', resource: 'googleAdsLinks'},
};
const readScopes = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/analytics.edit',
  'https://www.googleapis.com/auth/analytics',
];
const numericId = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v);
const invalid = (message: string, details: JsonObject = {}): never => {
  throw new MirrorError('GA4_CONFIG_INVALID', message, {source, ...details}, 502);
};
const text = (v: unknown, max = 256) =>
  typeof v === 'string' && [...v].length <= max && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(v);
const optionalText = (v: unknown, max = 256) => v === undefined || text(v, max);
const optionalBoolean = (v: unknown) => v === undefined || typeof v === 'boolean';
const time = (v: unknown) =>
  v === undefined || (typeof v === 'string' && !Number.isNaN(Date.parse(v)) && v.length <= 40);
const only = (row: JsonObject, allowed: string[], what: string) => {
  if (Object.keys(row).some(k => !allowed.includes(k)))
    invalid('GA4 returned configuration fields outside the pinned Admin API contract.', {resource: what});
};
const member = (v: unknown, values: string[]) => v === undefined || (typeof v === 'string' && values.includes(v));

/** The projections. Each refuses a row of another property, an unknown enum or a malformed field. */
function keyEvent(row: JsonObject, property: string) {
  only(row, ['name', 'eventName', 'createTime', 'deletable', 'custom', 'countingMethod', 'defaultValue'], 'key event');
  const value = row.defaultValue;
  if (
    typeof row.name !== 'string' ||
    !new RegExp('^properties/' + property + '/keyEvents/[A-Za-z0-9_-]{1,64}$').test(row.name) ||
    !text(row.eventName, 100) ||
    !row.eventName ||
    !time(row.createTime) ||
    !optionalBoolean(row.deletable) ||
    !optionalBoolean(row.custom) ||
    !member(row.countingMethod, ['COUNTING_METHOD_UNSPECIFIED', 'ONCE_PER_EVENT', 'ONCE_PER_SESSION']) ||
    (value !== undefined &&
      (!obj(value) ||
        Object.keys(value).some(k => !['numericValue', 'currencyCode'].includes(k)) ||
        (value.numericValue !== undefined &&
          (typeof value.numericValue !== 'number' || !Number.isFinite(value.numericValue))) ||
        (value.currencyCode !== undefined &&
          (typeof value.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(value.currencyCode)))))
  )
    invalid('A key event is outside the selected property or incompletely described.');
  return {
    name: row.name,
    event_name: row.eventName,
    counting_method: row.countingMethod ?? null,
    custom: row.custom ?? null,
    deletable: row.deletable ?? null,
    default_value: value
      ? {numeric_value: value.numericValue ?? null, currency_code: value.currencyCode ?? null}
      : null,
    create_time: row.createTime ?? null,
  };
}
function customDimension(row: JsonObject, property: string) {
  only(
    row,
    ['name', 'parameterName', 'displayName', 'description', 'scope', 'disallowAdsPersonalization'],
    'custom dimension',
  );
  if (
    typeof row.name !== 'string' ||
    !new RegExp('^properties/' + property + '/customDimensions/[A-Za-z0-9_-]{1,64}$').test(row.name) ||
    !text(row.parameterName, 100) ||
    !row.parameterName ||
    !optionalText(row.displayName) ||
    !optionalText(row.description, 300) ||
    !member(row.scope, ['DIMENSION_SCOPE_UNSPECIFIED', 'EVENT', 'USER', 'ITEM']) ||
    !optionalBoolean(row.disallowAdsPersonalization)
  )
    invalid('A custom dimension is outside the selected property or incompletely described.');
  return {
    name: row.name,
    parameter_name: row.parameterName,
    display_name: row.displayName ?? null,
    scope: row.scope ?? null,
    disallow_ads_personalization: row.disallowAdsPersonalization ?? null,
  };
}
const units = [
  'MEASUREMENT_UNIT_UNSPECIFIED',
  'STANDARD',
  'CURRENCY',
  'FEET',
  'METERS',
  'KILOMETERS',
  'MILES',
  'MILLISECONDS',
  'SECONDS',
  'MINUTES',
  'HOURS',
];
function customMetric(row: JsonObject, property: string) {
  only(
    row,
    ['name', 'parameterName', 'displayName', 'description', 'measurementUnit', 'scope', 'restrictedMetricType'],
    'custom metric',
  );
  if (
    typeof row.name !== 'string' ||
    !new RegExp('^properties/' + property + '/customMetrics/[A-Za-z0-9_-]{1,64}$').test(row.name) ||
    !text(row.parameterName, 100) ||
    !row.parameterName ||
    !optionalText(row.displayName) ||
    !optionalText(row.description, 300) ||
    !member(row.measurementUnit, units) ||
    !member(row.scope, ['METRIC_SCOPE_UNSPECIFIED', 'EVENT']) ||
    (row.restrictedMetricType !== undefined &&
      (!Array.isArray(row.restrictedMetricType) ||
        row.restrictedMetricType.some(
          (v: unknown) =>
            !member(v, ['RESTRICTED_METRIC_TYPE_UNSPECIFIED', 'COST_DATA', 'REVENUE_DATA']) || v === undefined,
        )))
  )
    invalid('A custom metric is outside the selected property or incompletely described.');
  return {
    name: row.name,
    parameter_name: row.parameterName,
    display_name: row.displayName ?? null,
    scope: row.scope ?? null,
    measurement_unit: row.measurementUnit ?? null,
    restricted_metric_types: row.restrictedMetricType ?? [],
  };
}
const streamTypes = ['WEB_DATA_STREAM', 'ANDROID_APP_DATA_STREAM', 'IOS_APP_DATA_STREAM'];
function dataStream(row: JsonObject, property: string) {
  only(
    row,
    [
      'name',
      'type',
      'displayName',
      'createTime',
      'updateTime',
      'webStreamData',
      'androidAppStreamData',
      'iosAppStreamData',
    ],
    'data stream',
  );
  const id =
      typeof row.name === 'string'
        ? new RegExp('^properties/' + property + '/dataStreams/([1-9][0-9]{0,19})$').exec(row.name)?.[1]
        : undefined,
    web = row.webStreamData,
    android = row.androidAppStreamData,
    ios = row.iosAppStreamData,
    nested = (v: unknown, keys: string[]) =>
      v === undefined ||
      (obj(v) && Object.keys(v).every(k => keys.includes(k)) && Object.values(v).every(x => text(x, 2048)));
  if (
    !id ||
    typeof row.type !== 'string' ||
    !streamTypes.includes(row.type) ||
    !optionalText(row.displayName) ||
    !time(row.createTime) ||
    !time(row.updateTime) ||
    !nested(web, ['measurementId', 'firebaseAppId', 'defaultUri']) ||
    !nested(android, ['firebaseAppId', 'packageName']) ||
    !nested(ios, ['firebaseAppId', 'bundleId']) ||
    // Exactly the stream data of its own type, never another type's.
    [web, android, ios].filter(v => v !== undefined).length > 1 ||
    (web !== undefined && row.type !== 'WEB_DATA_STREAM') ||
    (android !== undefined && row.type !== 'ANDROID_APP_DATA_STREAM') ||
    (ios !== undefined && row.type !== 'IOS_APP_DATA_STREAM') ||
    (web?.measurementId !== undefined && !/^G-[A-Z0-9]{4,20}$/.test(web.measurementId))
  )
    invalid('A data stream is outside the selected property or incompletely described.');
  return {
    name: row.name,
    stream_id: id,
    type: row.type,
    display_name: row.displayName ?? null,
    measurement_id: web?.measurementId ?? null,
    default_uri: web?.defaultUri ?? null,
    firebase_app_id: (web ?? android ?? ios)?.firebaseAppId ?? null,
    package_name: android?.packageName ?? null,
    bundle_id: ios?.bundleId ?? null,
  };
}
function googleAdsLink(row: JsonObject, property: string) {
  only(
    row,
    [
      'name',
      'customerId',
      'canManageClients',
      'adsPersonalizationEnabled',
      'createTime',
      'updateTime',
      'creatorEmailAddress',
    ],
    'Google Ads link',
  );
  if (
    typeof row.name !== 'string' ||
    !new RegExp('^properties/' + property + '/googleAdsLinks/[A-Za-z0-9_-]{1,64}$').test(row.name) ||
    typeof row.customerId !== 'string' ||
    !/^[0-9]{1,32}$/.test(row.customerId) ||
    !optionalBoolean(row.canManageClients) ||
    !optionalBoolean(row.adsPersonalizationEnabled) ||
    !time(row.createTime) ||
    !time(row.updateTime) ||
    !optionalText(row.creatorEmailAddress, 320)
  )
    invalid('A Google Ads link is outside the selected property or incompletely described.');
  // The creator's e-mail address is personal data: it is checked and never returned or kept.
  return {
    name: row.name,
    customer_id: row.customerId,
    can_manage_clients: row.canManageClients ?? null,
    ads_personalization_enabled: row.adsPersonalizationEnabled ?? null,
  };
}
const retentions = [
  'RETENTION_DURATION_UNSPECIFIED',
  'TWO_MONTHS',
  'FOURTEEN_MONTHS',
  'TWENTY_SIX_MONTHS',
  'THIRTY_EIGHT_MONTHS',
  'FIFTY_MONTHS',
];
function dataRetention(row: unknown, property: string) {
  if (!obj(row)) invalid('GA4 returned no data retention settings.');
  const r = row as JsonObject;
  only(r, ['name', 'eventDataRetention', 'userDataRetention', 'resetUserDataOnNewActivity'], 'data retention');
  if (
    r.name !== 'properties/' + property + '/dataRetentionSettings' ||
    !member(r.eventDataRetention, retentions) ||
    !member(r.userDataRetention, retentions) ||
    !optionalBoolean(r.resetUserDataOnNewActivity)
  )
    invalid('Data retention settings are outside the selected property or incompletely described.');
  return {
    event_data_retention: r.eventDataRetention ?? null,
    user_data_retention: r.userDataRetention ?? null,
    reset_user_data_on_new_activity: r.resetUserDataOnNewActivity ?? null,
  };
}
const project = {
  key_events: keyEvent,
  custom_dimensions: customDimension,
  custom_metrics: customMetric,
  data_streams: dataStream,
  google_ads_links: googleAdsLink,
} as const;

export async function ga4AdminConfig(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
): Promise<JsonObject> {
  if (input.gateway !== gateway)
    bad('GA4 property configuration uses gateway ga4_native_action.', 'MEASUREMENT_CONFIG_UNQUALIFIED');
  if (!numericId(input.account_id)) bad('Choose the exact numeric GA4 property ID.');
  const requirements = input.requirements ?? {};
  validate(requirements, ['sections']);
  const sections: Section[] = requirements.sections ?? [...ga4AdminConfigSections];
  if (
    !Array.isArray(sections) ||
    !sections.length ||
    sections.some(s => !ga4AdminConfigSections.includes(s)) ||
    new Set(sections).size !== sections.length
  )
    bad(
      'Choose sections from key_events, custom_dimensions, custom_metrics, data_streams, google_ads_links and data_retention.',
    );
  const property = input.account_id,
    connection = store.resolveConnection(actor, gateway, property, input.connection_id);
  if (!connection.scopes.some(s => readScopes.includes(s)))
    bad('This login requires Google Analytics read permission.', 'INSUFFICIENT_SCOPE');
  const login = fingerprint(storedLogin(store, connection)),
    plan = (path: string, query: JsonObject = {}): CompiledRequest => ({
      gateway,
      accountId: property,
      action: 'AMCP_GA4_ADMIN_CONFIG',
      method: 'GET',
      origin,
      path: '/v1beta/properties/' + property + path,
      query,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'Pinned GA4 Admin API v1beta configuration read of one selected property',
      warnings: [],
    });
  const current = () => {
    const c = store.resolveConnection(actor, gateway, property, connection.id);
    if (!c.scopes.some(s => readScopes.includes(s)))
      bad('This login requires Google Analytics read permission.', 'INSUFFICIENT_SCOPE');
    if (fingerprint(storedLogin(store, c)) !== login)
      throw new MirrorError(
        'CONNECTION_AUTHORITY_CHANGED',
        'This GA4 login changed during the read. Read the property configuration again.',
        {},
        409,
      );
  };
  new ScopeGuard(registry, store).authorize(plan(''), connection);
  current();
  const auth = await credentials.get(connection),
    requested_at = Date.now(),
    references: JsonObject[] = [];
  let usage: JsonObject = {};
  const scope = {gateway, connection_id: connection.id, property_id: property, sections};
  const budget = new ReportCollectionBudget(
    undefined,
    fingerprint({scope, requested_at}),
    state => {
      usage = state;
    },
    ga4AdminConfigLimits,
  );
  const get = async (request: CompiledRequest) => {
    const authority = nativeAuthority(store, registry, actor, request, connection, auth, current),
      response = await transport.request(request, authority(), auth, undefined, {beforeAttempt: authority});
    authority();
    budget.check();
    if (response.status !== 200 || !obj(response.data) || (response.data as JsonObject).error !== undefined)
      invalid('GA4 returned a failed, partial or unrecognized configuration response.');
    return response.data as JsonObject;
  };
  const collect = async (section: Exclude<Section, 'data_retention'>) => {
    const {path, key} = lists[section],
      rows: JsonObject[] = [],
      seen = new Set<string>(),
      pages: JsonObject[] = [];
    let token: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 10) invalid('A GA4 configuration list exceeded ten pages.');
      const request = plan('/' + path, {pageSize: 200, ...(token ? {pageToken: token} : {})}),
        data = await get(request);
      only(data, [key, 'nextPageToken'], 'list');
      const items = data[key] ?? [];
      if (!Array.isArray(items)) invalid('GA4 returned a malformed configuration list.');
      budget.rows(section + ':' + page, items.length);
      for (const item of items) {
        if (!obj(item)) invalid('GA4 returned a malformed configuration row.');
        rows.push(item);
      }
      if (rows.length > 1000) invalid('A GA4 configuration list exceeded 1000 rows.');
      pages.push({page, rows: items.length, response_hash: fingerprint(data), captured_at: Date.now()});
      if (data.nextPageToken === undefined || data.nextPageToken === '') break;
      if (!text(data.nextPageToken, 4096) || seen.has(data.nextPageToken) || !items.length)
        invalid('GA4 configuration pagination was malformed, repeated or incomplete.');
      seen.add(data.nextPageToken);
      token = data.nextPageToken;
    }
    const projected = rows.map(row => project[section](row, property) as JsonObject);
    if (new Set(projected.map(r => r.name)).size !== projected.length)
      invalid('GA4 returned the same configuration resource twice.');
    references.push({
      section,
      request: {method: 'GET', origin, path: '/v1beta/properties/' + property + '/' + path},
      pages,
      collection_hash: fingerprint(pages.map(({page, rows, response_hash}) => ({page, rows, response_hash}))),
      rows: projected.length,
    });
    return projected.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  };
  try {
    return await budget.run(async () => {
      const out: JsonObject = {};
      for (const section of ga4AdminConfigSections) {
        if (!sections.includes(section)) continue;
        if (section === 'data_retention') {
          const request = plan('/dataRetentionSettings'),
            data = await get(request);
          out.data_retention = dataRetention(data, property);
          references.push({
            section,
            request: {method: 'GET', origin, path: request.path},
            pages: [{page: 0, rows: 1, response_hash: fingerprint(data), captured_at: Date.now()}],
            rows: 1,
          });
        } else out[section] = await collect(section);
      }
      current();
      budget.check();
      const dimensions = (out.custom_dimensions ?? []) as JsonObject[],
        streams = (out.data_streams ?? []) as JsonObject[];
      return {
        record_kind: 'measurement_ga4_config',
        scope,
        requested_at,
        captured_at: Date.now(),
        complete: true,
        ...out,
        summary: Object.fromEntries(
          sections.filter(s => s !== 'data_retention').map(s => [s, (out[s] as JsonObject[]).length]),
        ),
        checks: {
          // The identity read (measurement_event_identity) needs an event-scoped amcp_test_id dimension.
          test_identifier_dimension: !sections.includes('custom_dimensions')
            ? 'not_read'
            : dimensions.some(d => d.parameter_name === 'amcp_test_id' && d.scope === 'EVENT')
              ? 'registered'
              : dimensions.some(d => d.parameter_name === 'amcp_test_id')
                ? 'other_scope'
                : 'not_registered',
          // GA4 deduplicates purchases by transaction ID only on web streams.
          web_streams: !sections.includes('data_streams')
            ? null
            : streams.filter(s => s.type === 'WEB_DATA_STREAM').length,
          event_delivery: 'unverified',
          deduplication: 'unverified',
          consent: 'unverified',
          attribution: 'unverified',
        },
        source_references: references,
        network_requests: usage.requests,
        collection_usage: {
          requests: usage.requests,
          rows: usage.rows,
          bytes: usage.bytes,
          elapsed_ms: usage.elapsed_ms,
        },
        provider_mutations: 0,
        snapshot_saved: false,
        meaning:
          'Current GA4 property configuration from complete bounded Admin API reads. Configuration is not proof that events are sent, counted, deduplicated, consented or attributed. Nothing was saved.',
      };
    });
  } catch (error) {
    // A revoked login or actor must refuse the response, never become an incomplete success.
    current();
    store.assertActorActive(actor);
    if (error instanceof MirrorError && error.code === 'REPORT_COLLECTION_LIMIT')
      throw new MirrorError(
        'GA4_CONFIG_LIMIT',
        'The GA4 property configuration exceeded its read limits. Choose fewer sections.',
        {dimension: error.details.dimension},
        422,
      );
    throw error;
  } finally {
    budget.close();
  }
}
