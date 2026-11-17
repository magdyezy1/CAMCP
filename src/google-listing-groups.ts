import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, fail, readOf} from './family-kit.js';
import {googleJson, validateGoogleRequest, assertGoogleAdsScope} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {googleAdsCustomers} from './google-version.js';
import {assertChainWithin, chainLimits} from './google-temp-names.js';
import {
  assertTree,
  dimension,
  finalTree,
  shape,
  type TreeAdapter,
  type TreeNode,
  type TreeOperation,
} from './google-tree.js';

/**
 * Listing group filters of Performance Max retail asset groups, per Google Ads API v23 AssetGroupListingGroupFilterService
 * and the "Listing Groups for Retail" guide (checked 2026-09-26). Every asset group of a retail campaign needs a valid
 * product partition tree, or its ads do not serve: one root; each subdivision completely partitioned, with an "Other"
 * node of the same dimension; units as leaves. Nodes created in one request name each other with negative temporary
 * IDs, parents come before children, and removals go leaves first. Type, asset group and listing source are immutable,
 * so nodes are created and removed, never updated. Webpage (non-retail) listing groups are outside this contract.
 */
export const googleListingGroupFields = [
  'resource_name',
  'asset_group',
  'id',
  'type',
  'listing_source',
  'parent_listing_group_filter',
  'case_value.product_brand.value',
  'case_value.product_category.category_id',
  'case_value.product_category.level',
  'case_value.product_channel.channel',
  'case_value.product_condition.condition',
  'case_value.product_custom_attribute.index',
  'case_value.product_custom_attribute.value',
  'case_value.product_item_id.value',
  'case_value.product_type.level',
  'case_value.product_type.value',
];
export const googleListingGroupParentFields = [
  'asset_group.resource_name',
  'asset_group.status',
  'asset_group.campaign',
  'campaign.resource_name',
  'campaign.status',
  'campaign.advertising_channel_type',
  'campaign.shopping_setting.merchant_id',
];
/** Each retail dimension: the field that holds a value (absent for the "Other" node) and the level or index that splits siblings. */
const dimensions: Record<string, {value: string; level?: string}> = {
  productBrand: {value: 'value'},
  productCategory: {value: 'categoryId', level: 'level'},
  productChannel: {value: 'channel'},
  productCondition: {value: 'condition'},
  productCustomAttribute: {value: 'value', level: 'index'},
  productItemId: {value: 'value'},
  productType: {value: 'value', level: 'level'},
};
const types = new Set(['SUBDIVISION', 'UNIT_INCLUDED', 'UNIT_EXCLUDED']),
  // A tree is one chain Google takes in one request; AMCP bounds it at 500 operations (Q28, owner 2026-11-15: this is no
  // raise of Google's 25 for independent operations, which stay 25).
  maxOperations = chainLimits.tree,
  maxNodes = 5000;
type Node = TreeNode;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string, details: JsonObject = {}): never {
  return fail('INVALID_LISTING_GROUP', message, details);
}
/**
 * A Performance Max tree for the shared tree module (src/google-tree.ts): its units are included or excluded, its nodes have
 * the listing source SHOPPING, and what it belongs to is an asset group.
 */
