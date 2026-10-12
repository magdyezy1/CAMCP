import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {storedLogin} from './connection-authority.js';
import {normalizeAccount} from './scope.js';
import {pinnedJson} from './pinned-json.js';
import {googleAdsContract, googleAdsVersion} from './google-version.js';

/**
 * Google Ads change history (PRV-07 A): one fixed-projection GAQL read of change_event for the selected customer.
 * Google keeps change events for 30 days and requires a change_date_time filter and a LIMIT of at most 10,000, so the
 * window is at most 30 days within the last 30 days and the limit at most 10,000. user_email is personal data and is
 * never requested (personal-data policy); client_type says which tool made the change. Old and new resource values are
 * not requested either: changed field paths name what changed. Nothing is saved and nothing is written.
 */
const gateway = 'google_ads_native_action',
  searchAction = 'google_ads_v23_google_ads_search',
  dayMs = 86400000;
const invalid = (message: string): never => bad(message, 'CHANGE_HISTORY_INVALID');
const fields = [
  'resource_name',
  'change_date_time',
  'change_resource_type',
  'change_resource_name',
  'client_type',
  'resource_change_operation',
  'changed_fields',
  'campaign',
  'ad_group',
  'asset',
];
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const selected = new Set(fields.map(camel));
const changeEventSchema = () =>
  pinnedJson('.mirror/VENDOR/' + googleAdsContract + '.json').document.schemas[
    'GoogleAdsGoogleads' + googleAdsVersion.toUpperCase() + 'Resources__ChangeEvent'
  ].properties;
const nativeEnum = (field: string): string[] =>
  (changeEventSchema()[field].enum as string[]).filter(v => !['UNSPECIFIED', 'UNKNOWN'].includes(v));
