import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {googleJson} from './google-contracts.js';
import {parseTempName, temporaryParentForms} from './google-temp-names.js';
import {assertTree, finalTree, shape, type TreeNode} from './google-tree.js';
import {assertRetailCampaign, googleListingGroupTreeRead, pmaxCreate, pmaxTree} from './google-listing-groups.js';

/**
 * Product trees inside an all-or-nothing Google build (R2.5 M3, L2-09 and G5 route A). A build that creates a Performance Max
 * asset group may create its listing group tree in the same request, the filters named after the new asset group with
 * composite temporary names, `customers/{c}/assetGroupListingGroupFilters/-{g}~-{n}` (src/google-temp-names.ts). Google requires
 * the whole tree in one request, so a build holds the whole tree of each new asset group: it is checked without state by the
 * shared tree module with the same adapter the one-service tree review uses (src/google-listing-groups.ts), so a node a tree
 * review refuses is refused in a build, with the same rule. A tree of an asset group that exists is not a build's: it belongs
 * to the one-service tree review, which reads the tree it edits.
 */
export const pmaxTreeRoute = 'google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters';
/** What a build's tree needs of one of its operations (src/google-atomic-builds.ts). */
export interface BuildTreeOp {
  index: number;
  /** The kind of the service the operation is for (assetGroups, assetGroupListingGroupFilters, campaigns). */
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
function refuse(message: string, field: string, extra: JsonObject = {}): never {
  throw new MirrorError('INVALID_GOOGLE_BUILD', message, {field, ...extra});
}
/**
 * The node a build's tree operation creates, checked as a tree review checks one: the same parse (`pmaxCreate`), with the asset
 * group a temporary name `-g` the build creates earlier and the filter named `-g~-n`. A tree of an asset group that exists is
 * refused, and so is a tree under a new asset group while Q7's switch (`temporaryParentForms`) is off; both name the route
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
  if (group && !group.parent && !temporaryParentForms.assetGroupListingGroupFilters)
    refuse(
      'A tree under an asset group the build creates is not accepted here: create the asset group in the build, then add its tree with the tree review (google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters) on the new asset group’s ID.',
      where + '.create.asset_group',
      {operation: index, route: pmaxTreeRoute, rule: 'temporary_parent_refused'},
    );
  return pmaxCreate(account, googleJson(create), where, index, true).node;
}
/** The tree operations of a build, by the asset group each creates a node in (the temporary name), each in the order of the build. */
function trees(ops: BuildTreeOp[]): Map<string, BuildTreeOp[]> {
  const out = new Map<string, BuildTreeOp[]>();
  for (const op of ops)
    if (op.node && typeof op.create.asset_group === 'string')
      out.set(op.create.asset_group, [...(out.get(op.create.asset_group) ?? []), op]);
  return out;
}
const finalOf = (own: BuildTreeOp[]) =>
  finalTree(
    pmaxTree,
    own.map(o => ({create: o.node!})),
    [],
  );
/** Every tree of the build is complete, with no state: a build creates the whole tree of each of its asset groups. */
export function assertBuildTrees(ops: BuildTreeOp[]): void {
  for (const own of trees(ops).values()) {
    try {
      assertTree(pmaxTree, finalOf(own));
    } catch (e) {
      // The same refusal, naming the operation it came from, as one service's check inside a build does.
      if (e instanceof MirrorError)
        throw new MirrorError(
          e.code,
          (typeof e.details.operation === 'number' ? 'mutate_operations[' + e.details.operation + ']: ' : '') +
            e.message,
          e.details,
        );
      throw e;
    }
  }
}
/**
 * The campaign of each tree's asset group is a Performance Max campaign with a Merchant Center account: a campaign the build
 * creates from its own create, one that exists from the parent read (`rows`, the state rows the review read).
 */
export function assertTreeCampaigns(ops: BuildTreeOp[], rows: JsonObject[]): void {
  for (const [group, own] of trees(ops)) {
    const asset = ops.find(o => o.kind === 'assetGroups' && o.temp === group),
      ref = asset?.create.campaign,
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
    try {
      assertRetailCampaign(campaign, {
        operation: own[0]!.index,
        field: 'mutate_operations[' + own[0]!.index + '].' + pmaxTreeKey + '.create.asset_group',
      });
    } catch (e) {
      if (e instanceof MirrorError)
        throw new MirrorError(e.code, 'mutate_operations[' + own[0]!.index + ']: ' + e.message, e.details);
      throw e;
    }
  }
}
/** What the impact shows of each tree: its asset group, its node count and the shape it will have. */
export function buildTreeImpact(ops: BuildTreeOp[]): JsonObject[] {
  return [...trees(ops)].map(([group, own]) => {
    const asset = ops.find(o => o.kind === 'assetGroups' && o.temp === group);
    return {
      asset_group: asset?.create.name ?? group,
      nodes: own.length,
      final_tree: shape(pmaxTree, finalOf(own)),
    };
  });
}
/**
 * The read-back of each tree: one read of the whole tree of the asset group Google created (`real` names it from the result),
 * compared by shape with the tree the build sent, not one read per node.
 */
export function buildTreeReads(
  plan: CompiledRequest,
  ops: BuildTreeOp[],
  real: (name: string) => unknown,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  return [...trees(ops)].map(([group, own]) => {
    const created = String(real(group));
    return {
      read: googleListingGroupTreeRead(plan, created),
      expected: {tree: shape(pmaxTree, finalOf(own))},
      id: created + ' listing groups',
    };
  });
}
