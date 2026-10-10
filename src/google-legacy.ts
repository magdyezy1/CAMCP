import mapping from './google-legacy-mapping.json' with {type: 'json'};
import {MirrorError} from './errors.js';
import {assertProviderAliasAvailable} from './retired-provider-actions.js';
import {googleAdsRequestChange} from './google-version.js';
import {guardInput, stable as stableJson} from './security.js';
import type {Registry} from './catalog.js';
import type {Action, CompiledRequest, JsonObject} from './types.js';

/** These are independently specified adapters. Captured legacy names do not establish wire parity. */
export interface GoogleLegacyAdaptation {
  input: JsonObject;
  legacyAction: string;
  evidence: 'INDEPENDENT_DESIGN';
  warnings: string[];
  responseMode: 'native';
  /** The GAQL LIMIT this list alias applied because the caller gave no limit and no query. */
  defaultLimit?: number;
}
interface Field {
  type: string;
  repeated?: boolean;
  required?: boolean;
  outputOnly?: boolean;
  immutable?: boolean;
}
interface Descriptor {
  kind: string;
  fields?: Record<string, Field>;
  oneofs?: string[][];
  values?: string[];
  resourcePattern?: string;
  source: string;
}
interface Entry {
  name: string;
  kind: string;
  rule: string;
  canonical?: string;
  resource?: string;
  verb?: string;
}
const descriptors = mapping.googleProto.descriptors as Record<string, Descriptor>;
const requests = mapping.googleProto.rpcRequests as Record<string, string>;
const entries = new Map<string, Entry>(mapping.entries.map(e => [e.name, e]));
const gateway = 'google_ads_native_action';
/** The Google Ads version of the pinned descriptors (tools/google-legacy-descriptors.mjs), the version AMCP sends. */
const version = mapping.googleProto.version,
  prefix = 'google.ads.googleads.' + version + '.';
const snake = (s: string) =>
  s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const isObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function error(code: string, message: string, details: JsonObject = {}): never {
  throw new MirrorError(code, message, details);
}
const obj = (v: unknown, label: string): JsonObject =>
  isObject(v) ? v : error('INVALID_LEGACY_INPUT', label + ' must be an object.');
const id = (v: unknown, label: string): string =>
  typeof v === 'string' && /^\d{1,20}$/.test(v)
    ? v
    : error('INVALID_RESOURCE_ID', label + ' must be a decimal string.');
function merge(...bags: JsonObject[]): JsonObject {
  const out: JsonObject = {};
  for (const bag of bags)
    for (const [key, value] of Object.entries(bag)) {
      if (key in out && stableJson(out[key]) !== stableJson(value))
        error('CONFLICTING_ARGUMENT', 'Conflicting values in legacy input envelopes.', {field: key});
      out[key] = value;
    }
  return out;
}
function normalized(value: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, v] of Object.entries(value)) {
    const k = snake(key);
    if (k in out) error('DUPLICATE_FIELD', 'Do not supply both protobuf and JSON field spellings.', {field: k});
    out[k] = v;
  }
  return out;
}
function typeName(type: string, context: string): string {
  if (descriptors[type]) return type;
  let scope = context;
  while (scope.includes('.')) {
    const n = scope + '.' + type;
    if (descriptors[n]) return n;
    scope = scope.slice(0, scope.lastIndexOf('.'));
  }
  return type;
}
function schema(type: string, context = ''): Descriptor {
  return (
    descriptors[typeName(type, context)] ??
    error('GOOGLE_SCHEMA_UNAVAILABLE', 'The pinned Google schema cannot resolve a message.', {type, context})
  );
}

/** Structural protobuf validation is separate from vendor business rules, eligibility and live validation. */
export function validateGoogleMessage(
  type: string,
  value: unknown,
  context = '',
  path = 'request',
  partial = false,
): JsonObject {
  const name = typeName(type, context),
    desc = schema(name),
    input = normalized(obj(value, path)),
    out: JsonObject = {};
  for (const [key, v] of Object.entries(input)) {
    const field = desc.fields?.[key];
    if (!field)
      error('UNKNOWN_GOOGLE_FIELD', 'Field is absent from the pinned Google Ads ' + version + ' message.', {
        message: name,
        field: path + '.' + key,
      });
    if (field.outputOnly)
      error('OUTPUT_ONLY_FIELD', 'Output-only fields cannot be submitted.', {field: path + '.' + key});
    if (v === null) {
      out[key] = null;
      continue;
    }
    const scalar = (item: unknown): unknown => {
      const t = typeName(field.type, name),
        d = descriptors[t];
      if (t === 'google.protobuf.FieldMask') {
        if (typeof item !== 'string' || !item.trim())
          error('INVALID_UPDATE_MASK', 'FieldMask must be a nonempty comma-separated string.');
        return item
          .split(',')
          .map(p => p.trim().split('.').map(camel).join('.'))
          .join(',');
      }
      if (t === 'google.protobuf.Timestamp' || t === 'google.protobuf.Duration') {
        if (typeof item !== 'string')
          error('INVALID_GOOGLE_FIELD', path + '.' + key + ' must be a protobuf JSON string.');
        return item;
      }
      if (t === 'string' || t === 'bytes') {
        if (typeof item !== 'string') error('INVALID_GOOGLE_FIELD', path + '.' + key + ' must be a string.');
        return item;
      }
      if (t === 'bool') {
        if (typeof item !== 'boolean') error('INVALID_GOOGLE_FIELD', path + '.' + key + ' must be boolean.');
        return item;
      }
      if (/^(u?int|sint|fixed|sfixed)(32|64)$/.test(t)) {
        if (!(
          (typeof item === 'string' && /^-?\d+$/.test(item)) ||
          (typeof item === 'number' && Number.isSafeInteger(item))
        ))
          error('INVALID_GOOGLE_FIELD', path + '.' + key + ' must be an exact integer; use strings for large values.');
        if (t.startsWith('u') && BigInt(item as string | number) < 0n)
          error('INVALID_GOOGLE_FIELD', 'Unsigned value cannot be negative.');
        return item;
      }
      if (t === 'float' || t === 'double') {
        if (typeof item !== 'number' || !Number.isFinite(item))
          error('INVALID_GOOGLE_FIELD', path + '.' + key + ' must be finite.');
        return item;
      }
      if (d?.kind === 'enum') {
        if (typeof item !== 'string' || !d.values?.includes(item))
          error('INVALID_GOOGLE_ENUM', 'Use a symbolic enum value from the pinned Google Ads ' + version + ' schema.', {
            field: path + '.' + key,
            allowed: d.values,
          });
        return item;
      }
      if (d?.kind === 'message')
        return validateGoogleMessage(t, item, '', path + '.' + key, partial || key === 'update');
      if (/^map\s*</.test(t)) {
        const target = t.match(/,\s*([\w.]+)\s*>/)?.[1];
        const map = obj(item, path + '.' + key);
        if (!target) error('GOOGLE_SCHEMA_UNAVAILABLE', 'Unresolved map type.');
        return Object.fromEntries(
          Object.entries(map).map(([k, v]) => [
            k,
            descriptors[typeName(target, name)]
              ? validateGoogleMessage(target, v, name, path + '.' + key + '.' + k, partial)
              : v,
          ]),
        );
      }
      error('GOOGLE_SCHEMA_UNAVAILABLE', 'The pinned schema cannot validate this field type.', {
        field: path + '.' + key,
        type: t,
      });
    };
    if (field.repeated) {
      if (!Array.isArray(v)) error('INVALID_GOOGLE_FIELD', path + '.' + key + ' must be an array.');
      out[key] = v.map(scalar);
    } else out[key] = scalar(v);
  }
  if (!partial)
    for (const [key, field] of Object.entries(desc.fields ?? {}))
      if (
        field.required &&
        (out[key] === undefined ||
          out[key] === null ||
          out[key] === '' ||
          (Array.isArray(out[key]) && !out[key].length))
      )
        error('MISSING_GOOGLE_FIELD', 'Missing required Google request field.', {
          message: name,
          field: path + '.' + key,
        });
  for (const group of desc.oneofs ?? []) {
    const supplied = group.filter(k => out[k] !== undefined && out[k] !== null);
    if (supplied.length > 1)
      error('GOOGLE_ONEOF_CONFLICT', 'Only one field in a protobuf oneof may be set.', {field: path, fields: supplied});
  }
  return out;
}

