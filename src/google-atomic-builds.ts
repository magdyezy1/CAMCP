import {MirrorError} from './errors.js';
import {parentReading, validateGooglePausedParents} from './google-paused-parents.js';
import {refuseShoppingLanguage, validateGoogleTargetingState} from './google-targeting-writes.js';
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
  assertPmaxExistingCampaigns,
  pmaxExistingAssets,
  pmaxImpact,
  type PmaxOp,
} from './google-pmax-build.js';
import {defineFamily, readOf} from './family-kit.js';
import {
  assertChainWithin,
  chainLimits,
  holdsTempName,
  parseTempName,
  standIn,
  type TempName,
} from './google-temp-names.js';
import {
  assertBuildTreeBids,
  assertBuildTrees,
  assertTreeCampaigns,
  buildTreeImpact,
  buildTreeReads,
  pmaxBuildNode,
  pmaxTreeKey,
  shoppingBuildNode,
  type BuildTreeOp,
} from './google-build-trees.js';
import type {TreeNode} from './google-tree.js';

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
 * the names Google returned. Only creates of eleven resource types are accepted: the six of a Search build, and text assets,
 * asset groups, asset-group asset links and signals of a Performance Max build (google-pmax-build.ts, CMP-07), and the nodes
 * of a product tree (google-build-trees.ts, R2.5 M3): a Performance Max retail tree (L2-09) and the listing group criteria of a
 * Standard Shopping ad group (G5), which share the criteria operation with keywords and are told apart by their `listing_group`.
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
  /**
   * Whether every operation of the type is a node of a Performance Max listing group tree (R2.5 M3, L2-09): its resource_name is
   * a composite temporary name, `-g~-n`, naming the asset group the build creates, and it is checked with the other nodes of its
   * tree, not as a one-service create. An ad group criterion is a node of a Standard Shopping tree only when it carries a
   * `listing_group` (G5, `-ag~-n`), so for that type it is each operation's `node` that says so.
   */
  tree?: true;
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
  // A Performance Max retail tree in the same build as its asset group (R2.5 M3, L2-09; src/google-build-trees.ts).
  [pmaxTreeKey]: {
    kind: 'assetGroupListingGroupFilters',
    resource: 'asset_group_listing_group_filter',
    result: 'assetGroupListingGroupFilterResult',
    action: 'asset_group_listing_group_filter_mutate_asset_group_listing_group_filters',
    tree: true,
    refs: {asset_group: 'assetGroups'},
  },
};
// A build is one chain linked by temporary names: AMCP bounds it at 1,000 operations (Q28, owner 2026-11-15: no raise of
// Google's 25 for independent operations), and a longer one is refused as TEMP_ID_CHAIN_TOO_LONG, never split.
const maxOperations = chainLimits.build;
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
  /** The node of a listing group tree that a tree operation creates (R2.5 M3, L2-09). */
  node?: TreeNode;
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
  assertChainWithin(list, maxOperations, plan.action, 'mutate_operations');
  if (!Array.isArray(list) || !list.length || list.length > maxOperations)
    invalid(
      'A build has 1–' + maxOperations + ' operations; this one has ' + (Array.isArray(list) ? list.length : 0) + '.',
      'mutate_operations',
    );
  const created = new Map<string, OpType>(),
    numbers = new Set<string>(),
    // The simple form only: a reference to a resource the build creates (R2.5 M3: the grammar is google-temp-names.ts).
    simpleTemp = (name: unknown): TempName | undefined => {
      const t = parseTempName(name);
      return t && !t.parent ? t : undefined;
    };
  return list.map((raw: unknown, index: number) => {
    const where = 'mutate_operations[' + index + ']';
    // Every refusal of an operation names it (L2-07): its index in the build, and the field it is about.
    function refuse(message: string, field: string, extra: JsonObject = {}): never {
      return invalid(message, field, {operation: index, ...extra});
    }
    if (!object(raw) || Object.keys(raw).length !== 1 || !types[Object.keys(raw)[0]!])
      refuse(where + ' must be exactly one of ' + Object.keys(types).join(', ') + '.', where, {
        allowed: Object.keys(types),
      });
    const key = Object.keys(raw)[0]!,
      type = types[key]!,
      inner = raw[key];
    if (!object(inner) || Object.keys(inner).join() !== 'create' || !object(inner.create))
      refuse(
        where +
          '.' +
          key +
          ' must be {create: {...}}: a build creates resources, and updates and removals are reviewed on their own.',
        where + '.' + key,
      );
    const create = inner.create as JsonObject,
      name = create.resource_name;
    let temp: string | undefined, node: TreeNode | undefined;
    // A node of a product tree is a Performance Max filter, or an ad group criterion that carries a listing group (R2.5 M3, G5).
    if (type.tree) node = pmaxBuildNode(account, index, create);
    else if (type.kind === 'adGroupCriteria' && create.listing_group !== undefined)
      node = shoppingBuildNode(account, index, create);
    if (node) {
      // A node of a tree: named `-g~-n` or `-ag~-n` after the asset group or ad group the build creates (checked with its parse), or unnamed.
      if (name !== undefined) {
        const own = parseTempName(name)!;
        if (numbers.has(own.number))
          refuse(
            'Each temporary name needs its own negative number; -' + own.number + ' is used twice.',
            where + '.' + key + '.create.resource_name',
          );
        numbers.add(own.number);
        temp = name as string;
      }
    } else if (name !== undefined) {
      const own = simpleTemp(name),
        m = own && own.customer === account && own.collection === type.kind ? own : undefined;
      if (!type.temp || !m)
        refuse(
          where +
            '.' +
            key +
            '.create.resource_name must be a temporary name, customers/' +
            account +
            '/' +
            type.kind +
            '/-N' +
            (type.temp
              ? ''
              : ', and only budgets, campaigns, ad groups, assets and asset groups take one; the nodes of a product tree take the composite form, named after their new asset group (-g~-n) or ad group (-ag~-n)') +
            '.',
          where + '.' + key + '.create.resource_name',
        );
      if (numbers.has(m.number))
        refuse(
          'Each temporary name needs its own negative number; -' + m.number + ' is used twice.',
          where + '.' + key + '.create.resource_name',
        );
      numbers.add(m.number);
      temp = name as string;
    }
    for (const [field, parentKind] of Object.entries(type.refs)) {
      const ref = create[field];
      if (ref === undefined) continue;
      if (typeof ref === 'string' && simpleTemp(ref)) {
        if (created.get(ref)?.kind !== parentKind)
          refuse(
            where +
              '.' +
              key +
              '.create.' +
              field +
              ' names ' +
              ref +
              ', which no earlier operation of this build creates as one of its ' +
              parentKind +
              '. A temporary name must be created before it is used.',
            where + '.' + key + '.create.' + field,
          );
      } else if (
        typeof ref !== 'string' ||
        !new RegExp('^customers/' + account + '/' + parentKind + '/[1-9][0-9]*$').test(ref)
      )
        refuse(
          where +
            '.' +
            key +
            '.create.' +
            field +
            ' must name one of this customer’s ' +
            parentKind +
            ', or a temporary one created earlier in the build.',
          where + '.' + key + '.create.' + field,
        );
    }
    // Any other resource name stays in this customer and is not temporary.
    // A tree node also names its parent node, with a temporary name (the tree check reads it): a Performance Max filter in its
    // parent_listing_group_filter, a Shopping criterion inside its listing group.
    const shoppingNode = !!node && !type.tree && object(create.listing_group),
      exempt = [
        ...Object.keys(type.refs),
        ...(type.tree ? ['parent_listing_group_filter'] : []),
        ...(shoppingNode ? ['listing_group.parent_ad_group_criterion'] : []),
      ],
      rest = {
        ...create,
        resource_name: undefined,
        ...Object.fromEntries(exempt.filter(f => !f.includes('.')).map(f => [f, undefined])),
        ...(shoppingNode
          ? {listing_group: {...(create.listing_group as JsonObject), parent_ad_group_criterion: undefined}}
          : {}),
      },
      text = JSON.stringify(rest);
    if (holdsTempName(rest))
      refuse(
        where + ': temporary names are accepted only in ' + (exempt.join(', ') || 'resource_name') + '.',
        where + '.' + key,
      );
    if ([...text.matchAll(/"customers\/([^"/]+)\//g)].some(m => m[1] !== account))
      refuse(where + ' names a resource of another customer.', where + '.' + key);
    if (temp) created.set(temp, type);
    return {index, key, type, create, temp, ...(node ? {node} : {})};
  });
}
/** Temporary names stand in as positive IDs for the one-service checks, which accept existing resources only (google-temp-names.ts). */
const withStandIns = (v: unknown): unknown =>
  typeof v === 'string' && parseTempName(v)
    ? standIn(v)
    : Array.isArray(v)
      ? v.map(withStandIns)
      : object(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withStandIns(x)]))
        : v;
