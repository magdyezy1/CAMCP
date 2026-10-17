import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {familyErrors, type ReasonFirstRefusal} from './family-kit.js';
import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import {stable, sha256} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {googleAdsCustomers} from './google-version.js';

type Kind = 'biddingSeasonalityAdjustments' | 'biddingDataExclusions';
type Send = (p: CompiledRequest) => Promise<TransportResult>;
const resources = {
  biddingSeasonalityAdjustments: 'bidding_seasonality_adjustment',
  biddingDataExclusions: 'bidding_data_exclusion',
};
const mutable = [
  'name',
  'description',
  'scope',
  'campaigns',
  'advertisingChannelTypes',
  'devices',
  'startDateTime',
  'endDateTime',
];
const commonFields = [
  'resource_name',
  'name',
  'description',
  'status',
  'scope',
  'campaigns',
  'advertising_channel_types',
  'devices',
  'start_date_time',
  'end_date_time',
];
export const googleBiddingEventFields: Record<Kind, string[]> = {
  biddingSeasonalityAdjustments: [...commonFields, 'seasonality_adjustment_id', 'conversion_rate_modifier'],
  biddingDataExclusions: [...commonFields, 'data_exclusion_id'],
};
const campaignFields = [
  'resource_name',
  'name',
  'status',
  'advertising_channel_type',
  'bidding_strategy_type',
  'bidding_strategy',
  'campaign_budget',
  'target_cpa.target_cpa_micros',
  'target_roas.target_roas',
  'maximize_conversions.target_cpa_micros',
  'maximize_conversion_value.target_roas',
];
const strategyFields = [
  'resource_name',
  'name',
  'status',
  'type',
  'currency_code',
  'effective_currency_code',
  'target_cpa.target_cpa_micros',
  'target_cpa.cpc_bid_ceiling_micros',
  'target_cpa.cpc_bid_floor_micros',
  'target_roas.target_roas',
  'target_roas.cpc_bid_ceiling_micros',
  'target_roas.cpc_bid_floor_micros',
  'target_roas.target_roas_tolerance_percent_millis',
  'maximize_conversions.target_cpa_micros',
  'maximize_conversions.cpc_bid_ceiling_micros',
  'maximize_conversions.cpc_bid_floor_micros',
  'maximize_conversion_value.target_roas',
  'maximize_conversion_value.cpc_bid_ceiling_micros',
  'maximize_conversion_value.cpc_bid_floor_micros',
  'maximize_conversion_value.target_roas_tolerance_percent_millis',
];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const fail: ReasonFirstRefusal = familyErrors('INVALID_BIDDING_EVENT');
const stateFail = (message: string): never => fail(message, 'BIDDING_EVENT_STATE_UNVERIFIED');
const only = (v: JsonObject, allowed: string[]) => {
  if (Object.keys(v).some(k => !allowed.includes(k))) fail('Unqualified or output-only bidding-event field.');
};
const text = (v: unknown, max: number, empty = false): v is string =>
  typeof v === 'string' && (empty || !!v.trim()) && [...v].length <= max && !/[\u0000-\u001f\ud800-\udfff]/u.test(v);
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) fail('Select one Google Ads client customer.');
  return id;
};
const rn = (p: CompiledRequest, value: unknown, collection: string) => {
  if (
    typeof value !== 'string' ||
    !new RegExp('^customers/' + account(p) + '/' + collection + '/[1-9][0-9]*$').test(value)
  )
    fail('Use an exact ' + collection + ' resource in the selected customer.');
  return value as string;
};
export function googleBiddingEventKind(p: CompiledRequest): Kind | undefined {
  const m = /^\/v\d+\/customers\/\d+\/(biddingSeasonalityAdjustments|biddingDataExclusions):mutate$/.exec(p.path);
  return p.gateway === 'google_ads_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com')
    ? (m?.[1] as Kind | undefined)
    : undefined;
}
function list(value: unknown, max: number, valid: (v: unknown) => boolean) {
  if (!Array.isArray(value) || value.length > max || value.some(v => !valid(v)) || new Set(value).size !== value.length)
    fail('Use a complete distinct native list within its documented bounds.');
}
function wall(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))
    fail('Dates use yyyy-MM-dd HH:mm:ss in the selected account timezone, without an offset.');
  const at = Date.parse((value as string).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 19).replace('T', ' ') !== value)
    fail('Use an actual calendar date and time.');
  return at;
}
/** Native dates have no offset. Reject ambiguous or nonexistent DST boundaries
 * instead of guessing which instant the reviewed request means. */
