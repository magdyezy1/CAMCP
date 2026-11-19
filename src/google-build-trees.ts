import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {googleJson} from './google-contracts.js';
import {parseTempName, temporaryParentFormAccepted} from './google-temp-names.js';
import {assertTree, finalTree, shape, type RefusalDetails, type TreeAdapter, type TreeNode} from './google-tree.js';
import {assertRetailCampaign, googleListingGroupTreeRead, pmaxCreate, pmaxTree} from './google-listing-groups.js';
import {assertShoppingCampaign, googleShoppingTreeRead, shoppingCreate, shoppingTree} from './google-shopping-tree.js';

/**
 * Product trees inside an all-or-nothing Google build (R2.5 M3, L2-09 and G5 route A). A build that creates a Performance Max
 * asset group may create its listing group tree in the same request, the filters named after the new asset group with
 * composite temporary names, `customers/{c}/assetGroupListingGroupFilters/-{g}~-{n}`; a build that creates a Standard Shopping
 * ad group may do the same with the listing group criteria of the new ad group, `customers/{c}/adGroupCriteria/-{ag}~-{n}`
 * (src/google-temp-names.ts). Google requires the whole tree in one request, so a build holds the whole tree of each new asset
 * group or ad group: it is checked without state by the shared tree module with the same adapter the one-service tree review
 * uses (src/google-listing-groups.ts, src/google-shopping-tree.ts), so a node a tree review refuses is refused in a build, with
 * the same rule. A tree of an asset group or ad group that exists is not a build's: it belongs to the one-service tree review,
 * which reads the tree it edits.
 */
export const pmaxTreeRoute = 'google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters';
export const shoppingTreeRoute = 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria';
/** What a build's tree needs of one of its operations (src/google-atomic-builds.ts). */
export interface BuildTreeOp {
  index: number;
  /** The kind of the service the operation is for (assetGroups, assetGroupListingGroupFilters, adGroups, adGroupCriteria, campaigns). */
  kind: string;
  /** Its create record, keys in snake_case. */
  create: JsonObject;
  /** Its temporary name, when later operations reference it. */
  temp?: string;
  /** The node a tree operation creates, once it has been checked. */
  node?: TreeNode;
}
/** The operation key of a Performance Max tree node in a build. */
export const pmaxTreeKey = 'asset_group_listing_group_filter_operation';
/** The operation key of a Standard Shopping tree node in a build: an ad group criterion that carries a listing group. */
export const shoppingTreeKey = 'ad_group_criterion_operation';
/** The two product trees a build may hold, by the kind of the service of their nodes. */
interface Flavor {
  /** Its nodes for the shared tree module. */
  adapter: TreeAdapter;
  /** The field of a node's create that names what the tree belongs to, and the kind of that parent the build creates. */
  parent: {field: string; kind: string};
  /** The operation key of a node in googleAds:mutate, and the one-service route that edits a tree that exists. */
  key: string;
  route: string;
  /** The read of the whole tree of the parent Google created, by the name Google returned. */
  read: (plan: CompiledRequest, created: string) => CompiledRequest;
}
const flavors: Record<string, Flavor> = {
  assetGroupListingGroupFilters: {
    adapter: pmaxTree,
    parent: {field: 'asset_group', kind: 'assetGroups'},
    key: pmaxTreeKey,
    route: pmaxTreeRoute,
    read: googleListingGroupTreeRead,
  },
  adGroupCriteria: {
    adapter: shoppingTree,
    parent: {field: 'ad_group', kind: 'adGroups'},
    key: shoppingTreeKey,
    route: shoppingTreeRoute,
    read: googleShoppingTreeRead,
  },
};
function refuse(message: string, field: string, extra: RefusalDetails = {}): never {
  throw new MirrorError('INVALID_GOOGLE_BUILD', message, {field, ...extra});
}
const snakeKey = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
/**
 * A tree check's refusal as a build reports it (L2-07): the field in the spelling of the build's own payload, which the check
 * spells in camelCase, and `mutate_operations` for the list of operations as a whole. The message keeps the sentence of the tree
 * review, which has the same rule, and takes `prefix`.
 */