function assertAccountReferences(value: unknown, account: string): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\bcustomers\/([^/\s'"(),]+)/g))
      if (match[1] !== account)
        error('ACCOUNT_SCOPE_MISMATCH', 'Resource belongs to a different Google customer.', {account_id: account});
  } else if (Array.isArray(value)) value.forEach(v => assertAccountReferences(v, account));
  else if (isObject(value)) Object.values(value).forEach(v => assertAccountReferences(v, account));
}
function resourceName(type: string, data: JsonObject, account: string): string {
  const pattern =
    schema(type).resourcePattern ??
    error(
      'RESOURCE_IDENTITY_UNAVAILABLE',
      'Provide an explicit native request for a resource without a captured identity pattern.',
      {type},
    );
  const supplied = data.resource_name ?? data.resourceName;
  if (supplied !== undefined) {
    if (typeof supplied !== 'string') error('INVALID_RESOURCE_NAME', 'resource_name must be a string.');
    const re = new RegExp('^' + pattern.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '([^/]+)') + '$');
    if (!re.test(supplied) || /[?#\\\r\n%]/.test(supplied) || supplied.split('/').some(p => p === '.' || p === '..'))
      error('INVALID_RESOURCE_NAME', 'Resource name must match the Google identity pattern.', {pattern});
    assertAccountReferences(supplied, account);
    return supplied;
  }
  const parts = [...pattern.matchAll(/\{([^}]+)\}/g)].map(m => m[1]!);
  const nonCustomer = parts.filter(p => p !== 'customer_id');
  return pattern.replace(/\{([^}]+)\}/g, (_, part: string) => {
    if (part === 'customer_id') return account;
    const value = data[part] ?? (nonCustomer.length === 1 ? data.entity_id : undefined);
    if (value === undefined)
      error('MISSING_RESOURCE_IDENTITY', 'Provide resource_name or all identity parts; parent IDs are never guessed.', {
        pattern,
        missing: part,
      });
    if (part === 'field_type') {
      const field = schema(type).fields?.field_type,
        values = field ? schema(typeName(field.type, type)).values : undefined;
      if (typeof value !== 'string' || !values?.includes(value) || ['UNKNOWN', 'UNSPECIFIED'].includes(value))
        error('INVALID_RESOURCE_ID', 'field_type must be a documented symbolic asset role.');
      return value;
    }
    if (part === 'recommendation_type') {
      if (typeof value !== 'string' || !/^[A-Z_]+$/.test(value))
        error('INVALID_RESOURCE_ID', 'recommendation_type must be a symbolic enum.');
      return value;
    }
    return id(value, part);
  });
}

function maskFor(type: string, resource: JsonObject, input: unknown): string {
  if (input === undefined)
    error(
      'UPDATE_MASK_REQUIRED',
      'Provide update_mask explicitly, including fields to clear. Resource identity is excluded.',
    );
  const paths = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : error('INVALID_UPDATE_MASK', 'update_mask must be a string or array of field paths.');
  if (!paths.length) error('INVALID_UPDATE_MASK', 'update_mask must not be empty.');
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim() || raw === '*')
      error('INVALID_UPDATE_MASK', 'Use explicit field paths; wildcard updates are not allowed.');
    const parts = raw.trim().split('.').map(snake);
    let current = type;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!,
        d = schema(current),
        f = d.fields?.[part];
      if (!f || f.outputOnly || f.immutable || part === 'resource_name')
        error('INVALID_UPDATE_MASK', 'Mask contains an unknown, immutable or output-only field.', {
          field: raw,
          type: current,
        });
      if (i < parts.length - 1) {
        if (f.repeated) error('INVALID_UPDATE_MASK', 'Repeated fields must be updated as a whole.', {field: raw});
        current = typeName(f.type, current);
      }
    }
    const canonical = parts.map(camel).join('.');
    if (seen.has(canonical)) error('INVALID_UPDATE_MASK', 'Duplicate update mask field.', {field: raw});
    seen.add(canonical);
  }
  for (const key of Object.keys(resource))
    if (key !== 'resource_name' && ![...seen].some(p => p === camel(key) || p.startsWith(camel(key) + '.')))
      error('UNMASKED_UPDATE_FIELD', 'Every supplied update field must be included in update_mask.', {field: key});
  return [...seen].join(',');
}