export function biddingEventInstant(value: string, zone: string): number {
  const target = wall(value);
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    stateFail('The account timezone is not recognized.');
  }
  const local = (at: number) => {
    const values = Object.fromEntries(format.formatToParts(at).map(p => [p.type, p.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
  };
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const at = target + hours * 3600000;
    offsets.add(wall(local(at)) - at);
  }
  const matches = [...offsets].map(offset => target - offset).filter(at => local(at) === value);
  if (matches.length !== 1)
    fail(
      'This account-local boundary is ambiguous or nonexistent at a timezone transition. Choose an unambiguous time.',
    );
  return matches[0]!;
}
function record(p: CompiledRequest, kind: Kind, row: JsonObject, complete = false, observed = false) {
  if (row.name !== undefined && !text(row.name, 255)) fail('Event names require 1–255 characters.');
  if (row.description !== undefined && !text(row.description, 2048, true))
    fail('Descriptions use at most 2048 characters.');
  if (
    row.scope !== undefined &&
    !(observed ? ['CAMPAIGN', 'CHANNEL', 'CUSTOMER'] : ['CAMPAIGN', 'CHANNEL']).includes(row.scope)
  )
    fail('Choose CAMPAIGN or CHANNEL; CUSTOMER is a read-only legacy scope.');
  if (row.campaigns !== undefined) list(row.campaigns, 2000, v => typeof v === 'string' && rn(p, v, 'campaigns') === v);
  if (row.advertisingChannelTypes !== undefined)
    list(row.advertisingChannelTypes, 3, v => typeof v === 'string' && ['SEARCH', 'SHOPPING', 'DISPLAY'].includes(v));
  if (row.devices !== undefined)
    list(
      row.devices,
      5,
      v => typeof v === 'string' && ['MOBILE', 'TABLET', 'DESKTOP', 'CONNECTED_TV', 'OTHER'].includes(v),
    );
  if (row.startDateTime !== undefined) wall(row.startDateTime);
  if (row.endDateTime !== undefined) wall(row.endDateTime);
  if (
    row.conversionRateModifier !== undefined &&
    (kind !== 'biddingSeasonalityAdjustments' ||
      typeof row.conversionRateModifier !== 'number' ||
      !Number.isFinite(row.conversionRateModifier) ||
      row.conversionRateModifier < 0.1 ||
      row.conversionRateModifier > 10)
  )
    fail('The conversion-rate multiplier is a number from 0.1 to 10, not a percentage.');
  if (complete) {
    if (!text(row.name, 255) || !row.scope || !row.startDateTime || !row.endDateTime)
      fail('The complete event needs name, scope and both dates.');
    if (
      (row.scope === 'CAMPAIGN' && (!row.campaigns?.length || row.advertisingChannelTypes?.length)) ||
      (row.scope === 'CHANNEL' && (!row.advertisingChannelTypes?.length || row.campaigns?.length)) ||
      (row.scope === 'CUSTOMER' && (row.campaigns?.length || row.advertisingChannelTypes?.length))
    )
      fail(
        'Campaign and channel scopes are mutually exclusive; explicitly clear the previous scope list when changing scope.',
      );
    if (wall(row.endDateTime) <= wall(row.startDateTime))
      fail('The end is exclusive and must follow the inclusive start.');
  }
}
function canonical(p: CompiledRequest, kind: Kind, value: JsonObject): JsonObject {
  const out: JsonObject = {
    ...value,
    description: value.description ?? '',
    campaigns: value.campaigns ?? [],
    advertisingChannelTypes: value.advertisingChannelTypes ?? [],
    devices: value.devices ?? [],
  };
  if (kind === 'biddingSeasonalityAdjustments') out.conversionRateModifier ??= 1;
  record(p, kind, out, true, true);
  for (const key of ['campaigns', 'advertisingChannelTypes', 'devices']) out[key] = [...out[key]].sort();
  return out;
}
export function assertGoogleBiddingEvent(p: CompiledRequest) {
  const kind = googleBiddingEventKind(p);
  if (!kind) return;
  const b = googleJson(p.body);
  only(b, ['operations', 'partialFailure', 'validateOnly', 'responseContentType']);
  if (
    !Array.isArray(b.operations) ||
    !b.operations.length ||
    b.operations.length > 25 ||
    b.partialFailure === true ||
    b.validateOnly === true ||
    (b.responseContentType !== undefined && b.responseContentType !== 'RESOURCE_NAME_ONLY')
  )
    fail('Review 1–25 atomic native operations with resource-name receipts.');
  if (Object.keys(p.query).length || Object.keys(p.headers).length || p.path.split('/')[3] !== account(p))
    fail('Use the selected customer and no query or header overrides.');
  const seen = new Set<string>();
  for (const op of b.operations) {
    if (!object(op)) fail('Use native operation objects.');
    only(op, ['create', 'update', 'remove', 'updateMask']);
    if (['create', 'update', 'remove'].filter(k => op[k] !== undefined).length !== 1)
      fail('Each operation needs exactly one create, update or remove.');
    const fields = [...mutable, ...(kind === 'biddingSeasonalityAdjustments' ? ['conversionRateModifier'] : [])];
    let key: string;
    if (op.create || op.update) {
      const row = op.create ?? op.update;
      if (!object(row)) fail('Native create/update requires an object.');
      only(row, [...fields, ...(op.update ? ['resourceName'] : [])]);
      record(p, kind, row, !!op.create);
      if (op.create) {
        if (kind === 'biddingSeasonalityAdjustments' && row.conversionRateModifier === undefined)
          fail('Explicitly provide the expected conversion-rate multiplier.');
        key = 'name:' + row.name;
      } else {
        key = rn(p, row.resourceName, kind);
        if (typeof op.updateMask !== 'string' || !op.updateMask) fail('Updates need an explicit native field mask.');
        const mask = op.updateMask.split(',');
        if (
          new Set(mask).size !== mask.length ||
          mask.some((f: string) => !fields.includes(f) || row[f] === undefined || row[f] === null) ||
          Object.keys(row).some(k => k !== 'resourceName' && !mask.includes(k))
        )
          fail(
            'The mask must cover exactly the explicitly supplied mutable fields. Use [] or an empty description to clear them.',
          );
      }
    } else key = rn(p, op.remove, kind);
    if (!op.update && op.updateMask !== undefined) fail('Only updates accept updateMask.');
    if (seen.has(key)) fail('Each target or new name may occur only once per review.');
    seen.add(key);
  }
}
const camel = (v: string) => v.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
function read(p: CompiledRequest, query: string): CompiledRequest {
  return {
    ...p,
    action: 'AMCP_BIDDING_EVENT_READ',
    method: 'POST',
    path: googleAdsCustomers + account(p) + '/googleAds:search',
    body: {query},
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
  };
}
// RESOURCE_NAME is selectable/filterable but not sortable in these v23 resources.
// Native page tokens traverse the result; identity-keyed state handles ordering.
const query = (resource: string, fields: string[], where = '') =>
  'SELECT ' +
  fields.map(f => resource + '.' + f).join(', ') +
  ' FROM ' +
  resource +
  (where ? ' WHERE ' + where : '') +
  (resource === 'customer' ? ' LIMIT 1' : '');
function reader(p: CompiledRequest, send: Send) {
  let requests = 0,
    bytes = 0,
    rows = 0;
  const started = performance.now();
  const fetch = async (resource: string, fields: string[], where = '') => {
    const result: JsonObject[] = [],
      tokens = new Set<string>();
    let token: string | undefined, total: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 25 || ++requests > 128 || performance.now() - started > 60000)
        stateFail('Complete bidding-event state exceeded its page/request/deadline bound.');
      const plan = read(p, query(resource, fields, where));
      if (token) (plan.body as JsonObject).pageToken = token;
      const response = await send(plan),
        raw = response.data;
      if (
        response.status !== 200 ||
        !object(raw) ||
        Object.keys(raw).some(
          k => !['results', 'fieldMask', 'queryResourceConsumption', 'nextPageToken', 'totalResultsCount'].includes(k),
        ) ||
        (raw.results !== undefined && !Array.isArray(raw.results)) ||
        (raw.nextPageToken !== undefined && typeof raw.nextPageToken !== 'string')
      )
        stateFail('Google returned an unrecognized, failed or partial bidding-event response.');
      const d = raw as JsonObject;
      const size = Buffer.byteLength(JSON.stringify(d));
      bytes += size;
      if (size > 4 * 1024 * 1024 || bytes > 8 * 1024 * 1024 || performance.now() - started > 60000)
        stateFail('Bidding-event responses exceeded their byte/deadline bound.');
      if (d.totalResultsCount !== undefined) {
        const count = String(d.totalResultsCount);
        if (!/^\d+$/.test(count) || (total !== undefined && total !== count))
          stateFail('Google returned an invalid or changing collection count.');
        total = count;
      }
      const values = d.results ?? [];
      rows += values.length;
      if (rows > 10000) stateFail('Bidding-event state exceeded 10000 total rows.');
      for (const v of values) {
        if (!object(v) || Object.keys(v).length !== 1 || !object(v[camel(resource)]))
          stateFail('Google returned an incomplete or unexpected resource row.');
        result.push(v[camel(resource)]);
      }
      if (!d.nextPageToken) break;
      if (d.nextPageToken.length > 4096 || tokens.has(d.nextPageToken) || !values.length)
        stateFail('Google returned incomplete or repeated pagination.');
      tokens.add(d.nextPageToken);
      token = d.nextPageToken;
    }
    if (total !== undefined && BigInt(total) !== BigInt(result.length))
      stateFail('The result count proves an incomplete collection.');
    return result;
  };
  const exact = async (resource: string, fields: string[], names: string[]) => {
    const out: JsonObject = {};
    for (let i = 0; i < names.length; i += 100) {
      const batch = names.slice(i, i + 100);
      for (const row of await fetch(
        resource,
        fields,
        resource + '.resource_name IN (' + batch.map(n => "'" + n + "'").join(', ') + ')',
      )) {
        if (!batch.includes(row.resourceName) || Object.hasOwn(out, row.resourceName))
          stateFail('A referenced resource was foreign or duplicated.');
        out[row.resourceName] = row;
      }
    }
    if (Object.keys(out).length !== names.length) stateFail('A referenced resource was omitted.');
    return out;
  };
  const customer = async (): Promise<JsonObject> => {
    const rows = await fetch('customer', ['id', 'currency_code', 'time_zone', 'manager']);
    if (
      rows.length !== 1 ||
      rows[0]!.id !== account(p) ||
      !text(rows[0]!.currencyCode, 3) ||
      !text(rows[0]!.timeZone, 128) ||
      (rows[0]!.manager !== undefined && typeof rows[0]!.manager !== 'boolean')
    )
      stateFail('The selected customer identity, timezone or manager flag was not verified.');
    if (rows[0]!.manager === true)
      fail('These Google Ads API resources belong to client accounts; choose the exact client customer.');
    return {...rows[0], manager: false};
  };
  const events = async (kind: Kind) => {
    const resource = resources[kind],
      out: JsonObject = {};
    for (const row of await fetch(
      resource,
      googleBiddingEventFields[kind],
      resource + ".status IN ('ENABLED', 'REMOVED')",
    )) {
      const name = rn(p, row.resourceName, kind),
        idKey = kind === 'biddingSeasonalityAdjustments' ? 'seasonalityAdjustmentId' : 'dataExclusionId';
      if (
        Object.hasOwn(out, name) ||
        row[idKey] !== name.split('/').at(-1) ||
        !['ENABLED', 'REMOVED'].includes(row.status)
      )
        stateFail('An event has a foreign, duplicate or incomplete native identity.');
      out[name] = canonical(p, kind, row);
    }
    if (Object.keys(out).length > 1000) stateFail('The event history exceeds 1000 rows per kind.');
    return out;
  };
  return {fetch, exact, customer, events};
}
export function googleBiddingEventSnapshots(p: CompiledRequest) {
  return [
    read(p, query('customer', ['id', 'currency_code', 'time_zone', 'manager'])),
    ...Object.keys(resources).map(k =>
      read(
        p,
        query(
          resources[k as Kind],
          googleBiddingEventFields[k as Kind],
          resources[k as Kind] + ".status IN ('ENABLED', 'REMOVED')",
        ),
      ),
    ),
  ];
}
function desired(p: CompiledRequest, kind: Kind, op: JsonObject, events: JsonObject) {
  const old = op.create ? undefined : events[op.remove ?? op.update.resourceName];
  if (!op.create && (!old || old.status !== 'ENABLED')) stateFail('The exact event is missing or already removed.');
  if (op.remove) return old;
  const row = canonical(p, kind, {...old, ...(op.create ?? op.update)});
  record(p, kind, row, true);
  return row;
}
export async function readGoogleBiddingEventState(p: CompiledRequest, send: Send): Promise<unknown[]> {
  const kind = googleBiddingEventKind(p)!,
    r = reader(p, send),
    customer = await r.customer(),
    events = await r.events(kind),
    otherKind: Kind =
      kind === 'biddingSeasonalityAdjustments' ? 'biddingDataExclusions' : 'biddingSeasonalityAdjustments',
    relatedEvents = await r.events(otherKind),
    ops = googleJson(p.body).operations as JsonObject[],
    intents = ops.map(op => desired(p, kind, op, events));
  const names = new Set<string>(),
    campaignNames = new Set<string>(),
    channels = new Set<string>();
  // Removed events can remain in native history. Do not admit a creation whose
  // own read-back would exceed this contract's complete-history bound.
  if (Object.keys(events).length + ops.filter(o => o.create).length > 1000)
    fail('Creating these events exceeds the 1000-row complete-history review bound.');
  for (const [i, value] of intents.entries()) {
    const op = ops[i]!,
      start = biddingEventInstant(value.startDateTime, customer.timeZone),
      end = biddingEventInstant(value.endDateTime, customer.timeZone);
    if (end <= start || end - start > 14 * 86400000)
      fail('An event must span more than zero and no more than 14 elapsed days in the account timezone.');
    if (!op.remove) {
      if (
        kind === 'biddingSeasonalityAdjustments' &&
        (op.create || op.update?.startDateTime !== undefined) &&
        start <= Date.now()
      )
        fail('New seasonality events and changed start times must start in the future.');
      if (
        names.has(value.name) ||
        Object.values(events).some(
          (e: any) => e.status === 'ENABLED' && e.name === value.name && e.resourceName !== op.update?.resourceName,
        )
      )
        fail('Use a unique active event name.');
      names.add(value.name);
    }
    for (const state of [value, ...(op.update ? [events[op.update.resourceName]] : [])]) {
      for (const name of state.campaigns) campaignNames.add(name);
      for (const channel of state.advertisingChannelTypes) channels.add(channel);
      if (state.scope === 'CUSTOMER')
        for (const channel of ['SEARCH', 'SHOPPING', 'DISPLAY', 'PERFORMANCE_MAX']) channels.add(channel);
    }
  }
  if (
    kind === 'biddingDataExclusions' &&
    Object.values(events).filter((v: any) => v.status === 'ENABLED').length +
      ops.filter(o => o.create).length -
      ops.filter(o => o.remove).length >
      500
  )
    fail('A customer supports at most 500 active data exclusions.');
  const campaigns: JsonObject = {};
  if (channels.size) {
    const filter =
      "campaign.status != 'REMOVED' AND campaign.advertising_channel_type IN (" +
      [...channels]
        .sort()
        .map(c => "'" + c + "'")
        .join(', ') +
      ')';
    for (const row of await r.fetch('campaign', campaignFields, filter)) {
      const name = rn(p, row.resourceName, 'campaigns');
      if (Object.hasOwn(campaigns, name) || !channels.has(row.advertisingChannelType))
        stateFail('Channel discovery returned duplicate or unrelated campaigns.');
      campaigns[name] = row;
    }
  }
  if (campaignNames.size > 2000 || Object.keys(campaigns).length > 2000)
    fail('Narrow the review to at most 2000 current campaigns.');
  Object.assign(
    campaigns,
    await r.exact('campaign', campaignFields, [...campaignNames].filter(n => !campaigns[n]).sort()),
  );
  if (Object.keys(campaigns).length > 2000) fail('The combined event scope exceeds 2000 campaigns.');
  const budgetNames = new Set<string>(),
    strategyNames = new Set<string>();
  for (const c of Object.values(campaigns) as JsonObject[]) {
    if (
      !text(c.name, 255) ||
      !['ENABLED', 'PAUSED'].includes(c.status) ||
      !text(c.advertisingChannelType, 64) ||
      !text(c.biddingStrategyType, 64)
    )
      stateFail('Campaign name, status, channel and bid strategy are required.');
    budgetNames.add(rn(p, c.campaignBudget, 'campaignBudgets'));
    if (c.biddingStrategy) strategyNames.add(rn(p, c.biddingStrategy, 'biddingStrategies'));
  }
  const budgets = await r.exact(
      'campaign_budget',
      [
        'resource_name',
        'name',
        'status',
        'amount_micros',
        'total_amount_micros',
        'explicitly_shared',
        'delivery_method',
      ],
      [...budgetNames].sort(),
    ),
    strategies = await r.exact('bidding_strategy', strategyFields, [...strategyNames].sort());
  for (const b of Object.values(budgets) as JsonObject[])
    if (
      b.status !== 'ENABLED' ||
      !text(b.name, 255) ||
      ![b.amountMicros, b.totalAmountMicros].some(v => typeof v === 'string' && /^\d+$/.test(v))
    )
      stateFail('The current native budget amount was not verified.');
  for (const s of Object.values(strategies) as JsonObject[])
    if (s.status !== 'ENABLED' || !text(s.name, 255) || !text(s.type, 64))
      stateFail('A portfolio bid strategy is incomplete.');
  for (const c of Object.values(campaigns) as JsonObject[])
    if (c.biddingStrategy && strategies[c.biddingStrategy].type !== c.biddingStrategyType)
      stateFail('The campaign and portfolio strategy disagree about the bidding type.');
  for (const [i, value] of intents.entries())
    if (!ops[i]!.remove && value.scope === 'CAMPAIGN')
      for (const name of value.campaigns) {
        const c = campaigns[name],
          bid = strategies[c.biddingStrategy] ?? c,
          type = bid.type ?? c.biddingStrategyType;
        if (
          !['SEARCH', 'DISPLAY', 'SHOPPING', 'PERFORMANCE_MAX'].includes(c.advertisingChannelType) ||
          !['TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE'].includes(type)
        )
          fail(
            'Select a supported Smart Bidding campaign; Hotel, App beta and other channel/bid variants require separate qualification.',
          );
        if (
          (kind === 'biddingSeasonalityAdjustments' &&
            c.advertisingChannelType !== 'PERFORMANCE_MAX' &&
            type === 'MAXIMIZE_CONVERSIONS' &&
            !(Number(bid.maximizeConversions?.targetCpaMicros) > 0)) ||
          (kind === 'biddingSeasonalityAdjustments' &&
            c.advertisingChannelType !== 'PERFORMANCE_MAX' &&
            type === 'MAXIMIZE_CONVERSION_VALUE' &&
            !(Number(bid.maximizeConversionValue?.targetRoas) > 0))
        )
          fail('Search, Display and Shopping seasonality adjustments require an explicit CPA or ROAS target.');
      }
  // Recheck event membership after dependencies. No cross-provider transaction is
  // available; a later mutation always repeats the complete snapshot and hash.
  if (
    stable(events) !== stable(await r.events(kind)) ||
    stable(relatedEvents) !== stable(await r.events(otherKind)) ||
    stable(customer) !== stable(await r.customer())
  )
    stateFail('Customer or bidding events changed during dependency discovery.');
  return [{customer, events, relatedEvents, campaigns, budgets, strategies}];
}
export function googleBiddingEventOutcome(p: CompiledRequest, result: TransportResult, before: unknown[]): boolean {
  const kind = googleBiddingEventKind(p)!,
    ops = googleJson(p.body).operations,
    d = result.data,
    state = before[0] as JsonObject;
  if (
    result.status !== 200 ||
    !object(d) ||
    Object.keys(d).some(k => !['results'].includes(k)) ||
    !Array.isArray(d.results) ||
    d.results.length !== ops.length
  )
    return false;
  const seen = new Set<string>();
  return d.results.every((row: unknown, i: number) => {
    try {
      if (!object(row) || Object.keys(row).some(k => k !== 'resourceName')) return false;
      const name = rn(p, row.resourceName, kind),
        op = ops[i];
      if (
        seen.has(name) ||
        (op.create && Object.hasOwn(state.events, name)) ||
        (!op.create && name !== (op.remove ?? op.update.resourceName))
      )
        return false;
      seen.add(name);
      return true;
    } catch {
      return false;
    }
  });
}
export async function verifyGoogleBiddingEvent(p: CompiledRequest, result: JsonObject, before: unknown[], send: Send) {
  const kind = googleBiddingEventKind(p)!,
    r = reader(p, send);
  await r.customer();
  const events = await r.events(kind),
    old = (before[0] as JsonObject).events,
    checks: JsonObject[] = [];
  for (const [i, op] of googleJson(p.body).operations.entries()) {
    const name = rn(p, result.data.results[i].resourceName, kind);
    let expected: JsonObject, actual: JsonObject;
    if (op.remove) {
      expected = {removed: true};
      actual = {removed: !events[name] || events[name].status === 'REMOVED'};
    } else {
      const base = canonical(p, kind, {
          ...(op.create ?? {...old[name], ...op.update}),
          resourceName: name,
          status: 'ENABLED',
        }),
        idKey = kind === 'biddingSeasonalityAdjustments' ? 'seasonalityAdjustmentId' : 'dataExclusionId';
      delete base[idKey];
      expected = base;
      actual = events[name] ? Object.fromEntries(Object.entries(events[name]).filter(([k]) => k !== idKey)) : {};
    }
    // Compare complete native field values, including array membership and explicit
    // clearing. Only the three documented set-like fields have canonical ordering.
    const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(
      k => stable(expected[k]) !== stable(actual[k]),
    );
    checks.push({
      resource_id: name,
      status: changed.length ? 'inconclusive' : 'verified',
      verification_scope: 'saved_bidding_event_configuration',
      changed_fields: changed,
      expected_hash: sha256(stable(expected)),
      actual_hash: sha256(stable(actual)),
    });
  }
  return {status: checks.every(c => c.status === 'verified') ? 'verified' : 'inconclusive', checks};
}
export const googleBiddingEventImpact = {
  provider: 'google_ads',
  scope: 'bidding_events',
  may_affect_serving: true,
  effect:
    'Seasonality events alter expected conversion rates for Smart Bidding; data exclusions omit affected click data from bid learning, not reporting. Creation, edits and removal can change bids. They do not change campaign budgets or guarantee spend/performance.',
  units:
    'conversionRateModifier is a multiplier: 1.5 means +50%. Dates are account-local; start is inclusive and end exclusive. Empty devices means all devices. CHANNEL includes future matching campaigns, which cannot be enumerated today.',
  review:
    'Use a user-supplied expected conversion change or identified tracking outage. Account for conversion delay for exclusions; do not infer business facts, automatically offset a finished promotion or undo a data exclusion. Review current events, campaigns, budgets and portfolio targets.',
  limits:
    'Client customers only; CHANNEL accepts SEARCH/DISPLAY/SHOPPING. CAMPAIGN supports qualified Smart Bidding on those channels and Performance Max. App beta, manager events and cross-customer portfolio strategies require separate qualification. Complete history is bounded to 1000 events per kind and 2000 current campaigns.',
  verification:
    'Exact native configuration or complete collection absence. Auction effects, data repair, convergence, future campaigns and provider eligibility remain separate outcomes.',
  recovery:
    'Retain the original review/idempotency key after partial or lost outcomes. Read back first; never automatically replay a mutation.',
};

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleBiddingEventFamily: ReviewedFamily = {
  name: 'google_bidding_events',
  files: ['src/google-bidding-events.ts', ['tests/google-bidding-events.test.ts']],
  kind: googleBiddingEventKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertGoogleBiddingEvent(plan);
  },
  scope: c => assertGoogleAdsScope(c),
  snapshots: googleBiddingEventSnapshots,
  state: (plan, readers) =>
    readGoogleBiddingEventState(
      plan,
      readers.guarded('Google goal and bidding-event dependency checks must be read-only.').read,
    ),
  impact: () => googleBiddingEventImpact,
  outcome: googleBiddingEventOutcome,
  verify: (plan, v) =>
    verifyGoogleBiddingEvent(
      plan,
      v.result,
      v.state,
      v.guarded('Google goal and bidding-event verification must remain read-only.', {check: assertGoogleAdsScope}),
    ).then(o => ({status: o.status, checks: o.checks})),
  spendConfirmation: {
    needed: () => true,
    message:
      'Seasonality adjustments and data exclusions can change bids, including after removal. Review the account timezone, scope and bidding impact, then provide spend_change_confirmed=true.',
  },
  activates: () => true,
};
