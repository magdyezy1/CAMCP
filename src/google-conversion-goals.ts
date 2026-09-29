import {MirrorError} from './errors.js';
import {googleJson} from './google-contracts.js';
import {stable, sha256} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {googleAdsContract, googleAdsCustomers, googleAdsVersion} from './google-version.js';
import {pinnedJson} from './pinned-json.js';

const resources = {
  customerConversionGoals: 'customer_conversion_goal',
  campaignConversionGoals: 'campaign_conversion_goal',
  conversionGoalCampaignConfigs: 'conversion_goal_campaign_config',
  customConversionGoals: 'custom_conversion_goal',
};
type Kind = keyof typeof resources;
type Send = (p: CompiledRequest) => Promise<TransportResult>;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 255): v is string =>
  typeof v === 'string' && !!v.trim() && [...v].length <= max && !/[\u0000-\u001f\ud800-\udfff]/u.test(v);
const fail = (message: string, code = 'INVALID_CONVERSION_GOAL'): never => {
  throw new MirrorError(code, message, {}, code === 'CONVERSION_GOAL_STATE_UNVERIFIED' ? 502 : 400);
};
const stateFail = (message: string): never => fail(message, 'CONVERSION_GOAL_STATE_UNVERIFIED');
const only = (v: JsonObject, keys: string[]) => {
  if (Object.keys(v).some(k => !keys.includes(k))) fail('Unqualified or immutable conversion-goal field.');
};
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id) || p.path.split('/')[3] !== id) fail('Select the exact Google Ads customer.');
  return id;
};
/**
 * A goal is named by its category and origin, as the pinned contract states:
 * `customers/{customer_id}/customerConversionGoals/{category}~{origin}` and
 * `customers/{customer_id}/campaignConversionGoals/{campaign_id}~{category}~{origin}`, each an enum value of the
 * contract other than UNSPECIFIED and UNKNOWN. Other goal resources and campaigns are named by numeric IDs.
 */
const goalValues = (field: 'category' | 'origin'): string[] =>
  (
    pinnedJson('.mirror/VENDOR/' + googleAdsContract + '.json').document.schemas[
      'GoogleAdsGoogleads' + googleAdsVersion.toUpperCase() + 'Resources__CustomerConversionGoal'
    ].properties[field].enum as string[]
  ).filter(v => v !== 'UNSPECIFIED' && v !== 'UNKNOWN');
const goalKey = () => '(?:' + goalValues('category').join('|') + ')~(?:' + goalValues('origin').join('|') + ')';
const rn = (p: CompiledRequest, v: unknown, collection: string) => {
  const id =
    collection === 'customerConversionGoals'
      ? goalKey()
      : collection === 'campaignConversionGoals'
        ? '[1-9][0-9]*~' + goalKey()
        : '[1-9][0-9]*';
  if (typeof v !== 'string' || !new RegExp('^customers/' + account(p) + '/' + collection + '/' + id + '$').test(v))
    fail(
      'Use an exact ' +
        collection +
        ' resource in the selected customer' +
        (collection === 'customerConversionGoals'
          ? ', named customers/{customer_id}/customerConversionGoals/{category}~{origin} (for example PURCHASE~WEBSITE).'
          : collection === 'campaignConversionGoals'
            ? ', named customers/{customer_id}/campaignConversionGoals/{campaign_id}~{category}~{origin}.'
            : '.'),
    );
  return v as string;
};
const campaignFor = (p: CompiledRequest, name: string) =>
  rn(p, 'customers/' + account(p) + '/campaigns/' + name.split('/').at(-1)!.split('~')[0], 'campaigns');
