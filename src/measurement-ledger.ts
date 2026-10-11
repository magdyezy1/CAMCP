import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {measurementGoogleGoals} from './measurement-google-goals.js';
import {ga4AdminConfig} from './ga4-admin-config.js';
import {measurementEvents} from './measurement-events.js';
import {googleAdsCustomers} from './google-version.js';
import {assertGoogleAdsScope} from './google-contracts.js';
import {nativeAuthority} from './native-authority.js';
import {readinessBinding} from './readiness.js';
import {storedLogin} from './connection-authority.js';
import {writePause} from './owner-operations.js';
import {normalizeAccount} from './scope.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {MirrorError} from './errors.js';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';

/**
 * The provider-neutral measurement evidence ledger (MSR-03 slice C). One selected asset, six fixed layers, each
 * observed, unknown, unavailable or not_applicable with its source references. Adapters reuse the qualified reads:
 * Google Ads conversion goals (configuration and last reported activity), offline upload summaries and attribution
 * settings; GA4 Admin configuration and recent key-event counts. A layer is observed only from complete, in-scope
 * evidence; a failed, partial or foreign read leaves it unknown and never upgrades it. Identity, login or control
 * changes refuse the whole ledger. Nothing is saved and no provider mutation is possible.
 *
 * Meta datasets, Snapchat and TikTok pixels are not adapters yet: Meta pixel ownership is not learned from
 * act_{id}/adspixels and its Dataset Quality API is not in the pinned catalog (see docs/PRODUCT-WORKFLOWS.md).
 */
export const measurementLedgerLayers = [
  'configuration',
  'provider_observed_activity',
  'provider_diagnostics',
  'supplied_runtime_trace',
  'consent',
  'attribution_settings',
] as const;
type LayerName = (typeof measurementLedgerLayers)[number];
type State = 'observed' | 'unknown' | 'unavailable' | 'not_applicable';
interface Layer extends JsonObject {
  layer: LayerName;
  state: State;
  evidence: JsonObject | null;
  note: string;
}
const qualified = ['google_ads_native_action', 'ga4_native_action'];
const layer = (name: LayerName, state: State, evidence: JsonObject | null, note: string): Layer => ({
  layer: name,
  state,
  evidence,
  note,
});
const trace = () =>
  layer(
    'supplied_runtime_trace',
    'unavailable',
    null,
    'Supplied traces are inspected only in your browser and never reach AMCP. Use Inspect a sanitized event trace.',
  );
export const measurementLedgerLimits = Object.freeze({
  requests: 24,
  rows: 2000,
  bytes: 2 * 1024 * 1024,
  elapsed_ms: 60000,
});
const invalid = (message: string): never => {
  throw new MirrorError('MEASUREMENT_LEDGER_INVALID', message, {}, 502);
};
const count = (v: unknown) => (typeof v === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(v) ? v : null);
const rate = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);
const statuses = ['EXCELLENT', 'GOOD', 'NEEDS_ATTENTION', 'NO_RECENT_UPLOAD', 'UNKNOWN', 'UNSPECIFIED'],
  clients = ['GOOGLE_ADS_API', 'GOOGLE_ADS_WEB_CLIENT', 'ADS_DATA_CONNECTOR', 'UNKNOWN', 'UNSPECIFIED'],
  models = [
    'EXTERNAL',
    'GOOGLE_ADS_LAST_CLICK',
    'GOOGLE_SEARCH_ATTRIBUTION_FIRST_CLICK',
    'GOOGLE_SEARCH_ATTRIBUTION_LINEAR',
    'GOOGLE_SEARCH_ATTRIBUTION_TIME_DECAY',
    'GOOGLE_SEARCH_ATTRIBUTION_POSITION_BASED',
    'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN',
    'UNKNOWN',
    'UNSPECIFIED',
  ];
