import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {Actor, CompiledRequest, Connection, JsonObject} from './types.js';
import {measurementGoogleGoals} from './measurement-google-goals.js';
import {ga4AdminConfig} from './ga4-admin-config.js';
import {measurementEvents} from './measurement-events.js';
import {googleAdsContract, googleAdsCustomers, googleAdsVersion} from './google-version.js';
import {assertGoogleAdsScope} from './google-contracts.js';
import {pinnedJson} from './pinned-json.js';
import {nativeAuthority} from './native-authority.js';
import {readinessBinding} from './readiness.js';
import {storedLogin} from './connection-authority.js';
import {writePause} from './owner-operations.js';
import {ScopeGuard, normalizeAccount} from './scope.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {MirrorError} from './errors.js';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';

/**
 * The provider-neutral measurement evidence ledger (MSR-03 slice C): one selected asset, six fixed layers, each
 * observed, unknown, unavailable or not_applicable with a stable reason code, its evidence and its source references.
 *
 * Adapters reuse qualified reads. Google Ads: the conversion goals read (configuration and last reported activity),
 * offline conversion upload client summaries (diagnostics) and the attribution settings of enabled conversion actions.
 * GA4: the Admin configuration read and recent realtime counts of the property's key events. A layer is observed only
 * from complete evidence of the selected asset; a failed, partial, foreign or thresholded read leaves that layer unknown
 * and never upgrades it. A change of actor, login, account access or (for Google Ads) the write pause refuses the whole
 * ledger. Every read is bounded by one ledger allowance; nothing is saved and no provider mutation is possible.
 *
 * Meta datasets, Snapchat and TikTok pixels have no adapter: AMCP does not learn pixel ownership from an ad account, the
 * Meta Dataset Quality API is not pinned, and owner decision P8 (the measurement scope) is open.
 */
export const measurementLedgerLayers = [
  'configuration',
  'provider_observed_activity',
  'provider_diagnostics',
  'supplied_runtime_trace',
  'consent',
  'attribution_settings',
] as const;
export const measurementLedgerStates = ['observed', 'unknown', 'unavailable', 'not_applicable'] as const;
type LayerName = (typeof measurementLedgerLayers)[number];
type State = (typeof measurementLedgerStates)[number];
interface Layer extends JsonObject {
  layer: LayerName;
  state: State;
  reason: string;
  evidence: JsonObject | null;
  note: string;
}
const qualified = ['google_ads_native_action', 'ga4_native_action'];
/** The whole ledger: the nested goals or configuration read keeps its own tighter bounds inside this allowance. */
export const measurementLedgerLimits = Object.freeze({
  requests: 96,
  rows: 8000,
  bytes: 8 * 1024 * 1024,
  elapsed_ms: 150000,
});
/** The ledger's own Google Ads collections (upload summaries and attribution settings). */
export const measurementLedgerReadLimits = Object.freeze({
  requests: 24,
  rows: 2000,
  bytes: 2 * 1024 * 1024,
  elapsed_ms: 60000,
});
const layer = (name: LayerName, state: State, reason: string, evidence: JsonObject | null, note: string): Layer => ({
  layer: name,
  state,
  reason,
  evidence,
  note,
});
const trace = () =>
  layer(
    'supplied_runtime_trace',
    'unavailable',
    'browser_only',
    null,
    'Supplied traces are inspected only in the browser and never reach AMCP. Use Inspect a sanitized event trace on the Measurement page.',
  );
const invalid = (message: string): never => {
  throw new MirrorError('MEASUREMENT_LEDGER_INVALID', message, {}, 502);
};

// Pinned Google Ads v25 enums: an unknown value is refused, never mapped.
const googleSchema = (name: string) =>
  pinnedJson('.mirror/VENDOR/' + googleAdsContract + '.json').document.schemas[
    'GoogleAdsGoogleads' + googleAdsVersion.toUpperCase() + 'Resources_' + name
  ];