export const pmaxTree: TreeAdapter = {
  code: 'INVALID_LISTING_GROUP',
  dimensions,
  isSubdivision: n => n.type === 'SUBDIVISION',
  isUnit: n => n.type === 'UNIT_INCLUDED' || n.type === 'UNIT_EXCLUDED',
  isExcluded: n => n.type === 'UNIT_EXCLUDED',
  label: n => n.type,
  foreign: {
    is: n => n.source !== 'SHOPPING',
    refuse: details =>
      invalid('The asset group has webpage listing groups; this contract edits retail (SHOPPING) trees only.', details),
  },
  refuse: {
    missing: (name, details) =>
      fail('STATE_NOT_FOUND', 'Listing group filter ' + name + ' does not exist in the asset group.', {
        resource_name: name,
        ...details,
      }),
    existingRoot: details =>
      invalid(
        'The asset group already has a root; remove the current tree, leaves first, in the same review to replace it.',
        details,
      ),
    emptyTree: details =>
      invalid(
        'The asset group would have no listing group tree, and its ads would stop serving. Replace the tree instead, or pause the asset group.',
        details,
      ),
  },
};
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) invalid('Select one Google Ads customer.');
  return id!;
};
const groupName = (c: string, group: string) => 'customers/' + c + '/assetGroups/' + group;
function parseNode(c: string, name: unknown): {group: string; id: string} | undefined {
  const m =
    typeof name === 'string'
      ? new RegExp('^customers/' + c + '/assetGroupListingGroupFilters/([1-9][0-9]*)~(-?[1-9][0-9]*)$').exec(name)
      : null;
  return m ? {group: m[1]!, id: m[2]!} : undefined;
}
export function googleListingGroupKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'google_ads_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    /^\/v\d+\/customers\/\d+\/assetGroupListingGroupFilters:mutate$/.test(p.path)
  );
}
type Operation = TreeOperation;
function operations(p: CompiledRequest): {group: string; ops: Operation[]} {
  const c = account(p),
    b = googleJson(p.body),
    ops: Operation[] = [];
  let group: string | undefined;
  const same = (g: string) => {
    if (group !== undefined && g !== group) invalid('A review edits the tree of one asset group.');
    group = g;
  };
  for (const [i, op] of (b.operations as JsonObject[]).entries()) {
    const at = 'operations[' + i + ']';
    if (op.remove !== undefined) {
      const n = parseNode(c, op.remove);
      if (!n || n.id.startsWith('-'))
        invalid(at + '.remove must be an existing listing group filter of the selected customer.');
      same(n!.group);
      ops.push({remove: op.remove, op: i, at: at + '.remove'});
      continue;
    }
    const r = op.create;
    if (
      !obj(r) ||
      Object.keys(r).some(
        k =>
          !['resourceName', 'assetGroup', 'type', 'listingSource', 'caseValue', 'parentListingGroupFilter'].includes(k),
      )
    )
      invalid(
        at +
          '.create accepts resourceName, assetGroup, type, listingSource, caseValue and parentListingGroupFilter only.',
      );
    const g = /^customers\/(\d+)\/assetGroups\/([1-9][0-9]*)$/.exec(String(r.assetGroup));
    if (!g || g[1] !== c) invalid(at + '.create.assetGroup must be an asset group of the selected customer.');
    same(g![2]!);
    if (!types.has(r.type)) invalid(at + '.create.type must be SUBDIVISION, UNIT_INCLUDED or UNIT_EXCLUDED.');
    if (r.listingSource !== 'SHOPPING')
      invalid(at + '.create.listingSource must be SHOPPING; webpage listing groups are not reviewed here.');
    const own = r.resourceName === undefined ? undefined : parseNode(c, r.resourceName);
    if (r.resourceName !== undefined && (!own || !own.id.startsWith('-') || own.group !== group))
      invalid(
        at +
          '.create.resourceName must be a temporary name customers/' +
          c +
          '/assetGroupListingGroupFilters/' +
          group +
          '~-N.',
      );
    if (r.type === 'SUBDIVISION' && !own)
      invalid(at + ' creates a subdivision; give it a temporary resourceName so its children can name it.');
    if (r.parentListingGroupFilter !== undefined) {
      const parent = parseNode(c, r.parentListingGroupFilter);
      if (!parent || parent.group !== group)
        invalid(at + '.create.parentListingGroupFilter must be a listing group filter of the same asset group.');
      dimension(pmaxTree, r.caseValue, at + '.create', {operation: i, field: at + '.create.caseValue'});
    } else if (r.caseValue !== undefined) invalid(at + ' creates the root, which has no caseValue.');
    ops.push({
      create: {
        name: own ? String(r.resourceName) : at,
        type: r.type,
        source: r.listingSource,
        parent: r.parentListingGroupFilter,
        caseValue: r.caseValue,
        op: i,
        at: at + '.create',
      },
    });
  }
  return {group: group!, ops};
}
export function assertGoogleListingGroups(p: CompiledRequest): void {
  if (!googleListingGroupKind(p)) return;
  const c = account(p);
  if (p.path.split('/')[3] !== c)
    fail('ACCOUNT_SCOPE_MISMATCH', 'The Google Ads path must belong to the selected customer.');
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Listing group reviews take no query or header overrides.');
  const b = googleJson(p.body);
  if (
    !obj(b) ||
    Object.keys(b).some(k => !['operations', 'responseContentType'].includes(k)) ||
    (b.responseContentType !== undefined && b.responseContentType !== 'RESOURCE_NAME_ONLY')
  )
    invalid('Send operations, optionally with responseContentType RESOURCE_NAME_ONLY; validateOnly is not reviewed.');
  // A tree is one chain linked by temporary names, which is never split: a longer one is refused as such (R2.5 M3, G4c).
  assertChainWithin(b.operations, maxOperations, p.action);
  if (!Array.isArray(b.operations) || !b.operations.length || b.operations.length > maxOperations)
    invalid('Review 1 to ' + maxOperations + ' listing group operations.');
  validateGoogleRequest(p);
  if (
    (b.operations as unknown[]).some(
      op => !obj(op) || Object.keys(op).length !== 1 || !['create', 'remove'].includes(Object.keys(op)[0]!),
    )
  )
    invalid('Each operation creates or removes one node; type, asset group and listing source cannot be updated.');
  const {ops} = operations(p),
    names = new Set<string>();
  for (const op of ops) {
    const name = op.remove ?? op.create!.name;
    if (names.has(name)) invalid(name + ' appears twice in this review.');
    names.add(name);
  }
}
function search(p: CompiledRequest, kind: 'group' | 'tree', group: string): CompiledRequest {
  const c = account(p),
    name = groupName(c, group);
  const query =
    kind === 'group'
      ? 'SELECT ' +
        googleListingGroupParentFields.join(', ') +
        " FROM asset_group WHERE asset_group.resource_name = '" +
        name +
        "'"
      : 'SELECT ' +
        googleListingGroupFields.map(f => 'asset_group_listing_group_filter.' + f).join(', ') +
        " FROM asset_group_listing_group_filter WHERE asset_group_listing_group_filter.asset_group = '" +
        name +
        "'";
  return readOf(
    p,
    {
      action: 'AMCP_LISTING_GROUP_READ',
      method: 'POST',
      path: googleAdsCustomers + c + '/googleAds:search',
      body: {query},
      query: {},
    },
    {googleListingGroupState: {kind, group}},
  );
}
/** The asset group with its campaign, then its complete listing group tree. */
export function googleListingGroupSnapshots(p: CompiledRequest): CompiledRequest[] {
  const {group} = operations(p);
  return [search(p, 'group', group), search(p, 'tree', group)];
}
export function isGoogleListingGroupRead(p: CompiledRequest): boolean {
  return p.gateway === 'google_ads_native_action' && !!p.googleListingGroupState;
}
export function validateGoogleListingGroupState(read: CompiledRequest, result: TransportResult): void {
  const m = read.googleListingGroupState!,
    d = result.data,
    c = account(read),
    name = groupName(c, m.group);
  if (result.status !== 200 || !obj(d) || d.error || (d.results !== undefined && !Array.isArray(d.results)))
    fail('STATE_READ_FAILED', 'Google must return the listing group state of the asset group.');
  if (d.nextPageToken)
    fail('INCOMPLETE_STATE', 'The listing group tree was read incompletely; no mutation was submitted.');
  const rows = ((d.results ?? []) as unknown[]).map(googleJson);
  if (m.kind === 'group') {
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !obj(row) ||
      row.assetGroup?.resourceName !== name ||
      !obj(row.campaign) ||
      row.assetGroup?.campaign !== row.campaign.resourceName
    )
      fail('STATE_TARGET_MISMATCH', 'The asset group ' + name + ' and its campaign were not returned exactly.');
    return;
  }
  if (rows.length > maxNodes)
    fail('STATE_TOO_LARGE', 'The listing group tree has more than ' + maxNodes + ' nodes; no mutation was submitted.');
  const seen = new Set<string>();
  for (const row of rows) {
    const f = obj(row) ? row.assetGroupListingGroupFilter : undefined,
      n = obj(f) ? parseNode(c, f.resourceName) : undefined;
    if (
      !obj(f) ||
      !n ||
      n.id.startsWith('-') ||
      n.group !== m.group ||
      f.assetGroup !== name ||
      seen.has(f.resourceName) ||
      (f.parentListingGroupFilter !== undefined && parseNode(c, f.parentListingGroupFilter)?.group !== m.group)
    )
      fail('STATE_TARGET_MISMATCH', 'Listing group rows must belong to the selected asset group, once each.');
    seen.add(f.resourceName);
  }
}
/** Stable review state: the asset group and campaign, or the tree as sorted nodes without output-only paths. */
export function googleListingGroupState(read: CompiledRequest, data: JsonObject): JsonObject {
  // Frozen review states are normalized again at execution; an already projected state stays as it is.
  if (
    (read.googleListingGroupState?.kind === 'group' && obj(data.asset_group)) ||
    (read.googleListingGroupState?.kind === 'tree' && Array.isArray(data.nodes))
  )
    return data;
  const rows = ((data.results ?? []) as unknown[]).map(googleJson) as JsonObject[];
  if (read.googleListingGroupState?.kind === 'group') {
    const r = rows[0] ?? {};
    return {
      asset_group: {
        resource_name: r.assetGroup?.resourceName,
        status: r.assetGroup?.status,
        campaign: r.assetGroup?.campaign,
      },
      campaign: {
        resource_name: r.campaign?.resourceName,
        status: r.campaign?.status,
        advertising_channel_type: r.campaign?.advertisingChannelType,
        merchant_id: r.campaign?.shoppingSetting?.merchantId ?? null,
      },
    };
  }
  return {nodes: treeNodes(rows)};
}
const stateNodes = (v: unknown): Node[] =>
  (obj(v) && Array.isArray(v.nodes) ? v.nodes : []).filter(obj).map((n: JsonObject) => ({
    name: n.resource_name,
    type: n.type,
    source: n.listing_source,
    parent: n.parent ?? undefined,
    caseValue: n.case_value ?? undefined,
  }));