const errorKinds = [
  'mutateError',
  'conversionAdjustmentUploadError',
  'stringFormatError',
  'collectionSizeError',
  'fieldError',
  'dateError',
  'distinctError',
  'conversionUploadError',
  'notAllowlistedError',
  'stringLengthError',
];
const dateTime = (v: unknown) =>
  v === undefined || v === null || v === ''
    ? null
    : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)?(?:[+-]\d{2}:\d{2})?$/.test(v)
      ? v
      : invalid('Google Ads returned a malformed upload date.');

/** One GAQL collection of the selected customer, bounded and checked; rows must name only that customer. */
async function googleSearch(
  context: {
    store: Store;
    registry: Registry;
    transport: NativeTransport;
    actor: Actor;
    connection: JsonObject;
    auth: JsonObject;
    account: string;
    current: () => void;
    budget: ReportCollectionBudget;
    references: JsonObject[];
  },
  resource: string,
  query: string,
) {
  const {store, registry, transport, actor, account, current, budget, references} = context,
    base: CompiledRequest = {
      gateway: 'google_ads_native_action',
      accountId: account,
      action: 'AMCP_MEASUREMENT_LEDGER',
      method: 'POST',
      path: googleAdsCustomers + account + '/googleAds:search',
      query: {},
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'Measurement ledger read of one selected Google Ads customer',
      warnings: [],
    },
    rows: JsonObject[] = [],
    seen = new Set<string>(),
    pages: JsonObject[] = [];
  let token: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 5) invalid('A measurement ledger collection exceeded five pages.');
    const plan = {...base, body: {query, ...(token ? {pageToken: token} : {})}},
      authority = nativeAuthority(store, registry, actor, plan, context.connection as never, context.auth as never, current),
      response = await transport.request(plan, authority(), context.auth as never, undefined, {beforeAttempt: authority});
    authority();
    budget.check();
    const raw = response.data;
    if (
      response.status !== 200 ||
      !obj(raw) ||
      Object.keys(raw).some(k => !['results', 'nextPageToken', 'totalResultsCount', 'fieldMask', 'queryResourceConsumption'].includes(k)) ||
      (raw.results !== undefined && !Array.isArray(raw.results))
    )
      invalid('Google Ads returned a failed, partial or unrecognized measurement response.');
    const data = raw as JsonObject,
      items = (data.results ?? []) as JsonObject[];
    budget.rows(resource + ':' + page, items.length);
    for (const item of items) {
      if (!obj(item) || Object.keys(item).length !== 1 || !obj((item as JsonObject)[resource]))
        invalid('A measurement row was incomplete or mixed with another resource.');
      rows.push(item[resource] as JsonObject);
    }
    if (rows.length > 1000) invalid('A measurement ledger collection exceeded 1000 rows.');
    pages.push({page, rows: items.length, response_hash: fingerprint(data), captured_at: Date.now()});
    if (data.nextPageToken === undefined || data.nextPageToken === '') break;
    if (typeof data.nextPageToken !== 'string' || seen.has(data.nextPageToken) || !items.length)
      invalid('Measurement pagination was malformed, repeated or incomplete.');
    seen.add(data.nextPageToken);
    token = data.nextPageToken;
  }
  references.push({resource, request: {method: 'POST', path: base.path, query}, pages, rows: rows.length});
  return rows;
}

