import {MirrorError} from './errors.js';
import {googleJson} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {googleAdsCustomers} from './google-version.js';

type Context = {campaigns: string[]; targets: string[]};
type Read = CompiledRequest & {googleCampaignBidState?: Context};
type Send = (p: CompiledRequest) => Promise<TransportResult>;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (message: string, code = 'INVALID_BID_MODIFIER'): never => {
  throw new MirrorError(code, message, {}, code === 'BID_MODIFIER_STATE_UNVERIFIED' ? 502 : 400);
};
const stateFail = (message: string): never => fail(message, 'BID_MODIFIER_STATE_UNVERIFIED');
const only = (v: JsonObject, keys: string[]) => {
  if (Object.keys(v).some(k => !keys.includes(k))) fail('Unqualified or immutable campaign bid-modifier field.');
};
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) fail('Select one Google Ads customer.');
  return id;
};
const rn = (p: CompiledRequest, v: unknown, collection = 'campaignBidModifiers') => {
  if (
    typeof v !== 'string' ||
    !new RegExp(
      '^customers/' +
        account(p) +
        '/' +
        collection +
        '/[1-9][0-9]*' +
        (collection === 'campaignBidModifiers' ? '~[1-9][0-9]*' : '') +
        '$',
    ).test(v)
  )
    fail('Use an exact selected-customer ' + collection + ' resource.');
  return v as string;
};
const parent = (p: CompiledRequest, v: unknown) =>
  rn(p, 'customers/' + account(p) + '/campaigns/' + rn(p, v).split('/').at(-1)!.split('~')[0], 'campaigns');
