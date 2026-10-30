import {MirrorError} from './errors.js';
import {validateGooglePausedParents} from './google-paused-parents.js';
import {validateGoogleTargetingState} from './google-targeting-writes.js';
import type {
  Classify,
  PolicyAmounts,
  ReadBuilder,
  ReviewedFamily,
  VerificationRead,
  WriteShape,
} from './reviewed-family.js';
import type {TransportResult} from './transport.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {snake} from './write-common.js';
import {currencyText, minimumUnitMicros} from './budget-units.js';
import {googleRejectionIsNonApplied} from './google-write-rejection.js';
import {
  assertPmaxBuild,
  assertPmaxExistingAssets,
  pmaxExistingAssets,
  pmaxImpact,
  type PmaxOp,
} from './google-pmax-build.js';
import {defineFamily, readOf} from './family-kit.js';

/**
 * All-or-nothing Google builds (the owner's item 5 and decision 1, 2026-09-29): one reviewed `googleAds:mutate` that
 * creates a budget, campaign, criteria, ad groups, keywords and ads together. The pinned v25 contract
 * (GoogleAdsService.Mutate): with partialFailure false, "all operations will be carried out in one transaction if and
 * only if they are all valid"; a resource created with a temporary name (a negative number where the server allocates
 * the ID) can be referenced by later operations of the same request, each temporary number unique.
 *
 * Nothing in a build is reviewed less than the same resources created one service at a time. Each operation is
 * checked as the one-operation request its own service would receive (write-shape.ts, targeting, paused parents),
 * with temporary names standing in as positive IDs for those checks only; the request Google receives is the one
 * reviewed. Existing parents are read at prepare and execute. A new campaign starts PAUSED; its children may start
 * ENABLED under it. Every created resource is read back and compared with what was sent, temporary names replaced by
 * the names Google returned. Only creates of ten resource types are accepted: the six of a Search build, and text assets,
 * asset groups, asset-group asset links and signals of a Performance Max build (google-pmax-build.ts, CMP-07).
 */
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
interface OpType {
  /** The service collection (the one-service path is customers/{id}/{kind}:mutate). */
  kind: string;
  /** The GAQL resource and the result field of MutateOperationResponse. */
  resource: string;
  result: string;
  /** The one-service action this operation is checked as. */
  action: string;
  /** Whether a create may carry a temporary resource_name that later operations reference. */
  temp?: true;
  /** Fields that reference a parent, and the parent's collection. */
  refs: Record<string, string>;
}
const types: Record<string, OpType> = {
  campaign_budget_operation: {
    kind: 'campaignBudgets',
    resource: 'campaign_budget',
    result: 'campaignBudgetResult',
    action: 'campaign_budget_mutate_campaign_budgets',
    temp: true,
    refs: {},
  },
  campaign_operation: {
    kind: 'campaigns',
    resource: 'campaign',
    result: 'campaignResult',
    action: 'campaign_mutate_campaigns',
    temp: true,
    refs: {campaign_budget: 'campaignBudgets'},
  },
  campaign_criterion_operation: {
    kind: 'campaignCriteria',
    resource: 'campaign_criterion',
    result: 'campaignCriterionResult',
    action: 'campaign_criterion_mutate_campaign_criteria',
    refs: {campaign: 'campaigns'},
  },
  ad_group_operation: {
    kind: 'adGroups',
    resource: 'ad_group',
    result: 'adGroupResult',
    action: 'ad_group_mutate_ad_groups',
    temp: true,
    refs: {campaign: 'campaigns'},
  },
  ad_group_criterion_operation: {
    kind: 'adGroupCriteria',
    resource: 'ad_group_criterion',
    result: 'adGroupCriterionResult',
    action: 'ad_group_criterion_mutate_ad_group_criteria',
    refs: {ad_group: 'adGroups'},
  },
  ad_group_ad_operation: {
    kind: 'adGroupAds',
    resource: 'ad_group_ad',
    result: 'adGroupAdResult',
    action: 'ad_group_ad_mutate_ad_group_ads',
    refs: {ad_group: 'adGroups'},
  },
  // Performance Max (CMP-07, google-pmax-build.ts): text assets, an asset group under the build's own PMax campaign,
  // the links to its minimum assets and its signals, all in the one request Google requires for them.
  asset_operation: {
    kind: 'assets',
    resource: 'asset',
    result: 'assetResult',
    action: 'asset_mutate_assets',
    temp: true,
    refs: {},
  },
  asset_group_operation: {
    kind: 'assetGroups',
    resource: 'asset_group',
    result: 'assetGroupResult',
    action: 'asset_group_mutate_asset_groups',
    temp: true,
    refs: {campaign: 'campaigns'},
  },
  asset_group_asset_operation: {
    kind: 'assetGroupAssets',
    resource: 'asset_group_asset',
    result: 'assetGroupAssetResult',
    action: 'asset_group_asset_mutate_asset_group_assets',
    refs: {asset_group: 'assetGroups', asset: 'assets'},
  },
  asset_group_signal_operation: {
    kind: 'assetGroupSignals',
    resource: 'asset_group_signal',
    result: 'assetGroupSignalResult',
    action: 'asset_group_signal_mutate_asset_group_signals',
    refs: {asset_group: 'assetGroups'},
  },
};
const maxOperations = 1000;
const snakeKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(snakeKeys)
    : object(v)
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), snakeKeys(x)]))
      : v;