const uploadFields = [
  'resource_name',
  'client',
  'status',
  'total_event_count',
  'successful_event_count',
  'pending_event_count',
  'success_rate',
  'pending_rate',
  'last_upload_date_time',
  'alerts',
];
function uploadSummary(row: JsonObject, account: string) {
  const allowed = [
    'resourceName',
    'client',
    'status',
    'totalEventCount',
    'successfulEventCount',
    'pendingEventCount',
    'successRate',
    'pendingRate',
    'lastUploadDateTime',
    'alerts',
  ];
  if (
    Object.keys(row).some(k => !allowed.includes(k)) ||
    typeof row.resourceName !== 'string' ||
    !row.resourceName.startsWith('customers/' + account + '/offlineConversionUploadClientSummaries/') ||
    (row.client !== undefined && !clients.includes(row.client)) ||
    (row.status !== undefined && !statuses.includes(row.status)) ||
    (row.alerts !== undefined && (!Array.isArray(row.alerts) || row.alerts.length > 100))
  )
    invalid('An offline upload summary is outside the selected customer or incompletely described.');
  const alerts = ((row.alerts ?? []) as unknown[]).map(alert => {
    if (!obj(alert) || Object.keys(alert).some(k => !['error', 'errorPercentage'].includes(k)))
      invalid('An offline upload alert is malformed.');
    const error = (alert as JsonObject).error ?? {},
      kinds = obj(error) ? Object.keys(error) : [];
    if (
      !obj(error) ||
      kinds.length > 1 ||
      kinds.some(k => !errorKinds.includes(k) || typeof error[k] !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(error[k]))
    )
      invalid('An offline upload alert is malformed.');
    return {
      error_type: kinds[0] ?? null,
      error_code: kinds[0] ? error[kinds[0]] : null,
      error_percentage: rate((alert as JsonObject).errorPercentage),
    };
  });
  return {
    client: row.client ?? null,
    status: row.status ?? null,
    total_event_count: count(row.totalEventCount),
    successful_event_count: count(row.successfulEventCount),
    pending_event_count: count(row.pendingEventCount),
    success_rate: rate(row.successRate),
    pending_rate: rate(row.pendingRate),
    last_upload_date_time: dateTime(row.lastUploadDateTime),
    alerts: alerts.slice(0, 20),
  };
}
function attribution(row: JsonObject, account: string) {
  const allowed = [
    'resourceName',
    'name',
    'status',
    'primaryForGoal',
    'countingType',
    'clickThroughLookbackWindowDays',
    'viewThroughLookbackWindowDays',
    'attributionModelSettings',
  ];
  const settings = row.attributionModelSettings ?? {},
    days = (v: unknown) =>
      v === undefined || v === null ? null : typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : undefined;
  if (
    Object.keys(row).some(k => !allowed.includes(k)) ||
    typeof row.resourceName !== 'string' ||
    !new RegExp('^customers/' + account + '/conversionActions/[1-9][0-9]*$').test(row.resourceName) ||
    typeof row.name !== 'string' ||
    row.name.length > 256 ||
    row.status !== 'ENABLED' ||
    (row.primaryForGoal !== undefined && typeof row.primaryForGoal !== 'boolean') ||
    (row.countingType !== undefined && !['ONE_PER_CLICK', 'MANY_PER_CLICK', 'UNKNOWN', 'UNSPECIFIED'].includes(row.countingType)) ||
    days(row.clickThroughLookbackWindowDays) === undefined ||
    days(row.viewThroughLookbackWindowDays) === undefined ||
    !obj(settings) ||
    Object.keys(settings).some(k => !['attributionModel', 'dataDrivenModelStatus'].includes(k)) ||
    (settings.attributionModel !== undefined && !models.includes(settings.attributionModel)) ||
    (settings.dataDrivenModelStatus !== undefined &&
      !['AVAILABLE', 'STALE', 'EXPIRED', 'NEVER_GENERATED', 'UNKNOWN', 'UNSPECIFIED'].includes(settings.dataDrivenModelStatus))
  )
    invalid('A conversion action attribution setting is outside the selected customer or incompletely described.');
  return {
    resource_name: row.resourceName,
    name: row.name,
    primary_for_goal: row.primaryForGoal ?? null,
    counting_type: row.countingType ?? null,
    click_through_lookback_window_days: days(row.clickThroughLookbackWindowDays),
    view_through_lookback_window_days: days(row.viewThroughLookbackWindowDays),
    attribution_model: settings.attributionModel ?? null,
    data_driven_model_status: settings.dataDrivenModelStatus ?? null,
  };
}

