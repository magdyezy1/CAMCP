import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, familyErrors, readOf, type ReasonFirstRefusal} from './family-kit.js';
import * as campaignBid from './google-campaign-bid-modifiers.js';
import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import {stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {googleAdsCustomers} from './google-version.js';

type Context = {groups: string[]; targets: string[]};
type Read = CompiledRequest & {googleBidState?: Context};
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const fail: ReasonFirstRefusal = familyErrors('INVALID_BID_MODIFIER');
const stateFail = (message: string): never => fail(message, 'BID_MODIFIER_STATE_UNVERIFIED');
const only = (v: JsonObject, keys: string[]) => {
  if (Object.keys(v).some(k => !keys.includes(k))) fail('Unqualified or immutable bid-modifier field.');
};
const criteria = {
  device: ['type'],
  hotelDateSelectionType: ['type'],
  hotelAdvanceBookingWindow: ['minDays', 'maxDays'],
  hotelLengthOfStay: ['minNights', 'maxNights'],
  hotelCheckInDay: ['dayOfWeek'],
  hotelCheckInDateRange: ['startDate', 'endDate'],
};
export const googleBidFields = [
  'resource_name',
  'ad_group',
  'criterion_id',
  'bid_modifier',
  'base_ad_group',
  'bid_modifier_source',
  'device.type',
  'hotel_date_selection_type.type',
  'hotel_advance_booking_window.min_days',
  'hotel_advance_booking_window.max_days',
  'hotel_length_of_stay.min_nights',
  'hotel_length_of_stay.max_nights',
  'hotel_check_in_day.day_of_week',
  'hotel_check_in_date_range.start_date',
  'hotel_check_in_date_range.end_date',
];
const groupFields = [
  'resource_name',
  'name',
  'status',
  'campaign',
  'type',
  'cpc_bid_micros',
  'cpm_bid_micros',
  'percent_cpc_bid_micros',
  'target_cpa_micros',
  'target_roas',
];
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
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) fail('Select one Google Ads customer.');
  return id;
};
const rn = (p: CompiledRequest, value: unknown, collection = 'adGroupBidModifiers') => {
  if (
    typeof value !== 'string' ||
    !new RegExp(
      '^customers/' +
        account(p) +
        '/' +
        collection +
        '/[1-9][0-9]*' +
        (collection === 'adGroupBidModifiers' ? '~[1-9][0-9]*' : '') +
        '$',
    ).test(value)
  )
    fail('Use the exact selected-customer ' + collection + ' resource.');
  return value as string;
};
export function googleBidKind(p: CompiledRequest): boolean {
  return (
    campaignBid.googleCampaignBidKind(p) ||
    (p.gateway === 'google_ads_native_action' &&
      p.method === 'POST' &&
      !p.specialTransport &&
      (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
      /^\/v\d+\/customers\/\d+\/adGroupBidModifiers:mutate$/.test(p.path))
  );
}
export {assertGoogleAdsScope as assertGoogleBidScope} from './google-contracts.js';
const groupFor = (p: CompiledRequest, op: JsonObject) =>
  op.create
    ? rn(p, op.create.adGroup, 'adGroups')
    : 'customers/' +
      account(p) +
      '/adGroups/' +
      rn(p, op.remove ?? op.update.resourceName)
        .split('/')
        .at(-1)!
        .split('~')[0];
function criterion(r: JsonObject): string {
  const kinds = Object.keys(criteria).filter(k => r[k] !== undefined);
  if (kinds.length !== 1) fail('Supply exactly one device or hotel criterion.');
  const k = kinds[0]!,
    v = r[k];
  if (!object(v)) fail('The criterion must be a native object.');
  const fields = criteria[k as keyof typeof criteria];
  only(v, fields);
  if (k === 'device' && !['MOBILE', 'DESKTOP', 'TABLET', 'CONNECTED_TV', 'OTHER'].includes(v.type))
    fail('Choose a documented device enum.');
  if (k === 'hotelDateSelectionType' && !['DEFAULT_SELECTION', 'USER_SELECTED'].includes(v.type))
    fail('Choose DEFAULT_SELECTION or USER_SELECTED.');
  if (
    k === 'hotelCheckInDay' &&
    !['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].includes(v.dayOfWeek)
  )
    fail('Choose a hotel check-in weekday.');
  if (k === 'hotelAdvanceBookingWindow' || k === 'hotelLengthOfStay') {
    if (
      fields.some(
        f =>
          !['string', 'number'].includes(typeof v[f]) ||
          !/^\d+$/.test(String(v[f])) ||
          BigInt(v[f]) > BigInt(Number.MAX_SAFE_INTEGER),
      ) ||
      BigInt(v[fields[0]!]) > BigInt(v[fields[1]!])
    )
      fail('Supply explicit increasing nonnegative whole-day/night boundaries.');
  }
  if (k === 'hotelCheckInDateRange') {
    const valid = (d: unknown) =>
      typeof d === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(d) &&
      Number.isFinite(Date.parse(d)) &&
      new Date(d).toISOString().slice(0, 10) === d;
    if (!valid(v.startDate) || !valid(v.endDate) || v.startDate > v.endDate)
      fail('Supply valid ordered YYYY-MM-DD hotel check-in dates.');
  }
  return k;
}
function modifier(value: unknown, device: boolean) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !((value >= 0.1 && value <= 10) || (device && value === 0))
  )
    fail('bidModifier must be 0.1–10; only a device criterion may use zero to opt out.');
}
function canonical(r: JsonObject): JsonObject {
  const v = structuredClone(r);
  for (const k of ['hotelAdvanceBookingWindow', 'hotelLengthOfStay'])
    if (object(v[k]))
      for (const field of criteria[k as keyof typeof criteria])
        if (v[k][field] !== undefined) v[k][field] = BigInt(v[k][field]).toString();
  return v;
}
const criterionKey = (r: JsonObject) =>
  stable(
    Object.fromEntries(
      Object.keys(criteria)
        .filter(k => r[k] !== undefined)
        .map(k => [k, canonical(r)[k]]),
    ),
  );
