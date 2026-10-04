import {googleAdsContract, googleAdsCustomers, googleAdsVersion} from './google-version.js';
import {assertGoogleAdsScope} from './google-contracts.js';
import {googleConversionGoalFields} from './google-conversion-goals.js';
import {pinnedJson} from './pinned-json.js';
import {nativeAuthority} from './native-authority.js';
import {ScopeGuard, normalizeAccount} from './scope.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {fingerprint, obj} from './workspace-core.js';
import {MirrorError} from './errors.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';

export const googleGoalInspectionLimits = Object.freeze({
  requests: 64,
  rows: 4000,
  bytes: 2 * 1024 * 1024,
  elapsed_ms: 60000,
});
const fields = {
  customer: [
    'id',
    'currency_code',
    'time_zone',
    'manager',
    'conversion_tracking_setting.google_ads_conversion_customer',
  ],
  customer_conversion_goal: googleConversionGoalFields.customerConversionGoals,
  conversion_action: ['resource_name', 'name', 'status', 'category', 'origin', 'owner_customer', 'primary_for_goal'],
};
type Resource = keyof typeof fields | 'conversion_action_activity';
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const invalid = (message: string): never => {
  throw new MirrorError('GOOGLE_GOAL_INSPECTION_INVALID', message, {}, 502);
};
const changed = (): never => {
  throw new MirrorError(
    'GOOGLE_GOAL_INSPECTION_CHANGED',
    'Current conversion configuration changed during inspection.',
    {},
    409,
  );
};
const text = (v: unknown, max = 255): v is string =>
  typeof v === 'string' && !!v.trim() && [...v].length <= max && !/[\u0000-\u001f\ud800-\udfff]/u.test(v);
const schema = (resource: string) =>
  pinnedJson('.mirror/VENDOR/' + googleAdsContract + '.json').document.schemas[
    'GoogleAdsGoogleads' + googleAdsVersion.toUpperCase() + 'Resources__' + resource
  ];
const enumValue = (resource: string, field: string, value: unknown): value is string =>
  typeof value === 'string' &&
  !['UNSPECIFIED', 'UNKNOWN'].includes(value) &&
  schema(resource).properties[field].enum.includes(value);
const only = (row: JsonObject, allowed: string[]) => {
  if (Object.keys(row).some(k => !allowed.includes(k)))
    invalid('Unselected conversion configuration fields were returned.');
};
const statuses = () => ({account_default_conversion_goals: 'unknown', primary_conversion_actions: 'unknown'});