const mainFields: Record<string, string[]> = {
  campaign: ['resource_name', 'id', 'name', 'status', 'advertising_channel_type', 'campaign_budget'],
  ad_group: ['resource_name', 'id', 'name', 'status', 'campaign', 'type'],
  ad_group_ad: ['resource_name', 'ad_group', 'status', 'ad.id', 'ad.name', 'ad.type', 'ad.final_urls'],
  asset_group: ['resource_name', 'id', 'name', 'status', 'campaign'],
  ad_group_criterion: [
    'resource_name',
    'criterion_id',
    'ad_group',
    'status',
    'negative',
    'keyword.text',
    'keyword.match_type',
  ],
  campaign_criterion: ['resource_name', 'criterion_id', 'campaign', 'type', 'negative'],
  customer_negative_criterion: ['resource_name', 'type'],
  shared_set: ['resource_name', 'id', 'name', 'type'],
  shared_criterion: ['resource_name', 'shared_set', 'criterion_id', 'type'],
  campaign_budget: ['resource_name', 'id', 'name', 'amount_micros', 'explicitly_shared'],
  asset: ['resource_name', 'id', 'name', 'type'],
  user_list: ['resource_name', 'id', 'name', 'membership_status'],
  conversion_action: ['resource_name', 'id', 'name', 'type', 'status'],
  search_term_view: ['resource_name', 'search_term', 'status'],
  recommendation: ['resource_name', 'type'],
  recommendation_subscription: ['resource_name', 'type', 'status'],
};
const staticFilters: Record<string, string[]> = {
  FETCH_KEYWORDS: ["ad_group_criterion.type = 'KEYWORD'", 'ad_group_criterion.negative = FALSE'],
  LIST_AD_GROUP_NEGATIVE_KEYWORDS: ["ad_group_criterion.type = 'KEYWORD'", 'ad_group_criterion.negative = TRUE'],
  LIST_CAMPAIGN_NEGATIVE_KEYWORDS: ["campaign_criterion.type = 'KEYWORD'", 'campaign_criterion.negative = TRUE'],
  LIST_ACCOUNT_NEGATIVE_KEYWORDS: ["customer_negative_criterion.type = 'KEYWORD'"],
  LIST_SHARED_NEGATIVE_KEYWORD_LISTS: ["shared_set.type = 'NEGATIVE_KEYWORDS'"],
  LIST_SHARED_NEGATIVE_KEYWORDS: ["shared_criterion.type = 'KEYWORD'"],
  LIST_BRAND_LISTS: ["shared_set.type = 'BRANDS'"],
  LIST_BRAND_LIST_BRANDS: ["shared_criterion.type = 'BRAND'"],
};
const fieldName = (value: unknown): string =>
  typeof value === 'string' && /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(value)
    ? value
    : error('INVALID_GAQL_FIELD', 'Use a dotted snake_case GAQL field name.');
function gaqlLiteral(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && !/[\u0000-\u001f]/.test(value))
    return "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
  return error('INVALID_GAQL_VALUE', 'Filter values must be strings, finite numbers or booleans.');
}
function date(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value
  )
    error('INVALID_DATE', 'Use a valid YYYY-MM-DD date.');
  return value;
}
function gaql(resource: string, data: JsonObject, name: string): string {
  if (data.query !== undefined) {
    if (
      typeof data.query !== 'string' ||
      !/^\s*SELECT\s/i.test(data.query) ||
      /[;\u0000]/.test(data.query) ||
      /--|\/\*/.test(data.query)
    )
      error('INVALID_GAQL_QUERY', 'Provide one SELECT query without comments or statement separators.');
    const from = data.query.match(/\bFROM\s+([a-z_]+)\b/i)?.[1]?.toLowerCase();
    if (resource && from !== resource)
      error('GAQL_RESOURCE_MISMATCH', 'Query FROM does not match the explicit legacy route.', {
        expected: resource,
        actual: from,
      });
    if ((staticFilters[name]?.length || name.startsWith('LIST_APP_')) && !data.query_contract_acknowledged)
      error(
        'EXPLICIT_QUERY_CONTRACT_REQUIRED',
        'For this typed alias, supply fields/filters or query_contract_acknowledged=true to take responsibility for its typed query constraints.',
      );
    return data.query;
  }
  const allowed = new Set([
    'fields',
    'filters',
    'limit',
    'start_date',
    'end_date',
    'date_range',
    'campaign_id',
    'ad_group_id',
    'ad_id',
    'shared_set_id',
    'page_token',
    'order_by',
    'negative',
    'query_contract_acknowledged',
  ]);
  for (const key of Object.keys(data))
    if (!allowed.has(key)) error('UNKNOWN_LEGACY_ARGUMENT', 'Unknown query adapter argument.', {field: key});
  const fields = data.fields ?? mainFields[resource]?.map(f => resource + '.' + f);
  if (!Array.isArray(fields) || !fields.length)
    error(
      'GAQL_FIELDS_REQUIRED',
      'Provide explicit fields for this resource; metric grain and projection are not inferred.',
      {resource},
    );
  const select = [...new Set(fields.map(fieldName))];
  const where = [...(staticFilters[name] ?? [])];
  if (name.startsWith('LIST_APP_')) {
    if (
      [
        'campaign',
        'ad_group',
        'ad_group_ad',
        'ad_group_ad_asset_view',
        'campaign_criterion',
        'ad_group_criterion',
      ].includes(resource)
    )
      where.push("campaign.advertising_channel_type = 'MULTI_CHANNEL'");
    else
      error(
        'APP_QUERY_REQUIRED',
        'Provide an explicit query with query_contract_acknowledged=true for app-specific conversion, SKAN, customer or shared scope.',
      );
  }
  for (const [key, field] of [
    ['campaign_id', 'campaign.id'],
    ['ad_group_id', 'ad_group.id'],
    ['ad_id', 'ad_group_ad.ad.id'],
    ['shared_set_id', 'shared_set.id'],
  ] as const)
    if (data[key] !== undefined) where.push(field + ' = ' + id(data[key], key));
  if (data.negative !== undefined) {
    if (typeof data.negative !== 'boolean' || !['ad_group_criterion', 'campaign_criterion'].includes(resource))
      error('INVALID_NEGATIVE_FILTER', 'negative requires a criterion route and boolean value.');
    if (name === 'FETCH_KEYWORDS' && data.negative)
      error('CONFLICTING_ARGUMENT', 'Use the explicit negative keyword alias.');
    where.push(resource + '.negative = ' + gaqlLiteral(data.negative));
  }
  if (data.filters !== undefined) {
    if (!Array.isArray(data.filters)) error('INVALID_GAQL_FILTER', 'filters must be an array.');
    for (const f of data.filters) {
      const filter = obj(f, 'filter'),
        field = fieldName(filter.field),
        op = String(filter.operator ?? '=');
      if (
        ![
          '=',
          '!=',
          '>',
          '>=',
          '<',
          '<=',
          'LIKE',
          'NOT LIKE',
          'IN',
          'NOT IN',
          'CONTAINS ANY',
          'CONTAINS ALL',
          'CONTAINS NONE',
        ].includes(op)
      )
        error('INVALID_GAQL_FILTER', 'Unsupported typed filter operator.');
      const multi = ['IN', 'NOT IN', 'CONTAINS ANY', 'CONTAINS ALL', 'CONTAINS NONE'].includes(op);
      if (multi && (!Array.isArray(filter.value) || !filter.value.length))
        error('INVALID_GAQL_FILTER', 'List operators require a nonempty array.');
      where.push(
        field +
          ' ' +
          op +
          ' ' +
          (multi ? '(' + filter.value.map(gaqlLiteral).join(', ') + ')' : gaqlLiteral(filter.value)),
      );
    }
  }
  const range = data.date_range ?? {};
  if (data.start_date || data.end_date || Object.keys(range).length) {
    const start = date(data.start_date ?? range.start),
      end = date(data.end_date ?? range.end);
    if (start > end) error('INVALID_DATE_RANGE', 'start_date must not be after end_date.');
    where.push("segments.date BETWEEN '" + start + "' AND '" + end + "'");
  }
  if (select.some(f => f.startsWith('metrics.')) && !where.some(f => f.startsWith('segments.date ')))
    error('REPORT_DATE_RANGE_REQUIRED', 'Metric queries require an explicit date range.');
  if (['change_event', 'change_status'].includes(resource))
    error(
      'CHANGE_WINDOW_QUERY_REQUIRED',
      'Provide an explicit bounded query for change resources, with their native date-time field and documented retention window.',
    );
  let order = '';
  if (data.order_by !== undefined) {
    if (!Array.isArray(data.order_by)) error('INVALID_GAQL_ORDER', 'order_by must be an array of {field,direction}.');
    order =
      ' ORDER BY ' +
      data.order_by
        .map((o: unknown) => {
          const item = obj(o, 'order_by');
          const direction = item.direction ?? 'ASC';
          if (!['ASC', 'DESC'].includes(direction)) error('INVALID_GAQL_ORDER', 'Order direction must be ASC or DESC.');
          return fieldName(item.field) + ' ' + direction;
        })
        .join(', ');
  }
  const limit = data.limit ?? legacyDefaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
    error('INVALID_QUERY_LIMIT', 'limit must be an integer between 1 and 10000.');
  return (
    'SELECT ' +
    select.join(', ') +
    ' FROM ' +
    resource +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    order +
    ' LIMIT ' +
    limit
  );
}