function invalid(message: string, field: string, extra: JsonObject = {}): never {
  throw new MirrorError('INVALID_GOOGLE_BUILD', message, {field, ...extra});
}
export function googleAtomicKind(plan: CompiledRequest) {
  return (
    plan.gateway === 'google_ads_native_action' &&
    plan.method === 'POST' &&
    /^\/v\d+\/customers\/\d+\/googleAds:mutate$/.test(plan.path)
  );
}
interface Op {
  index: number;
  key: string;
  type: OpType;
  /** The create record, keys in snake_case. */
  create: JsonObject;
  /** Its temporary name, when later operations reference it. */
  temp?: string;
}
/** The build's operations, checked for everything that does not depend on another service's rules. */
function operations(plan: CompiledRequest): Op[] {
  const account = /\/customers\/(\d+)\//.exec(plan.path)![1]!,
    body = snakeKeys(plan.body) as JsonObject;
  if (!object(body)) invalid('Send the build as {mutate_operations: [...]}.', 'payload');
  const unknown = Object.keys(body).filter(k => !['mutate_operations', 'partial_failure'].includes(k));
  if (unknown.length)
    invalid(
      'A build takes mutate_operations and optionally partial_failure: false; ' +
        unknown.join(', ') +
        ' ' +
        (unknown.includes('validate_only') ? '(a validation-only request is a local dry run) ' : '') +
        'is not accepted.',
      unknown[0]!,
      {allowed: ['mutate_operations', 'partial_failure']},
    );
  if (body.partial_failure !== undefined && body.partial_failure !== false)
    invalid('A build is all or nothing: partial_failure must be false or omitted.', 'partial_failure');
  const list = body.mutate_operations;
  if (!Array.isArray(list) || !list.length || list.length > maxOperations)
    invalid(
      'A build has 1–' + maxOperations + ' operations; this one has ' + (Array.isArray(list) ? list.length : 0) + '.',
      'mutate_operations',
    );
  const created = new Map<string, OpType>(),
    numbers = new Set<string>(),
    tempPattern = /^customers\/[^/]+\/[A-Za-z]+\/-\d+$/;
  return list.map((raw: unknown, index: number) => {
    const where = 'mutate_operations[' + index + ']';
    if (!object(raw) || Object.keys(raw).length !== 1 || !types[Object.keys(raw)[0]!])
      invalid(where + ' must be exactly one of ' + Object.keys(types).join(', ') + '.', where, {
        allowed: Object.keys(types),
      });
    const key = Object.keys(raw)[0]!,
      type = types[key]!,
      inner = raw[key];
    if (!object(inner) || Object.keys(inner).join() !== 'create' || !object(inner.create))
      invalid(
        where +
          '.' +
          key +
          ' must be {create: {...}}: a build creates resources, and updates and removals are reviewed on their own.',
        where + '.' + key,
      );
    const create = inner.create as JsonObject,
      name = create.resource_name;
    let temp: string | undefined;
    if (name !== undefined) {
      const m =
        typeof name === 'string'
          ? new RegExp('^customers/' + account + '/' + type.kind + '/-(\\d+)$').exec(name)
          : null;
      if (!type.temp || !m)
        invalid(
          where +
            '.create.resource_name must be a temporary name, customers/' +
            account +
            '/' +
            type.kind +
            '/-N' +
            (type.temp ? '' : ', and only budgets, campaigns, ad groups, assets and asset groups take one') +
            '.',
          where + '.create.resource_name',
        );
      if (numbers.has(m[1]!))
        invalid(
          'Each temporary name needs its own negative number; -' + m[1] + ' is used twice.',
          where + '.create.resource_name',
        );
      numbers.add(m[1]!);
      temp = name as string;
    }
    for (const [field, parentKind] of Object.entries(type.refs)) {
      const ref = create[field];
      if (ref === undefined) continue;
      if (typeof ref === 'string' && tempPattern.test(ref)) {
        if (created.get(ref)?.kind !== parentKind)
          invalid(
            where +
              '.create.' +
              field +
              ' names ' +
              ref +
              ', which no earlier operation of this build creates as one of its ' +
              parentKind +
              '. A temporary name must be created before it is used.',
            where + '.create.' + field,
          );
      } else if (
        typeof ref !== 'string' ||
        !new RegExp('^customers/' + account + '/' + parentKind + '/[1-9][0-9]*$').test(ref)
      )
        invalid(
          where +
            '.create.' +
            field +
            ' must name one of this customer’s ' +
            parentKind +
            ', or a temporary one created earlier in the build.',
          where + '.create.' + field,
        );
    }
    // Any other resource name stays in this customer and is not temporary.
    const text = JSON.stringify({
      ...create,
      resource_name: undefined,
      ...Object.fromEntries(Object.keys(type.refs).map(f => [f, undefined])),
    });
    if (/"customers\/[^"/]+\/[A-Za-z]+\/-\d/.test(text))
      invalid(
        where +
          ': temporary names are accepted only in ' +
          (Object.keys(type.refs).join(', ') || 'resource_name') +
          '.',
        where,
      );
    if ([...text.matchAll(/"customers\/([^"/]+)\//g)].some(m => m[1] !== account))
      invalid(where + ' names a resource of another customer.', where);
    if (temp) created.set(temp, type);
    return {index, key, type, create, temp};
  });
}
/** Temporary names stand in as positive IDs for the one-service checks, which accept existing resources only. */
const standIn = (name: string) => name.replace(/\/-(\d+)$/, (_, n: string) => '/' + (9_000_000_000_000 + Number(n)));
const withStandIns = (v: unknown): unknown =>
  typeof v === 'string' && /^customers\/[^/]+\/[A-Za-z]+\/-\d+$/.test(v)
    ? standIn(v)
    : Array.isArray(v)
      ? v.map(withStandIns)
      : object(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withStandIns(x)]))
        : v;