/** The listing group nodes of a tree read as Google lists them, in the form the review keeps (sorted by name). */
const treeNodes = (results: unknown): JsonObject[] =>
  (Array.isArray(results) ? results : [])
    .map(googleJson)
    .map(r => (r as JsonObject).assetGroupListingGroupFilter as JsonObject)
    .map(f => ({
      resource_name: f.resourceName,
      type: f.type,
      listing_source: f.listingSource,
      parent: f.parentListingGroupFilter ?? null,
      case_value: f.caseValue ?? null,
    }))
    .sort((a, b) => (a.resource_name < b.resource_name ? -1 : a.resource_name > b.resource_name ? 1 : 0));
/** The tree the request leaves, applied in order as Google does (src/google-tree.ts finalTree). */
const finalOf = (p: CompiledRequest, current: Node[]): Map<string, Node> =>
  finalTree(pmaxTree, operations(p).ops, current);
export function validateGoogleListingGroupPrerequisites(plan: CompiledRequest, state: unknown[]): void {
  if (!googleListingGroupKind(plan)) return;
  const parent = obj(state[0]) ? state[0] : {},
    group = obj(parent.asset_group) ? parent.asset_group : {},
    campaign = obj(parent.campaign) ? parent.campaign : {};
  if (campaign.advertising_channel_type !== 'PERFORMANCE_MAX' || !campaign.merchant_id)
    invalid(
      'Listing group filters partition the Merchant Center products of Performance Max retail campaigns; campaign ' +
        campaign.resource_name +
        ' is ' +
        campaign.advertising_channel_type +
        ' without a linked Merchant Center account.',
    );
  if (!['ENABLED', 'PAUSED'].includes(group.status))
    invalid('Asset group ' + group.resource_name + ' is ' + group.status + '.');
  assertTree(pmaxTree, finalOf(plan, stateNodes(state[1])));
}
export function googleListingGroupImpact(plan: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!googleListingGroupKind(plan)) return;
  const parent = obj(state[0]) ? state[0] : {},
    group = parent.asset_group ?? {},
    campaign = parent.campaign ?? {};
  return {
    provider: 'google',
    scope: 'pmax_listing_groups',
    asset_group: group,
    campaign,
    may_affect_serving: group.status === 'ENABLED' && campaign.status === 'ENABLED',
    effect:
      'Changes which Merchant Center products this asset group can advertise. Included units serve their products; excluded units and removed branches stop them.',
    final_tree: shape(pmaxTree, finalOf(plan, stateNodes(state[1]))),
    verification:
      'Reads the complete tree again and compares its shape (dimension paths and node types) with the reviewed result; Google assigns new IDs to created nodes.',
    source: 'https://developers.google.com/google-ads/api/performance-max/listing-groups',
  };
}
export function googleListingGroupOutcome(plan: CompiledRequest, result: TransportResult): boolean {
  const c = account(plan),
    {group, ops} = operations(plan),
    rows = obj(result.data) ? result.data.results : undefined;
  return (
    [200, 201].includes(result.status) &&
    Array.isArray(rows) &&
    rows.length === ops.length &&
    rows.every((r: JsonObject, i: number) => {
      const op = ops[i]!,
        n = parseNode(c, r?.resourceName);
      return op.remove ? r.resourceName === op.remove : !!n && n.group === group && !n.id.startsWith('-');
    })
  );
}
export function googleListingGroupVerification(
  plan: CompiledRequest,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const {group} = operations(plan);
  return [
    {
      read: search(plan, 'tree', group),
      expected: {tree: shape(pmaxTree, finalOf(plan, stateNodes(before[1])))},
      id: groupName(account(plan), group) + ' listing groups',
    },
  ];
}
export function googleListingGroupObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const nodes = stateNodes(googleListingGroupState(read, data));
  return {tree: shape(pmaxTree, new Map(nodes.map(n => [n.name, n])))};
}
/**
 * What the lookup of an uncertain tree edit compares (R2.5 M2, L2-13), as the family's own read-back does: the query of the
 * asset group's whole tree, the shape the reviewed request gives it (`after`), the shape the review read before it
 * (`before`), and the names the tree had then. Undefined for a request that is no tree edit, or one it cannot work out.
 */