const directRpc: Record<string, string> = {
  GENERATE_TEXT_ASSETS: 'AssetGenerationService.GenerateText',
  GENERATE_IMAGE_ASSETS: 'AssetGenerationService.GenerateImages',
  CONFIGURE_CUSTOMER_LIFECYCLE_GOAL: 'CustomerLifecycleGoalService.ConfigureCustomerLifecycleGoals',
  CONFIGURE_CAMPAIGN_LIFECYCLE_GOAL: 'CampaignLifecycleGoalService.ConfigureCampaignLifecycleGoals',
  REGENERATE_THIRD_PARTY_APP_ANALYTICS_LINK: 'ThirdPartyAppAnalyticsLinkService.RegenerateShareableLinkId',
  MUTATE_SKAD_CONVERSION_VALUE_SCHEMA:
    'CustomerSkAdNetworkConversionValueSchemaService.MutateCustomerSkAdNetworkConversionValueSchema',
  SEARCH_LOCATIONS: 'GeoTargetConstantService.SuggestGeoTargetConstants',
};
/** The LIMIT a generated legacy GAQL query applies when the caller gives none. */
export const legacyDefaultLimit = 100;
const bespokeQueries: Record<string, string> = {
  FETCH_CAMPAIGN_INSIGHTS: 'campaign',
  LIST_BRAND_LISTS: 'shared_set',
  LIST_BRAND_LIST_BRANDS: 'shared_criterion',
  SEARCH_INTERESTS: 'user_interest',
  LIST_APP_CAMPAIGNS: 'campaign',
  LIST_APP_AD_GROUPS: 'ad_group',
  LIST_APP_ADS: 'ad_group_ad',
  LIST_APP_ASSET_PERFORMANCE: 'ad_group_ad_asset_view',
  LIST_APP_CONVERSION_ACTIONS: 'conversion_action',
  LIST_APP_SKAN_PERFORMANCE: 'campaign',
  LIST_APP_CAMPAIGN_CRITERIA: 'campaign_criterion',
  LIST_APP_AD_GROUP_CRITERIA: 'ad_group_criterion',
  LIST_APP_ACCOUNT_NEGATIVE_CRITERIA: 'customer_negative_criterion',
  LIST_APP_SHARED_CRITERIA: 'shared_criterion',
};
const mutationRoutes: Record<string, [string, string]> = {
  CREATE_CAMPAIGN: ['CampaignService.MutateCampaigns', 'create'],
  UPDATE_CAMPAIGN: ['CampaignService.MutateCampaigns', 'update'],
  UPDATE_CAMPAIGN_BUDGET: ['CampaignBudgetService.MutateCampaignBudgets', 'update'],
  CREATE_AD: ['AdGroupAdService.MutateAdGroupAds', 'create'],
  DELETE_AD: ['AdGroupAdService.MutateAdGroupAds', 'remove'],
  CREATE_NEGATIVE_KEYWORD_LIST: ['SharedSetService.MutateSharedSets', 'create'],
  ATTACH_NEGATIVE_KEYWORD_LIST: ['CampaignSharedSetService.MutateCampaignSharedSets', 'create'],
  CREATE_BRAND_LIST: ['SharedSetService.MutateSharedSets', 'create'],
  ADD_BRAND_TO_LIST: ['SharedCriterionService.MutateSharedCriteria', 'create'],
  REMOVE_BRAND_FROM_LIST: ['SharedCriterionService.MutateSharedCriteria', 'remove'],
  ATTACH_BRAND_LIST_TO_CAMPAIGN: ['CampaignCriterionService.MutateCampaignCriteria', 'create'],
  DETACH_BRAND_LIST_FROM_CAMPAIGN: ['CampaignCriterionService.MutateCampaignCriteria', 'remove'],
  SUBSCRIBE_RECOMMENDATION: ['RecommendationSubscriptionService.MutateRecommendationSubscription', 'create'],
  UNSUBSCRIBE_RECOMMENDATION: ['RecommendationSubscriptionService.MutateRecommendationSubscription', 'update'],
  UPDATE_RECOMMENDATION_SUBSCRIPTION: ['RecommendationSubscriptionService.MutateRecommendationSubscription', 'update'],
  CREATE_CUSTOMER_MATCH_USER_LIST: ['UserListService.MutateUserLists', 'create'],
  CREATE_LOOKALIKE_USER_LIST: ['UserListService.MutateUserLists', 'create'],
  CREATE_MOBILE_APP_ASSET: ['AssetService.MutateAssets', 'create'],
  CREATE_APP_DEEP_LINK_ASSET: ['AssetService.MutateAssets', 'create'],
  CREATE_APP_AD_GROUP_ASSET: ['AdGroupAssetService.MutateAdGroupAssets', 'create'],
  SET_CAMPAIGN_BRAND_SAFETY: ['CampaignService.MutateCampaigns', 'update'],
};