/** The one-operation request this operation's own service would receive. */
function single(plan: CompiledRequest, op: Op): CompiledRequest {
  const {resource_name: _, ...create} = withStandIns(op.create) as JsonObject;
  return {
    ...plan,
    action: plan.action.replace(/google_ads_mutate$/, op.type.action),
    path: plan.path.replace(/googleAds:mutate$/, op.type.kind + ':mutate'),
    body: {operations: [{create}]},
  };
}
const pmaxOps = (ops: Op[]): PmaxOp[] =>
  ops.map(o => ({index: o.index, kind: o.type.kind, create: o.create, ...(o.temp ? {temp: o.temp} : {})}));
export function assertGoogleAtomicBuild(plan: CompiledRequest, _gateway: () => void, shape: WriteShape) {
  const ops = operations(plan);
  // Performance Max minimums and structure, before any request (CMP-07).
  assertPmaxBuild(pmaxOps(ops));
  for (const op of ops) {
    try {
      shape(single(plan, op));
    } catch (e) {
      // The same refusal, naming the operation it came from.
      if (e instanceof MirrorError)
        throw new MirrorError(e.code, 'mutate_operations[' + op.index + ']: ' + e.message, {
          ...e.details,
          operation: op.index,
        });
      throw e;
    }
  }
}
const search = (classify: Classify, plan: CompiledRequest, query: string): CompiledRequest =>
  classify(
    readOf(plan, {
      action: 'AMCP_STATE_READ',
      method: 'POST',
      path: plan.path.replace(/googleAds:mutate$/, 'googleAds:search'),
      query: {},
      body: {query},
    }),
  );
