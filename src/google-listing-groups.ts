import {MirrorError} from './errors.js';
import {googleJson, validateGoogleRequest} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {googleAdsCustomers} from './google-version.js';

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
  maxOperations = 500,
  maxNodes = 5000;
type Node = {name: string; type: string; source: string; parent?: string; caseValue?: JsonObject};
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, details: JsonObject = {}): never {
  throw new MirrorError(code, message, details);
}
function invalid(message: string): never {
  return fail('INVALID_LISTING_GROUP', message);
}
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
/** The dimension that splits a node from its siblings and whether it is the "Other" node of that dimension. */
function dimension(caseValue: unknown, at: string): {key: string; other: boolean; value: string} {
  if (!obj(caseValue) || Object.keys(caseValue).length !== 1 || !dimensions[Object.keys(caseValue)[0]!])
    invalid(at + ' needs caseValue with exactly one retail dimension: ' + Object.keys(dimensions).join(', ') + '.');
  const d = Object.keys(caseValue)[0]!,
    spec = dimensions[d]!,
    o = (caseValue as JsonObject)[d];
  if (!obj(o) || Object.keys(o).some(k => k !== spec.value && k !== spec.level))
    invalid(at + '.' + d + ' accepts only ' + [spec.value, spec.level].filter(Boolean).join(' and ') + '.');
  if (spec.level && (typeof o[spec.level] !== 'string' || !o[spec.level]))
    invalid(at + '.' + d + ' needs its ' + spec.level + '.');
  const value = o[spec.value];
  if (value !== undefined && ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()))
    invalid(at + '.' + d + '.' + spec.value + ' must be a nonblank value, or absent for the "Other" node.');
  return {
    key: d + (spec.level ? ':' + o[spec.level] : ''),
    other: value === undefined,
    value: value === undefined ? '' : String(value).trim().toLowerCase(),
  };
}
type Operation = {remove?: string; create?: Node};
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
      ops.push({remove: op.remove});
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
      dimension(r.caseValue, at + '.create');
    } else if (r.caseValue !== undefined) invalid(at + ' creates the root, which has no caseValue.');
    ops.push({
      create: {
        name: own ? String(r.resourceName) : at,
        type: r.type,
        source: r.listingSource,
        parent: r.parentListingGroupFilter,
        caseValue: r.caseValue,
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
  return {
    ...p,
    action: 'AMCP_LISTING_GROUP_READ',
    method: 'POST',
    path: googleAdsCustomers + c + '/googleAds:search',
    body: {query},
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    googleListingGroupState: {kind, group},
  };
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
  const nodes = rows
    .map(r => r.assetGroupListingGroupFilter as JsonObject)
    .map(f => ({
      resource_name: f.resourceName,
      type: f.type,
      listing_source: f.listingSource,
      parent: f.parentListingGroupFilter ?? null,
      case_value: f.caseValue ?? null,
    }));
  return {
    nodes: nodes.sort((a, b) => (a.resource_name < b.resource_name ? -1 : a.resource_name > b.resource_name ? 1 : 0)),
  };
}
const stateNodes = (v: unknown): Node[] =>
  (obj(v) && Array.isArray(v.nodes) ? v.nodes : []).filter(obj).map((n: JsonObject) => ({
    name: n.resource_name,
    type: n.type,
    source: n.listing_source,
    parent: n.parent ?? undefined,
    caseValue: n.case_value ?? undefined,
  }));
/** Applies the operations in order, as Google does, refusing parents removed before their children and children created before their parents. */
function finalTree(p: CompiledRequest, current: Node[]): Map<string, Node> {
  const tree = new Map(current.map(n => [n.name, n])),
    {ops} = operations(p);
  const children = (name: string) => [...tree.values()].filter(n => n.parent === name);
  for (const op of ops) {
    if (op.remove) {
      if (!tree.has(op.remove))
        fail('STATE_NOT_FOUND', 'Listing group filter ' + op.remove + ' does not exist in the asset group.', {
          resource_name: op.remove,
        });
      if (children(op.remove).length)
        invalid('Remove the children of ' + op.remove + ' before it: removals go leaves first.');
      tree.delete(op.remove);
      continue;
    }
    const n = op.create!;
    if (tree.has(n.name)) invalid(n.name + ' already exists.');
    if (n.parent === undefined) {
      if ([...tree.values()].some(x => x.parent === undefined))
        invalid(
          'The asset group already has a root; remove the current tree, leaves first, in the same review to replace it.',
        );
    } else {
      const parent = tree.get(n.parent);
      if (!parent)
        invalid('The parent ' + n.parent + ' of a new node does not exist yet: create parents before their children.');
      if (parent!.type !== 'SUBDIVISION')
        invalid('The parent ' + n.parent + ' is a unit; only subdivisions have children.');
    }
    tree.set(n.name, n);
  }
  return tree;
}
function assertTree(tree: Map<string, Node>): void {
  const nodes = [...tree.values()];
  if (!nodes.length)
    invalid(
      'The asset group would have no listing group tree, and its ads would stop serving. Replace the tree instead, or pause the asset group.',
    );
  if (nodes.some(n => n.source !== 'SHOPPING'))
    invalid('The asset group has webpage listing groups; this contract edits retail (SHOPPING) trees only.');
  const roots = nodes.filter(n => n.parent === undefined);
  if (roots.length !== 1) invalid('The tree needs exactly one root.');
  if (roots[0]!.type === 'UNIT_EXCLUDED')
    invalid('An excluded root would exclude every product; include all products, or subdivide.');
  for (const n of nodes) {
    const kids = nodes.filter(k => k.parent === n.name);
    if (n.type !== 'SUBDIVISION') {
      if (kids.length) invalid('Unit ' + n.name + ' cannot have children.');
      continue;
    }
    if (kids.length < 2) invalid('Subdivision ' + n.name + ' needs at least one product group and an "Other" node.');
    const dims = kids.map(k => dimension(k.caseValue, k.name));
    if (new Set(dims.map(d => d.key)).size !== 1)
      invalid('All children of ' + n.name + ' must use the same dimension (and level or index).');
    if (dims.filter(d => d.other).length !== 1)
      invalid('Subdivision ' + n.name + ' needs exactly one "Other" node, with the dimension and no value.');
    const values = dims.filter(d => !d.other).map(d => d.value);
    if (new Set(values).size !== values.length) invalid('Subdivision ' + n.name + ' repeats a product group value.');
  }
}
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
  assertTree(finalTree(plan, stateNodes(state[1])));
}
/** Every node as its path of dimension values from the root, so trees compare regardless of IDs. */
function shape(tree: Map<string, Node>): string[] {
  const path = (n: Node): string =>
    n.parent === undefined
      ? 'root'
      : path(tree.get(n.parent)!) +
        ' > ' +
        (() => {
          const d = dimension(n.caseValue, n.name);
          return d.key + '=' + (d.other ? '*' : d.value);
        })();
  return [...tree.values()].map(n => path(n) + ' [' + n.type + ']').sort();
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
    final_tree: shape(finalTree(plan, stateNodes(state[1]))),
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
      expected: {tree: shape(finalTree(plan, stateNodes(before[1])))},
      id: groupName(account(plan), group) + ' listing groups',
    },
  ];
}
export function googleListingGroupObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const nodes = stateNodes(googleListingGroupState(read, data));
  return {tree: shape(new Map(nodes.map(n => [n.name, n])))};
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