function destination(registry: Registry, value: string): Action {
  return (
    registry.data.catalogs
      .find(c => c.gateway === gateway)
      ?.actions.find(a => a.path && (a.name === value || a.raw.service + '.' + a.raw.rpc === value)) ??
    error('GOOGLE_DESTINATION_UNAVAILABLE', 'Canonical destination is absent from the captured catalog.', {
      destination: value,
    })
  );
}
function operationInfo(action: Action): {key: string; type: string; descriptor: Descriptor} {
  const request = schema(requests[action.name]!),
    key = request.fields?.operation ? 'operation' : 'operations',
    field = request.fields?.[key];
  if (!field) error('GOOGLE_OPERATION_UNAVAILABLE', 'Destination does not accept resource mutation operations.');
  const type = typeName(field.type, requests[action.name]!);
  return {key, type, descriptor: schema(type)};
}
function nativeBody(action: Action, body: JsonObject, account: string): JsonObject {
  const desc = requests[action.name] ?? error('GOOGLE_SCHEMA_UNAVAILABLE', 'Missing native request descriptor.');
  const fields = schema(desc).fields ?? {};
  const value = normalized(body);
  if (fields.customer_id) {
    if (value.customer_id !== undefined && String(value.customer_id).replaceAll('-', '') !== account)
      error('ACCOUNT_SCOPE_MISMATCH', 'Native request customer_id conflicts with account_id.');
    value.customer_id = account;
  }
  let validated: JsonObject;
  try {
    validated = validateGoogleMessage(desc, value);
  } catch (e) {
    // A request shaped for the captured version names what the current one takes instead.
    const change = googleAdsRequestChange(action.name);
    if (change && e instanceof MirrorError)
      throw new MirrorError(e.code, e.message, {...e.details, version_change: change}, e.status, e.retryable);
    throw e;
  }
  assertAccountReferences(validated, account);
  for (const key of ['operations', 'operation'])
    if (validated[key])
      for (const operation of Array.isArray(validated[key]) ? validated[key] : [validated[key]])
        if (isObject(operation) && operation.update) {
          const info = operationInfo(action),
            f = info.descriptor.fields?.update;
          if (f) operation.update_mask = maskFor(typeName(f.type, info.type), operation.update, operation.update_mask);
        }
  return validated;
}
function compileMutation(action: Action, verb: string, data: JsonObject, account: string, legacy: string): JsonObject {
  const info = operationInfo(action),
    field = info.descriptor.fields?.[verb];
  if (!field)
    error('UNSUPPORTED_GOOGLE_MUTATION', 'This Google operation does not support ' + verb + '.', {action: action.name});
  if (data.request !== undefined) return nativeBody(action, obj(data.request, 'request'), account);
  if (data.operations !== undefined || data.operation !== undefined) return nativeBody(action, data, account);
  const type =
    verb === 'remove'
      ? typeName(info.descriptor.fields?.update?.type ?? info.descriptor.fields?.create?.type ?? '', info.type)
      : typeName(field.type, info.type);
  let operation: JsonObject;
  if (verb === 'remove') operation = {remove: resourceName(type, data, account)};
  else {
    let raw = normalized(obj(data.resource, 'resource'));
    if (verb === 'update') raw.resource_name = resourceName(type, {...data, ...raw}, account);
    if (verb === 'create' && ['CREATE_CAMPAIGN', 'CREATE_AD_GROUP', 'CREATE_AD'].includes(legacy)) {
      if (raw.status !== undefined && raw.status !== 'PAUSED')
        error('PAUSED_CREATION_REQUIRED', 'Campaigns, ad groups and ads must be created PAUSED.');
      raw.status = 'PAUSED';
    }
    if (legacy === 'CREATE_CAMPAIGN') {
      for (const key of ['name', 'advertising_channel_type', 'campaign_budget'])
        if (!raw[key])
          error(
            'MISSING_CAMPAIGN_FIELD',
            'Create a campaign with name, advertising_channel_type and an explicit campaign_budget resource. Budget creation is a separate operation.',
            {field: key},
          );
    }
    if (legacy === 'CREATE_AD' && (!raw.ad_group || !isObject(raw.ad)))
      error('MISSING_AD_PARENT', 'Create an AdGroupAd with ad_group and embedded ad.');
    if (legacy === 'CREATE_NEGATIVE_KEYWORD_LIST' || legacy === 'CREATE_BRAND_LIST') {
      const expected = legacy === 'CREATE_BRAND_LIST' ? 'BRANDS' : 'NEGATIVE_KEYWORDS';
      if (raw.type !== undefined && raw.type !== expected)
        error('INVALID_SHARED_SET_TYPE', 'Shared-set type conflicts with the alias.');
      raw.type = expected;
    }
    if (legacy === 'ATTACH_NEGATIVE_KEYWORD_LIST' && (!raw.campaign || !raw.shared_set))
      error('MISSING_ASSOCIATION', 'Provide campaign and shared_set resource names.');
    if (legacy === 'ADD_BRAND_TO_LIST' && (!raw.shared_set || !raw.brand?.entity_id))
      error('MISSING_BRAND_IDENTITY', 'Provide shared_set and brand.entity_id.');
    if (
      legacy === 'ATTACH_BRAND_LIST_TO_CAMPAIGN' &&
      (!raw.campaign || !raw.brand_list?.shared_set || typeof raw.negative !== 'boolean')
    )
      error(
        'EXPLICIT_BRAND_SCOPE_REQUIRED',
        'Provide campaign, brand_list.shared_set and explicit negative boolean for inclusion/exclusion.',
      );
    if (legacy === 'UNSUBSCRIBE_RECOMMENDATION') {
      if (raw.status !== undefined && raw.status !== 'PAUSED')
        error('INVALID_SUBSCRIPTION_STATUS', 'Unsubscribe uses status PAUSED; removal is unsupported.');
      raw.status = 'PAUSED';
      data = {...data, update_mask: 'status'};
    }
    for (const [name, variant] of Object.entries({
      CREATE_CUSTOMER_MATCH_USER_LIST: 'crm_based_user_list',
      CREATE_LOOKALIKE_USER_LIST: 'lookalike_user_list',
      CREATE_MOBILE_APP_ASSET: 'mobile_app_asset',
      CREATE_APP_DEEP_LINK_ASSET: 'app_deep_link_asset',
    }))
      if (legacy === name && !isObject(raw[variant]))
        error('MISSING_TYPED_RESOURCE', 'Provide the explicit typed Google resource variant.', {variant});
    if (legacy === 'SET_CAMPAIGN_BRAND_SAFETY') {
      if (
        Object.keys(raw).some(k => !['resource_name', 'video_brand_safety_suitability'].includes(k)) ||
        !raw.video_brand_safety_suitability
      )
        error(
          'EXPLICIT_BRAND_SAFETY_REQUIRED',
          'This adapter changes only video_brand_safety_suitability. Use content-label criteria separately.',
        );
      data = {...data, update_mask: 'video_brand_safety_suitability'};
    }
    raw = validateGoogleMessage(type, raw, '', 'resource', verb === 'update');
    operation = {[verb]: raw};
    if (verb === 'update') operation.update_mask = maskFor(type, raw, data.update_mask ?? data.updateMask);
  }
  const allowed = new Set([
    'resource',
    'resource_name',
    'resourceName',
    'update_mask',
    'updateMask',
    'entity_id',
    ...Array.from(schema(type).resourcePattern?.matchAll(/\{([^}]+)\}/g) ?? []).map(m => m[1]!),
    'partial_failure',
    'validate_only',
    'response_content_type',
  ]);
  for (const key of Object.keys(data))
    if (!allowed.has(key))
      error(
        'UNKNOWN_LEGACY_ARGUMENT',
        'Unknown mutation adapter argument; native fields belong inside resource or request.',
        {field: key},
      );
  const body: JsonObject = {[info.key]: info.key === 'operations' ? [operation] : operation};
  for (const key of ['partial_failure', 'validate_only', 'response_content_type'])
    if (data[key] !== undefined) body[key] = data[key];
  return nativeBody(action, body, account);
}