const parentFields: Record<string, string> = {
  campaignBudgets: 'campaign_budget.resource_name, campaign_budget.amount_micros',
  campaigns: 'campaign.resource_name, campaign.status, campaign.campaign_budget',
  adGroups: 'ad_group.resource_name, ad_group.status, ad_group.campaign, campaign.status',
};
const resourceOf: Record<string, string> = {
  campaignBudgets: 'campaign_budget',
  campaigns: 'campaign',
  adGroups: 'ad_group',
};
/** The customer (currency and time zone), and every existing parent the build names. */
export function googleAtomicSnapshots(
  plan: CompiledRequest,
  _stateRead: ReadBuilder,
  classify: Classify,
): CompiledRequest[] {
  const reads = [
      search(classify, plan, 'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'),
    ],
    seen = new Set<string>(),
    ops = operations(plan);
  for (const op of ops)
    for (const [field, kind] of Object.entries(op.type.refs)) {
      const ref = op.create[field];
      // Existing assets are read together below; an existing asset group is refused before any read.
      if (typeof ref !== 'string' || /\/-\d+$/.test(ref) || seen.has(ref) || !resourceOf[kind]) continue;
      seen.add(ref);
      const resource = resourceOf[kind]!;
      reads.push(
        search(
          classify,
          plan,
          'SELECT ' +
            parentFields[kind] +
            ' FROM ' +
            resource +
            ' WHERE ' +
            resource +
            ".resource_name IN ('" +
            ref +
            "')",
        ),
      );
    }
  // The existing images, logos and videos a Performance Max build links: each must exist with the type its link needs.
  const assets = [...pmaxExistingAssets(pmaxOps(ops)).keys()].sort();
  if (assets.length)
    reads.push(
      search(
        classify,
        plan,
        'SELECT asset.resource_name, asset.type FROM asset WHERE asset.resource_name IN (' +
          assets.map(a => "'" + a + "'").join(', ') +
          ')',
      ),
    );
  return reads;
}
/**
 * The paused-parent and targeting rules of each operation's own service, on the state read for existing parents and
 * on the build's own records for temporary ones: a temporary campaign's status is the one this build sends.
 */