async function googleLedger(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
) {
  const gateway = 'google_ads_native_action',
    account = normalizeAccount(gateway, input.account_id);
  if (typeof input.account_id !== 'string' || !/^\d{1,32}$/.test(account))
    bad('Choose the exact numeric Google Ads customer ID.');
  const goals = await measurementGoogleGoals(store, registry, transport, credentials, actor, {
    gateway,
    account_id: account,
    connection_id: input.connection_id,
  });
  const connection = store.resolveConnection(actor, gateway, account, goals.scope.connection_id),
    binding = readinessBinding(connection),
    login = storedLogin(store, connection),
    pause = fingerprint(writePause(store, actor.tenantId));
  // The same fence as the goals read: the actor, the login's readiness and credential, and the write pause.
  const current = () => {
    store.assertActorActive(actor);
    const now = store.resolveConnection(actor, gateway, account, connection.id);
    if (
      readinessBinding(now) !== binding ||
      storedLogin(store, now) !== login ||
      fingerprint(writePause(store, actor.tenantId)) !== pause
    )
      throw new MirrorError(
        'STATE_CHANGED',
        'Account access, the login or workspace controls changed during the read. Read the measurement ledger again.',
      );
  };
  const configuration = goals.complete
      ? layer(
          'configuration',
          'observed',
          {
            dependency_statuses: goals.dependency_statuses,
            summary: goals.summary,
            goals: goals.goals,
            primary_actions: (goals.primary_actions as JsonObject[]).map(({activity: _activity, ...a}) => a),
          },
          'Account-default goals and enabled primary conversion actions from two matching reads.',
        )
      : layer(
          'configuration',
          'unknown',
          {reason: goals.reason ?? goals.error?.code ?? null},
          'The conversion configuration could not be completely inspected, so no configuration is reported.',
        ),
    activity = !goals.complete
      ? layer('provider_observed_activity', 'unknown', null, 'Without complete goals, reported activity stays unknown.')
      : goals.dependency_statuses.reported_conversion_activity === 'ready'
        ? layer(
            'provider_observed_activity',
            'observed',
            {
              primary_actions: (goals.primary_actions as JsonObject[]).map(a => ({
                resource_name: a.resource_name,
                ...a.activity,
              })),
            },
            'Google Ads reported a last conversion date and a last tag detection for every primary action.',
          )
        : layer(
            'provider_observed_activity',
            'unknown',
            {
              primary_last_conversion_known: goals.summary.primary_last_conversion_known ?? 0,
              primary_last_tag_known: goals.summary.primary_last_tag_known ?? 0,
              matching_primary_actions: goals.summary.matching_primary_actions ?? 0,
            },
            'Google Ads did not report activity for every primary action, so delivery stays unknown.',
          );
  const references: JsonObject[] = [...((goals.source_references as JsonObject[]) ?? [])];
  let diagnostics: Layer, attributionLayer: Layer, requests = 0;
  if (!goals.complete) {
    diagnostics = layer('provider_diagnostics', 'unknown', null, 'Only the exact client customer that records its own conversions is read.');
    attributionLayer = layer('attribution_settings', 'unknown', null, 'Only the exact client customer that records its own conversions is read.');
  } else {
    current();
    assertGoogleAdsScope(connection);
    const auth = await credentials.get(connection),
      budget = new ReportCollectionBudget(undefined, fingerprint({account, at: Date.now()}), state => {
        requests = Number(state.requests) || 0;
      }, measurementLedgerLimits),
      context = {store, registry, transport, actor, connection: connection as never, auth: auth as never, account, current, budget, references};
    const read = async (name: LayerName, run: () => Promise<Layer>) => {
      try {
        return await budget.run(run);
      } catch (error) {
        // A changed actor, login or control refuses the whole ledger; any other failure leaves only this layer unknown.
        current();
        if (!(error instanceof MirrorError)) throw error;
        return layer(name, 'unknown', {error: error.code}, 'This read failed or was incomplete, so the layer stays unknown.');
      }
    };
    try {
      diagnostics = await read('provider_diagnostics', async () => {
        const rows = (
          await googleSearch(
            context,
            'offlineConversionUploadClientSummary',
            'SELECT ' +
              uploadFields.map(f => 'offline_conversion_upload_client_summary.' + f).join(', ') +
              ' FROM offline_conversion_upload_client_summary',
          )
        ).map(row => uploadSummary(row, account));
        return rows.length
          ? layer('provider_diagnostics', 'observed', {upload_summaries: rows}, 'Google Ads offline conversion upload summaries by upload client.')
          : layer('provider_diagnostics', 'not_applicable', {upload_summaries: []}, 'Google Ads reported no offline conversion uploads for this customer.');
      });
      attributionLayer = await read('attribution_settings', async () => {
        const rows = (
          await googleSearch(
            context,
            'conversionAction',
            'SELECT conversion_action.resource_name, conversion_action.name, conversion_action.status, conversion_action.primary_for_goal, conversion_action.counting_type, conversion_action.click_through_lookback_window_days, conversion_action.view_through_lookback_window_days, conversion_action.attribution_model_settings.attribution_model, conversion_action.attribution_model_settings.data_driven_model_status FROM conversion_action WHERE conversion_action.status = \'ENABLED\'',
          )
        )
          .map(row => attribution(row, account))
          .sort((a, b) => Number(b.primary_for_goal === true) - Number(a.primary_for_goal === true) || a.resource_name.localeCompare(b.resource_name));
        return rows.length
          ? layer('attribution_settings', 'observed', {actions: rows.slice(0, 20), action_count: rows.length}, 'Configured attribution model and lookback windows of enabled conversion actions.')
          : layer('attribution_settings', 'not_applicable', {actions: [], action_count: 0}, 'The customer has no enabled conversion action.');
      });
    } finally {
      budget.close();
    }
    current();
  }
  return {
    scope: {gateway, connection_id: connection.id, account_id: account},
    layers: [
      configuration,
      activity,
      diagnostics,
      trace(),
      layer('consent', 'unavailable', null, 'This read has no Google Ads consent setting. The Tag Manager audit reports the consent configuration of tags.'),
      attributionLayer,
    ],
    source_references: references,
    network_requests: (Number(goals.network_requests) || 0) + requests,
  };
}