function keywords(
  registry: Registry,
  data: JsonObject,
  account: string,
  name: string,
): {action: Action; body: JsonObject} {
  const negative = name.includes('NEGATIVE'),
    scope = name === 'ADD_SHARED_NEGATIVE_KEYWORDS' ? 'shared' : (data.scope ?? (!negative ? 'ad_group' : undefined));
  const routes: Record<string, string> = {
    ad_group: 'AdGroupCriterionService.MutateAdGroupCriteria',
    campaign: 'CampaignCriterionService.MutateCampaignCriteria',
    customer: 'CustomerNegativeCriterionService.MutateCustomerNegativeCriteria',
    shared: 'SharedCriterionService.MutateSharedCriteria',
  };
  if (typeof scope !== 'string' || !routes[scope])
    error('KEYWORD_SCOPE_REQUIRED', 'Provide explicit keyword scope: ad_group, campaign, customer, or shared.');
  if (!negative && scope !== 'ad_group')
    error('INVALID_KEYWORD_SCOPE', 'Positive keyword aliases require ad_group scope.');
  const action = destination(registry, routes[scope]!);
  if (name === 'REMOVE_KEYWORDS') {
    if (!Array.isArray(data.resource_names) || !data.resource_names.length)
      error('KEYWORD_IDENTITIES_REQUIRED', 'Provide full resource_names including parent and criterion IDs.');
    const info = operationInfo(action),
      type = typeName(info.descriptor.fields!.create!.type, info.type);
    return {
      action,
      body: nativeBody(
        action,
        {
          operations: data.resource_names.map((n: unknown) => ({
            remove: resourceName(type, {resource_name: n}, account),
          })),
        },
        account,
      ),
    };
  }
  if (!Array.isArray(data.keywords) || !data.keywords.length)
    error('KEYWORDS_REQUIRED', 'Provide a nonempty keywords array of {text,match_type}.');
  const parent =
    scope === 'ad_group'
      ? {
          ad_group: resourceName(
            prefix + 'resources.AdGroup',
            {resource_name: data.ad_group, ad_group_id: data.ad_group_id},
            account,
          ),
        }
      : scope === 'campaign'
        ? {
            campaign: resourceName(
              prefix + 'resources.Campaign',
              {resource_name: data.campaign, campaign_id: data.campaign_id},
              account,
            ),
          }
        : scope === 'shared'
          ? {
              shared_set: resourceName(
                prefix + 'resources.SharedSet',
                {resource_name: data.shared_set, shared_set_id: data.shared_set_id},
                account,
              ),
            }
          : {};
  const operations = data.keywords.map((k: unknown) => {
    const keyword = normalized(obj(k, 'keyword'));
    if (
      typeof keyword.text !== 'string' ||
      !keyword.text.trim() ||
      keyword.text.length > 80 ||
      keyword.text.trim().split(/\s+/).length > 10 ||
      !['EXACT', 'PHRASE', 'BROAD'].includes(keyword.match_type)
    )
      error(
        'INVALID_KEYWORD',
        'Keywords require text of at most 80 characters/10 words and explicit EXACT, PHRASE or BROAD match_type.',
      );
    if (Object.keys(keyword).some(k => !['text', 'match_type'].includes(k)))
      error('UNKNOWN_LEGACY_ARGUMENT', 'Keyword objects accept only text and match_type.');
    return {
      create: {
        ...parent,
        keyword,
        ...(['ad_group', 'campaign'].includes(scope) ? {negative} : {}),
        ...(scope === 'ad_group' && !negative ? {status: 'PAUSED'} : {}),
      },
    };
  });
  const allowed = new Set([
    'scope',
    'keywords',
    'ad_group',
    'ad_group_id',
    'campaign',
    'campaign_id',
    'shared_set',
    'shared_set_id',
    'partial_failure',
    'validate_only',
  ]);
  for (const key of Object.keys(data))
    if (!allowed.has(key)) error('UNKNOWN_LEGACY_ARGUMENT', 'Unknown keyword adapter argument.', {field: key});
  return {
    action,
    body: nativeBody(
      action,
      {
        operations,
        ...(data.partial_failure !== undefined ? {partial_failure: data.partial_failure} : {}),
        ...(data.validate_only !== undefined ? {validate_only: data.validate_only} : {}),
      },
      account,
    ),
  };
}