/**
 * A refusal's details as a build spells them (R2.5 M3 merge, the lead's decision on the trees review's answer 5, with targeting's S3-1): in a
 * build `operation` is the index in `mutate_operations`, and `field` is the path in the build's own payload, in snake_case, with the
 * operation's key: `mutate_operations[i].<operation_key>.create.<path>`. A one-operation check names its field in its own request
 * (`operations[0].create.<path>`), relative to the create (`status`) or not at all, so:
 * - a field that already starts with `mutate_operations` is left alone (pmax's own refusals and the trees' node refusals spell it);
 * - `operations[0]` becomes `mutate_operations[<i>].<key>`, the rest of the path kept;
 * - a bare relative field becomes `mutate_operations[<i>].<key>.create.<field>`;
 * - a refusal with no field gets `mutate_operations[<i>].<key>`.
 * The message keeps its prefix `mutate_operations[i]: ` (the callers add it).
 */
export function buildDetails(details: JsonObject, op: {index: number; key: string}): JsonObject {
  const at = 'mutate_operations[' + op.index + '].' + op.key,
    field = details.field;
  const spelled =
    typeof field !== 'string' || field === ''
      ? at
      : field.startsWith('mutate_operations')
        ? field
        : field.startsWith('operations[0]')
          ? at + field.slice('operations[0]'.length)
          : at + '.create.' + field;
  return {...details, field: spelled, operation: op.index};
}
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
/** What the build's trees need of its operations (google-build-trees.ts). */
const treeOps = (ops: Op[]): BuildTreeOp[] =>
  ops.map(o => ({
    index: o.index,
    kind: o.type.kind,
    create: o.create,
    ...(o.temp ? {temp: o.temp} : {}),
    ...(o.node ? {node: o.node} : {}),
  }));