function inBuild(e: unknown, prefix = ''): unknown {
  if (!(e instanceof MirrorError)) return e;
  const field = e.details.field,
    mapped =
      field === 'operations'
        ? 'mutate_operations'
        : typeof field === 'string'
          ? field.replace(
              /^(mutate_operations\[\d+\]\.[a-z_]+\.create)((?:\.[A-Za-z_]+)*)$/,
              (_, head: string, tail: string) =>
                head + tail.replace(/\.([A-Za-z_]+)/g, (_k, k: string) => '.' + snakeKey(k)),
            )
          : field;
  return new MirrorError(
    e.code,
    prefix + e.message,
    field === undefined ? e.details : {...e.details, field: mapped},
    e.status,
    e.retryable,
  );
}
/**
 * The node a build's tree operation creates, checked as a tree review checks one: the same parse (`pmaxCreate`), with the asset
 * group a temporary name `-g` the build creates earlier and the filter named `-g~-n`. A tree of an asset group that exists is
 * refused, and so is a tree under a new asset group while Q7's switch (`temporaryParentForms`, read through `temporaryParentFormAccepted`) is off; both name the route
 * that does it, the tree review, on the ID of an asset group that exists.
 */
export function pmaxBuildNode(account: string, index: number, create: JsonObject): TreeNode {
  const where = 'mutate_operations[' + index + '].' + pmaxTreeKey,
    group = parseTempName(create.asset_group),
    name = create.resource_name === undefined ? undefined : parseTempName(create.resource_name),
    existing =
      typeof create.asset_group === 'string' &&
      new RegExp('^customers/' + account + '/assetGroups/[1-9][0-9]*$').test(create.asset_group);
  if (existing || (name?.parent && !name.parent.temporary))
    refuse(
      'A tree of an asset group that exists is edited with the tree review, not in a build: send it to google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters, and create only the asset groups of a new tree in a build, naming each filter after its new asset group, -g~-n.',
      where + '.create.asset_group',
      {operation: index, route: pmaxTreeRoute, rule: 'tree_of_existing_group'},
    );
  if (group && !group.parent && !temporaryParentFormAccepted('assetGroupListingGroupFilters'))
    refuse(
      'A tree under an asset group the build creates is not accepted here: create the asset group in the build, then add its tree with the tree review (google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters) on the new asset group’s ID.',
      where + '.create.asset_group',
      {operation: index, route: pmaxTreeRoute, rule: 'temporary_parent_refused'},
    );
  try {
    return pmaxCreate(account, googleJson(create), where, index, true).node;
  } catch (e) {
    throw inBuild(e);
  }
}
/**
 * The node a build's Standard Shopping tree operation creates (G5 route A), checked as the tree review checks one
 * (`shoppingCreate`), with the ad group a temporary name `-ag` the build creates earlier and the criterion named `-ag~-n`. The
 * same two refusals as a Performance Max node: an ad group that exists, and Q7's switch for this form.
 */
export function shoppingBuildNode(account: string, index: number, create: JsonObject): TreeNode {
  const where = 'mutate_operations[' + index + '].' + shoppingTreeKey,
    group = parseTempName(create.ad_group),
    name = create.resource_name === undefined ? undefined : parseTempName(create.resource_name),
    existing =
      typeof create.ad_group === 'string' &&
      new RegExp('^customers/' + account + '/adGroups/[1-9][0-9]*$').test(create.ad_group);
  if (existing || (name?.parent && !name.parent.temporary))
    refuse(
      'A tree of an ad group that exists is edited with the tree review, not in a build: send it to google_ads_v23_ad_group_criterion_mutate_ad_group_criteria, and create only the ad groups of a new tree in a build, naming each criterion after its new ad group, -ag~-n.',
      where + '.create.ad_group',
      {operation: index, route: shoppingTreeRoute, rule: 'tree_of_existing_group'},
    );
  if (group && !group.parent && !temporaryParentFormAccepted('adGroupCriteria'))
    refuse(
      'A tree under an ad group the build creates is not accepted here: create the ad group in the build, then add its tree with the tree review (google_ads_v23_ad_group_criterion_mutate_ad_group_criteria) on the new ad group’s ID.',
      where + '.create.ad_group',
      {operation: index, route: shoppingTreeRoute, rule: 'temporary_parent_refused'},
    );
  try {
    return shoppingCreate(account, googleJson(create), where, index, true).node;
  } catch (e) {
    throw inBuild(e);
  }
}
/** The tree operations of a build, by the asset group or ad group each creates a node in (the temporary name), each in the order of the build. */
function trees(ops: BuildTreeOp[]): Map<string, BuildTreeOp[]> {
  const out = new Map<string, BuildTreeOp[]>();
  for (const op of ops) {
    const flavor = op.node ? flavors[op.kind] : undefined,
      group = flavor ? op.create[flavor.parent.field] : undefined;
    if (flavor && typeof group === 'string') out.set(group, [...(out.get(group) ?? []), op]);
  }
  return out;
}
/** The flavor of a tree: all its nodes are of one service. */
const flavorOf = (own: BuildTreeOp[]): Flavor => flavors[own[0]!.kind]!;
const finalOf = (own: BuildTreeOp[]) =>
  finalTree(
    flavorOf(own).adapter,
    own.map(o => ({create: o.node!})),
    [],
  );