function day(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

export async function googleChangeHistory(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  if (input.gateway !== gateway)
    bad('Change history reads a selected Google Ads customer (gateway google_ads_native_action).');
  const account = normalizeAccount(gateway, input.account_id);
  if (typeof input.account_id !== 'string' || !/^\d{1,32}$/.test(account))
    bad('Choose the exact numeric Google Ads customer ID.');
  const config = input.requirements ?? {};
  validate(config, ['date_from', 'date_to', 'limit', 'resource_types']);
  const from = day(config.date_from),
    to = day(config.date_to),
    limit = config.limit ?? 1000,
    today = day(new Date().toISOString().slice(0, 10))!;
  // The last 30 days are today and the 29 days before it (UTC). A start day 30 days back begins more than 30 days ago,
  // which Google refuses (START_DATE_TOO_OLD). Account time zones run up to a day ahead of UTC, hence tomorrow's end.
  if (
    from === null ||
    to === null ||
    to < from ||
    to - from > 29 * dayMs ||
    from < today - 29 * dayMs ||
    to > today + dayMs
  )
    bad(
      'Choose explicit dates covering at most 30 days within the last 30 days. Google Ads keeps change history for 30 days.',
    );
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) bad('Choose a limit of 1–10,000 change events.');
  const types = config.resource_types;
  if (
    types !== undefined &&
    (!Array.isArray(types) ||
      !types.length ||
      types.length > 20 ||
      new Set(types).size !== types.length ||
      types.some(t => typeof t !== 'string' || !nativeEnum('changeResourceType').includes(t)))
  )
    bad('Use 1–20 distinct native Google Ads change resource types, such as CAMPAIGN or AD_GROUP_AD.');
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id),
    login = fingerprint(storedLogin(store, connection));
  const current = () => {
    store.assertActorActive(actor);
    const now = store.resolveConnection(actor, gateway, account, connection.id);
    if (fingerprint(storedLogin(store, now)) !== login)
      bad('This Google Ads login changed. Read the change history again.', 'CONNECTION_AUTHORITY_CHANGED');
  };
  current();
  const window = {date_from: config.date_from as string, date_to: config.date_to as string},
    query =
      'SELECT ' +
      fields.map(f => 'change_event.' + f).join(', ') +
      " FROM change_event WHERE change_event.change_date_time >= '" +
      window.date_from +
      " 00:00:00' AND change_event.change_date_time <= '" +
      window.date_to +
      " 23:59:59'" +
      (types
        ? ' AND change_event.change_resource_type IN (' + types.map((t: string) => "'" + t + "'").join(', ') + ')'
        : '') +
      ' ORDER BY change_event.change_date_time DESC LIMIT ' +
      limit,
    scope = {
      gateway,
      connection_id: connection.id,
      account_id: account,
      ...window,
      limit,
      resource_types: types ?? null,
    },
    budget = new ReportCollectionBudget(undefined, fingerprint(scope), () => {}, {
      requests: 3,
      rows: 10000,
      bytes: 16 * 1024 * 1024,
      elapsed_ms: 60000,
    }),
    requestedAt = Date.now();
  try {
    return await budget.run(async () => {
      const response = await call(
        gateway,
        {
          action: searchAction,
          connection_id: connection.id,
          account_id: account,
          payload: {query},
          aggregate_pages: true,
          max_pages: 2,
        },
        actor,
      );
      current();
      if (!response.success)
        bad(
          response.error?.message ?? 'Google Ads change history read failed.',
          response.error?.code ?? 'CHANGE_HISTORY_READ_FAILED',
        );
      const data = response.data?.data;
      if (response.data?.truncated)
        invalid('Google Ads returned more change history pages than this bounded read takes.');
      if (!obj(data) || (data.results !== undefined && !Array.isArray(data.results)))
        invalid('Google Ads did not return a complete change history response.');
      const raw = (data.results ?? []) as unknown[];
      budget.rows('change_event', raw.length);
      if (raw.length > limit) invalid('Google Ads returned more change events than the requested limit.');
      const prefix = 'customers/' + account + '/',
        resource = (v: unknown, kind?: string) =>
          v === undefined
            ? null
            : typeof v === 'string' &&
                v.startsWith(prefix) &&
                v.length <= 512 &&
                (!kind || v.startsWith(prefix + kind + '/'))
              ? v
              : invalid('Google Ads returned a change for another customer or a malformed resource name.'),
        enumOrNull = (field: string, v: unknown) =>
          v === undefined
            ? null
            : typeof v === 'string' && nativeEnum(field).includes(v)
              ? v
              : invalid('Google Ads returned an unrecognized change value.'),
        seen = new Set<string>();
      const rows = raw.map(r => {
        if (!obj(r) || Object.keys(r).length !== 1 || !obj(r.changeEvent))
          invalid('Google Ads returned a change history row mixed with another resource.');
        const e = (r as JsonObject).changeEvent as JsonObject;
        // Personal data and unselected values are refused rather than passed on.
        if (Object.keys(e).some(k => !selected.has(k))) invalid('Google Ads returned unselected change event fields.');
        const name = resource(e.resourceName, 'changeEvents');
        if (name === null || seen.has(name)) invalid('Google Ads returned a missing or repeated change event.');
        seen.add(name!);
        const at = e.changeDateTime;
        if (
          typeof at !== 'string' ||
          !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(at) ||
          at.slice(0, 10) < window.date_from ||
          at.slice(0, 10) > window.date_to
        )
          invalid('Google Ads returned a change outside the requested window.');
        const type = enumOrNull('changeResourceType', e.changeResourceType);
        if (type === null || (types && !types.includes(type)))
          invalid('Google Ads returned a change of a resource type outside the request.');
        const changed = e.changedFields;
        if (
          changed !== undefined &&
          (typeof changed !== 'string' ||
            changed.length > 8192 ||
            changed.split(',').some((p: string) => !/^[A-Za-z0-9_.]{1,256}$/.test(p)))
        )
          invalid('Google Ads returned malformed changed field paths.');
        return {
          change_date_time: at,
          resource_type: type,
          operation: enumOrNull('resourceChangeOperation', e.resourceChangeOperation),
          client_type: enumOrNull('clientType', e.clientType),
          resource_name: resource(e.changeResourceName),
          changed_fields: changed ? (changed as string).split(',') : [],
          campaign: resource(e.campaign, 'campaigns'),
          ad_group: resource(e.adGroup, 'adGroups'),
          asset: resource(e.asset, 'assets'),
          change_event: name,
        };
      });
      rows.sort(
        (a, b) =>
          b.change_date_time.localeCompare(a.change_date_time) || a.change_event!.localeCompare(b.change_event!),
      );
      // A timeline the website or an assistant can show without the rows: changes per account-local day.
      const count = (key: (r: (typeof rows)[number]) => string | null) =>
        Object.fromEntries(
          [
            ...rows.reduce(
              (m, r) => m.set(key(r) ?? 'not_reported', (m.get(key(r) ?? 'not_reported') ?? 0) + 1),
              new Map<string, number>(),
            ),
          ].sort(([a], [b]) => a.localeCompare(b)),
        );
      current();
      budget.check();
      const capturedAt = Date.now(),
        limitReached = rows.length === limit;
      return {
        record_kind: 'change_history',
        scope,
        requested_at: requestedAt,
        captured_at: capturedAt,
        timezone: 'account',
        complete: !limitReached,
        limit_reached: limitReached,
        row_count: rows.length,
        rows,
        timeline: {
          by_day: count(r => r.change_date_time.slice(0, 10)),
          by_resource_type: count(r => r.resource_type),
          by_operation: count(r => r.operation),
          by_client_type: count(r => r.client_type),
        },
        personal_data: {user_email: 'not_requested'},
        source_references: [
          {
            request: {method: 'POST', resource: 'customers/' + account + '/googleAds:search', query},
            observed_at: capturedAt,
            source_hash: fingerprint(rows),
          },
        ],
        source_hash: fingerprint({scope, query, rows, requestedAt, capturedAt}),
        provider_mutations: 0,
        retained_snapshot: false,
        meaning:
          'Google Ads change events of the selected customer in the requested account-local dates, newest first. Who made a change is personal data and was not requested; client_type names the tool used. Changed field paths name what changed, not its old or new value. limit_reached means older changes in the window may exist. Change history explains configuration changes; it does not prove their effect on performance. Nothing was saved or changed.',
      };
    });
  } finally {
    budget.close();
  }
}