export function assertGoogleAtomicBuild(plan: CompiledRequest, _gateway: () => void, shape: WriteShape) {
  const ops = operations(plan);
  // Performance Max minimums and structure, before any request (CMP-07).
  assertPmaxBuild(pmaxOps(ops));
  // Each tree of the build is complete, as the tree review requires of the tree it edits (R2.5 M3, L2-09). A tree operation is no
  // one-operation request: a single node would fail the tree rules, so the tree is checked whole, and its node is not checked alone.
  assertBuildTrees(treeOps(ops));
  // R2.5 M3 live finding F4 (package r25-m3-live): a unit that bids needs its bid under a Manual CPC campaign the build creates (no request).
  assertBuildTreeBids(treeOps(ops));
  for (const op of ops) {
    if (op.node) continue;
    try {
      shape(single(plan, op));
      // R2.5 M3 live finding F3 (package r25-m3-live): a language criterion on a SHOPPING campaign is refused by Google. The campaign this build
      // creates names its channel in its own create, so that case is refused here, with no request; a campaign that exists is read, and
      // refused with the same sentence in googleAtomicPrerequisites (the rule of the targeting family, src/google-targeting-writes.ts).
      if (op.type.kind === 'campaignCriteria' && object(op.create.language)) {
        const campaign = ops.find(
          o => o.type.kind === 'campaigns' && o.temp !== undefined && o.temp === op.create.campaign,
        );
        if (campaign?.create.advertising_channel_type === 'SHOPPING') refuseShoppingLanguage(0);
      }
    } catch (e) {
      // The same refusal, naming the operation it came from and the path of the field in the build (buildDetails).
      if (e instanceof MirrorError)
        throw new MirrorError(e.code, 'mutate_operations[' + op.index + ']: ' + e.message, buildDetails(e.details, op));
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
  // R2.5 M3: the campaign's channel, brand-guideline mode and Merchant Center account (G1, G5, L2-09, G6), the ad group's type; r25-m3-live
  // (F4) adds its bidding strategy, which a Standard Shopping tree needs (assertBuildTreeBids). The merge
  // adds, once, on `campaigns` and on `adGroups`, the campaign's Demand Gen level (demand_gen_campaign_settings.upgraded_targeting), which
  // targeting's round 2 reads for an existing campaign: explicit true is the ad-group level, explicit false the campaign level, and a value
  // the row does not carry (or carries as anything else) decides nothing, so neither form is refused and the default validate-only decides.
  campaigns:
    'campaign.resource_name, campaign.status, campaign.campaign_budget, campaign.advertising_channel_type, campaign.brand_guidelines_enabled, campaign.shopping_setting.merchant_id, campaign.bidding_strategy_type, campaign.demand_gen_campaign_settings.upgraded_targeting',
  adGroups:
    'ad_group.resource_name, ad_group.status, ad_group.campaign, ad_group.type, campaign.status, campaign.advertising_channel_type, campaign.demand_gen_campaign_settings.upgraded_targeting',
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
    // A campaign the build names: the one it creates (its own create) or an existing one (the row read for it).
    campaignOf = (name: unknown): {status?: unknown; channel?: unknown; upgraded?: unknown} => {
      const own = ops.find(o => o.temp === name);
      if (own) {
        // R2.5 M3 round 2, S2-1 (the lead's correction of 2026-11-19): a campaign AMCP creates itself says in its own create whether
        // upgraded targeting is on, and the field left out is Google's default, true. That is the only place the default applies: the
        // value of an existing campaign is what its row says, and a row without it is unknown (the merge adds the field to the rows
        // a build reads for its existing campaigns).
        const settings = own.create.demand_gen_campaign_settings,
          given = object(settings) ? settings.upgraded_targeting : undefined;
        return {
          status: own.create.status,
          channel: own.create.advertising_channel_type,
          upgraded: typeof given === 'boolean' ? given : true,
        };
      }
      const row = rows.find(r => object(r.campaign) && (r.campaign.resourceName ?? r.campaign.resource_name) === name),
        campaign = row ? (row.campaign as JsonObject) : undefined,
        settings = campaign?.demandGenCampaignSettings ?? campaign?.demand_gen_campaign_settings;
      return {
        status: campaign?.status,
        channel: campaign?.advertisingChannelType ?? campaign?.advertising_channel_type,
        upgraded: object(settings) ? (settings.upgradedTargeting ?? settings.upgraded_targeting) : undefined,
      };
    },
    statusOf = (name: unknown): unknown => campaignOf(name).status,
    // The Demand Gen settings a campaign row carries for the targeting rules (only a Demand Gen campaign's level is asked for).
    settingsOf = (c: {channel?: unknown; upgraded?: unknown}): JsonObject =>
      c.channel === 'DEMAND_GEN' && c.upgraded !== undefined
        ? {demandGenCampaignSettings: {upgradedTargeting: c.upgraded}}
        : {},
    built: JsonObject[] = [];
  for (const op of ops) {
    if (!op.temp) continue;
    // R2.5 M3, G6: a campaign row also carries its channel, which the targeting rules of its ad groups' criteria read (a
    // temporary ad group's own row takes the one of its campaign: the build's, or the existing campaign's read row).
    if (op.type.kind === 'campaigns')
      built.push({
        campaign: {
          resourceName: standIn(op.temp),
          status: op.create.status,
          advertisingChannelType: op.create.advertising_channel_type,
          ...settingsOf(campaignOf(op.temp)),
        },
      });
    if (op.type.kind === 'adGroups')
      built.push({
        adGroup: {resourceName: standIn(op.temp), status: op.create.status, campaign: withStandIns(op.create.campaign)},
        campaign: {
          status: statusOf(op.create.campaign),
          advertisingChannelType: campaignOf(op.create.campaign).channel,
          ...settingsOf(campaignOf(op.create.campaign)),
        },
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
              // The build field rule (the lead's review of the M3 merge, S4-2): the path in the build's own payload, with the operation's key.
              field: 'mutate_operations[' + op.index + '].' + op.key + '.create.' + field,
              requested: currencyText(BigInt(v), currency as string) + ' ' + currency + ' (' + v + ' micros)',
              currency,
              minimum_unit_micros: String(unit),
              minimum_unit: currencyText(unit, currency as string) + ' ' + currency,
            },
          );
      }
    }
  assertPmaxExistingAssets(pmaxOps(ops), rows);
  assertPmaxExistingCampaigns(pmaxOps(ops), rows);
  const states = [...state, {results: built}];
  for (const op of ops) {
    if (op.node) continue;
    const one = single(plan, op);
    try {
      validateGooglePausedParents(one, states);
      validateGoogleTargetingState(one, states);
    } catch (e) {
      // Targeting's own refusal (a bare field such as `status`) in the build's words: the operation and the path of the field (buildDetails).
      if (e instanceof MirrorError)
        throw new MirrorError(e.code, 'mutate_operations[' + op.index + ']: ' + e.message, buildDetails(e.details, op));
      throw e;
    }
  }
  // The campaign of each tree's asset group is a retail Performance Max campaign (R2.5 M3, L2-09).
  assertTreeCampaigns(treeOps(ops), rows);
  // The same, for a campaign that exists: its bidding strategy is in the row the review read (F4).
  assertBuildTreeBids(treeOps(ops), rows);
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
      ...(ops.some(o => o.node) ? {trees: buildTreeImpact(treeOps(ops))} : {}),
    },
    // Q1's rule (owner 2026-11-15, R2.5 M3): a child may start ENABLED under the new PAUSED campaign, which stays the one activation, or
    // under an existing campaign, where it serves as soon as it is created if that campaign serves (it then needs the spend flag, and the
    // owner's allow_activation switch refuses it). Pinned by tests/m3-merge-joins.test.mjs (join 2); its Arabic is in web/locales/ar.json.
    meaning:
      'One request: Google creates every resource or none. Each resource is checked as its own service would check it; children may start ENABLED under the new PAUSED campaign, which stays the one activation, or under an existing campaign, where an ENABLED child serves as soon as it is created if that campaign serves.',
  };
}
const responses = (result: JsonObject | TransportResult) => {
  const d = object(result.data) ? result.data : {};
  return Array.isArray(d.mutateOperationResponses) ? (d.mutateOperationResponses as unknown[]) : [];
};
/** A resource a build creates that Google keeps unique by name, and what it was created under. */
export interface BuildAnchor {
  /** The index of its operation. */
  op: number;
  /** The GAQL resource (campaign_budget, campaign, ad_group, asset_group) and its name in the request. */
  resource: string;
  name: string;
  /** Its temporary name, when later operations name it. */
  temp?: string;
  /** What it was created under: the field that names the parent, and what the request put there. */
  parent?: {field: string; ref: string};
}
/**
 * What the lookup of an uncertain build needs of its request (R2.5 M2, L2-13): the field each operation's result answers
 * in, and the resources the build creates that Google keeps unique by name. A campaign's name is unique among those not
 * removed, an ad group's and an asset group's within their campaign, and a budget's when it is shared (the default; an
 * unshared budget takes its name from its campaign, so its own proves nothing). A build is all or nothing, so finding the
 * set it named, each under the parent it gave it, is finding the build. Undefined for a request that is no valid build.
 */