export function googleListingGroupLookup(
  plan: CompiledRequest,
  state: unknown[],
): {group: string; query: string; before: string[]; after: string[]; existing: string[]} | undefined {
  if (!googleListingGroupKind(plan)) return undefined;
  try {
    const {group} = operations(plan),
      current = stateNodes(state[1]),
      body = search(plan, 'tree', group).body;
    return {
      group: groupName(account(plan), group),
      query: String(obj(body) ? body.query : ''),
      before: shape(pmaxTree, new Map(current.map(n => [n.name, n]))),
      after: shape(pmaxTree, finalOf(plan, current)),
      existing: current.map(n => n.name),
    };
  } catch {
    return undefined;
  }
}
/** The shape and the node names of a tree as Google lists it (the rows of the tree read); undefined when it cannot be read. */
export function googleListingGroupTree(results: unknown): {shape: string[]; names: string[]} | undefined {
  try {
    const nodes = stateNodes({nodes: treeNodes(results)});
    return {shape: shape(pmaxTree, new Map(nodes.map(n => [n.name, n]))), names: nodes.map(n => n.name)};
  } catch {
    return undefined;
  }
}
export function googleListingGroupRemoves(p: CompiledRequest): boolean {
  return (
    googleListingGroupKind(p) && (googleJson(p.body).operations as JsonObject[]).some(op => op.remove !== undefined)
  );
}
/** An enabled asset group of an enabled campaign serves at once; unknown state counts as serving. */
export function googleListingGroupServing(p: CompiledRequest, before: unknown): boolean {
  if (!googleListingGroupKind(p)) return false;
  const parent = Array.isArray(before) && obj(before[0]) ? before[0] : undefined;
  return !parent || (parent.asset_group?.status === 'ENABLED' && parent.campaign?.status === 'ENABLED');
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleListingGroupFamily: ReviewedFamily = defineFamily({
  name: 'google_listing_groups',
  files: ['src/google-listing-groups.ts', ['tests/google-listing-groups.test.ts']],
  kind: googleListingGroupKind,
  assert: plan => assertGoogleListingGroups(plan),
  scope: (c, write) => {
    if (write) assertGoogleAdsScope(c);
  },
  snapshots: googleListingGroupSnapshots,
  isRead: isGoogleListingGroupRead,
  validateState: validateGoogleListingGroupState,
  snapshotState: googleListingGroupState,
  prerequisites: (plan, state) => validateGoogleListingGroupPrerequisites(plan, state),
  impact: googleListingGroupImpact,
  outcome: googleListingGroupOutcome,
  verification: (plan: CompiledRequest, result: JsonObject, before: unknown[]) =>
    googleListingGroupVerification(plan, before),
  observed: (read: CompiledRequest, data: JsonObject) =>
    data.amcp_absent === true
      ? data
      : read.googleState?.removedAsAbsent && !data.results?.length
        ? {status: 'REMOVED'}
        : googleListingGroupObserved(read, data),
  spendConfirmation: {
    needed: () => true,
    message:
      'Listing groups decide which Merchant Center products a Performance Max asset group advertises. Review the resulting tree and provide spend_change_confirmed=true.',
  },
  activates: (plan, before) => !!googleListingGroupServing(plan, before),
  destructive: plan => !!googleListingGroupRemoves(plan),
});
