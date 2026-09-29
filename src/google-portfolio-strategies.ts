import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import {sha256, stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {googleAdsCustomers} from './google-version.js';

type Send = (plan: CompiledRequest) => Promise<TransportResult>;
const schemes: Record<string, string[]> = {
  targetCpa: ['targetCpaMicros', 'cpcBidCeilingMicros', 'cpcBidFloorMicros'],
  targetRoas: ['targetRoas', 'cpcBidCeilingMicros', 'cpcBidFloorMicros', 'targetRoasTolerancePercentMillis'],
  maximizeConversions: ['targetCpaMicros', 'cpcBidCeilingMicros', 'cpcBidFloorMicros'],
  maximizeConversionValue: [
    'targetRoas',
    'cpcBidCeilingMicros',
    'cpcBidFloorMicros',
    'targetRoasTolerancePercentMillis',
  ],
  targetImpressionShare: ['location', 'locationFractionMicros', 'cpcBidCeilingMicros'],
  targetSpend: ['cpcBidCeilingMicros'],
};
const snake = (s: string) => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const typeOf = (scheme: string) => snake(scheme).toUpperCase();
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (message: string, code = 'INVALID_PORTFOLIO_STRATEGY'): never => {
  throw new MirrorError(code, message);
};
const incomplete = (message: string): never => fail(message, 'PORTFOLIO_STATE_UNVERIFIED');
const only = (row: JsonObject, fields: string[]) => {
  if (Object.keys(row).some(k => !fields.includes(k)))
    fail('An output-only, retired or unqualified portfolio field was supplied.');
};
function nativeInt(value: unknown, positive = false): string {
  if (!(
    (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  ))
    fail('Native monetary values and counts require an exact nonnegative int64, preferably a decimal string.');
  const n = BigInt(value as string | number);
  if (n > 9223372036854775807n || (positive && n === 0n)) fail('Native value is outside its positive int64 range.');
  return String(n);
}
function name(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    !value ||
    Buffer.byteLength(value, 'utf8') > 255 ||
    /[\u0000-\u001f\ud800-\udfff]/u.test(value)
  )
    fail('Use an already-trimmed portfolio name of 1–255 UTF-8 bytes.');
  return value as string;
}
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) fail('Select an exact Google Ads client customer.');
  return id!;
};
function resource(p: CompiledRequest, value: unknown, collection = 'biddingStrategies'): string {
  if (
    typeof value !== 'string' ||
    !new RegExp('^customers/' + account(p) + '/' + collection + '/[1-9][0-9]*$').test(value)
  )
    fail('The ' + collection + ' resource must belong to the selected client customer.');
  return value as string;
}
export function googlePortfolioKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'google_ads_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    /^\/v\d+\/customers\/\d+\/biddingStrategies:mutate$/.test(p.path)
  );
}
function values(scheme: string, input: JsonObject, complete: boolean): JsonObject {
  only(input, schemes[scheme]!);
  const out: JsonObject = {};
  for (const [field, value] of Object.entries(input)) {
    if (field === 'location') {
      if (!['ANYWHERE_ON_PAGE', 'TOP_OF_PAGE', 'ABSOLUTE_TOP_OF_PAGE'].includes(value))
        fail('Choose a documented target impression-share location.');
      out[field] = value;
    } else if (field === 'targetRoas') {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < (scheme === 'targetRoas' ? 0.01 : 0) ||
        value > 1000
      )
        fail('ROAS is a ratio, from 0.01 to 1000; only optional maximize-value targets may be cleared with 0.');
      out[field] = value;
    } else
      out[field] = nativeInt(
        value,
        (field === 'targetCpaMicros' && scheme === 'targetCpa') || scheme === 'targetImpressionShare',
      );
  }
  if (out.locationFractionMicros !== undefined && BigInt(out.locationFractionMicros) > 1000000n)
    fail('Impression share is 1–1,000,000 micros; 500,000 means 50%.');
  // A deliberate local bound, not an inference of a provider-approved tolerance.
  if (out.targetRoasTolerancePercentMillis !== undefined && BigInt(out.targetRoasTolerancePercentMillis) > 100000n)
    fail(
      'Review supports ROAS tolerance from 0 to 100,000 percent-millis (0–100%). Provider eligibility remains required.',
    );
  if (complete) {
    if (
      (scheme === 'targetCpa' && out.targetCpaMicros === undefined) ||
      (scheme === 'targetRoas' && out.targetRoas === undefined) ||
      (scheme === 'targetImpressionShare' &&
        ['location', 'locationFractionMicros', 'cpcBidCeilingMicros'].some(f => out[f] === undefined))
    )
      fail('The selected strategy needs its complete native target and required ceiling.');
    for (const field of schemes[scheme]!) if (out[field] === undefined) out[field] = field === 'targetRoas' ? 0 : '0';
    if (
      BigInt(out.cpcBidCeilingMicros ?? '0') > 0n &&
      BigInt(out.cpcBidFloorMicros ?? '0') > BigInt(out.cpcBidCeilingMicros)
    )
      fail('The CPC floor cannot exceed a nonzero CPC ceiling.');
  }
  return out;
}
function shape(row: JsonObject, creating: boolean) {
  only(row, ['name', ...Object.keys(schemes), ...(creating ? [] : ['resourceName'])]);
  if (row.name !== undefined) name(row.name);
  const selected = Object.keys(schemes).filter(s => row[s] !== undefined);
  if (selected.length > 1 || (creating && selected.length !== 1))
    fail('Select exactly one portfolio scheme on creation; its type cannot change on update.');
  if (creating && row.name === undefined) fail('A new portfolio needs a unique name.');
  for (const scheme of selected) {
    if (!object(row[scheme])) fail('Use a native bidding-scheme object.');
    values(scheme, row[scheme], creating);
  }
}
export function assertGooglePortfolio(p: CompiledRequest) {
  if (!googlePortfolioKind(p)) return;
  const body = googleJson(p.body);
  only(body, ['operations', 'partialFailure', 'validateOnly', 'responseContentType']);
  if (Object.keys(p.query).length || Object.keys(p.headers).length || p.path.split('/')[3] !== account(p))
    fail('Use the selected client account without header/query overrides.');
  if (
    !Array.isArray(body.operations) ||
    !body.operations.length ||
    body.operations.length > 25 ||
    body.partialFailure === true ||
    body.validateOnly === true ||
    (body.responseContentType !== undefined && body.responseContentType !== 'RESOURCE_NAME_ONLY')
  )
    fail('Review 1–25 atomic operations with resource-name receipts.');
  const seen = new Set<string>();
  for (const op of body.operations) {
    if (!object(op)) fail('Use native operation objects.');
    only(op, ['create', 'update', 'remove', 'updateMask']);
    if (['create', 'update', 'remove'].filter(k => op[k] !== undefined).length !== 1)
      fail('Use exactly one create, update or remove per operation.');
    let target: string;
    if (op.create !== undefined || op.update !== undefined) {
      const row = op.create ?? op.update;
      if (!object(row)) fail('Create/update must contain an object.');
      shape(row, !!op.create);
      target = op.create ? 'name:' + row.name : resource(p, row.resourceName);
      if (op.update) {
        if (typeof op.updateMask !== 'string' || !op.updateMask) fail('Updates require an explicit leaf field mask.');
        const expected = Object.keys(row)
            .filter(k => k !== 'resourceName')
            .flatMap(k => (schemes[k] ? Object.keys(row[k]).map(f => k + '.' + f) : [k])),
          mask = op.updateMask.split(',');
        if (
          !expected.length ||
          new Set(mask).size !== mask.length ||
          stable([...mask].sort()) !== stable(expected.sort())
        )
          fail(
            'The mask must cover exactly the supplied mutable leaves. Whole-scheme masks, wildcards and implicit clearing are not supported; use explicit zero only for optional fields.',
          );
      }
    } else target = resource(p, op.remove);
    if (!op.update && op.updateMask !== undefined) fail('Only updates accept an update mask.');
    if (seen.has(target)) fail('A target or new portfolio name may appear only once per review.');
    seen.add(target);
  }
}
export const googlePortfolioFields = [
  'resource_name',
  'id',
  'name',
  'status',
  'type',
  'currency_code',
  'effective_currency_code',
  'aligned_campaign_budget_id',
  'campaign_count',
  'non_removed_campaign_count',
  ...Object.entries(schemes).flatMap(([s, fields]) => fields.map(f => snake(s) + '.' + snake(f))),
];
const campaignFields = [
  'resource_name',
  'name',
  'status',
  'advertising_channel_type',
  'bidding_strategy_type',
  'bidding_strategy',
  'campaign_budget',
  'start_date',
  'end_date',
];
const budgetFields = [
  'resource_name',
  'name',
  'status',
  'amount_micros',
  'total_amount_micros',
  'explicitly_shared',
  'delivery_method',
  'period',
];
function read(p: CompiledRequest, query: string): CompiledRequest {
  return {
    ...p,
    action: 'AMCP_PORTFOLIO_READ',
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
// Do not sort on RESOURCE_NAME: the v23 field reference marks it non-sortable.
// Follow provider page tokens and compare identity-keyed projections instead.
const query = (entity: string, fields: string[], where = '') =>
  'SELECT ' +
  fields.map(f => entity + '.' + f).join(', ') +
  ' FROM ' +
  entity +
  (where ? ' WHERE ' + where : '') +
  (entity === 'customer' ? ' LIMIT 1' : '');
const inNames = (field: string, names: string[]) => field + ' IN (' + names.map(n => "'" + n + "'").join(', ') + ')';
function project(row: JsonObject, fields: string[]): JsonObject {
  const out: JsonObject = {};
  for (const field of fields) {
    const parts = field.split('.').map(camel);
    let src: any = row,
      dst = out;
    for (const [i, part] of parts.entries()) {
      if (!object(src) || src[part] === undefined) break;
      if (i === parts.length - 1) dst[part] = src[part];
      else {
        dst[part] ??= {};
        dst = dst[part];
        src = src[part];
      }
    }
  }
  return out;
}
function reader(p: CompiledRequest, send: Send) {
  let requests = 0,
    bytes = 0,
    rows = 0;
  const started = performance.now();
  const fetch = async (entity: string, fields: string[], where = '') => {
    const out: JsonObject[] = [],
      tokens = new Set<string>();
    let token: string | undefined, total: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 25 || ++requests > 128 || performance.now() - started > 60000)
        incomplete('Complete portfolio state exceeded its page/request/deadline bound.');
      const plan = read(p, query(entity, fields, where));
      if (token) (plan.body as JsonObject).pageToken = token;
      const response = await send(plan),
        data = response.data;
      if (
        response.status !== 200 ||
        !object(data) ||
        Object.keys(data).some(
          k =>
            ![
              'results',
              'fieldMask',
              'queryResourceConsumption',
              'nextPageToken',
              'totalResultsCount',
              'requestId',
            ].includes(k),
        ) ||
        (data.results !== undefined && !Array.isArray(data.results)) ||
        (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string')
      )
        incomplete('Google returned a failed, partial or unrecognized portfolio response.');
      const d = data as JsonObject,
        size = Buffer.byteLength(JSON.stringify(d));
      bytes += size;
      if (size > 4 * 1024 * 1024 || bytes > 8 * 1024 * 1024 || performance.now() - started > 60000)
        incomplete('Portfolio responses exceeded their byte/deadline bound.');
      if (d.totalResultsCount !== undefined) {
        const count = nativeInt(d.totalResultsCount);
        if (total !== undefined && total !== count) incomplete('Collection counts changed between pages.');
        total = count;
      }
      const pageRows = d.results ?? [];
      rows += pageRows.length;
      if (rows > 20000) incomplete('Portfolio state exceeded 20000 rows across both consistency reads.');
      for (const v of pageRows) {
        if (!object(v) || Object.keys(v).length !== 1 || !object(v[camel(entity)]))
          incomplete('Google returned an incomplete or unexpected resource row.');
        out.push(project(v[camel(entity)], fields));
      }
      if (!d.nextPageToken) break;
      if (d.nextPageToken.length > 4096 || tokens.has(d.nextPageToken) || !pageRows.length)
        incomplete('Google returned incomplete or repeated pagination.');
      tokens.add(d.nextPageToken);
      token = d.nextPageToken;
    }
    if (total !== undefined && BigInt(total) !== BigInt(out.length))
      incomplete('The native result count proves an incomplete collection.');
    return out;
  };
  const exact = async (entity: string, fields: string[], names: string[]) => {
    const out: JsonObject = {};
    for (let i = 0; i < names.length; i += 100) {
      const batch = names.slice(i, i + 100);
      for (const row of await fetch(entity, fields, inNames(entity + '.resource_name', batch))) {
        if (!batch.includes(row.resourceName) || Object.hasOwn(out, row.resourceName))
          incomplete('A referenced resource was foreign or duplicated.');
        out[row.resourceName] = row;
      }
    }
    if (Object.keys(out).length !== names.length) incomplete('A referenced resource was omitted.');
    return out;
  };
  const customer = async (): Promise<JsonObject> => {
    const found = await fetch('customer', ['id', 'currency_code', 'time_zone', 'manager']);
    const c = found[0];
    if (
      found.length !== 1 ||
      c?.id !== account(p) ||
      typeof c.currencyCode !== 'string' ||
      !/^[A-Z]{3}$/.test(c.currencyCode) ||
      typeof c.timeZone !== 'string' ||
      !c.timeZone ||
      (c.manager !== undefined && typeof c.manager !== 'boolean')
    )
      incomplete('The selected customer identity/currency/timezone was not verified.');
    if (c!.manager === true)
      fail(
        'Manager-owned and cross-customer portfolios need descendant authority; select a client-owned portfolio.',
        'WRITE_CONTRACT_UNAVAILABLE',
      );
    return {...c, manager: false};
  };
  return {fetch, exact, customer};
}
function strategy(p: CompiledRequest, row: JsonObject, currency: string): JsonObject {
  const scheme = Object.keys(schemes).find(s => typeOf(s) === row.type);
  if (!scheme || Object.keys(schemes).some(s => s !== scheme && row[s] !== undefined))
    fail('The existing portfolio uses an unqualified or inconsistent bidding scheme.', 'WRITE_CONTRACT_UNAVAILABLE');
  if (
    (row.currencyCode && row.currencyCode !== currency) ||
    (row.effectiveCurrencyCode && row.effectiveCurrencyCode !== currency)
  )
    incomplete('Portfolio currency disagrees with the selected client account.');
  if (nativeInt(row.alignedCampaignBudgetId ?? '0') !== '0')
    fail('Aligned campaign budgets require a separate complete alignment contract.', 'WRITE_CONTRACT_UNAVAILABLE');
  const rn = resource(p, row.resourceName);
  if (row.id !== rn.split('/').at(-1) || row.status !== 'ENABLED')
    incomplete('The portfolio identity or enabled status was not verified.');
  return {
    resourceName: rn,
    name: name(row.name),
    status: row.status,
    type: row.type,
    currencyCode: currency,
    [scheme!]: values(scheme!, row[scheme!] ?? {}, true),
  };
}
function desired(p: CompiledRequest, op: JsonObject, old: JsonObject | undefined, currency: string): JsonObject {
  if (op.create) {
    const s = Object.keys(schemes).find(s => op.create[s] !== undefined)!;
    return {
      name: op.create.name,
      status: 'ENABLED',
      type: typeOf(s),
      currencyCode: currency,
      [s]: values(s, op.create[s], true),
    };
  }
  if (!old) incomplete('The exact existing portfolio is missing or removed.');
  if (op.remove) return old!;
  const out = {...old, ...op.update};
  for (const s of Object.keys(schemes))
    if (op.update[s] !== undefined) {
      if (typeOf(s) !== old!.type)
        fail(
          'Portfolio bidding type is immutable. Create a new portfolio and separately review campaign reassignment.',
        );
      out[s] = values(s, {...old![s], ...op.update[s]}, true);
    }
  return out;
}
async function snapshot(p: CompiledRequest, r: ReturnType<typeof reader>) {
  const customer = await r.customer(),
    ops = googleJson(p.body).operations as JsonObject[],
    targets = ops.filter(o => !o.create).map(o => o.remove ?? o.update.resourceName),
    inventory: JsonObject = {},
    strategies: JsonObject = {},
    counts: JsonObject = {};
  const all = await r.fetch('bidding_strategy', googlePortfolioFields, "bidding_strategy.status = 'ENABLED'");
  if (all.length + ops.filter(o => o.create).length > 1000)
    incomplete('Review is bounded to 1000 current portfolio strategies.');
  for (const row of all) {
    const rn = resource(p, row.resourceName);
    if (Object.hasOwn(inventory, rn) || row.status !== 'ENABLED' || row.id !== rn.split('/').at(-1))
      incomplete('Portfolio discovery returned duplicate, foreign or incomplete identities.');
    inventory[rn] = {name: name(row.name)};
    if (targets.includes(rn)) {
      strategies[rn] = strategy(p, row, customer.currencyCode);
      counts[rn] = {all: nativeInt(row.campaignCount ?? '0'), current: nativeInt(row.nonRemovedCampaignCount ?? '0')};
    }
  }
  const newNames = new Set<string>();
  for (const op of ops) {
    const target = op.remove ?? op.update?.resourceName,
      after = desired(p, op, strategies[target], customer.currencyCode);
    if (op.remove) continue;
    if (
      newNames.has(after.name) ||
      Object.entries(inventory).some(([rn, v]) => rn !== target && (v as JsonObject).name === after.name)
    )
      fail('Portfolio names must remain unique in this customer, including within the batch.');
    newNames.add(after.name);
  }
  const campaigns: JsonObject = {},
    budgets: JsonObject = {},
    budgetSharingCampaigns: JsonObject = {};
  if (targets.length) {
    for (const row of await r.fetch(
      'campaign',
      campaignFields,
      inNames('campaign.bidding_strategy', targets) + " AND campaign.status IN ('ENABLED', 'PAUSED')",
    )) {
      const rn = resource(p, row.resourceName, 'campaigns');
      if (
        Object.hasOwn(campaigns, rn) ||
        !targets.includes(row.biddingStrategy) ||
        !['ENABLED', 'PAUSED'].includes(row.status) ||
        row.biddingStrategyType !== strategies[row.biddingStrategy]?.type ||
        typeof row.name !== 'string' ||
        !row.name ||
        typeof row.advertisingChannelType !== 'string' ||
        !row.advertisingChannelType
      )
        incomplete('Affected campaigns have incomplete or inconsistent portfolio bindings.');
      resource(p, row.campaignBudget, 'campaignBudgets');
      campaigns[rn] = row;
    }
  }
  for (const target of targets) {
    const count = Object.values(campaigns).filter((c: any) => c.biddingStrategy === target).length;
    if (BigInt(counts[target].current) !== BigInt(count) || BigInt(counts[target].all) < BigInt(count))
      incomplete('Portfolio campaign counts do not match complete client membership.');
    if (ops.some(o => o.remove === target) && BigInt(counts[target].all) > 0n)
      fail(
        'Only entirely unassociated portfolios can be removed. Separately review campaign reassignment first; historical associations need provider-specific removal qualification.',
      );
  }
  const budgetNames = [...new Set((Object.values(campaigns) as JsonObject[]).map(c => c.campaignBudget))].sort();
  Object.assign(budgets, await r.exact('campaign_budget', budgetFields, budgetNames));
  for (const b of Object.values(budgets) as JsonObject[]) {
    if (
      b.status !== 'ENABLED' ||
      typeof b.name !== 'string' ||
      !b.name ||
      (b.amountMicros === undefined && b.totalAmountMicros === undefined)
    )
      incomplete('An affected native budget was not verified.');
    if (b.amountMicros !== undefined) b.amountMicros = nativeInt(b.amountMicros);
    if (b.totalAmountMicros !== undefined) b.totalAmountMicros = nativeInt(b.totalAmountMicros);
    b.explicitlyShared ??= false;
  }
  for (let i = 0; i < budgetNames.length; i += 100) {
    const batch = budgetNames.slice(i, i + 100);
    for (const row of await r.fetch(
      'campaign',
      campaignFields,
      inNames('campaign.campaign_budget', batch) + " AND campaign.status IN ('ENABLED', 'PAUSED')",
    )) {
      const rn = resource(p, row.resourceName, 'campaigns');
      if (
        Object.hasOwn(budgetSharingCampaigns, rn) ||
        !batch.includes(row.campaignBudget) ||
        !['ENABLED', 'PAUSED'].includes(row.status)
      )
        incomplete('Shared-budget campaign membership was incomplete or foreign.');
      budgetSharingCampaigns[rn] = row;
    }
  }
  for (const [rn, c] of Object.entries(campaigns))
    if (stable(c) !== stable(budgetSharingCampaigns[rn]))
      incomplete('Campaign and budget membership changed during discovery.');
  // Only name-affecting operations depend on unrelated inventory names. Updates
  // never hash an unrelated portfolio's mutable targets or provider telemetry.
  const namesNeeded = ops.some(o => o.create || o.update?.name !== undefined);
  return {
    customer,
    strategies,
    campaigns,
    budgets,
    budgetSharingCampaigns,
    ...(namesNeeded ? {portfolioNames: inventory} : {}),
  };
}
export function googlePortfolioSnapshots(p: CompiledRequest) {
  return [
    read(p, query('customer', ['id', 'currency_code', 'time_zone', 'manager'])),
    read(p, query('bidding_strategy', googlePortfolioFields, "bidding_strategy.status = 'ENABLED'")),
  ];
}
export async function readGooglePortfolioState(p: CompiledRequest, send: Send): Promise<unknown[]> {
  const r = reader(p, send),
    before = await snapshot(p, r),
    after = await snapshot(p, r);
  if (stable(before) !== stable(after))
    incomplete('Portfolio configuration or affected membership changed during dependency discovery.');
  return [before];
}
export function googlePortfolioOutcome(p: CompiledRequest, response: TransportResult, before: unknown[]): boolean {
  const d = response.data,
    ops = googleJson(p.body).operations,
    state = before[0] as JsonObject,
    seen = new Set<string>();
  if (
    response.status !== 200 ||
    !object(d) ||
    Object.keys(d).some(k => k !== 'results') ||
    !Array.isArray(d.results) ||
    d.results.length !== ops.length
  )
    return false;
  return d.results.every((row: unknown, i: number) => {
    try {
      if (!object(row) || Object.keys(row).some(k => k !== 'resourceName')) return false;
      const rn = resource(p, row.resourceName),
        op = ops[i];
      if (
        seen.has(rn) ||
        (op.create && Object.hasOwn(state.portfolioNames ?? {}, rn)) ||
        (!op.create && rn !== (op.remove ?? op.update.resourceName))
      )
        return false;
      seen.add(rn);
      return true;
    } catch {
      return false;
    }
  });
}
export async function verifyGooglePortfolio(p: CompiledRequest, result: JsonObject, before: unknown[], send: Send) {
  const r = reader(p, send),
    customer = await r.customer(),
    old = (before[0] as JsonObject).strategies,
    rows = await r.fetch('bidding_strategy', googlePortfolioFields, "bidding_strategy.status = 'ENABLED'"),
    current: JsonObject = {},
    checks: JsonObject[] = [];
  for (const row of rows) {
    const rn = resource(p, row.resourceName);
    if (Object.hasOwn(current, rn) || row.status !== 'ENABLED' || row.id !== rn.split('/').at(-1))
      incomplete('Read-back returned incomplete, foreign or duplicate portfolio identities.');
    current[rn] = row;
  }
  for (const [i, op] of googleJson(p.body).operations.entries()) {
    const rn = resource(p, result.data.results[i].resourceName),
      expected: JsonObject = op.remove
        ? {removed: true}
        : {...desired(p, op, old[rn], customer.currencyCode), resourceName: rn},
      actual: JsonObject = op.remove
        ? {removed: !current[rn]}
        : current[rn]
          ? strategy(p, current[rn], customer.currencyCode)
          : {};
    const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(
      k => stable(expected[k]) !== stable(actual[k]),
    );
    checks.push({
      resource_id: rn,
      status: changed.length ? 'inconclusive' : 'verified',
      verification_scope: 'saved_portfolio_configuration',
      changed_fields: changed,
      expected_hash: sha256(stable(expected)),
      actual_hash: sha256(stable(actual)),
    });
  }
  return {status: checks.every(c => c.status === 'verified') ? 'verified' : 'inconclusive', checks};
}
export function googlePortfolioServing(p: CompiledRequest): boolean {
  return (
    googlePortfolioKind(p) &&
    googleJson(p.body).operations.some(
      (o: JsonObject) => o.update && Object.keys(schemes).some(s => o.update[s] !== undefined),
    )
  );
}
export const googlePortfolioImpact = {
  provider: 'google_ads',
  scope: 'client_owned_portfolio_bidding',
  may_affect_serving: true,
  effect:
    'Changing a portfolio target or CPC limit changes bidding for every associated campaign, including paused campaigns when resumed. A creation is unattached; assignment is a separate reviewed campaign change. No campaign budget changes or performance guarantees are implied.',
  units:
    'CPA and CPC fields are exact micros in the selected account currency, not budgets. ROAS is a ratio: 3 means 300%. Impression share uses millionths; ROAS tolerance uses percent-millis. Explicit zero clears only optional targets/limits.',
  review:
    'Review the customer, complete current campaign membership, budget amounts and other campaigns sharing those budgets. Budget limits remain distinct from bid/CPA values. Bidding changes require spend confirmation and obey the owner activation policy; unassociated removal obeys deletion policy.',
  limits:
    'Client-owned portfolios only; 25 atomic operations, 1000 strategies, 25 pages per collection, 128 reads, 20,000 total rows, 8 MiB and 60 seconds per state read. Manager/cross-customer portfolios, budget alignment, type changes and retired enhanced CPC/target spend fields are not qualified. Provider eligibility and minimum billable units remain provider checks.',
  recovery:
    'Native receipts must match each exact operation. An uncertain or partial outcome retains the original idempotency key; inspect native state before any recovery. Read-back verifies saved configuration, not auction performance.',
};

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googlePortfolioFamily: ReviewedFamily = {
  name: 'google_portfolio_strategies',
  files: ['src/google-portfolio-strategies.ts', ['tests/google-portfolio-strategies.test.ts']],
  kind: googlePortfolioKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertGooglePortfolio(plan);
  },
  scope: c => assertGoogleAdsScope(c),
  snapshots: googlePortfolioSnapshots,
  state: (plan, readers) =>
    readGooglePortfolioState(
      plan,
      readers.guarded(
        'Portfolio prerequisites must remain read-only.',
        readers.sameLogin('The selected login changed during portfolio checks. Prepare again with the current login.'),
      ).read,
    ),
  impact: () => googlePortfolioImpact,
  outcome: googlePortfolioOutcome,
  verify: (plan, v) =>
    verifyGooglePortfolio(
      plan,
      v.result,
      v.state,
      v.guarded('Portfolio verification must remain read-only.', {
        check: assertGoogleAdsScope,
        binding: v.sameLogin('The selected login changed during portfolio verification.'),
      }),
    ).then(o => ({status: o.status, checks: o.checks})),
  spendConfirmation: {
    needed: plan => !!googlePortfolioServing(plan),
    message:
      'Portfolio target and bid-limit changes affect all associated campaigns. Review campaign membership, budgets and native units, then provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  activates: plan => !!googlePortfolioServing(plan),
};