export function assertGoogleBid(p: CompiledRequest) {
  if (campaignBid.googleCampaignBidKind(p)) return campaignBid.assertGoogleCampaignBid(p);
  if (!googleBidKind(p)) return;
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
    fail('Review 1–25 atomic operations using resource-name receipts.');
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    fail('Bid reviews do not accept query/header overrides.');
  const seen = new Set<string>();
  for (const op of b.operations) {
    if (!object(op)) fail('Supply native operation objects.');
    only(op, ['create', 'update', 'remove', 'updateMask']);
    if (['create', 'update', 'remove'].filter(k => op[k] !== undefined).length !== 1)
      fail('Each operation needs one create, update or remove.');
    let key: string;
    if (op.create) {
      const r = op.create;
      if (!object(r)) fail('create requires an object.');
      only(r, ['adGroup', 'bidModifier', ...Object.keys(criteria)]);
      const k = criterion(r);
      modifier(r.bidModifier, k === 'device');
      key = groupFor(p, op) + '/' + criterionKey(r);
    } else if (op.update) {
      const r = op.update;
      if (!object(r)) fail('update requires an object.');
      only(r, ['resourceName', 'bidModifier']);
      if (op.updateMask !== 'bidModifier') fail('The updateMask must be bid_modifier.');
      modifier(r.bidModifier, true);
      key = rn(p, r.resourceName);
    } else key = rn(p, op.remove);
    if (!op.update && op.updateMask !== undefined) fail('Only updates accept updateMask.');
    if (seen.has(key)) fail('Duplicate bid-modifier operations require separate reviews.');
    seen.add(key);
  }
}
function read(p: CompiledRequest, query: string): Read {
  return readOf<Read>(
    p,
    {
      action: 'AMCP_GOOGLE_BID_READ',
      method: 'POST',
      path: googleAdsCustomers + account(p) + '/googleAds:search',
      body: {query},
      query: {},
      clears: ['responseControls'],
    },
    {googleBidState: undefined},
  );
}
export function googleBidSnapshots(p: CompiledRequest): Read[] {
  if (campaignBid.googleCampaignBidKind(p)) return campaignBid.googleCampaignBidSnapshots(p);
  const ops = googleJson(p.body).operations as JsonObject[];
  return [
    {
      ...read(p, 'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'),
      googleBidState: {
        groups: [...new Set(ops.map(o => groupFor(p, o)))].sort(),
        targets: ops
          .filter(o => !o.create)
          .map(o => rn(p, o.remove ?? o.update.resourceName))
          .sort(),
      },
    },
  ];
}
export function isGoogleBidRead(p: CompiledRequest): p is Read {
  return campaignBid.isGoogleCampaignBidRead(p) || !!(p as Read).googleBidState;
}
export async function readGoogleBidState(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  if (campaignBid.isGoogleCampaignBidRead(p)) return campaignBid.readGoogleCampaignBidState(p, request);
  const context = (p as Read).googleBidState;
  if (!context) return request(p);
  let requests = 0,
    bytes = 0,
    rows = 0;
  const start = performance.now();
  const fetch = async (query: string, key: string) => {
    const result: JsonObject[] = [],
      tokens = new Set<string>();
    let pageToken: string | undefined, total: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 25 || ++requests > 80 || performance.now() - start > 60000)
        stateFail('Complete bid configuration exceeds its page/request/time bounds.');
      const plan = read(p, query);
      if (pageToken) (plan.body as JsonObject).pageToken = pageToken;
      const response = await request(plan),
        value = response.data;
      if (
        response.status !== 200 ||
        !object(value) ||
        value.error !== undefined ||
        value.errors !== undefined ||
        value.partialFailureError !== undefined ||
        value.warnings !== undefined
      )
        stateFail('Google returned a failed or unknown state response.');
      const raw = value as JsonObject;
      const size = Buffer.byteLength(JSON.stringify(raw));
      bytes += size;
      if (size > 4 * 1024 * 1024 || bytes > 8 * 1024 * 1024 || performance.now() - start > 60000)
        stateFail('Complete bid configuration exceeds its byte/time bounds.');
      if (
        Object.keys(raw).some(
          k => !['results', 'fieldMask', 'queryResourceConsumption', 'nextPageToken', 'totalResultsCount'].includes(k),
        ) ||
        (raw.results !== undefined && !Array.isArray(raw.results)) ||
        (raw.nextPageToken !== undefined && typeof raw.nextPageToken !== 'string')
      )
        stateFail('Google returned an unrecognized incomplete state envelope.');
      if (raw.totalResultsCount !== undefined) {
        const n = String(raw.totalResultsCount);
        if (!/^\d+$/.test(n) || (total !== undefined && total !== n))
          stateFail('Google returned an invalid or changing result count.');
        total = n;
      }
      const values = raw.results ?? [];
      rows += values.length;
      if (rows > 1100) stateFail('Complete bid configuration exceeds 1100 total state rows.');
      for (const value of values) {
        const row = googleJson(value);
        if (!object(row) || !object(row[key])) stateFail('Google returned a malformed configuration row.');
        result.push(row[key]);
      }
      if (!raw.nextPageToken) break;
      if (
        typeof raw.nextPageToken !== 'string' ||
        raw.nextPageToken.length > 4096 ||
        tokens.has(raw.nextPageToken) ||
        !values.length
      )
        stateFail('Google bid configuration has invalid pagination.');
      tokens.add(raw.nextPageToken);
      pageToken = raw.nextPageToken;
    }
    if (total !== undefined && BigInt(total) !== BigInt(result.length))
      stateFail('Google result count proves an incomplete collection.');
    return result;
  };
  const query = (resource: string, fields: string[], filter: string, names: string[]) =>
    'SELECT ' +
    fields.map(f => resource + '.' + f).join(', ') +
    ' FROM ' +
    resource +
    ' WHERE ' +
    resource +
    '.' +
    filter +
    ' IN (' +
    names.map(n => "'" + n + "'").join(', ') +
    ')';
  const customer = await fetch(
    'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1',
    'customer',
  );
  if (
    customer.length !== 1 ||
    customer[0]!.id !== account(p) ||
    typeof customer[0]!.currencyCode !== 'string' ||
    typeof customer[0]!.timeZone !== 'string'
  )
    stateFail('The selected customer was not verified.');
  const exact = (values: JsonObject[], names: string[]) => {
    const map: JsonObject = {};
    for (const v of values) {
      if (typeof v.resourceName !== 'string' || !names.includes(v.resourceName) || Object.hasOwn(map, v.resourceName))
        stateFail('A required parent was foreign or repeated.');
      map[v.resourceName] = v;
    }
    if (Object.keys(map).length !== names.length) stateFail('A required parent was omitted.');
    return map;
  };
  const groups = exact(
    await fetch(query('ad_group', groupFields, 'resource_name', context.groups), 'adGroup'),
    context.groups,
  );
  const campaignNames = [...new Set(Object.values(groups).map((g: JsonObject) => rn(p, g.campaign, 'campaigns')))];
  const campaigns = exact(
    await fetch(query('campaign', campaignFields, 'resource_name', campaignNames), 'campaign'),
    campaignNames,
  );
  for (const parent of [...Object.values(groups), ...Object.values(campaigns)] as JsonObject[])
    if (typeof parent.name !== 'string' || !['ENABLED', 'PAUSED'].includes(parent.status))
      stateFail('Every parent must return its current name and enabled/paused configuration.');
  for (const c of Object.values(campaigns) as JsonObject[])
    if (typeof c.advertisingChannelType !== 'string' || typeof c.biddingStrategyType !== 'string')
      stateFail('Campaign channel and bidding strategy are required for review.');
  const budgetNames = [
    ...new Set(Object.values(campaigns).map((c: JsonObject) => rn(p, c.campaignBudget, 'campaignBudgets'))),
  ];
  const budgets = exact(
    await fetch(
      query(
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
        'resource_name',
        budgetNames,
      ),
      'campaignBudget',
    ),
    budgetNames,
  );
  for (const b of Object.values(budgets) as JsonObject[])
    if (
      b.status !== 'ENABLED' ||
      typeof b.name !== 'string' ||
      ![b.amountMicros, b.totalAmountMicros].some(v => typeof v === 'string' && /^\d+$/.test(v))
    )
      stateFail('The current campaign budget and native amount were not verified.');
  const modifiers: JsonObject = {},
    identities = new Set<string>();
  for (const m of await fetch(
    query('ad_group_bid_modifier', googleBidFields, 'ad_group', context.groups),
    'adGroupBidModifier',
  )) {
    const name = rn(p, m.resourceName),
      g = rn(p, m.adGroup, 'adGroups');
    if (
      !Object.hasOwn(groups, g) ||
      name.split('/').at(-1)!.split('~')[0] !== g.split('/').at(-1) ||
      Object.hasOwn(modifiers, name) ||
      !['AD_GROUP', 'CAMPAIGN'].includes(m.bidModifierSource)
    )
      stateFail('A bid modifier returned the wrong parent, duplicate identity or unknown source.');
    if (String(m.criterionId) !== name.split('~').at(-1))
      stateFail('The bid modifier criterion identity disagrees with its resource.');
    if (m.baseAdGroup !== undefined && m.baseAdGroup !== null) rn(p, m.baseAdGroup, 'adGroups');
    const k = criterion(m);
    modifier(m.bidModifier, k === 'device');
    const identity = g + '/' + criterionKey(m);
    if (identities.has(identity)) stateFail('Google returned ambiguous repeated criterion identities.');
    identities.add(identity);
    modifiers[name] = canonical(m);
  }
  if (Object.keys(modifiers).length > 1000)
    stateFail('Review supports at most 1000 modifiers across selected ad groups.');
  const targets = Object.fromEntries(
    context.targets.map(name => [
      name,
      {localOverrideAbsent: !modifiers[name] || modifiers[name].bidModifierSource === 'CAMPAIGN'},
    ]),
  );
  return {status: 200, headers: {}, data: {customer: customer[0], groups, campaigns, budgets, modifiers, targets}};
}
export function validateGoogleBidState(p: CompiledRequest, r: TransportResult) {
  if (campaignBid.isGoogleCampaignBidRead(p)) return campaignBid.validateGoogleCampaignBidState(p, r);
  const d = r.data,
    c = (p as Read).googleBidState;
  if (
    !c ||
    r.status !== 200 ||
    !object(d) ||
    d.customer?.id !== account(p) ||
    !object(d.modifiers) ||
    !object(d.groups) ||
    c.groups.some(g => !d.groups[g])
  )
    stateFail('The complete scoped bid-modifier snapshot is missing.');
}
export function googleBidPrerequisites(p: CompiledRequest, states: unknown[]) {
  if (campaignBid.googleCampaignBidKind(p)) return campaignBid.googleCampaignBidPrerequisites(p, states);
  if (!googleBidKind(p)) return;
  const state = states[0] as JsonObject,
    seen = new Set<string>(),
    ops = googleJson(p.body).operations;
  let newCount = 0;
  for (const op of ops) {
    const g = groupFor(p, op),
      current = op.create ? undefined : state.modifiers[op.remove ?? op.update.resourceName];
    if (!op.create && !current) stateFail('The exact modifier is missing; never infer an inherited bid.');
    const record = op.create ?? current,
      k = criterion(record),
      campaign = state.campaigns[state.groups[g].campaign];
    if (k.startsWith('hotel') && campaign.advertisingChannelType !== 'HOTEL')
      fail('Hotel criteria require a Hotel campaign.');
    if (op.update) modifier(op.update.bidModifier, k === 'device');
    const key = g + '/' + criterionKey(record);
    if (seen.has(key)) fail('This review addresses the same criterion more than once.');
    seen.add(key);
    if (
      op.create &&
      Object.values(state.modifiers).some(
        (m: any) =>
          m.adGroup === g && criterionKey(m) === criterionKey(op.create) && m.bidModifierSource === 'AD_GROUP',
      )
    )
      fail(
        'An explicit modifier already exists. Prepare an update for its discovered resource.',
        'BID_MODIFIER_EXISTS',
      );
    if (
      op.create &&
      !Object.values(state.modifiers).some((m: any) => m.adGroup === g && criterionKey(m) === criterionKey(op.create))
    )
      newCount++;
  }
  if (Object.keys(state.modifiers).length + newCount > 1000)
    fail('Creating these modifiers exceeds complete read-back capacity.');
}
export function googleBidOutcome(p: CompiledRequest, r: TransportResult): boolean {
  if (campaignBid.googleCampaignBidKind(p)) return campaignBid.googleCampaignBidOutcome(p, r);
  const b = googleJson(p.body),
    d = r.data;
  if (
    r.status !== 200 ||
    !object(d) ||
    d.partialFailureError !== undefined ||
    d.error !== undefined ||
    d.errors !== undefined ||
    !Array.isArray(d.results) ||
    d.results.length !== b.operations.length
  )
    return false;
  const seen = new Set<string>();
  return d.results.every((row: unknown, i: number) => {
    try {
      if (!object(row) || Object.keys(row).some(k => k !== 'resourceName')) return false;
      const name = rn(p, row.resourceName),
        op = b.operations[i];
      if (
        seen.has(name) ||
        name.split('/').at(-1)!.split('~')[0] !== groupFor(p, op).split('/').at(-1) ||
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
export function googleBidVerification(p: CompiledRequest, result: JsonObject) {
  if (campaignBid.googleCampaignBidKind(p)) return campaignBid.googleCampaignBidVerification(p, result);
  const reads = googleBidSnapshots(p),
    snapshot = reads[0]!,
    context = snapshot.googleBidState!,
    expected: JsonObject = {modifiers: {}, targets: {}};
  for (const [i, op] of googleJson(p.body).operations.entries()) {
    const name = rn(p, result.data.results[i].resourceName);
    if (op.remove) {
      context.targets.push(name);
      expected.targets[name] = {localOverrideAbsent: true};
    } else
      expected.modifiers[name] = canonical({
        ...(op.create ?? op.update),
        resourceName: name,
        adGroup: groupFor(p, op),
        bidModifierSource: 'AD_GROUP',
      });
  }
  context.targets = [...new Set(context.targets)].sort();
  return [{read: snapshot, expected, id: context.groups.join(',')}];
}
export const googleBidImpact = {
  provider: 'google',
  scope: 'ad_group_bid_modifiers',
  may_affect_serving: true,
  effect:
    'Changes native bid multipliers for device or hotel criteria. Zero opts out of a device. Removing an override restores inherited/default bidding and can increase bids. Smart Bidding may ignore a positive modifier; configuration verification never proves auction effects.',
  units:
    'Dimensionless multiplier, not currency or percent: 1.2 means +20%. Existing monetary budgets are unchanged; this is not a billed-spend forecast.',
  verification:
    'Complete selected-group modifiers and fresh parent configuration. Removed overrides may be absent or have source CAMPAIGN. Unknown inheritance or incomplete state remains unverified.',
  recovery:
    'Retain the original claim after a lost or partial response. Read back first; never automatically repeat a mutation.',
};

export const googleBidImpactFor = (p: CompiledRequest) =>
  campaignBid.googleCampaignBidKind(p) ? campaignBid.googleCampaignBidImpact : googleBidImpact;

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleBidFamily: ReviewedFamily = defineFamily({
  name: 'google_bid_modifiers',
  files: [
    'src/google-bid-modifiers.ts / src/google-campaign-bid-modifiers.ts',
    ['tests/google-bid-modifiers.test.ts', 'tests/google-campaign-bid-modifiers.test.ts'],
  ],
  kind: googleBidKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertGoogleBid(plan);
  },
  scope: c => assertGoogleAdsScope(c),
  authorize: (plan, connection) => {
    if (plan.gateway === 'google_ads_native_action' && plan.action === 'AMCP_GOOGLE_BID_READ')
      assertGoogleAdsScope(connection);
    return false;
  },
  snapshots: googleBidSnapshots,
  isRead: isGoogleBidRead,
  reader: (read, next) => readGoogleBidState(read, next),
  validateState: validateGoogleBidState,
  prerequisites: (plan, state) => googleBidPrerequisites(plan, state),
  impact: plan => googleBidImpactFor(plan),
  outcome: googleBidOutcome,
  verification: googleBidVerification,
  readCheck: c => assertGoogleAdsScope(c),
  observed: (read: CompiledRequest, data: JsonObject) => data,
  activates: () => true,
});