export function googleAtomicPrerequisites(plan: CompiledRequest, state: unknown[]) {
  const ops = operations(plan),
    rows = state.flatMap(s => (object(s) && Array.isArray(s.results) ? s.results : [])).filter(object),
    statusOf = (name: unknown): unknown => {
      const own = ops.find(o => o.temp === name);
      if (own) return own.create.status;
      const row = rows.find(r => object(r.campaign) && (r.campaign.resourceName ?? r.campaign.resource_name) === name);
      return row ? (row.campaign as JsonObject).status : undefined;
    },
    built: JsonObject[] = [];
  for (const op of ops) {
    if (!op.temp) continue;
    if (op.type.kind === 'campaigns')
      built.push({campaign: {resourceName: standIn(op.temp), status: op.create.status}});
    if (op.type.kind === 'adGroups')
      built.push({
        adGroup: {resourceName: standIn(op.temp), status: op.create.status, campaign: withStandIns(op.create.campaign)},
        campaign: {status: statusOf(op.create.campaign)},
      });
  }
  // Budget amounts in the customer's currency precision (WRT-07 Stage A): Google refuses an amount that is not a
  // multiple of the currency's smallest unit (NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT), so prepare refuses it first.
  const customer = rows.map(r => r.customer).find(object) as JsonObject | undefined,
    currency = customer?.currencyCode ?? customer?.currency_code,
    unit = minimumUnitMicros(currency);
  if (unit !== undefined)
    for (const op of ops) {
      if (op.type.kind !== 'campaignBudgets') continue;
      for (const field of ['amount_micros', 'total_amount_micros']) {
        const v = op.create[field];
        if ((typeof v !== 'string' && typeof v !== 'number') || !/^\d{1,19}$/.test(String(v))) continue;
        // One fixed sentence (translated on the website); the details show the amount as "500.5 JPY (500500000 micros)".
        if (BigInt(v) % unit !== 0n)
          throw new MirrorError(
            'BUDGET_PRECISION_INVALID',
            'A budget amount is not a multiple of the smallest unit of the account currency, which Google refuses (NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT). Round it to that unit: JPY and CLP budgets are whole amounts, USD budgets whole cents.',
            {
              operation: op.index,
              field,
              requested: currencyText(BigInt(v), currency as string) + ' ' + currency + ' (' + v + ' micros)',
              currency,
              minimum_unit_micros: String(unit),
              minimum_unit: currencyText(unit, currency as string) + ' ' + currency,
            },
          );
      }
    }
  assertPmaxExistingAssets(pmaxOps(ops), rows);
  const states = [...state, {results: built}];
  for (const op of ops) {
    const one = single(plan, op);
    try {
      validateGooglePausedParents(one, states);
      validateGoogleTargetingState(one, states);
    } catch (e) {
      if (e instanceof MirrorError)
        throw new MirrorError(e.code, 'mutate_operations[' + op.index + ']: ' + e.message, {
          ...e.details,
          operation: op.index,
        });
      throw e;
    }
  }
}
export function googleAtomicImpact(plan: CompiledRequest): JsonObject {
  const ops = operations(plan),
    count: Record<string, number> = {};
  for (const op of ops) count[op.type.resource] = (count[op.type.resource] ?? 0) + 1;
  return {
    build: {
      operations: ops.length,
      created: count,
      all_or_nothing: true,
      budgets: ops
        .filter(o => o.type.kind === 'campaignBudgets')
        .map(o => ({name: o.create.name, amount_micros: o.create.amount_micros ?? null})),
      campaigns: ops
        .filter(o => o.type.kind === 'campaigns')
        .map(o => ({name: o.create.name, status: o.create.status})),
      enabled: ops.filter(o => o.create.status === 'ENABLED').length,
      ...(ops.some(o => o.type.kind === 'assetGroups') ? {asset_groups: pmaxImpact(pmaxOps(ops))} : {}),
    },
    meaning:
      'One request: Google creates every resource or none. Each resource is checked as its own service would check it; children may start ENABLED under the new PAUSED campaign, which stays the one activation.',
  };
}
const responses = (result: JsonObject | TransportResult) => {
  const d = object(result.data) ? result.data : {};
  return Array.isArray(d.mutateOperationResponses) ? (d.mutateOperationResponses as unknown[]) : [];
};
/** Every operation has its result, in order, naming a resource of its type in this customer. */
export function googleAtomicOutcome(plan: CompiledRequest, result: TransportResult): boolean {
  const ops = operations(plan),
    list = responses(result),
    account = plan.accountId;
  return (
    list.length === ops.length &&
    ops.every((op, i) => {
      const r = list[i];
      const name = object(r) && object(r[op.type.result]) ? r[op.type.result].resourceName : undefined;
      return (
        typeof name === 'string' &&
        name.startsWith('customers/' + account + '/' + op.type.kind + '/') &&
        !/\/-\d+$/.test(name)
      );
    })
  );
}
// As the one-service read-back selects them (verification-reads.ts): nested fields by path, an empty message not at all.
const leaves = (value: JsonObject, prefix = ''): string[] =>
  Object.entries(value).flatMap(([k, v]) => (object(v) ? leaves(v, prefix + k + '.') : [prefix + k]));