export function adaptGoogleLegacy(registry: Registry, input: JsonObject): GoogleLegacyAdaptation | undefined {
  const name = String(input.action ?? ''),
    entry = entries.get(name);
  if (!entry) return undefined;
  guardInput(input);
  assertProviderAliasAvailable(gateway, name);
  const accountRaw = input.account_id ?? input.customer_id ?? input.params?.customer_id ?? input.params?.account_id;
  if (typeof accountRaw !== 'string')
    error('ACCOUNT_ID_REQUIRED', 'Provide account_id as a string for the Google legacy adapter.');
  const account = id(accountRaw.replaceAll('-', ''), 'account_id');
  let data = merge(
    input.path_params === undefined ? {} : obj(input.path_params, 'path_params'),
    input.params === undefined ? {} : obj(input.params, 'params'),
    input.payload === undefined ? {} : obj(input.payload, 'payload'),
  );
  for (const key of ['account_id', 'customer_id'])
    if (data[key] !== undefined) {
      if (String(data[key]).replaceAll('-', '') !== account)
        error('ACCOUNT_SCOPE_MISMATCH', 'Conflicting account aliases.');
      delete data[key];
    }
  let action: Action, body: JsonObject, defaultLimit: number | undefined;
  // A generated list query stops at its LIMIT: Google returns no page token past it, so the default is disclosed.
  const defaulted = (d: JsonObject) =>
    d.query === undefined && d.limit === undefined ? legacyDefaultLimit : undefined;
  if (entry.kind === 'RPC' || directRpc[name]) {
    action = destination(registry, entry.kind === 'RPC' ? entry.canonical! : directRpc[name]!);
    body = nativeBody(action, data.request === undefined ? data : obj(data.request, 'request'), account);
  } else if (entry.kind === 'GAQL' || bespokeQueries[name] || name === 'RUN_GAQL_QUERY') {
    if (name === 'FETCH_CAMPAIGN_INSIGHTS' && !data.fields && !data.query)
      data = {
        ...data,
        fields: [
          'campaign.resource_name',
          'campaign.id',
          'campaign.name',
          'metrics.impressions',
          'metrics.clicks',
          'metrics.cost_micros',
          'metrics.conversions',
          'metrics.conversions_value',
        ],
      };
    if (name === 'LIST_APP_SKAN_PERFORMANCE' && !data.query)
      error(
        'SKAN_QUERY_REQUIRED',
        'Provide an explicit GAQL query with SKAN segments and query_contract_acknowledged=true; this adapter does not invent a SKAN resource or attribution definition.',
      );
    action = destination(registry, 'GoogleAdsService.Search');
    defaultLimit = defaulted(data);
    body = nativeBody(
      action,
      {
        query: gaql(entry.resource ?? bespokeQueries[name] ?? '', data, name),
        ...(data.page_token ? {page_token: data.page_token} : {}),
      },
      account,
    );
  } else if (['SET_CAMPAIGN_STATUS', 'SET_AD_GROUP_STATUS', 'SET_AD_STATUS', 'PAUSE_ENTITY'].includes(name)) {
    const entity =
      name === 'PAUSE_ENTITY'
        ? data.entity_type
        : (
            {SET_CAMPAIGN_STATUS: 'campaign', SET_AD_GROUP_STATUS: 'ad_group', SET_AD_STATUS: 'ad'} as Record<
              string,
              string
            >
          )[name];
    const routes: Record<string, string> = {
      campaign: 'CampaignService.MutateCampaigns',
      ad_group: 'AdGroupService.MutateAdGroups',
      ad: 'AdGroupAdService.MutateAdGroupAds',
    };
    if (typeof entity !== 'string' || !routes[entity])
      error('ENTITY_TYPE_REQUIRED', 'Provide entity_type campaign, ad_group or ad.');
    const status = name === 'PAUSE_ENTITY' ? 'PAUSED' : data.status;
    if (!['PAUSED', 'ENABLED'].includes(status))
      error('INVALID_STATUS', 'Status actions accept PAUSED or ENABLED. Use a removal action for deletion.');
    action = destination(registry, routes[entity]!);
    const clean = {...data};
    delete clean.status;
    delete clean.entity_type;
    body = compileMutation(action, 'update', {...clean, resource: {status}, update_mask: 'status'}, account, name);
  } else if (
    [
      'ADD_KEYWORDS',
      'ADD_KEYWORD_CRITERIA',
      'REMOVE_KEYWORDS',
      'ADD_NEGATIVE_KEYWORDS',
      'ADD_SHARED_NEGATIVE_KEYWORDS',
    ].includes(name)
  ) {
    ({action, body} = keywords(registry, data, account, name));
  } else if (name === 'UPDATE_AD') {
    const resource = normalized(obj(data.resource, 'resource'));
    const association = ['status', 'start_date_time', 'end_date_time', 'ad_group_ad_asset_automation_settings'];
    const supplied = Object.keys(resource).filter(k => k !== 'resource_name');
    if (!supplied.length) error('AD_UPDATE_FIELDS_REQUIRED', 'Provide explicit creative or association changes.');
    const mode =
      data.scope ??
      (supplied.every(k => association.includes(k))
        ? 'association'
        : supplied.every(k => !association.includes(k))
          ? 'creative'
          : undefined);
    if (!['association', 'creative'].includes(mode))
      error('MIXED_AD_UPDATE', 'Split mixed creative and association/status changes into explicit requests.');
    if (
      (mode === 'association' && supplied.some(k => !association.includes(k))) ||
      (mode === 'creative' && supplied.some(k => association.includes(k)))
    )
      error('MIXED_AD_UPDATE', 'Fields conflict with explicit ad update scope.');
    action = destination(registry, mode === 'creative' ? 'AdService.MutateAds' : 'AdGroupAdService.MutateAdGroupAds');
    const clean = {...data};
    delete clean.scope;
    body = compileMutation(action, 'update', clean, account, name);
  } else if (name === 'GENERATE_ASSETS' || name === 'SUGGEST_ASSETS') {
    const kind = data.kind,
      routes: Record<string, string> = {
        text: 'AssetGenerationService.GenerateText',
        image: 'AssetGenerationService.GenerateImages',
        travel: 'TravelAssetSuggestionService.SuggestTravelAssets',
      };
    if (typeof kind !== 'string' || !routes[kind] || data.request === undefined)
      error(
        'ASSET_GENERATION_KIND_REQUIRED',
        'Provide explicit kind text, image or travel and a typed native request. Eligibility and legacy default semantics are not inferred.',
      );
    action = destination(registry, routes[kind]!);
    body = nativeBody(action, obj(data.request, 'request'), account);
  } else if (name === 'REMOVE_AUTO_CREATED_ASSET') {
    const routes: Record<string, string> = {
      ad: 'AdGroupAdService.RemoveAutomaticallyCreatedAssets',
      campaign: 'AutomaticallyCreatedAssetRemovalService.RemoveCampaignAutomaticallyCreatedAsset',
    };
    if (typeof data.scope !== 'string' || !routes[data.scope] || !data.request)
      error('ASSET_REMOVAL_SCOPE_REQUIRED', 'Provide scope ad or campaign and the matching native request.');
    action = destination(registry, routes[data.scope]!);
    body = nativeBody(action, obj(data.request, 'request'), account);
  } else if (['FETCH_EXTENSIONS', 'LIST_ASSET_PERFORMANCE', 'ADD_EXTENSIONS'].includes(name)) {
    const routes: Record<string, [string, string]> = {
      customer: ['customer_asset', 'CustomerAssetService.MutateCustomerAssets'],
      campaign: ['campaign_asset', 'CampaignAssetService.MutateCampaignAssets'],
      ad_group: ['ad_group_asset', 'AdGroupAssetService.MutateAdGroupAssets'],
    };
    if (typeof data.scope !== 'string' || !routes[data.scope])
      error('ASSET_ASSOCIATION_SCOPE_REQUIRED', 'Provide explicit scope customer, campaign or ad_group.');
    const route = routes[data.scope]!,
      clean = {...data};
    delete clean.scope;
    if (name === 'ADD_EXTENSIONS') {
      action = destination(registry, route[1]);
      body = compileMutation(action, 'create', clean, account, name);
    } else {
      action = destination(registry, 'GoogleAdsService.Search');
      defaultLimit = defaulted(clean);
      body = nativeBody(action, {query: gaql(route[0], clean, name)}, account);
    }
  } else if (name === 'SET_CAMPAIGN_CONTENT_LABEL_EXCLUSIONS') {
    if (data.mode !== 'add')
      error(
        'EXCLUSION_MODE_REQUIRED',
        'Use mode add with explicit labels. Replacement requires existing criterion identities and a separate reviewed removal plan.',
      );
    if (!Array.isArray(data.labels) || !data.labels.length)
      error('CONTENT_LABELS_REQUIRED', 'Provide explicit labels.');
    const campaign = resourceName(prefix + 'resources.Campaign', data, account);
    action = destination(registry, 'CampaignCriterionService.MutateCampaignCriteria');
    body = nativeBody(
      action,
      {operations: data.labels.map((type: unknown) => ({create: {campaign, negative: true, content_label: {type}}}))},
      account,
    );
  } else if (entry.kind === 'MUTATE' || mutationRoutes[name]) {
    const route = mutationRoutes[name];
    action = destination(registry, route?.[0] ?? entry.canonical!);
    body = compileMutation(action, route?.[1] ?? entry.verb!, data, account, name);
  } else
    return error('LEGACY_CONTRACT_INCOMPLETE', 'This legacy name lacks a safe explicit adapter.', {
      action: name,
      rule: entry.rule,
    });
  assertAccountReferences(body, account);
  const path: JsonObject = {...obj(input.path_params ?? {}, 'path_params')};
  const desc = schema(requests[action.name]!);
  for (const key of action.required)
    if (key !== 'customer_id' && path[key] !== undefined && body[key] === undefined && desc.fields?.[key])
      body[key] = path[key];
  return {
    input: {...input, action: action.name, account_id: account, params: body, payload: undefined, path_params: path},
    legacyAction: name,
    evidence: 'INDEPENDENT_DESIGN',
    responseMode: 'native',
    warnings: [
      'Google legacy adapter uses an independently specified input contract. Exact AMCP payload/response parity is unverified.',
      'Request structure is checked against the pinned Google Ads ' +
        version +
        ' protobuf metadata and, when sent, against its Discovery contract. Vendor business rules, permissions and eligibility still require vendor validation.',
      'Native response envelopes and partial-failure details are preserved without claiming a legacy response transformation.',
      ...(defaultLimit
        ? [
            'No limit was given, so this list returns at most ' +
              defaultLimit +
              ' rows (GAQL LIMIT ' +
              defaultLimit +
              '). A result of exactly that many rows carries truncated_possible and a next_call with limit 10000.',
          ]
        : []),
    ],
    ...(defaultLimit ? {defaultLimit} : {}),
  };
}