async function ga4Ledger(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  call: ToolCall,
  actor: Actor,
  input: JsonObject,
) {
  const gateway = 'ga4_native_action',
    config = await ga4AdminConfig(store, registry, transport, credentials, actor, {
      gateway,
      account_id: input.account_id,
      connection_id: input.connection_id,
    }),
    connection = store.resolveConnection(actor, gateway, input.account_id, config.scope.connection_id),
    login = fingerprint(storedLogin(store, connection));
  const current = () => {
    store.assertActorActive(actor);
    const now = store.resolveConnection(actor, gateway, input.account_id, connection.id);
    if (fingerprint(storedLogin(store, now)) !== login)
      throw new MirrorError('CONNECTION_AUTHORITY_CHANGED', 'This GA4 login changed during the read. Read the measurement ledger again.', {}, 409);
  };
  const keyEvents = (config.key_events as JsonObject[])
    .map(k => k.event_name as string)
    .filter(name => /^\p{L}[\p{L}\p{N}_]{0,39}$/u.test(name))
    .slice(0, 20);
  let activity: Layer,
    requests = Number(config.network_requests) || 0;
  const references: JsonObject[] = [...((config.source_references as JsonObject[]) ?? [])];
  if (!(config.key_events as JsonObject[]).length)
    activity = layer('provider_observed_activity', 'not_applicable', {key_events: []}, 'The property has no key event to observe.');
  else if (!keyEvents.length)
    activity = layer('provider_observed_activity', 'unknown', null, 'No key event name can be read as an exact realtime event name.');
  else {
    try {
      const events = await measurementEvents(store, call, actor, {
        gateway,
        account_id: input.account_id,
        connection_id: connection.id,
        requirements: {event_names: keyEvents, minutes: 30},
      });
      requests += 1;
      current();
      references.push({resource: 'runRealtimeReport', source_hash: events.source_hash, event_names: keyEvents});
      activity =
        events.state === 'observed'
          ? layer('provider_observed_activity', 'observed', {window_minutes: 30, events: events.events}, 'GA4 realtime counts of the property key events in the last 30 minutes.')
          : layer('provider_observed_activity', 'unknown', {window_minutes: 30, events: events.events}, 'No key event was reported in the last 30 minutes. Absence does not establish a broken tag.');
    } catch (error) {
      current();
      if (!(error instanceof MirrorError)) throw error;
      activity = layer('provider_observed_activity', 'unknown', {error: error.code}, 'The realtime read failed or was incomplete, so activity stays unknown.');
    }
  }
  const streams = config.data_streams as JsonObject[];
  return {
    scope: {gateway, connection_id: connection.id, account_id: input.account_id},
    layers: [
      layer(
        'configuration',
        'observed',
        {
          summary: config.summary,
          key_events: (config.key_events as JsonObject[]).slice(0, 20),
          data_streams: streams.slice(0, 20),
          checks: {test_identifier_dimension: config.checks.test_identifier_dimension, web_streams: config.checks.web_streams},
        },
        'Key events, data streams and custom definitions from complete GA4 Admin reads.',
      ),
      activity,
      layer('provider_diagnostics', 'unavailable', null, 'GA4 offers no event diagnostics API; DebugView is only in the GA4 interface.'),
      trace(),
      layer('consent', 'unavailable', null, 'The GA4 Admin API in use exposes no consent settings. The Tag Manager audit reports the consent configuration of tags.'),
      layer('attribution_settings', 'unavailable', null, 'GA4 attribution settings are only in the Admin API alpha version, which AMCP has not pinned.'),
    ],
    source_references: references,
    network_requests: requests,
  };
}