/** One read per created resource, of the fields sent, with temporary names replaced by the ones Google returned. */
export function googleAtomicVerification(
  plan: CompiledRequest,
  result: JsonObject,
  _before: unknown[],
  _verificationRead: ReadBuilder,
  classify: Classify,
): VerificationRead[] {
  const ops = operations(plan),
    list = responses(result),
    names = new Map<string, string>();
  ops.forEach((op, i) => {
    const r = list[i];
    if (op.temp && object(r) && object(r[op.type.result])) names.set(op.temp, String(r[op.type.result].resourceName));
  });
  const real = (v: unknown): unknown =>
    typeof v === 'string' && names.has(v)
      ? names.get(v)
      : Array.isArray(v)
        ? v.map(real)
        : object(v)
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, real(x)]))
          : v;
  return ops.map((op, i) => {
    const r = list[i],
      id = String(object(r) && object(r[op.type.result]) ? r[op.type.result].resourceName : ''),
      {resource_name: _, ...sent} = real(op.create) as JsonObject,
      fields = [
        ...new Set([
          op.type.resource + '.resource_name',
          ...leaves(sent).map(f => op.type.resource + '.' + f),
          // A new asset group is read back with Google's own status and ad strength (CMP-07); only sent fields compare.
          ...(op.type.kind === 'assetGroups' ? ['asset_group.primary_status', 'asset_group.ad_strength'] : []),
        ]),
      ];
    return {
      read: search(
        classify,
        plan,
        'SELECT ' +
          fields.join(', ') +
          ' FROM ' +
          op.type.resource +
          ' WHERE ' +
          op.type.resource +
          ".resource_name IN ('" +
          id +
          "')",
      ),
      expected: sent,
      id,
    };
  });
}
/** A build that starts anything ENABLED activates it, which an owner policy with allow_activation false forbids. */
export function googleAtomicActivates(plan: CompiledRequest): boolean {
  return operations(plan).some(op => op.create.status === 'ENABLED');
}
/** The budgets a build creates, in micros, for the owner's spending caps. */
export function googleAtomicPolicyAmounts(plan: CompiledRequest): PolicyAmounts | undefined {
  const budgets = operations(plan).filter(
    op => op.type.kind === 'campaignBudgets' && op.create.amount_micros !== undefined,
  );
  if (!budgets.length) return undefined;
  return {
    creating: true,
    amounts: budgets.map(op => ({
      path: '/mutate_operations/' + op.index + '/campaign_budget_operation/create/amount_micros',
      key: 'amount_micros:' + (op.temp ?? String(op.index)),
      amount: Number(op.create.amount_micros),
      decimal: String(op.create.amount_micros),
    })),
  };
}
// The one-service create actions a Google build step may contain, and the operation each becomes in googleAds:mutate.
const buildOperations: Record<string, {key: string; kind: string}> = {
  campaign_budget_mutate_campaign_budgets: {key: 'campaign_budget_operation', kind: 'campaignBudgets'},
  campaign_mutate_campaigns: {key: 'campaign_operation', kind: 'campaigns'},
  campaign_criterion_mutate_campaign_criteria: {key: 'campaign_criterion_operation', kind: 'campaignCriteria'},
  ad_group_mutate_ad_groups: {key: 'ad_group_operation', kind: 'adGroups'},
  ad_group_criterion_mutate_ad_group_criteria: {key: 'ad_group_criterion_operation', kind: 'adGroupCriteria'},
  ad_group_ad_mutate_ad_group_ads: {key: 'ad_group_ad_operation', kind: 'adGroupAds'},
};
/**
 * A Google plan's create steps as one all-or-nothing step (google-atomic-builds.ts, the owner's decision 1). Each step
 * a later one references by {$ref: "<step>#/data/results/0/resourceName"} creates its one resource under a temporary
 * name, and the reference becomes that name; Google creates every resource or none. Steps keep their order, so each
 * temporary name is created before it is used.
 */