const camel = (v: string) => v.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
export const googleConversionGoalFields: Record<Kind, string[]> = {
  customerConversionGoals: ['resource_name', 'category', 'origin', 'biddable'],
  campaignConversionGoals: ['resource_name', 'campaign', 'category', 'origin', 'biddable'],
  conversionGoalCampaignConfigs: ['resource_name', 'campaign', 'goal_config_level', 'custom_conversion_goal'],
  customConversionGoals: ['resource_name', 'id', 'name', 'status', 'conversion_actions'],
};
const customerFields = [
  'id',
  'currency_code',
  'time_zone',
  'manager',
  'conversion_tracking_setting.google_ads_conversion_customer',
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
const actionFields = [
  'resource_name',
  'name',
  'status',
  'type',
  'category',
  'origin',
  'owner_customer',
  'primary_for_goal',
  'counting_type',
  'click_through_lookback_window_days',
  'view_through_lookback_window_days',
  'value_settings.default_value',
  'value_settings.default_currency_code',
  'value_settings.always_use_default_value',
  'attribution_model_settings.attribution_model',
];
const liveCampaigns = "campaign.status != 'REMOVED' AND campaign.advertising_channel_type != 'MULTI_CHANNEL'";
export function googleConversionGoalKind(p: CompiledRequest): Kind | undefined {
  const kind = p.path.match(/^\/v\d+\/customers\/\d+\/([A-Za-z]+):mutate$/)?.[1];
  return p.gateway === 'google_ads_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    kind &&
    Object.hasOwn(resources, kind)
    ? (kind as Kind)
    : undefined;
}
export function googleConversionGoalServing(p: CompiledRequest): boolean {
  const kind = googleConversionGoalKind(p);
  return (
    !!kind &&
    (kind !== 'customConversionGoals' ||
      !Array.isArray(googleJson(p.body)?.operations) ||
      googleJson(p.body).operations.some((op: any) => !op?.create))
  );
}
function actions(p: CompiledRequest, v: unknown) {
  if (!Array.isArray(v) || !v.length || v.length > 100 || new Set(v).size !== v.length)
    fail('Provide 1–100 distinct existing conversion actions, as a complete replacement set.');
  for (const n of v as unknown[]) rn(p, n, 'conversionActions');
}
export function assertGoogleConversionGoal(p: CompiledRequest) {
  const kind = googleConversionGoalKind(p);
  if (!kind) return;
  account(p);
  const b = googleJson(p.body);
  only(b, [
    'operations',
    'validateOnly',
    ...(['conversionGoalCampaignConfigs', 'customConversionGoals'].includes(kind) ? ['responseContentType'] : []),
  ]);
  if (
    !Array.isArray(b.operations) ||
    !b.operations.length ||
    b.operations.length > 25 ||
    b.partialFailure === true ||
    b.validateOnly === true ||
    (b.responseContentType !== undefined && b.responseContentType !== 'RESOURCE_NAME_ONLY')
  )
    fail('Review 1–25 atomic operations with resource-name receipts.');
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    fail('Do not override conversion-goal query parameters or headers.');
  const seen = new Set<string>();
  for (const op of b.operations) {
    if (!object(op)) fail('Use native operation objects.');
    only(op, ['create', 'update', 'remove', 'updateMask']);
    if (
      ['create', 'update', 'remove'].filter(k => op[k] !== undefined).length !== 1 ||
      (kind !== 'customConversionGoals' && !op.update)
    )
      fail(
        'Google creates standard goals/configs automatically: only updates are allowed. Custom goals support create/update/remove.',
      );
    let key: string;
    const row = op.create ?? op.update;
    if (row) {
      if (!object(row)) fail('Use native create/update objects.');
      const fields =
        kind === 'customConversionGoals'
          ? ['name', 'conversionActions']
          : kind === 'conversionGoalCampaignConfigs'
            ? ['goalConfigLevel', 'customConversionGoal']
            : ['biddable'];
      only(row, [...fields, ...(op.update ? ['resourceName'] : ['status'])]);
      if (kind === 'customConversionGoals') {
        if (op.create || row.name !== undefined)
          if (!text(row.name)) fail('Custom-goal names require 1–255 characters.');
        if (op.create || row.conversionActions !== undefined) actions(p, row.conversionActions);
        if (row.status !== undefined && row.status !== 'ENABLED')
          fail('Create ENABLED custom goals; remove a goal using a remove operation.');
      }
      if (row.biddable !== undefined && typeof row.biddable !== 'boolean')
        fail('biddable must be an explicit boolean.');
      if (row.goalConfigLevel !== undefined && !['CUSTOMER', 'CAMPAIGN'].includes(row.goalConfigLevel))
        fail('Choose CUSTOMER or CAMPAIGN.');
      if (row.customConversionGoal !== undefined && row.customConversionGoal !== '')
        rn(p, row.customConversionGoal, 'customConversionGoals');
      if (row.goalConfigLevel === 'CUSTOMER' && row.customConversionGoal)
        fail('A customer-default campaign cannot simultaneously activate a custom goal.');
      if (op.create) key = 'name:' + row.name;
      else {
        key = rn(p, row.resourceName, kind);
        if (typeof op.updateMask !== 'string' || !op.updateMask) fail('Supply the exact native field mask.');
        const mask = op.updateMask.split(',');
        if (
          new Set(mask).size !== mask.length ||
          mask.some((f: string) => !fields.includes(f) || row[f] === undefined || row[f] === null) ||
          Object.keys(row).some(k => k !== 'resourceName' && !mask.includes(k))
        )
          fail(
            'The mask must cover exactly the explicit changed fields, including false or an empty custom-goal reference.',
          );
      }
    } else key = rn(p, op.remove, kind);
    if (!op.update && op.updateMask !== undefined) fail('Only updates accept a field mask.');
    if (seen.has(key)) fail('A target or new name may occur only once in a review.');
    seen.add(key);
  }
}
function read(p: CompiledRequest, resource: string, fields: string[], where = ''): CompiledRequest {
  return {
    ...p,
    action: 'AMCP_CONVERSION_GOAL_READ',
    method: 'POST',
    path: googleAdsCustomers + account(p) + '/googleAds:search',
    body: {
      query:
        'SELECT ' +
        fields.map(f => resource + '.' + f).join(', ') +
        ' FROM ' +
        resource +
        (where ? ' WHERE ' + where : '') +
        (resource === 'customer' ? ' LIMIT 1' : ''),
    },
    query: {},
    headers: {},
    readOnly: true,
    requiresConfirmation: false,
    destructive: false,
    responseControls: undefined,
  };
}
export function googleConversionGoalSnapshots(p: CompiledRequest) {
  return [
    read(p, 'customer', customerFields),
    ...Object.entries(resources).map(([kind, resource]) =>
      read(
        p,
        resource,
        googleConversionGoalFields[kind as Kind],
        kind === 'campaignConversionGoals' || kind === 'conversionGoalCampaignConfigs' ? liveCampaigns : '',
      ),
    ),
  ];
}
function reader(p: CompiledRequest, send: Send) {
  let bytes = 0,
    rows = 0,
    requests = 0;
  const started = performance.now();
  return async (resource: string, fields: string[], where = '') => {
    const out: JsonObject[] = [],
      tokens = new Set<string>();
    let token: string | undefined, total: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 25 || ++requests > 100 || performance.now() - started > 60000)
        stateFail('Complete goal state exceeded its page/request/deadline bound.');
      const plan = read(p, resource, fields, where);
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
        stateFail('Google returned a failed, partial or unrecognized goal-state envelope.');
      const d = raw as JsonObject;
      const size = Buffer.byteLength(JSON.stringify(d));
      bytes += size;
      if (size > 4 * 1024 * 1024 || bytes > 8 * 1024 * 1024 || performance.now() - started > 60000)
        stateFail('Goal state exceeded its byte/deadline bound.');
      if (d.totalResultsCount !== undefined) {
        const n = String(d.totalResultsCount);
        if (!/^\d+$/.test(n) || (total !== undefined && total !== n))
          stateFail('Google returned an invalid or changing result count.');
        total = n;
      }
      const values = d.results ?? [];
      rows += values.length;
      if (rows > 30000) stateFail('Goal state exceeded 30000 rows including consistency rereads.');
      for (const row of values) {
        if (!object(row) || Object.keys(row).length !== 1 || !object(row[camel(resource)]))
          stateFail('Google returned an incomplete or unexpected goal-state row.');
        out.push(row[camel(resource)]);
      }
      if (!d.nextPageToken) break;
      if (d.nextPageToken.length > 4096 || tokens.has(d.nextPageToken) || !values.length)
        stateFail('Google returned repeated or incomplete pagination.');
      tokens.add(d.nextPageToken);
      token = d.nextPageToken;
    }
    if (total !== undefined && BigInt(total) !== BigInt(out.length))
      stateFail('The provider count proves that goal state is incomplete.');
    return out;
  };
}
function goal(p: CompiledRequest, kind: Kind, row: JsonObject): JsonObject {
  const name = rn(p, row.resourceName, kind),
    out = {...row};
  if (kind === 'customerConversionGoals' || kind === 'campaignConversionGoals') {
    if (
      !text(row.category, 64) ||
      !text(row.origin, 64) ||
      ['UNSPECIFIED', 'UNKNOWN'].includes(row.category) ||
      ['UNSPECIFIED', 'UNKNOWN'].includes(row.origin) ||
      (row.biddable !== undefined && typeof row.biddable !== 'boolean')
    )
      stateFail('Goal category, origin or biddability is unknown.');
    // The name repeats the category and origin; a row whose name says otherwise is not a goal AMCP can target.
    const key = name.split('/').at(-1)!.split('~');
    if (key.slice(kind === 'campaignConversionGoals' ? 1 : 0).join('~') !== row.category + '~' + row.origin)
      stateFail('The goal resource name and its category or origin disagree.');
    out.biddable ??= false;
  }
  if (kind === 'campaignConversionGoals' || kind === 'conversionGoalCampaignConfigs')
    if (row.campaign !== campaignFor(p, name)) stateFail('The goal/config resource and campaign identities disagree.');
  if (kind === 'conversionGoalCampaignConfigs') {
    if (!['CUSTOMER', 'CAMPAIGN'].includes(row.goalConfigLevel))
      stateFail('The campaign goal configuration level is unknown.');
    if (row.customConversionGoal) rn(p, row.customConversionGoal, 'customConversionGoals');
    out.customConversionGoal ??= '';
  }
  if (kind === 'customConversionGoals') {
    if (row.id !== name.split('/').at(-1) || !text(row.name) || !['ENABLED', 'REMOVED'].includes(row.status))
      stateFail('The custom goal identity, name or status is incomplete.');
    if (!Array.isArray(row.conversionActions) && row.conversionActions !== undefined)
      stateFail('Custom-goal members must be a native array.');
    const a = row.conversionActions ?? [];
    if (a.length > 100 || new Set(a).size !== a.length)
      stateFail('The custom-goal membership is duplicate or exceeds this contract.');
    for (const n of a) rn(p, n, 'conversionActions');
    out.conversionActions = [...a].sort();
  }
  return out;
}
const pair = (g: JsonObject) => g.category + '/' + g.origin;
const configName = (p: CompiledRequest, campaign: string) =>
  'customers/' + account(p) + '/conversionGoalCampaignConfigs/' + campaign.split('/').at(-1);