export async function measurementLedger(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  call: ToolCall,
  actor: Actor,
  input: JsonObject,
): Promise<JsonObject> {
  if (!qualified.includes(input.gateway))
    bad('The measurement ledger covers a Google Ads customer or a GA4 property.', 'MEASUREMENT_LEDGER_UNQUALIFIED', {qualified});
  validate(input.requirements ?? {}, []);
  const requested_at = Date.now(),
    out =
      input.gateway === 'google_ads_native_action'
        ? await googleLedger(store, registry, transport, credentials, actor, input)
        : await ga4Ledger(store, registry, transport, credentials, call, actor, input);
  const layers = out.layers as Layer[];
  if (layers.map(l => l.layer).join() !== measurementLedgerLayers.join()) invalid('The measurement ledger layers are incomplete.');
  return {
    record_kind: 'measurement_ledger',
    scope: out.scope,
    requested_at,
    captured_at: Date.now(),
    layers,
    summary: Object.fromEntries(
      (['observed', 'unknown', 'unavailable', 'not_applicable'] as State[]).map(s => [s, layers.filter(l => l.state === s).length]),
    ),
    checks: {event_delivery: 'unverified', deduplication: 'unverified', consent: 'unverified', attribution: 'unverified'},
    source_references: out.source_references,
    network_requests: out.network_requests,
    provider_mutations: 0,
    snapshot_saved: false,
    meaning:
      'Measurement evidence for one asset in six fixed layers. A layer is observed only from complete evidence of the selected asset; everything else stays unknown, unavailable or not applicable. Configuration and reported activity do not prove that conversions are delivered, deduplicated, consented or attributed. Nothing was saved.',
  };
}