export function composeGoogleBuild(steps: JsonObject[], account: string): JsonObject {
  const temps = new Map<string, string>(),
    referenced = new Set<string>(),
    ops: JsonObject[] = [];
  const refOf = (v: unknown) =>
    object(v) && typeof v.$ref === 'string'
      ? /^([^#]+)#\/data\/results\/0\/resourceName$/.exec(v.$ref)?.[1]
      : undefined;
  const scan = (v: unknown): void => {
    const id = refOf(v);
    if (id) referenced.add(id);
    else if (Array.isArray(v)) v.forEach(scan);
    else if (object(v)) Object.values(v).forEach(scan);
  };
  steps.forEach(s => scan(s.arguments));
  const resolve = (v: unknown): unknown => {
    const id = refOf(v);
    if (id && !temps.has(id))
      throw new MirrorError(
        'CLONE_UNSUPPORTED',
        'A step refers to ' + id + ', which no earlier step of the build creates.',
        {
          field: 'atomic',
        },
      );
    if (id) return temps.get(id);
    if (Array.isArray(v)) return v.map(resolve);
    return object(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)])) : v;
  };
  steps.forEach(s => {
    const action = String(s.arguments?.action ?? '').replace(/^google_ads_v\d+_/, ''),
      op = buildOperations[action],
      list = s.arguments?.payload?.operations;
    if (!op || !Array.isArray(list) || list.some(o => !object(o) || Object.keys(o).join() !== 'create'))
      throw new MirrorError('CLONE_UNSUPPORTED', 'Step ' + s.id + ' is not a Google create this build can include.', {
        field: 'atomic',
      });
    if (referenced.has(s.id)) {
      if (list.length !== 1)
        throw new MirrorError(
          'CLONE_UNSUPPORTED',
          'Step ' + s.id + ' is referenced but creates more than one resource.',
          {
            field: 'atomic',
          },
        );
      temps.set(s.id, 'customers/' + account + '/' + op.kind + '/-' + (temps.size + 1));
    }
    for (const o of list)
      ops.push({
        [op.key]: {
          create: {
            ...(referenced.has(s.id) ? {resource_name: temps.get(s.id)} : {}),
            ...(resolve(o.create) as JsonObject),
          },
        },
      });
  });
  if (ops.length > 1000)
    throw new MirrorError(
      'CLONE_SOURCE_TOO_LARGE',
      'The copy has ' +
        ops.length +
        ' resources; one build creates at most 1,000. Leave some out with changes.drop, or clone with atomic: false.',
      {field: 'changes.drop'},
    );
  const first = steps[0]!;
  return {
    id: 'build',
    kind: 'write',
    gateway: 'google_ads_native_action',
    connection_id: first.connection_id,
    account_id: first.account_id,
    description: 'Every resource of ' + steps.map(s => s.id).join(', ') + ', created together or not at all.',
    arguments: {action: 'google_ads_v23_google_ads_mutate', payload: {mutate_operations: ops, partial_failure: false}},
    depends_on: [],
  };
}
/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleAtomicFamily: ReviewedFamily = defineFamily({
  name: 'google_atomic_builds',
  files: ['src/google-atomic-builds.ts', ['tests/google-atomic-builds.test.ts', 'tests/google-pmax-build.test.mjs']],
  kind: googleAtomicKind,
  assert: assertGoogleAtomicBuild,
  snapshots: googleAtomicSnapshots,
  prerequisites: googleAtomicPrerequisites,
  impact: googleAtomicImpact,
  outcome: googleAtomicOutcome,
  // partialFailure false (assert refuses anything else): a refused build created nothing (CMP-04; the owner's decision 5).
  rejectionIsNonApplied: googleRejectionIsNonApplied,
  verification: googleAtomicVerification,
  spendConfirmation: {
    needed: () => true,
    message:
      'A build creates budgets and campaigns and may start ad groups, keywords and ads ENABLED under its paused campaign. Confirm the spending effect with spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  activates: googleAtomicActivates,
  policyAmounts: googleAtomicPolicyAmounts,
});