/** Every tree of the build is complete, with no state: a build creates the whole tree of each of its asset groups and ad groups. */
export function assertBuildTrees(ops: BuildTreeOp[]): void {
  for (const own of trees(ops).values()) {
    try {
      assertTree(flavorOf(own).adapter, finalOf(own));
    } catch (e) {
      // The same refusal, naming the operation it came from, as one service's check inside a build does.
      throw inBuild(
        e,
        e instanceof MirrorError && typeof e.details.operation === 'number'
          ? 'mutate_operations[' + e.details.operation + ']: '
          : '',
      );
    }
  }
}
/**
 * What each tree belongs to is of the right kind: the campaign of a Performance Max asset group is a Performance Max campaign
 * with a Merchant Center account, and a Standard Shopping tree is in an ad group of type SHOPPING_PRODUCT_ADS of a Shopping
 * campaign with one. A campaign the build creates is known from its own create, one that exists from the parent read (`rows`, the
 * state rows the review read).
 */
export function assertTreeCampaigns(ops: BuildTreeOp[], rows: JsonObject[]): void {
  for (const [group, own] of trees(ops)) {
    const flavor = flavorOf(own),
      parent = ops.find(o => o.kind === flavor.parent.kind && o.temp === group),
      ref = parent?.create.campaign,
      made = ops.find(o => o.kind === 'campaigns' && o.temp === ref),
      row = rows.find(r => {
        const c = r.campaign;
        return !!c && typeof c === 'object' && (c.resourceName ?? c.resource_name) === ref;
      })?.campaign;
    const campaign: JsonObject = made
      ? {
          resource_name: made.create.name ?? ref,
          advertising_channel_type: made.create.advertising_channel_type,
          merchant_id: made.create.shopping_setting?.merchant_id,
        }
      : {
          resource_name: ref,
          advertising_channel_type: row?.advertisingChannelType ?? row?.advertising_channel_type,
          merchant_id: row?.shoppingSetting?.merchantId ?? row?.shopping_setting?.merchant_id,
        };
    const details = {
      operation: own[0]!.index,
      field: 'mutate_operations[' + own[0]!.index + '].' + flavor.key + '.create.' + flavor.parent.field,
    };
    try {
      if (flavor.adapter === shoppingTree)
        assertShoppingCampaign(
          {resource_name: parent?.create.name ?? group, type: parent?.create.type ?? 'UNSPECIFIED', campaign: ref},
          campaign,
          details,
        );
      else assertRetailCampaign(campaign, details);
    } catch (e) {
      if (e instanceof MirrorError)
        throw new MirrorError(e.code, 'mutate_operations[' + own[0]!.index + ']: ' + e.message, e.details);
      throw e;
    }
  }
}
/** What the impact shows of each tree: its asset group or ad group, its node count and the shape it will have. */
export function buildTreeImpact(ops: BuildTreeOp[]): JsonObject[] {
  return [...trees(ops)].map(([group, own]) => {
    const flavor = flavorOf(own),
      parent = ops.find(o => o.kind === flavor.parent.kind && o.temp === group);
    return {
      [flavor.parent.field]: parent?.create.name ?? group,
      nodes: own.length,
      final_tree: shape(flavor.adapter, finalOf(own)),
    };
  });
}
/**
 * The read-back of each tree: one read of the whole tree of the asset group or ad group Google created (`real` names it from the
 * result), compared by shape with the tree the build sent, not one read per node.
 */
export function buildTreeReads(
  plan: CompiledRequest,
  ops: BuildTreeOp[],
  real: (name: string) => unknown,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  return [...trees(ops)].map(([group, own]) => {
    const flavor = flavorOf(own),
      created = String(real(group));
    return {
      read: flavor.read(plan, created),
      expected: {tree: shape(flavor.adapter, finalOf(own))},
      id: created + ' listing groups',
    };
  });
}