export function googleBuildLookup(
  plan: CompiledRequest,
): {operations: {result: string}[]; anchors: BuildAnchor[]; anchorTemps: string[]} | undefined {
  let ops: Op[];
  try {
    ops = operations(plan);
  } catch {
    return undefined;
  }
  const parentOf: Record<string, string> = {
      campaigns: 'campaign_budget',
      adGroups: 'campaign',
      assetGroups: 'campaign',
    },
    anchored = new Set(['campaignBudgets', 'campaigns', 'adGroups', 'assetGroups']),
    anchors: BuildAnchor[] = [];
  for (const op of ops) {
    const name = op.create.name;
    if (!anchored.has(op.type.kind) || typeof name !== 'string' || !name) continue;
    if (op.type.kind === 'campaignBudgets' && op.create.explicitly_shared === false) continue;
    const field = parentOf[op.type.kind],
      ref = field ? op.create[field] : undefined;
    anchors.push({
      op: op.index,
      resource: op.type.resource,
      name,
      ...(op.temp ? {temp: op.temp} : {}),
      ...(field && typeof ref === 'string' ? {parent: {field, ref}} : {}),
    });
  }
  return {
    operations: ops.map(op => ({result: op.type.result})),
    anchors,
    anchorTemps: anchors.flatMap(a => (a.temp ? [a.temp] : [])),
  };
}
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
/**
 * One read per created resource, of the fields sent, with temporary names replaced by the ones Google returned; a tree's nodes
 * are the exception: one read of each tree, by shape.
 */
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
  // R2.5 M3 live finding F1 (the lead's live evidence of 2026-11-20, a Standard Shopping build and the standard google_search recipe): Google
  // names a budget created with `explicitly_shared: false` after the campaign that uses it. A budget a build sent as "<name> budget" read
  // back as its campaign's name, "<name>", although Google had created exactly what was sent, so every build that creates such a budget
  // (every guided Google recipe does) ended in VERIFICATION_MISMATCH on /name, with every other resource verified. The name of that budget
  // is therefore neither read nor compared; every other field of it is. A shared budget (the default, or `explicitly_shared: true`) keeps
  // its own name, which stays compared, and so does the name of a non-shared budget that no campaign of the build uses, which nothing
  // renamed. (`googleBuildLookup` below leaves the name of a non-shared budget out of the uncertain-write lookup for the same reason.)
  const budgetsOfCampaigns = new Set(ops.filter(o => o.type.kind === 'campaigns').map(o => o.create.campaign_budget)),
    namedByItsCampaign = (op: Op): boolean =>
      op.type.kind === 'campaignBudgets' &&
      op.create.explicitly_shared === false &&
      op.temp !== undefined &&
      budgetsOfCampaigns.has(op.temp);
  const reads = ops.map((op, i) => {
    const r = list[i],
      id = String(object(r) && object(r[op.type.result]) ? r[op.type.result].resourceName : ''),
      {resource_name: _, ...asSent} = real(op.create) as JsonObject,
      {name: _name, ...withoutName} = asSent,
      sent = namedByItsCampaign(op) ? withoutName : asSent,
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
  // A tree is read back whole, by shape, from the asset group Google created: its nodes have no read of their own (R2.5 M3, L2-09).
  return [
    ...reads.filter((_, i) => !ops[i]!.node),
    ...buildTreeReads(plan, treeOps(ops), name => real(name)).map(t => ({...t, read: classify(t.read)})),
  ];
}
/** A build that starts anything ENABLED activates it, which an owner policy with allow_activation false forbids. */
export function googleAtomicActivates(plan: CompiledRequest, before?: unknown): boolean {
  const ops = operations(plan);
  if (ops.some(op => op.create.status === 'ENABLED')) return true;
  // R2.5 M3, G8 (Q1, owner 2026-11-15): a positive criterion that names no status, added to an EXISTING ad group, starts ENABLED
  // (Google's default for a status left out is UNVERIFIED here, so it is read as ENABLED) now that a serving parent lets children
  // in. It counts unless the ad group or its campaign reads PAUSED in the state the review read. A criterion under an ad group
  // this build creates is covered by that ad group's own explicit status (which counts above, or is PAUSED), so it never newly counts.
  const rows = (Array.isArray(before) ? before : [])
    .flatMap(s => (object(s) && Array.isArray(s.results) ? s.results : []))
    .map(r => snakeKeys(r) as JsonObject);
  return ops.some(op => {
    const group = op.create.ad_group;
    if (op.type.kind !== 'adGroupCriteria' || op.create.status !== undefined || op.create.negative === true)
      return false;
    if (typeof group !== 'string' || /\/-\d+$/.test(group)) return false;
    const row = rows.find(r => object(r.ad_group) && r.ad_group.resource_name === group);
    return (
      parentReading([
        object(row?.ad_group) ? row.ad_group.status : undefined,
        object(row?.campaign) ? row.campaign.status : undefined,
      ]) !== 'paused'
    );
  });
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
 * temporary name is created before it is used. `shrinkAdvice` is what else the caller can do to make a build of more than
 * 1,000 resources smaller, in the caller's own words (a clone: the adapter's googleCloneShrinkAdvice); the Google Search
 * recipe, which has no such choice, passes none (the lead's review, 2026-11-20, S4-9).
 */
export function composeGoogleBuild(steps: JsonObject[], account: string, shrinkAdvice?: string): JsonObject {
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
        ' resources; one build creates at most 1,000. Leave some out with changes.drop, ' +
        (shrinkAdvice ? shrinkAdvice + ', ' : '') +
        'or clone with atomic: false.',
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
    // Q1, owner 2026-11-15 (R2.5 M3, G8): children of an existing campaign or ad group may start ENABLED too, once the review reads it as serving.
    message:
      'A build creates budgets and campaigns and may start ad groups, keywords and ads ENABLED under its paused campaign, or, with this confirmation, under an existing campaign or ad group that serves. Confirm the spending effect with spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  activates: googleAtomicActivates,
  policyAmounts: googleAtomicPolicyAmounts,
});

/**
 * What each operation of a build answers with, by the operation's key in snake_case (`campaign_operation`): the collection of the resource it
 * creates and the field of `MutateOperationResponse` that holds its resource name (`campaignResult`). Derived from the table the build is checked
 * with, never copied, so that a later step's reference into a build (`/data/mutateOperationResponses/<i>/<result>/resourceName`, the plan's preflight:
 * src/google-preflight.ts, R2.5 r25-field3-refs, AMCP-02) and the build itself cannot disagree on an operation type.
 */
export const googleBuildResults: Readonly<Record<string, Readonly<{kind: string; result: string}>>> = Object.freeze(
  Object.fromEntries(
    Object.entries(types).map(([key, type]) => [key, Object.freeze({kind: type.kind, result: type.result})]),
  ),
);