const multiplier = (v: unknown) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.1 || v > 10)
    fail(
      'Call-interaction bidModifier must be a dimensionless multiplier from 0.1 to 10. Zero is a device-only opt-out, not a call adjustment.',
    );
};
export const googleCampaignBidFields = [
  'resource_name',
  'campaign',
  'criterion_id',
  'bid_modifier',
  'interaction_type.type',
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
const budgetFields = [
  'resource_name',
  'name',
  'status',
  'amount_micros',
  'total_amount_micros',
  'explicitly_shared',
  'delivery_method',
];
// Full native configuration; account-wide aggregate counts and redundant ID are
// excluded. Currency, aligned budget, targets, ceilings and floors remain guarded.
export const googleCampaignBidStrategyFields = [
  'aligned_campaign_budget_id',
  'currency_code',
  'effective_currency_code',
  'enhanced_cpc',
  'maximize_conversion_value.cpc_bid_ceiling_micros',
  'maximize_conversion_value.cpc_bid_floor_micros',
  'maximize_conversion_value.target_roas',
  'maximize_conversion_value.target_roas_tolerance_percent_millis',
  'maximize_conversions.cpc_bid_ceiling_micros',
  'maximize_conversions.cpc_bid_floor_micros',
  'maximize_conversions.target_cpa_micros',
  'name',
  'resource_name',
  'status',
  'target_cpa.cpc_bid_ceiling_micros',
  'target_cpa.cpc_bid_floor_micros',
  'target_cpa.target_cpa_micros',
  'target_impression_share.cpc_bid_ceiling_micros',
  'target_impression_share.location',
  'target_impression_share.location_fraction_micros',
  'target_roas.cpc_bid_ceiling_micros',
  'target_roas.cpc_bid_floor_micros',
  'target_roas.target_roas',
  'target_roas.target_roas_tolerance_percent_millis',
  'target_spend.cpc_bid_ceiling_micros',
  'target_spend.target_spend_micros',
  'type',
];
const strategyFields = googleCampaignBidStrategyFields;
/** Creation needs a separately qualified native campaign/criterion identity contract.
 * Its historical alias remains blocked; the RPC supports exact update/remove only. */
export function googleCampaignBidKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'google_ads_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    p.action !== 'CREATE_CAMPAIGN_BID_MODIFIER' &&
    /^\/v\d+\/customers\/\d+\/campaignBidModifiers:mutate$/.test(p.path)
  );
}
export function assertGoogleCampaignBid(p: CompiledRequest) {
  const b = googleJson(p.body);
  only(b, ['operations', 'partialFailure', 'validateOnly', 'responseContentType']);
  if (
    p.path.split('/')[3] !== account(p) ||
    !Array.isArray(b.operations) ||
    !b.operations.length ||
    b.operations.length > 25 ||
    b.partialFailure === true ||
    b.validateOnly === true ||
    (b.responseContentType !== undefined && b.responseContentType !== 'RESOURCE_NAME_ONLY')
  )
    fail('Review 1–25 atomic campaign bid changes for the selected customer.');
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    fail('Campaign bid reviews do not accept query or header overrides.');
  const seen = new Set<string>();
  for (const op of b.operations) {
    if (!object(op)) fail('Supply native operation objects.');
    only(op, ['update', 'remove', 'updateMask']);
    if (['update', 'remove'].filter(k => op[k] !== undefined).length !== 1)
      fail('This campaign contract supports update/remove of discovered call modifiers. Creation remains unqualified.');
    const name = rn(p, op.remove ?? op.update?.resourceName);
    if (seen.has(name)) fail('Each modifier may occur only once in a review.');
    seen.add(name);
    if (op.update) {
      if (!object(op.update)) fail('update requires a native object.');
      only(op.update, ['resourceName', 'bidModifier']);
      if (op.updateMask !== 'bidModifier') fail('The updateMask must cover only bid_modifier.');
      multiplier(op.update.bidModifier);
    } else if (op.updateMask !== undefined) fail('Removal has no updateMask.');
  }
}
function read(
  p: CompiledRequest,
  resource: string,
  fields: string[],
  names?: string[],
  filter = 'resource_name',
): Read {
  return {
    ...p,
    action: 'AMCP_CAMPAIGN_BID_READ',
    method: 'POST',
    path: googleAdsCustomers + account(p) + '/googleAds:search',
    body: {
      query:
        'SELECT ' +
        fields.map(f => resource + '.' + f).join(', ') +
        ' FROM ' +
        resource +
        (names
          ? ' WHERE ' + resource + '.' + filter + ' IN (' + names.map(n => "'" + n + "'").join(', ') + ')'
          : resource === 'customer'
            ? ' LIMIT 1'
            : ''),
    },
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    googleCampaignBidState: undefined,
  };
}
export function googleCampaignBidSnapshots(p: CompiledRequest): Read[] {
  const targets = googleJson(p.body).operations.map((op: JsonObject) => rn(p, op.remove ?? op.update.resourceName));
  return [
    {
      ...read(p, 'customer', ['id', 'currency_code', 'time_zone', 'manager']),
      googleCampaignBidState: {
        campaigns: [...new Set<string>(targets.map((id: string) => parent(p, id)))].sort(),
        targets: targets.sort(),
      },
    },
  ];
}
export function isGoogleCampaignBidRead(p: CompiledRequest): p is Read {
  return !!(p as Read).googleCampaignBidState;
}
export async function readGoogleCampaignBidState(p: CompiledRequest, send: Send): Promise<TransportResult> {
  const context = (p as Read).googleCampaignBidState;
  if (!context) return send(p);
  let bytes = 0,
    rows = 0,
    requests = 0;
  const started = performance.now();
  const fetch = async (resource: string, fields: string[], names?: string[], filter?: string) => {
    const out: JsonObject[] = [],
      tokens = new Set<string>();
    let token: string | undefined, total: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 25 || ++requests > 80 || performance.now() - started > 60000)
        stateFail('Complete call-modifier state exceeded its page/request/deadline bound.');
      const plan = read(p, resource, fields, names, filter);
      if (token) (plan.body as JsonObject).pageToken = token;
      const response = await send(plan),
        d = response.data as JsonObject;
      if (
        response.status !== 200 ||
        !object(d) ||
        Object.keys(d).some(
          k => !['results', 'fieldMask', 'queryResourceConsumption', 'nextPageToken', 'totalResultsCount'].includes(k),
        ) ||
        (d.results !== undefined && !Array.isArray(d.results)) ||
        (d.nextPageToken !== undefined && typeof d.nextPageToken !== 'string')
      )
        stateFail('Google returned a failed or unrecognized call-modifier state envelope.');
      const size = Buffer.byteLength(JSON.stringify(d));
      bytes += size;
      if (size > 4 * 1024 * 1024 || bytes > 8 * 1024 * 1024 || performance.now() - started > 60000)
        stateFail('Call-modifier state exceeded its byte/deadline bound.');
      if (d.totalResultsCount !== undefined) {
        const n = String(d.totalResultsCount);
        if (!/^\d+$/.test(n) || (total !== undefined && total !== n))
          stateFail('The native result count is invalid or changing.');
        total = n;
      }
      const values = d.results ?? [],
        key = resource.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      rows += values.length;
      if (rows > 2100) stateFail('Call-modifier state exceeded 2100 rows including consistency rereads.');
      for (const v of values) {
        if (!object(v) || Object.keys(v).length !== 1 || !object(v[key]))
          stateFail('The native state row has an unexpected identity or shape.');
        out.push(v[key]);
      }
      if (!d.nextPageToken) break;
      if (d.nextPageToken.length > 4096 || tokens.has(d.nextPageToken) || !values.length)
        stateFail('Call-modifier pagination is repeated or incomplete.');
      tokens.add(d.nextPageToken);
      token = d.nextPageToken;
    }
    if (total !== undefined && BigInt(total) !== BigInt(out.length))
      stateFail('The native result count proves incomplete state.');
    return out;
  };
  const exact = (values: JsonObject[], names: string[], collection: string) => {
    const out: JsonObject = {};
    for (const v of values) {
      const id = rn(p, v.resourceName, collection);
      if (!names.includes(id) || Object.hasOwn(out, id)) stateFail('A required parent is foreign or repeated.');
      out[id] = v;
    }
    if (Object.keys(out).length !== names.length) stateFail('A required parent is missing.');
    return out;
  };
  const customer = await fetch('customer', ['id', 'currency_code', 'time_zone', 'manager']);
  if (
    customer.length !== 1 ||
    customer[0]!.id !== account(p) ||
    typeof customer[0]!.currencyCode !== 'string' ||
    !/^[A-Z]{3}$/.test(customer[0]!.currencyCode) ||
    typeof customer[0]!.timeZone !== 'string' ||
    !customer[0]!.timeZone ||
    (customer[0]!.manager !== undefined && customer[0]!.manager !== false)
  )
    stateFail('Verify a client customer, its currency and time zone.');
  const campaigns = exact(await fetch('campaign', campaignFields, context.campaigns), context.campaigns, 'campaigns');
  for (const c of Object.values(campaigns) as JsonObject[])
    if (
      typeof c.name !== 'string' ||
      !c.name ||
      !['ENABLED', 'PAUSED'].includes(c.status) ||
      c.advertisingChannelType !== 'SEARCH' ||
      typeof c.biddingStrategyType !== 'string' ||
      ['UNKNOWN', 'UNSPECIFIED'].includes(c.biddingStrategyType)
    )
      stateFail('Call interaction adjustments require an existing Search campaign with known bidding configuration.');
  const budgetNames = [
    ...new Set<string>(Object.values(campaigns).map((c: JsonObject) => rn(p, c.campaignBudget, 'campaignBudgets'))),
  ];
  const budgets = exact(await fetch('campaign_budget', budgetFields, budgetNames), budgetNames, 'campaignBudgets');
  for (const b of Object.values(budgets) as JsonObject[])
    if (
      b.status !== 'ENABLED' ||
      typeof b.name !== 'string' ||
      !b.name ||
      ![b.amountMicros, b.totalAmountMicros].some(v => typeof v === 'string' && /^\d+$/.test(v))
    )
      stateFail('The exact current budget and native amount are required.');
  const strategyNames = [
    ...new Set<string>(
      Object.values(campaigns).flatMap((c: JsonObject) =>
        c.biddingStrategy ? [rn(p, c.biddingStrategy, 'biddingStrategies')] : [],
      ),
    ),
  ];
  const strategies = strategyNames.length
    ? exact(await fetch('bidding_strategy', strategyFields, strategyNames), strategyNames, 'biddingStrategies')
    : {};
  for (const s of Object.values(strategies) as JsonObject[])
    if (
      s.status !== 'ENABLED' ||
      typeof s.name !== 'string' ||
      !s.name ||
      !Object.values(campaigns).some(
        (c: any) => c.biddingStrategy === s.resourceName && c.biddingStrategyType === s.type,
      )
    )
      stateFail('The current client-owned portfolio strategy was not verified.');
  const modifiers: JsonObject = {},
    identities = new Set<string>();
  for (const row of await fetch('campaign_bid_modifier', googleCampaignBidFields, context.campaigns, 'campaign')) {
    const name = rn(p, row.resourceName),
      campaign = parent(p, name);
    if (
      row.campaign !== campaign ||
      !context.campaigns.includes(campaign) ||
      Object.hasOwn(modifiers, name) ||
      String(row.criterionId) !== name.split('~').at(-1) ||
      !object(row.interactionType) ||
      Object.keys(row.interactionType).length !== 1 ||
      row.interactionType.type !== 'CALLS' ||
      identities.has(campaign)
    )
      stateFail('The native call-modifier identity, campaign or criterion is ambiguous.');
    multiplier(row.bidModifier);
    identities.add(campaign);
    modifiers[name] = row;
  }
  if (Object.keys(modifiers).length > 1000) stateFail('Call-modifier state exceeds complete verification capacity.');
  // Parent names and IDs are frozen with configuration. A second read detects
  // changes while fetching dependencies, instead of combining unrelated snapshots.
  const again = exact(await fetch('campaign', campaignFields, context.campaigns), context.campaigns, 'campaigns');
  if (JSON.stringify(sort(campaigns)) !== JSON.stringify(sort(again)))
    stateFail('Campaign configuration changed while reading its bid dependencies.');
  return {
    status: 200,
    headers: {},
    data: {
      customer: {...customer[0], manager: false},
      campaigns,
      budgets,
      strategies,
      modifiers,
      targets: Object.fromEntries(context.targets.map(name => [name, {present: Object.hasOwn(modifiers, name)}])),
    },
  };
}
function sort(value: any): any {
  if (Array.isArray(value)) return value.map(sort);
  return object(value)
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map(k => [k, sort(value[k])]),
      )
    : value;
}
export function validateGoogleCampaignBidState(p: CompiledRequest, r: TransportResult) {
  const d = r.data,
    c = (p as Read).googleCampaignBidState;
  if (
    !c ||
    r.status !== 200 ||
    !object(d) ||
    d.customer?.id !== account(p) ||
    !object(d.modifiers) ||
    !object(d.campaigns) ||
    c.campaigns.some(id => !d.campaigns[id])
  )
    stateFail('A complete scoped campaign bid snapshot is required.');
}
export function googleCampaignBidPrerequisites(p: CompiledRequest, states: unknown[]) {
  const state = states[0] as JsonObject;
  for (const op of googleJson(p.body).operations)
    if (!state.modifiers[op.remove ?? op.update.resourceName])
      stateFail('The discovered call modifier no longer exists. Absence is not an inferred default bid.');
}
export function googleCampaignBidOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const ops = googleJson(p.body).operations,
    d = r.data;
  if (
    r.status !== 200 ||
    !object(d) ||
    Object.keys(d).some(k => k !== 'results') ||
    !Array.isArray(d.results) ||
    d.results.length !== ops.length
  )
    return false;
  return d.results.every(
    (v: unknown, i: number) =>
      object(v) && Object.keys(v).length === 1 && v.resourceName === (ops[i].remove ?? ops[i].update.resourceName),
  );
}
export function googleCampaignBidVerification(p: CompiledRequest, result: JsonObject) {
  const snapshot = googleCampaignBidSnapshots(p)[0]!,
    expected: JsonObject = {modifiers: {}, targets: {}};
  for (const [i, op] of googleJson(p.body).operations.entries()) {
    const name = rn(p, result.data.results[i].resourceName);
    if (op.remove) expected.targets[name] = {present: false};
    else
      expected.modifiers[name] = {
        resourceName: name,
        campaign: parent(p, name),
        interactionType: {type: 'CALLS'},
        bidModifier: op.update.bidModifier,
      };
  }
  return [{read: snapshot, expected, id: snapshot.googleCampaignBidState!.campaigns.join(',')}];
}
export const googleCampaignBidImpact = {
  provider: 'google',
  scope: 'campaign_call_bid_modifiers',
  may_affect_serving: true,
  effect:
    'Changes the Search campaign call-interaction multiplier. Removing an adjustment restores default bidding and can increase bids. This applies to current and future eligible ads; Smart Bidding may ignore manual adjustments.',
  units:
    'Dimensionless multiplier: 1.2 means +20%, not currency or 1.2 percent. Budgets remain unchanged; no spend or performance forecast is implied.',
  limits:
    'Exact existing CALLS modifiers only; 1–25 update/remove operations. Creation is separately unqualified. Client-owned portfolio dependencies are checked; cross-customer portfolios need a separate authority contract.',
  verification:
    'Exact configuration or complete native collection absence, never proof of serving, auction effects or call-asset eligibility.',
  recovery:
    'Keep the original review and idempotency key for partial or lost outcomes. Inspect read-back; never repeat an uncertain mutation.',
};