/** Current configuration only. No goal edits, event reads, campaign acceptance or manager-account expansion. */
export async function inspectGoogleRecipeGoals(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  requestedScope: JsonObject,
  currentBrief: () => void,
): Promise<JsonObject> {
  const account = normalizeAccount('google_ads_native_action', requestedScope.account_id);
  const withValueSettings = requestedScope.include_value_settings === true,
    withActivity = requestedScope.include_activity === true,
    actionFields = [
      ...fields.conversion_action,
      ...(withValueSettings
        ? [
            'value_settings.default_value',
            'value_settings.default_currency_code',
            'value_settings.always_use_default_value',
          ]
        : []),
    ];
  if (
    requestedScope.gateway !== 'google_ads_native_action' ||
    !/^\d{1,32}$/.test(account) ||
    typeof requestedScope.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(requestedScope.currency)
  )
    throw new MirrorError('INVALID_ARGUMENT', 'Use the exact Google account, login and compiled currency.');
  const scope: JsonObject = {...requestedScope, account_id: account},
    base: CompiledRequest = {
      gateway: 'google_ads_native_action',
      accountId: account,
      action: 'AMCP_RECIPE_CONVERSION_PREREQUISITES',
      method: 'POST',
      path: googleAdsCustomers + account + '/googleAds:search',
      query: {},
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'Qualified Google account-default conversion goals and selected conversion-action fields',
      warnings: [],
    },
    connection = store.resolveConnection(actor, base.gateway, account, requestedScope.connection_id);
  scope.connection_id = connection.id;
  assertGoogleAdsScope(connection);
  new ScopeGuard(registry, store).authorize(base, connection);
  const auth = await credentials.get(connection),
    active = store.resolveConnection(actor, base.gateway, account, connection.id),
    access = nativeAuthority(store, registry, actor, base, active, auth, currentBrief),
    requested_at = Date.now(),
    references: JsonObject[] = [];
  let usage: JsonObject = {};
  const budget = new ReportCollectionBudget(
    undefined,
    fingerprint({scope, requested_at}),
    state => {
      usage = state;
    },
    googleGoalInspectionLimits,
  );
  const header = () => ({
    record_kind: 'google_conversion_goal_inspection',
    scope,
    requested_at,
    captured_at: Date.now(),
    network_requests: usage.requests,
    collection_usage: {requests: usage.requests, rows: usage.rows, bytes: usage.bytes, elapsed_ms: usage.elapsed_ms},
    provider_mutations: 0,
    ...(withValueSettings ? {value_settings_selected: true} : {}),
    ...(withActivity ? {activity_selected: true} : {}),
  });
  const read = async (resource: Resource, pass: number) => {
    const values: JsonObject[] = [],
      seen = new Set<string>();
    let token: string | undefined, total: string | undefined;
    const activity = resource === 'conversion_action_activity',
      nativeResource = activity ? 'conversion_action' : resource,
      query =
        'SELECT ' +
        (activity
          ? [
              'conversion_action.resource_name',
              'metrics.conversion_last_conversion_date',
              'metrics.conversion_last_received_request_date_time',
            ]
          : (resource === 'conversion_action' ? actionFields : fields[resource]).map(f => resource + '.' + f)
        ).join(', ') +
        ' FROM ' +
        nativeResource +
        (resource === 'customer'
          ? ' LIMIT 1'
          : nativeResource === 'conversion_action'
            ? " WHERE conversion_action.status != 'REMOVED'"
            : '');
    const pages: JsonObject[] = [];
    for (let page = 0; ; page++) {
      if (page >= 10) invalid('Complete conversion configuration exceeded ten pages per collection.');
      const plan = {...base, body: {query, ...(token ? {pageToken: token} : {})}},
        authority = nativeAuthority(store, registry, actor, plan, active, auth, currentBrief),
        response = await transport.request(plan, authority(), auth, undefined, {
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
        invalid('The conversion configuration response was failed, partial or unrecognized.');
      const data = raw as JsonObject,
        rows = data.results ?? [];
      budget.rows(resource + ':' + pass + ':' + page, rows.length);
      if (data.totalResultsCount !== undefined) {
        if (
          typeof data.totalResultsCount !== 'string' ||
          !/^\d{1,7}$/.test(data.totalResultsCount) ||
          (total !== undefined && total !== data.totalResultsCount)
        )
          invalid('Conversion result counts were invalid or changed.');
        total = data.totalResultsCount;
      }
      for (const row of rows) {
        if (
          !obj(row) ||
          !obj(row[camel(nativeResource)]) ||
          (activity
            ? Object.keys(row).some(k => !['conversionAction', 'metrics'].includes(k))
            : Object.keys(row).length !== 1)
        )
          invalid('The conversion configuration row was incomplete or mixed with another resource.');
        values.push(activity ? row : row[camel(nativeResource)]);
      }
      if (values.length > 1000) invalid('Complete conversion configuration exceeded 1000 rows per collection.');
      pages.push({
        page,
        response_hash: fingerprint(data),
        captured_at: Date.now(),
        rows: rows.length,
      });
      if (data.nextPageToken === undefined || data.nextPageToken === '') break;
      if (!text(data.nextPageToken, 4096) || seen.has(data.nextPageToken) || !rows.length)
        invalid('Conversion pagination was malformed, repeated or incomplete.');
      seen.add(data.nextPageToken);
      token = data.nextPageToken;
    }
    if (total !== undefined && BigInt(total) !== BigInt(values.length))
      invalid('The native count proves conversion configuration is incomplete.');
    references.push({
      pass,
      resource,
      request: {method: base.method, path: base.path, query},
      pages,
      collection_hash: fingerprint(pages.map(({page, response_hash, rows}) => ({page, response_hash, rows}))),
      rows: values.length,
    });
    return values;
  };
  const customer = (rows: JsonObject[]) => {
    if (rows.length !== 1) invalid('One complete selected customer is required.');
    const row = rows[0]!;
    only(row, ['id', 'currencyCode', 'timeZone', 'manager', 'conversionTrackingSetting']);
    if (
      row.id !== account ||
      row.currencyCode !== scope.currency ||
      !text(row.timeZone, 128) ||
      (row.manager !== undefined && typeof row.manager !== 'boolean')
    )
      invalid('The customer identity, currency or manager flag is incomplete or different.');
    if (row.conversionTrackingSetting !== undefined && !obj(row.conversionTrackingSetting))
      invalid('Conversion tracking configuration is malformed.');
    if (row.conversionTrackingSetting) only(row.conversionTrackingSetting, ['googleAdsConversionCustomer']);
    const holder = row.conversionTrackingSetting?.googleAdsConversionCustomer;
    if (holder !== undefined && (typeof holder !== 'string' || !/^customers\/\d{1,32}$/.test(holder)))
      invalid('The conversion customer identity is malformed.');
    return {
      id: row.id,
      currency: row.currencyCode,
      timezone: row.timeZone,
      manager: row.manager ?? false,
      conversion_customer: holder ?? null,
    };
  };
  const goals = (rows: JsonObject[]) => {
    const names = new Set<string>();
    return rows
      .map(row => {
        only(row, ['resourceName', 'category', 'origin', 'biddable']);
        if (
          !enumValue('CustomerConversionGoal', 'category', row.category) ||
          !enumValue('CustomerConversionGoal', 'origin', row.origin) ||
          row.resourceName !== `customers/${account}/customerConversionGoals/${row.category}~${row.origin}` ||
          names.has(row.resourceName) ||
          (row.biddable !== undefined && typeof row.biddable !== 'boolean')
        )
          invalid(
            'A conversion goal has an unknown enum, duplicate identity, scope mismatch or malformed biddability.',
          );
        names.add(row.resourceName);
        // This selected field is a non-optional proto3 bool; omitted false is distinct from an optional primary flag.
        return {
          resource_name: row.resourceName,
          category: row.category,
          origin: row.origin,
          biddable: row.biddable ?? false,
        };
      })
      .sort((a, b) => a.resource_name.localeCompare(b.resource_name));
  };
  const actionValues = (raw: unknown) => {
    const value = raw == null ? {} : raw;
    if (!obj(value)) invalid('A selected conversion value setting is unqualified or malformed.');
    const v = value as JsonObject;
    only(v, ['defaultValue', 'defaultCurrencyCode', 'alwaysUseDefaultValue']);
    if (
      (v.defaultValue != null &&
        (typeof v.defaultValue !== 'number' ||
          !Number.isFinite(v.defaultValue) ||
          v.defaultValue < 0 ||
          v.defaultValue > 1e12)) ||
      (v.defaultCurrencyCode != null &&
        (typeof v.defaultCurrencyCode !== 'string' || !/^[A-Z]{3}$/.test(v.defaultCurrencyCode))) ||
      (v.alwaysUseDefaultValue != null && typeof v.alwaysUseDefaultValue !== 'boolean')
    )
      invalid('A selected conversion value setting is unqualified or malformed.');
    // Optional proto presence in v25: missing/null stays unknown; explicit false and zero remain present.
    return {
      default_value: v.defaultValue ?? null,
      default_currency_code: v.defaultCurrencyCode ?? null,
      always_use_default_value: v.alwaysUseDefaultValue ?? null,
    };
  };
  const actions = (rows: JsonObject[]) => {
    const names = new Set<string>();
    return rows
      .map(row => {
        only(row, [
          'resourceName',
          'name',
          'status',
          'category',
          'origin',
          'ownerCustomer',
          'primaryForGoal',
          ...(withValueSettings ? ['valueSettings'] : []),
        ]);
        if (
          typeof row.resourceName !== 'string' ||
          !new RegExp('^customers/' + account + '/conversionActions/[1-9][0-9]*$').test(row.resourceName) ||
          names.has(row.resourceName) ||
          !text(row.name) ||
          !['ENABLED', 'HIDDEN'].includes(row.status) ||
          !enumValue('ConversionAction', 'category', row.category) ||
          !enumValue('ConversionAction', 'origin', row.origin) ||
          (row.ownerCustomer != null && row.ownerCustomer !== 'customers/' + account) ||
          (row.primaryForGoal != null && typeof row.primaryForGoal !== 'boolean')
        )
          invalid('A conversion action is duplicate, out of scope or incompletely described.');
        names.add(row.resourceName);
        return {
          resource_name: row.resourceName,
          name: row.name,
          status: row.status,
          category: row.category,
          origin: row.origin,
          owner_customer: row.ownerCustomer ?? null,
          primary_for_goal: row.primaryForGoal ?? null,
          ...(withValueSettings ? {value_settings: actionValues(row.valueSettings)} : {}),
        };
      })
      .sort((a, b) => a.resource_name.localeCompare(b.resource_name));
  };
  const activityRows = (rows: JsonObject[], knownActions: JsonObject[], timezone: string) => {
    // Preserve native account-local strings. Never reinterpret these as UTC or infer recent event volume.
    try {
      new Intl.DateTimeFormat('en', {timeZone: timezone}).format(0);
    } catch {
      invalid('Conversion activity requires a qualified account timezone.');
    }
    const names = new Set<string>(),
      known = new Set(knownActions.map(a => a.resource_name));
    const date = (v: unknown) =>
      typeof v === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(v) &&
      v >= '0001-01-01' &&
      Number.isFinite(new Date(v + 'T00:00:00.000Z').getTime()) &&
      new Date(v + 'T00:00:00.000Z').toISOString().slice(0, 10) === v;
    const normalize = (v: unknown, time: boolean) => {
      if (v == null || v === '') return null;
      if (
        !time
          ? !date(v)
          : typeof v !== 'string' ||
            !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/.test(v) ||
            !date(v.slice(0, 10))
      )
        invalid('A selected conversion activity date is unqualified or malformed.');
      return v;
    };
    return rows
      .map(row => {
        const action = row.conversionAction,
          metrics = row.metrics == null ? {} : row.metrics;
        only(action, ['resourceName']);
        if (
          typeof action.resourceName !== 'string' ||
          !known.has(action.resourceName) ||
          names.has(action.resourceName) ||
          !obj(metrics)
        )
          invalid('Conversion activity has an unknown, repeated or different action identity.');
        names.add(action.resourceName);
        only(metrics, ['conversionLastConversionDate', 'conversionLastReceivedRequestDateTime']);
        return {
          resource_name: action.resourceName,
          last_conversion_date: normalize(metrics.conversionLastConversionDate, false),
          last_tag_received_time: normalize(metrics.conversionLastReceivedRequestDateTime, true),
        };
      })
      .sort((a, b) => a.resource_name.localeCompare(b.resource_name));
  };
  try {
    return await budget.run(async () => {
      access();
      const firstCustomer = customer(await read('customer', 1));
      if (firstCustomer.manager || firstCustomer.conversion_customer !== 'customers/' + account)
        return {
          ...header(),
          complete: false,
          dependency_statuses: statuses(),
          customer: firstCustomer,
          source_references: references,
          reason: firstCustomer.manager
            ? 'manager_account'
            : firstCustomer.conversion_customer
              ? 'shared_conversion_customer'
              : 'conversion_customer_unknown',
          meaning:
            'Only the exact selected client using its own conversion customer is qualified. No other customer was read; goal and primary-action settings remain unknown.',
        };
      const firstGoals = goals(await read('customer_conversion_goal', 1)),
        firstActions = actions(await read('conversion_action', 1)),
        firstActivity = withActivity
          ? activityRows(await read('conversion_action_activity', 1), firstActions, firstCustomer.timezone)
          : [],
        secondActivity = withActivity
          ? activityRows(await read('conversion_action_activity', 2), firstActions, firstCustomer.timezone)
          : [],
        secondActions = actions(await read('conversion_action', 2)),
        secondGoals = goals(await read('customer_conversion_goal', 2)),
        secondCustomer = customer(await read('customer', 2));
      if (
        fingerprint(firstCustomer) !== fingerprint(secondCustomer) ||
        fingerprint(firstGoals) !== fingerprint(secondGoals) ||
        fingerprint(firstActions) !== fingerprint(secondActions) ||
        fingerprint(firstActivity) !== fingerprint(secondActivity)
      )
        changed();
      access();
      budget.check();
      const selected = firstGoals.filter(g => g.biddable),
        matches = (a: JsonObject) => selected.some(g => g.category === a.category && g.origin === a.origin),
        primary = firstActions.filter(a => a.status === 'ENABLED' && a.primary_for_goal === true && matches(a)),
        unknown = firstActions.filter(a => a.status === 'ENABLED' && a.primary_for_goal === null && matches(a)),
        knownValues = primary.filter(
          a => a.value_settings && Object.values(a.value_settings).every(v => v !== null),
        ).length,
        activity = new Map(
          firstActivity.map(a => [
            a.resource_name,
            {last_conversion_date: a.last_conversion_date, last_tag_received_time: a.last_tag_received_time},
          ]),
        ),
        lastConversions = primary.filter(a => activity.get(a.resource_name)?.last_conversion_date != null).length,
        lastTags = primary.filter(a => activity.get(a.resource_name)?.last_tag_received_time != null).length;
      return {
        ...header(),
        complete: true,
        customer: firstCustomer,
        state_hash: fingerprint({
          customer: firstCustomer,
          goals: firstGoals,
          actions: firstActions,
          ...(withActivity ? {activity: firstActivity} : {}),
        }),
        dependency_statuses: {
          account_default_conversion_goals: selected.length ? 'ready' : 'blocked',
          primary_conversion_actions: primary.length ? 'ready' : unknown.length ? 'unknown' : 'blocked',
          ...(withValueSettings
            ? {
                conversion_value_configuration:
                  primary.length && !unknown.length && knownValues === primary.length ? 'ready' : 'unknown',
              }
            : {}),
          ...(withActivity
            ? {
                reported_conversion_activity:
                  primary.length && !unknown.length && lastConversions === primary.length && lastTags === primary.length
                    ? 'ready'
                    : 'unknown',
              }
            : {}),
        },
        summary: {
          goals: firstGoals.length,
          biddable_goals: selected.length,
          actions: firstActions.length,
          matching_primary_actions: primary.length,
          unknown_primary_flags: unknown.length,
          ...(withValueSettings
            ? {primary_value_settings_known: knownValues, primary_value_settings_unknown: primary.length - knownValues}
            : {}),
          ...(withActivity ? {primary_last_conversion_known: lastConversions, primary_last_tag_known: lastTags} : {}),
        },
        goals: firstGoals.slice(0, 20).map(g => ({
          ...g,
          matching_primary_actions: primary.filter(a => a.category === g.category && a.origin === g.origin).length,
        })),
        primary_actions: primary.slice(0, 20).map(a => ({
          ...a,
          ...(withActivity
            ? {activity: activity.get(a.resource_name) ?? {last_conversion_date: null, last_tag_received_time: null}}
            : {}),
        })),
        display_omissions: {
          goals: Math.max(0, firstGoals.length - 20),
          primary_actions: Math.max(0, primary.length - 20),
        },
        source_references: references,
        meaning:
          'Complete bounded configuration reads matched on reinspection. Enabled explicit primary actions were joined to biddable account-default goals by category and origin. This does not prove event delivery, campaign acceptance, performance or a point-in-time snapshot. Settings can change after inspection; activation remains separately reviewed.',
      };
    });
  } catch (error) {
    access(); // Revocation or a changed brief must refuse the response, never become an unknown successful proof.
    if (!(error instanceof MirrorError)) throw error;
    return {
      ...header(),
      complete: false,
      dependency_statuses: statuses(),
      error: {
        code: error.code === 'REPORT_COLLECTION_LIMIT' ? 'GOOGLE_GOAL_INSPECTION_LIMIT' : error.code,
        ...(error.code === 'REPORT_COLLECTION_LIMIT' ? {dimension: error.details.dimension} : {}),
        message:
          'The current conversion configuration could not be completely inspected. Inspect it again before activation.',
      },
      meaning:
        'No partial goal or primary-action evidence establishes readiness. Event delivery and provider acceptance remain unverified.',
    };
  } finally {
    budget.close();
  }
}