const pinned = (name: string, field: string, value: unknown) =>
  typeof value === 'string' && (googleSchema(name)?.properties?.[field]?.enum ?? []).includes(value);
const int64 = (v: unknown) => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(v);
const ratio = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const uploadTime = (v: unknown) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:[+-]\d{2}:\d{2})?$/.test(v);

interface GoogleContext {
  store: Store;
  registry: Registry;
  transport: NativeTransport;
  actor: Actor;
  connection: Connection;
  auth: JsonObject;
  account: string;
  fence: () => void;
  budget: ReportCollectionBudget;
  references: JsonObject[];
}
const googleBase = (account: string): CompiledRequest => ({
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
});

/** One complete GAQL collection of the selected customer: bounded pages, no repeated token, one resource per row. */
async function googleSearch(context: GoogleContext, resource: string, query: string) {
  const {store, registry, transport, actor, account, budget, references} = context,
    base = googleBase(account),
    rows: JsonObject[] = [],
    seen = new Set<string>(),
    pages: JsonObject[] = [];
  let token: string | undefined, total: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 5) invalid('A measurement ledger collection exceeded five pages.');
    const plan = {...base, body: {query, ...(token ? {pageToken: token} : {})}},
      authority = nativeAuthority(store, registry, actor, plan, context.connection, context.auth as never, context.fence),
      response = await transport.request(plan, authority(), context.auth as never, undefined, {
        beforeAttempt: authority,
      });
    authority();
    budget.check();
    const raw = response.data;
    if (
      response.status !== 200 ||
      !obj(raw) ||
      Object.keys(raw).some(
        k => !['results', 'nextPageToken', 'totalResultsCount', 'fieldMask', 'queryResourceConsumption'].includes(k),
      ) ||
      (raw.results !== undefined && !Array.isArray(raw.results))
    )
      invalid('Google Ads returned a failed, partial or unrecognized measurement response.');
    const data = raw as JsonObject,
      items = (data.results ?? []) as JsonObject[];
    budget.rows(resource + ':' + page, items.length);
    if (data.totalResultsCount !== undefined) {
      if (!int64(data.totalResultsCount) || (total !== undefined && total !== data.totalResultsCount))
        invalid('Google Ads measurement result counts were invalid or changed.');
      total = data.totalResultsCount;
    }
    for (const item of items) {
      if (!obj(item) || Object.keys(item).length !== 1 || !obj((item as JsonObject)[resource]))
        invalid('A measurement row was incomplete or mixed with another resource.');
      rows.push((item as JsonObject)[resource] as JsonObject);
    }
    if (rows.length > 1000) invalid('A measurement ledger collection exceeded 1000 rows.');
    pages.push({page, rows: items.length, response_hash: fingerprint(data), captured_at: Date.now()});
    if (data.nextPageToken === undefined || data.nextPageToken === '') break;
    if (
      typeof data.nextPageToken !== 'string' ||
      data.nextPageToken.length > 4096 ||
      seen.has(data.nextPageToken) ||
      !items.length
    )
      invalid('Measurement pagination was malformed, repeated or incomplete.');
    seen.add(data.nextPageToken);
    token = data.nextPageToken;
  }
  if (total !== undefined && BigInt(total) !== BigInt(rows.length))
    invalid('The native count shows the measurement collection is incomplete.');
  references.push({
    resource,
    request: {method: 'POST', path: base.path, query},
    pages,
    collection_hash: fingerprint(pages.map(({page, rows, response_hash}) => ({page, rows, response_hash}))),
    rows: rows.length,
  });
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
/** An offline upload client summary of the selected customer; malformed counts are refused, never nulled. */
function uploadSummary(row: JsonObject, account: string) {
  const summary = '_OfflineConversionUploadClientSummary';
  if (
    Object.keys(row).some(
      k =>
        ![
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
        ].includes(k),
    ) ||
    typeof row.resourceName !== 'string' ||
    !new RegExp('^customers/' + account + '/offlineConversionUploadClientSummaries/[A-Z_]{1,64}$').test(
      row.resourceName,
    ) ||
    (row.client !== undefined && !pinned(summary, 'client', row.client)) ||
    (row.status !== undefined && !pinned(summary, 'status', row.status)) ||
    ['totalEventCount', 'successfulEventCount', 'pendingEventCount'].some(
      k => row[k] !== undefined && !int64(row[k]),
    ) ||
    ['successRate', 'pendingRate'].some(k => row[k] !== undefined && !ratio(row[k])) ||
    (row.lastUploadDateTime !== undefined && row.lastUploadDateTime !== '' && !uploadTime(row.lastUploadDateTime)) ||
    (row.alerts !== undefined && (!Array.isArray(row.alerts) || row.alerts.length > 100))
  )
    invalid('An offline upload summary is outside the selected customer or incompletely described.');
  const alerts = ((row.alerts ?? []) as unknown[]).map(alert => {
    const value = obj(alert) ? (alert as JsonObject) : invalid('An offline upload alert is malformed.'),
      error = value.error ?? {},
      kinds = obj(error) ? Object.keys(error) : [];
    if (
      Object.keys(value).some(k => !['error', 'errorPercentage'].includes(k)) ||
      !obj(error) ||
      kinds.length > 1 ||
      kinds.some(k => !pinned('_OfflineConversionError', k, (error as JsonObject)[k])) ||
      (value.errorPercentage !== undefined && !ratio(value.errorPercentage))
    )
      invalid('An offline upload alert is malformed.');
    return {
      error_type: kinds[0] ?? null,
      error_code: kinds[0] ? (error as JsonObject)[kinds[0]] : null,
      error_percentage: value.errorPercentage ?? null,
    };
  });
  return {
    resource_name: row.resourceName,
    client: row.client ?? null,
    status: row.status ?? null,
    total_event_count: row.totalEventCount ?? null,
    successful_event_count: row.successfulEventCount ?? null,
    pending_event_count: row.pendingEventCount ?? null,
    success_rate: row.successRate ?? null,
    pending_rate: row.pendingRate ?? null,
    last_upload_date_time: row.lastUploadDateTime || null,
    alerts: alerts.slice(0, 20),
    alert_count: alerts.length,
  };
}
/** The attribution settings of one enabled conversion action of the selected customer. */
function attribution(row: JsonObject, account: string) {
  const settings = row.attributionModelSettings ?? {},
    days = (v: unknown) => (v === undefined ? null : typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : NaN);
  if (
    Object.keys(row).some(
      k =>
        ![
          'resourceName',
          'name',
          'status',
          'primaryForGoal',
          'countingType',
          'clickThroughLookbackWindowDays',
          'viewThroughLookbackWindowDays',
          'attributionModelSettings',
        ].includes(k),
    ) ||
    typeof row.resourceName !== 'string' ||
    !new RegExp('^customers/' + account + '/conversionActions/[1-9][0-9]*$').test(row.resourceName) ||
    typeof row.name !== 'string' ||
    !row.name.trim() ||
    [...row.name].length > 256 ||
    /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(row.name) ||
    row.status !== 'ENABLED' ||
    (row.primaryForGoal !== undefined && typeof row.primaryForGoal !== 'boolean') ||
    (row.countingType !== undefined && !pinned('_ConversionAction', 'countingType', row.countingType)) ||
    Number.isNaN(days(row.clickThroughLookbackWindowDays)) ||
    Number.isNaN(days(row.viewThroughLookbackWindowDays)) ||
    !obj(settings) ||
    Object.keys(settings).some(k => !['attributionModel', 'dataDrivenModelStatus'].includes(k)) ||
    (settings.attributionModel !== undefined &&
      !pinned('ConversionAction_AttributionModelSettings', 'attributionModel', settings.attributionModel)) ||
    (settings.dataDrivenModelStatus !== undefined &&
      !pinned('ConversionAction_AttributionModelSettings', 'dataDrivenModelStatus', settings.dataDrivenModelStatus))
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

/**
 * Runs one layer read. A changed actor, login, access or control (the fence), or an exhausted whole-ledger allowance,
 * refuses the ledger; any other provider or evidence failure leaves only this layer unknown with its error code.
 */
async function guarded(name: LayerName, fence: () => void, ledger: string, run: () => Promise<Layer>) {
  try {
    return await run();
  } catch (error) {
    fence();
    if (!(error instanceof MirrorError)) throw error;
    if (error.code === 'REPORT_COLLECTION_LIMIT' && error.details?.definition === ledger) throw error;
    return layer(
      name,
      'unknown',
      'read_failed',
      {error: error.code === 'REPORT_COLLECTION_LIMIT' ? 'MEASUREMENT_LEDGER_READ_LIMIT' : error.code},
      'This read failed or was incomplete, so the layer stays unknown.',
    );
  }
}

async function googleLedger(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
  ledger: string,
) {
  const gateway = 'google_ads_native_action',
    account = normalizeAccount(gateway, input.account_id);
  if (typeof input.account_id !== 'string' || !/^\d{1,32}$/.test(account))
    bad('Choose the exact numeric Google Ads customer ID.');
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id);
  assertGoogleAdsScope(connection);
  new ScopeGuard(registry, store).authorize(googleBase(account), connection);
  // The goals read's fence for the whole ledger: actor, the login's access and stored credential, and the write pause.
  const binding = readinessBinding(connection),
    login = storedLogin(store, connection),
    pause = fingerprint(writePause(store, actor.tenantId));
  const fence = () => {
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
  fence();
  const goals = await measurementGoogleGoals(store, registry, transport, credentials, actor, {
    gateway,
    account_id: account,
    connection_id: connection.id,
  });
  fence();
  const references: JsonObject[] = [...((goals.source_references as JsonObject[] | undefined) ?? [])],
    summary = (goals.summary ?? {}) as JsonObject,
    customer = (goals.customer ?? {}) as JsonObject;
  const unknownReason =
    typeof goals.reason === 'string' && /^[a-z_]{1,64}$/.test(goals.reason) ? goals.reason : 'configuration_incomplete';
  const configuration = goals.complete
    ? layer(
        'configuration',
        'observed',
        'complete_configuration',
        {
          customer: {currency: customer.currency ?? null, timezone: customer.timezone ?? null},
          dependency_statuses: goals.dependency_statuses,
          summary,
          goals: goals.goals,
          primary_actions: (goals.primary_actions as JsonObject[]).map(({activity: _activity, ...a}) => a),
        },
        'Account-default goals and enabled primary conversion actions from two matching reads.',
      )
    : layer(
        'configuration',
        'unknown',
        unknownReason,
        {error: goals.error?.code ?? null},
        'The conversion configuration could not be completely inspected, so no configuration is reported.',
      );
  const activity = !goals.complete
    ? layer(
        'provider_observed_activity',
        'unknown',
        'configuration_unknown',
        null,
        'Without complete goals, reported activity stays unknown.',
      )
    : goals.dependency_statuses.reported_conversion_activity === 'ready'
      ? layer(
          'provider_observed_activity',
          'observed',
          'activity_reported',
          {
            primary_actions: (goals.primary_actions as JsonObject[]).map(a => ({
              resource_name: a.resource_name,
              name: a.name,
              last_conversion_date: a.activity?.last_conversion_date ?? null,
              last_tag_received_time: a.activity?.last_tag_received_time ?? null,
            })),
          },
          'Google Ads reported a last conversion date and a last tag detection for every primary action.',
        )
      : layer(
          'provider_observed_activity',
          'unknown',
          'activity_incomplete',
          {
            matching_primary_actions: summary.matching_primary_actions ?? 0,
            primary_last_conversion_known: summary.primary_last_conversion_known ?? 0,
            primary_last_tag_known: summary.primary_last_tag_known ?? 0,
          },
          'Google Ads did not report activity for every primary action, so delivery stays unknown.',
        );
  let diagnostics: Layer, attributionLayer: Layer;
  if (!goals.complete) {
    // Only the exact client customer that records its own conversions is read; nothing else is guessed.
    diagnostics = layer(
      'provider_diagnostics',
      'unknown',
      'configuration_unknown',
      null,
      'Without complete goals, no other collection of this customer is read.',
    );
    attributionLayer = layer(
      'attribution_settings',
      'unknown',
      'configuration_unknown',
      null,
      'Without complete goals, no other collection of this customer is read.',
    );
  } else {
    const auth = (await credentials.get(connection)) as unknown as JsonObject;
    fence();
    const budget = new ReportCollectionBudget(
        undefined,
        fingerprint({ledger, reads: 'google'}),
        () => {},
        measurementLedgerReadLimits,
      ),
      context: GoogleContext = {store, registry, transport, actor, connection, auth, account, fence, budget, references};
    try {
      diagnostics = await guarded('provider_diagnostics', fence, ledger, () =>
        budget.run(async () => {
          const rows = (
            await googleSearch(
              context,
              'offlineConversionUploadClientSummary',
              'SELECT ' +
                uploadFields.map(f => 'offline_conversion_upload_client_summary.' + f).join(', ') +
                ' FROM offline_conversion_upload_client_summary',
            )
          )
            .map(row => uploadSummary(row, account))
            .sort((a, b) => String(a.resource_name).localeCompare(String(b.resource_name)));
          if (new Set(rows.map(r => r.resource_name)).size !== rows.length)
            invalid('Google Ads returned the same upload summary twice.');
          return rows.length
            ? layer(
                'provider_diagnostics',
                'observed',
                'upload_summaries',
                {upload_summaries: rows.slice(0, 20), summary_count: rows.length},
                'Google Ads offline conversion upload summaries by upload client.',
              )
            : layer(
                'provider_diagnostics',
                'not_applicable',
                'no_uploads',
                {upload_summaries: [], summary_count: 0},
                'Google Ads reported no offline conversion upload for this customer.',
              );
        }),
      );
      fence();
      attributionLayer = await guarded('attribution_settings', fence, ledger, () =>
        budget.run(async () => {
          const rows = (
            await googleSearch(
              context,
              'conversionAction',
              'SELECT ' +
                [
                  'resource_name',
                  'name',
                  'status',
                  'primary_for_goal',
                  'counting_type',
                  'click_through_lookback_window_days',
                  'view_through_lookback_window_days',
                  'attribution_model_settings.attribution_model',
                  'attribution_model_settings.data_driven_model_status',
                ]
                  .map(f => 'conversion_action.' + f)
                  .join(', ') +
                " FROM conversion_action WHERE conversion_action.status = 'ENABLED'",
            )
          )
            .map(row => attribution(row, account))
            .sort(
              (a, b) =>
                Number(b.primary_for_goal === true) - Number(a.primary_for_goal === true) ||
                a.resource_name.localeCompare(b.resource_name),
            );
          if (new Set(rows.map(r => r.resource_name)).size !== rows.length)
            invalid('Google Ads returned the same conversion action twice.');
          return rows.length
            ? layer(
                'attribution_settings',
                'observed',
                'action_settings',
                {actions: rows.slice(0, 20), action_count: rows.length},
                'Configured attribution model and lookback windows of enabled conversion actions.',
              )
            : layer(
                'attribution_settings',
                'not_applicable',
                'no_enabled_actions',
                {actions: [], action_count: 0},
                'The customer has no enabled conversion action.',
              );
        }),
      );
    } finally {
      budget.close();
    }
    fence();
  }
  return {
    scope: {gateway, connection_id: connection.id, account_id: account},
    layers: [
      configuration,
      activity,
      diagnostics,
      trace(),
      layer(
        'consent',
        'unavailable',
        'no_provider_source',
        null,
        'Google Ads exposes no consent setting to this read. The Tag Manager audit reports the consent configuration of tags.',
      ),
      attributionLayer,
    ],
    source_references: references,
  };
}

const ga4ReadScopes = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/analytics.edit',
  'https://www.googleapis.com/auth/analytics',
];
async function ga4Ledger(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  call: ToolCall,
  actor: Actor,
  input: JsonObject,
  ledger: string,
) {
  const gateway = 'ga4_native_action',
    property = input.account_id;
  if (typeof property !== 'string' || !/^[1-9][0-9]{0,19}$/.test(property))
    bad('Choose the exact numeric GA4 property ID.');
  const connection = store.resolveConnection(actor, gateway, property, input.connection_id);
  const fence = () => {
    store.assertActorActive(actor);
    const now = store.resolveConnection(actor, gateway, property, connection.id);
    if (!now.scopes.some(s => ga4ReadScopes.includes(s)))
      bad('This login requires Google Analytics read permission.', 'INSUFFICIENT_SCOPE');
    if (fingerprint(storedLogin(store, now)) !== login)
      throw new MirrorError(
        'CONNECTION_AUTHORITY_CHANGED',
        'This GA4 login changed during the read. Read the measurement ledger again.',
        {},
        409,
      );
  };
  if (!connection.scopes.some(s => ga4ReadScopes.includes(s)))
    bad('This login requires Google Analytics read permission.', 'INSUFFICIENT_SCOPE');
  const login = fingerprint(storedLogin(store, connection));
  fence();
  const references: JsonObject[] = [];
  let config: JsonObject | undefined;
  const configuration = await guarded('configuration', fence, ledger, async () => {
    config = await ga4AdminConfig(store, registry, transport, credentials, actor, {
      gateway,
      account_id: property,
      connection_id: connection.id,
    });
    if (config.complete !== true) invalid('The GA4 configuration read was incomplete.');
    references.push(...((config.source_references as JsonObject[] | undefined) ?? []));
    const checks = config.checks as JsonObject;
    return layer(
      'configuration',
      'observed',
      'complete_configuration',
      {
        summary: config.summary,
        key_events: (config.key_events as JsonObject[])
          .slice(0, 20)
          .map(k => ({event_name: k.event_name, counting_method: k.counting_method})),
        data_streams: (config.data_streams as JsonObject[]).slice(0, 20).map(s => ({
          stream_id: s.stream_id,
          type: s.type,
          display_name: s.display_name,
          measurement_id: s.measurement_id,
        })),
        google_ads_links: (config.google_ads_links as JsonObject[]).slice(0, 20).map(l => ({
          customer_id: l.customer_id,
          ads_personalization_enabled: l.ads_personalization_enabled,
        })),
        data_retention: config.data_retention,
        checks: {test_identifier_dimension: checks.test_identifier_dimension, web_streams: checks.web_streams},
      },
      'Key events, data streams, custom definitions, Google Ads links and data retention from complete GA4 Admin reads.',
    );
  });
  fence();
  let activity: Layer;
  if (configuration.state !== 'observed' || !config)
    activity = layer(
      'provider_observed_activity',
      'unknown',
      'configuration_unknown',
      null,
      'Without complete configuration, the key events to observe are unknown.',
    );
  else {
    const all = (config.key_events as JsonObject[]).map(k => k.event_name as string),
      names = [...new Set(all.filter(name => /^\p{L}[\p{L}\p{N}_]{0,39}$/u.test(name)))].slice(0, 20);
    if (!all.length)
      activity = layer(
        'provider_observed_activity',
        'not_applicable',
        'no_key_events',
        {key_events: 0},
        'The property has no key event to observe.',
      );
    else if (!names.length)
      activity = layer(
        'provider_observed_activity',
        'unknown',
        'key_events_unreadable',
        {key_events: all.length},
        'No key event name can be read as an exact realtime event name.',
      );
    else
      activity = await guarded('provider_observed_activity', fence, ledger, async () => {
        const events = await measurementEvents(store, call, actor, {
          gateway,
          account_id: property,
          connection_id: connection.id,
          requirements: {event_names: names, minutes: 30},
        });
        references.push({
          resource: 'runRealtimeReport',
          source_hash: events.source_hash,
          event_names: names,
          window_minutes: 30,
        });
        const evidence = {
          window_minutes: 30,
          events: events.events,
          key_events: all.length,
          key_events_read: names.length,
        };
        return events.state === 'observed'
          ? layer(
              'provider_observed_activity',
              'observed',
              'key_events_reported',
              evidence,
              'GA4 realtime counts of the property key events in the last 30 minutes.',
            )
          : layer(
              'provider_observed_activity',
              'unknown',
              'no_recent_key_events',
              evidence,
              'No key event was reported in the last 30 minutes. Absence does not establish a broken tag.',
            );
      });
    fence();
  }
  return {
    scope: {gateway, connection_id: connection.id, account_id: property},
    layers: [
      configuration,
      activity,
      layer(
        'provider_diagnostics',
        'unavailable',
        'no_provider_source',
        null,
        'GA4 offers no event diagnostics API; DebugView exists only in the GA4 interface.',
      ),
      trace(),
      layer(
        'consent',
        'unavailable',
        'no_provider_source',
        null,
        'The pinned GA4 Admin API exposes no consent settings. The Tag Manager audit reports the consent configuration of tags.',
      ),
      layer(
        'attribution_settings',
        'unavailable',
        'unpinned_api',
        null,
        'GA4 attribution settings exist only in the Admin API alpha version, which AMCP has not pinned.',
      ),
    ],
    source_references: references,
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
    bad(
      'The measurement ledger covers a Google Ads customer or a GA4 property.',
      'MEASUREMENT_LEDGER_UNQUALIFIED',
      {qualified},
    );
  validate(input.requirements ?? {}, []);
  const requested_at = Date.now(),
    ledger = fingerprint({
      gateway: input.gateway,
      account_id: input.account_id,
      connection_id: input.connection_id ?? null,
      requested_at,
    });
  let usage: JsonObject = {};
  const budget = new ReportCollectionBudget(
    undefined,
    ledger,
    state => {
      usage = state;
    },
    measurementLedgerLimits,
  );
  let out: {scope: JsonObject; layers: Layer[]; source_references: JsonObject[]};
  try {
    out = await budget.run(() =>
      input.gateway === 'google_ads_native_action'
        ? googleLedger(store, registry, transport, credentials, actor, input, ledger)
        : ga4Ledger(store, registry, transport, credentials, call, actor, input, ledger),
    );
  } catch (error) {
    if (error instanceof MirrorError && error.code === 'REPORT_COLLECTION_LIMIT')
      throw new MirrorError(
        'MEASUREMENT_LEDGER_LIMIT',
        'The measurement ledger exceeded its read limits. Read the individual measurement tasks instead.',
        {dimension: error.details.dimension},
        422,
      );
    throw error;
  } finally {
    budget.close();
  }
  const layers = out.layers;
  if (
    layers.map(l => l.layer).join() !== measurementLedgerLayers.join() ||
    layers.some(l => !measurementLedgerStates.includes(l.state))
  )
    invalid('The measurement ledger layers are incomplete.');
  return {
    record_kind: 'measurement_ledger',
    scope: out.scope,
    requested_at,
    captured_at: Date.now(),
    layers,
    summary: Object.fromEntries(measurementLedgerStates.map(s => [s, layers.filter(l => l.state === s).length])),
    checks: {event_delivery: 'unverified', deduplication: 'unverified', consent: 'unverified', attribution: 'unverified'},
    source_references: out.source_references,
    network_requests: usage.requests ?? 0,
    collection_usage: {requests: usage.requests, rows: usage.rows, bytes: usage.bytes, elapsed_ms: usage.elapsed_ms},
    provider_mutations: 0,
    snapshot_saved: false,
    meaning:
      'Measurement evidence for one asset in six fixed layers. A layer is observed only from complete evidence of the selected asset; everything else stays unknown, unavailable or not applicable. Configuration and reported activity do not prove that conversions are delivered, deduplicated, consented or attributed. Nothing was saved.',
  };
}