/**
 * A defaulted legacy list that returned exactly its default LIMIT may hold more rows: GAQL LIMIT ends the result without
 * a page token. The disclosure names the default and offers the same call with the adapter's maximum limit.
 */
export function legacyLimitDisclosure(
  plan: CompiledRequest,
  data: unknown,
  args: JsonObject,
  compile?: (call: JsonObject) => CompiledRequest,
): JsonObject | undefined {
  const limit = plan.legacyDefaultLimit,
    results = data && typeof data === 'object' ? (data as JsonObject).results : undefined;
  if (!limit || plan.gateway !== gateway || !Array.isArray(results) || results.length < limit) return undefined;
  const candidate = {...args, params: {...(args.params ?? {}), limit: 10000}};
  // Offered only when it compiles back to the same request with LIMIT 10000, as continuations are (MCP-04).
  if (compile) {
    let verified = false;
    try {
      const next = compile(candidate);
      verified =
        next.path === plan.path &&
        next.method === plan.method &&
        next.legacyDefaultLimit === undefined &&
        JSON.stringify(next.body ?? null).includes(' LIMIT 10000');
    } catch {}
    if (!verified)
      return {
        truncated_possible: true,
        default_limit: limit,
        next_call: null,
        continuation_unavailable: 'Give params.limit (at most 10000) or a query to read more than ' + limit + ' rows.',
      };
  }
  return {
    truncated_possible: true,
    default_limit: limit,
    next_call: {
      tool: gateway,
      arguments: candidate,
      effects: {provider_requests: 1, saves: [], advertising_writes: 0},
      meaning:
        'No limit was given, so this list stopped at its default of ' +
        limit +
        ' rows. This repeats it with the maximum limit, 10000.',
    },
  };
}
export function googleLegacyCoverage() {
  return {
    total: entries.size,
    evidence: 'INDEPENDENT_DESIGN',
    exactBehaviorParityVerified: 0,
    requestTypes: Object.keys(requests).length,
    sources: Object.keys(mapping.googleProto.sources).length,
    entries: [...entries.values()].map(e => ({
      action: e.name,
      classification: e.kind,
      status: 'explicit_adapter',
      destination:
        e.canonical ??
        directRpc[e.name] ??
        mutationRoutes[e.name]?.[0] ??
        bespokeQueries[e.name] ??
        e.resource ??
        'requires explicit scope',
      limitations: [
        'Vendor business validation not performed',
        'Legacy input/output compatibility unverified',
        ...(e.kind === 'GAQL' && !mainFields[e.resource ?? ''] ? ['Explicit projection or query required'] : []),
      ],
    })),
  };
}