function projection(kind: Kind, row: JsonObject) {
  const out = {...row};
  if (kind === 'customConversionGoals') delete out.id;
  if (kind === 'conversionGoalCampaignConfigs' && out.goalConfigLevel === 'CUSTOMER') out.customConversionGoal = '';
  return out;
}
export async function readGoogleConversionGraph(p: CompiledRequest, send: Send, actionManagement = false) {
  const fetch = reader(p, send),
    customers = await fetch('customer', customerFields);
  if (
    customers.length !== 1 ||
    customers[0]!.id !== account(p) ||
    !text(customers[0]!.currencyCode, 3) ||
    !text(customers[0]!.timeZone, 128)
  )
    stateFail('The selected customer configuration is incomplete.');
  const customer: JsonObject = {...customers[0], manager: customers[0]!.manager ?? false};
  if (
    customer.manager !== false ||
    customer.conversionTrackingSetting?.googleAdsConversionCustomer !== 'customers/' + account(p)
  )
    fail(
      'Select a client using its own Google Ads conversion customer. Shared manager conversion tracking needs a separately scoped multi-account contract.',
    );
  const collection = async (kind: Kind) => {
    const out: JsonObject = {},
      identities = new Set<string>();
    for (const row of await fetch(
      resources[kind],
      googleConversionGoalFields[kind],
      kind === 'campaignConversionGoals' || kind === 'conversionGoalCampaignConfigs' ? liveCampaigns : '',
    )) {
      const v = goal(p, kind, row),
        id = v.resourceName,
        key =
          kind === 'customerConversionGoals'
            ? pair(v)
            : kind === 'campaignConversionGoals'
              ? v.campaign + '/' + pair(v)
              : id;
      if (Object.hasOwn(out, id) || identities.has(key))
        stateFail('Goal collections contain duplicate or conflicting identities.');
      identities.add(key);
      out[id] = v;
    }
    if (Object.keys(out).length > (kind === 'campaignConversionGoals' ? 10000 : 2000))
      stateFail('Narrow the account: the complete goal collection exceeds its local bound.');
    return out;
  };
  const goals = {} as Record<Kind, JsonObject>;
  for (const k of Object.keys(resources) as Kind[]) goals[k] = await collection(k);
  const campaigns: JsonObject = {},
    budgets: JsonObject = {},
    strategies: JsonObject = {},
    conversionActions: JsonObject = {};
  for (const c of await fetch('campaign', campaignFields, liveCampaigns)) {
    const name = rn(p, c.resourceName, 'campaigns');
    if (
      Object.hasOwn(campaigns, name) ||
      !text(c.name) ||
      !['ENABLED', 'PAUSED'].includes(c.status) ||
      !text(c.advertisingChannelType, 64) ||
      c.advertisingChannelType === 'MULTI_CHANNEL' ||
      !text(c.biddingStrategyType, 64)
    )
      stateFail('A campaign is duplicate, ineligible or incompletely described.');
    rn(p, c.campaignBudget, 'campaignBudgets');
    if (c.biddingStrategy) rn(p, c.biddingStrategy, 'biddingStrategies');
    campaigns[name] = c;
  }
  if (Object.keys(campaigns).length > 2000) stateFail('At most 2000 current non-App campaigns can be reviewed.');
  const names = [...new Set(Object.values(campaigns).map((c: any) => c.campaignBudget))].sort();
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100);
    for (const b of await fetch(
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
      'campaign_budget.resource_name IN (' + batch.map(n => "'" + n + "'").join(', ') + ')',
    )) {
      if (
        !batch.includes(b.resourceName) ||
        Object.hasOwn(budgets, b.resourceName) ||
        b.status !== 'ENABLED' ||
        !text(b.name) ||
        ![b.amountMicros, b.totalAmountMicros].some(v => typeof v === 'string' && /^\d+$/.test(v))
      )
        stateFail('The native budget amount or identity is incomplete.');
      budgets[b.resourceName] = b;
    }
  }
  if (Object.keys(budgets).length !== names.length) stateFail('A campaign budget was omitted.');
  const portfolio = [
    ...new Set(
      Object.values(campaigns)
        .map((c: any) => c.biddingStrategy)
        .filter(Boolean),
    ),
  ].sort();
  for (let i = 0; i < portfolio.length; i += 100) {
    const batch = portfolio.slice(i, i + 100);
    for (const s of await fetch(
      'bidding_strategy',
      strategyFields,
      'bidding_strategy.resource_name IN (' + batch.map(n => "'" + n + "'").join(', ') + ')',
    )) {
      if (
        !batch.includes(s.resourceName) ||
        Object.hasOwn(strategies, s.resourceName) ||
        s.status !== 'ENABLED' ||
        !text(s.name) ||
        !text(s.type, 64)
      )
        stateFail('The local portfolio bid strategy is incomplete.');
      strategies[s.resourceName] = s;
    }
  }
  if (Object.keys(strategies).length !== portfolio.length) stateFail('A portfolio strategy was omitted.');
  for (const c of Object.values(campaigns) as JsonObject[])
    if (c.biddingStrategy && strategies[c.biddingStrategy].type !== c.biddingStrategyType)
      stateFail('Campaign and portfolio bidding types disagree.');
  const conversionFields = actionManagement
      ? [...actionFields, 'id', 'phone_call_duration_seconds', 'app_id']
      : actionFields,
    conversionWhere = actionManagement
      ? "conversion_action.status IN ('ENABLED', 'HIDDEN', 'REMOVED')"
      : "conversion_action.status != 'REMOVED'";
  const collectActions = async () => {
    const found: JsonObject = {};
    for (const a of await fetch('conversion_action', conversionFields, conversionWhere)) {
      const name = rn(p, a.resourceName, 'conversionActions');
      if (
        Object.hasOwn(found, name) ||
        !text(a.name) ||
        !(actionManagement ? ['ENABLED', 'HIDDEN', 'REMOVED'] : ['ENABLED', 'HIDDEN']).includes(a.status) ||
        (a.ownerCustomer != null &&
          (typeof a.ownerCustomer !== 'string' || !/^customers\/[1-9][0-9]*$/.test(a.ownerCustomer))) ||
        !text(a.type, 64) ||
        !text(a.category, 64) ||
        !text(a.origin, 64) ||
        [a.type, a.category, a.origin].some(v => ['UNKNOWN', 'UNSPECIFIED'].includes(v)) ||
        (a.primaryForGoal !== undefined && typeof a.primaryForGoal !== 'boolean')
      )
        stateFail('Conversion-action identity, owner or configuration is incomplete.');
      found[name] = actionManagement ? {...a} : {...a, primaryForGoal: a.primaryForGoal ?? false};
    }
    if (Object.keys(found).length > 2000)
      stateFail('At most 2000 conversion actions including retained removed definitions can be reviewed.');
    return found;
  };
  Object.assign(conversionActions, await collectActions());
  if (actionManagement) {
    // App campaigns use selective_optimization instead of this goal graph.
    if (
      (
        await fetch(
          'campaign',
          ['resource_name'],
          "campaign.status != 'REMOVED' AND campaign.advertising_channel_type = 'MULTI_CHANNEL'",
        )
      ).length
    )
      fail(
        'Conversion-action changes in accounts with current App campaigns need a selective-optimization dependency contract.',
      );
    if (stable(conversionActions) !== stable(await collectActions()))
      stateFail('Conversion definitions changed during discovery.');
  }
  for (const g of Object.values(goals.campaignConversionGoals) as JsonObject[])
    if (!campaigns[g.campaign]) stateFail('A campaign goal is outside the complete campaign collection.');
  for (const c of Object.values(goals.conversionGoalCampaignConfigs) as JsonObject[])
    if (
      !campaigns[c.campaign] ||
      (c.goalConfigLevel === 'CAMPAIGN' &&
        c.customConversionGoal &&
        (!goals.customConversionGoals[c.customConversionGoal] ||
          goals.customConversionGoals[c.customConversionGoal].status !== 'ENABLED'))
    )
      stateFail('A campaign config references a missing parent or active custom goal.');
  for (const c of Object.keys(campaigns))
    if (!goals.conversionGoalCampaignConfigs[configName(p, c)])
      stateFail('A current campaign goal configuration is missing.');
  // Check the dependency graph again after the reads. There is no provider-side
  // multi-resource transaction; execution will also reread this entire snapshot.
  for (const k of Object.keys(resources) as Kind[])
    if (stable(goals[k]) !== stable(await collection(k))) stateFail('Goal configuration changed during discovery.');
  if (stable(customers) !== stable(await fetch('customer', customerFields)))
    stateFail('The conversion customer changed during discovery.');
  return {customer, goals, campaigns, budgets, strategies, conversionActions};
}
function desired(p: CompiledRequest, before: JsonObject, receipts?: JsonObject[]) {
  const kind = googleConversionGoalKind(p)!,
    goals = structuredClone(before.goals) as Record<Kind, JsonObject>,
    ops = googleJson(p.body).operations as JsonObject[],
    touched = new Set<string>();
  const need = (collection: Kind, name: string) => {
    const row = goals[collection][name];
    if (!row) stateFail('The exact goal or campaign configuration is missing.');
    return row;
  };
  const setCampaignLevel = (campaign: string, level: string) => {
    const c = need('conversionGoalCampaignConfigs', configName(p, campaign));
    c.goalConfigLevel = level;
    touched.add('conversionGoalCampaignConfigs|' + c.resourceName);
    if (level === 'CUSTOMER') {
      for (const source of Object.values(goals.customerConversionGoals) as JsonObject[])
        if (
          !Object.values(goals.campaignConversionGoals).some(
            (g: any) => g.campaign === campaign && pair(g) === pair(source),
          )
        )
          stateFail('A campaign goal needed for account-default inheritance is missing.');
      for (const g of Object.values(goals.campaignConversionGoals) as JsonObject[])
        if (g.campaign === campaign) {
          const source = Object.values(goals.customerConversionGoals).find((v: any) => pair(v) === pair(g)) as
            JsonObject | undefined;
          if (!source) stateFail('The account default for a campaign goal is missing.');
          g.biddable = source!.biddable;
          touched.add('campaignConversionGoals|' + g.resourceName);
        }
    }
  };
  for (const [i, op] of ops.entries()) {
    const name = op.remove ?? op.update?.resourceName ?? receipts?.[i]?.resourceName ?? 'new:' + i,
      old = op.create ? undefined : need(kind, name);
    if (old?.status === 'REMOVED') stateFail('The selected custom goal is removed.');
    if (kind === 'customConversionGoals') {
      if (op.remove) {
        if (
          Object.values(goals.conversionGoalCampaignConfigs).some(
            (c: any) => c.goalConfigLevel === 'CAMPAIGN' && c.customConversionGoal === name,
          )
        )
          fail('Detach this custom goal from every current campaign in separate reviewed changes before deleting it.');
        goals[kind][name] = {...old, status: 'REMOVED'};
      } else {
        const value = {...old, ...(op.create ?? op.update), resourceName: name, status: 'ENABLED'};
        if (
          Object.values(goals[kind]).some(
            (g: any) => g.status === 'ENABLED' && g.name === value.name && g.resourceName !== name,
          )
        )
          fail('Use a unique active custom-goal name.');
        actions(p, value.conversionActions);
        value.conversionActions = [...value.conversionActions].sort();
        for (const n of value.conversionActions)
          if (
            before.conversionActions[n]?.status !== 'ENABLED' ||
            before.conversionActions[n]?.ownerCustomer !== 'customers/' + account(p)
          )
            fail('Every selected custom-goal action must be currently enabled and owned by this conversion customer.');
        goals[kind][name] = value;
      }
    } else if (kind === 'customerConversionGoals') {
      const value = (goals[kind][name] = {...old, ...op.update});
      for (const c of Object.values(goals.conversionGoalCampaignConfigs) as JsonObject[])
        if (
          c.goalConfigLevel === 'CUSTOMER' &&
          !Object.values(goals.campaignConversionGoals).some(
            (g: any) => g.campaign === c.campaign && pair(g) === pair(value),
          )
        )
          stateFail('A customer-default campaign is missing the goal required for propagation.');
      for (const g of Object.values(goals.campaignConversionGoals) as JsonObject[])
        if (
          pair(g) === pair(value) &&
          need('conversionGoalCampaignConfigs', configName(p, g.campaign)).goalConfigLevel === 'CUSTOMER'
        ) {
          g.biddable = value.biddable;
          touched.add('campaignConversionGoals|' + g.resourceName);
        }
    } else if (kind === 'campaignConversionGoals') {
      goals[kind][name] = {...old, ...op.update};
      setCampaignLevel(old!.campaign, 'CAMPAIGN');
    } else {
      const next = (goals[kind][name] = {...old, ...op.update});
      const level = op.update.goalConfigLevel ?? (op.update.customConversionGoal ? 'CAMPAIGN' : old!.goalConfigLevel);
      if (
        level === 'CAMPAIGN' &&
        next.customConversionGoal &&
        (!goals.customConversionGoals[next.customConversionGoal] ||
          goals.customConversionGoals[next.customConversionGoal].status !== 'ENABLED')
      )
        fail('Select an enabled custom goal from this conversion customer.');
      setCampaignLevel(old!.campaign, level);
    }
    touched.add(kind + '|' + name);
  }
  if (Object.keys(goals.customConversionGoals).length > 2000)
    fail('Creation would exceed complete custom-goal read-back capacity.');
  return {goals, touched};
}
export async function readGoogleConversionGoalState(p: CompiledRequest, send: Send): Promise<unknown[]> {
  const state = await readGoogleConversionGraph(p, send);
  desired(p, state);
  return [state];
}
export function googleConversionGoalOutcome(p: CompiledRequest, result: TransportResult, before: unknown[]) {
  const kind = googleConversionGoalKind(p)!,
    ops = googleJson(p.body).operations,
    d = result.data;
  if (
    result.status !== 200 ||
    !object(d) ||
    Object.keys(d).some(k => k !== 'results') ||
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
        (op.create && Object.hasOwn((before[0] as JsonObject).goals[kind], name)) ||
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
export async function verifyGoogleConversionGoal(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
  send: Send,
) {
  const actual = await readGoogleConversionGraph(p, send),
    {goals, touched} = desired(p, before[0] as JsonObject, result.data.results),
    checks: JsonObject[] = [];
  for (const key of touched) {
    const [collection, name] = key.split('|') as [Kind, string],
      expected = goals[collection][name],
      observed = actual.goals[collection][name];
    let e: JsonObject, a: JsonObject;
    if (expected.status === 'REMOVED') {
      e = {removed: true};
      a = {removed: !observed || observed.status === 'REMOVED'};
    } else {
      e = projection(collection, expected);
      a = observed ? projection(collection, observed) : {};
    }
    const changed = [...new Set([...Object.keys(e), ...Object.keys(a)])].filter(k => stable(e[k]) !== stable(a[k]));
    checks.push({
      resource_id: name,
      status: changed.length ? 'inconclusive' : 'verified',
      verification_scope: 'conversion_goal_configuration_and_inheritance',
      changed_fields: changed,
      expected_hash: sha256(stable(e)),
      actual_hash: sha256(stable(a)),
    });
  }
  return {status: checks.every(c => c.status === 'verified') ? 'verified' : 'inconclusive', checks};
}
export const googleConversionGoalImpact = {
  provider: 'google_ads',
  scope: 'conversion_goals',
  may_affect_serving: true,
  effect:
    'Changes bidding objectives and potentially conversion reporting. Account defaults propagate to current and future campaigns using CUSTOMER-level goals. Editing a campaign goal or attaching a custom goal switches that campaign to CAMPAIGN-level configuration. A custom goal adds its actions even when primaryForGoal is false; it does not automatically disable other standard goals.',
  units:
    'No monetary budget is changed. Goal membership and biddability are business decisions, never inferred from names or recommended without user-provided objectives.',
  limits:
    'Client accounts using their own conversion customer; current non-App campaigns only. Manager-shared conversion tracking requires a separate multi-account contract. Complete scoped goal graph is frozen; unrelated goal edits may require a fresh review.',
  verification:
    'Checks saved goals and documented inheritance/config-level side effects. CUSTOMER level makes a retained custom-goal reference inactive. It does not prove tracking implementation, historical reporting recalculation, bid learning or performance.',
  recovery:
    'Retain the original review and idempotency key after partial or lost responses. Read back before preparing a correction. Delete only after separately detaching a custom goal from its current campaigns.',
};
