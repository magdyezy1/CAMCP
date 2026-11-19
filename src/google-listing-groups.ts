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
  type NodeRule,
  type RefusalDetails,
  type TreeAdapter,
  type TreeNode,
  type TreeOperation,
} from './google-tree.js';
import {
  assertGoogleShoppingTree,
  googleShoppingTreeImpact,
  googleShoppingTreeKind,
  googleShoppingTreeObserved,
  googleShoppingTreeOutcome,
  googleShoppingTreeRemoves,
  googleShoppingTreeServing,
  googleShoppingTreeSnapshots,
  googleShoppingTreeSpendMessage,
  googleShoppingTreeState,
  googleShoppingTreeVerification,
  isGoogleShoppingTreeRead,
  validateGoogleShoppingTreePrerequisites,
  validateGoogleShoppingTreeState,
} from './google-shopping-tree.js';

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
const dimensions: Record<string, {value: string; level?: string; hierarchical?: boolean}> = {
  productBrand: {value: 'value'},
  productCategory: {value: 'categoryId', level: 'level', hierarchical: true},
  productChannel: {value: 'channel'},
  productCondition: {value: 'condition'},
  productCustomAttribute: {value: 'value', level: 'index'},
  productItemId: {value: 'value'},
  productType: {value: 'value', level: 'level', hierarchical: true},
};
const types = new Set(['SUBDIVISION', 'UNIT_INCLUDED', 'UNIT_EXCLUDED']),
  // A tree is one chain Google takes in one request; AMCP bounds it at 500 operations (Q28, owner 2026-11-15: this is no
  // raise of Google's 25 for independent operations, which stay 25).
  maxOperations = chainLimits.tree,
  maxNodes = 5000;
type Node = TreeNode;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string, details: RefusalDetails = {}): never {
  return fail('INVALID_LISTING_GROUP', message, details);
}
/**
 * A Performance Max tree for the shared tree module (src/google-tree.ts): its units are included or excluded, its nodes have
 * the listing source SHOPPING, and what it belongs to is an asset group.
 */
export const pmaxTree: TreeAdapter = {
  code: 'INVALID_LISTING_GROUP',
  fields: {parent: 'parentListingGroupFilter', caseValue: 'caseValue'},
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
  if (!id || !/^\d+$/.test(id)) invalid('Select one Google Ads customer.', {field: 'account_id'});
  return id!;
};
const groupName = (c: string, group: string) => 'customers/' + c + '/assetGroups/' + group;
/** A filter's name as its asset group and node: `temporary` is a build's, whose asset group is one the build creates (`-g~-n`). */
function parseNode(c: string, name: unknown, temporary = false): {group: string; id: string} | undefined {
  const m =
    typeof name === 'string'
      ? new RegExp(
          '^customers/' +
            c +
            '/assetGroupListingGroupFilters/(' +
            (temporary ? '-' : '') +
            '[1-9][0-9]*)~(-?[1-9][0-9]*)$',
        ).exec(name)
      : null;
  return m ? {group: m[1]!, id: m[2]!} : undefined;
}
/**
 * The compile default of a tree create (R2.5 M3, G4a). This family edits retail trees only, so SHOPPING is the one listing
 * source it accepts (a webpage tree is refused below); a create that omits the field gets it here, in the compiled body, so the
 * review's request shows it, the fingerprint covers it, and Google receives exactly what was reviewed. It covers a create on
 * the one-service route and a tree operation of a build, in the spelling the request uses; a value the caller wrote, whatever it
 * is, stays for the refusal; nothing else of the request changes, and the caller's own input is never mutated.
 */
export function withDefaultListingSource(route: string, body: unknown): unknown {
  const build = /\/googleAds:mutate$/.test(route);
  if ((!build && !/\/assetGroupListingGroupFilters:mutate$/.test(route)) || !obj(body)) return body;
  const listKey = build ? ['mutate_operations', 'mutateOperations'].find(k => Array.isArray(body[k])) : 'operations';
  if (!listKey || !Array.isArray(body[listKey])) return body;
  const withSource = (create: unknown): unknown => {
    if (!obj(create) || Object.hasOwn(create, 'listingSource') || Object.hasOwn(create, 'listing_source'))
      return create;
    return Object.keys(create).some(k => k.includes('_'))
      ? {...create, listing_source: 'SHOPPING'}
      : {...create, listingSource: 'SHOPPING'};
  };
  let changed = false;
  const next = (body[listKey] as unknown[]).map(op => {
    if (!obj(op)) return op;
    if (!build) {
      const create = withSource(op.create);
      if (create === op.create) return op;
      changed = true;
      return {...op, create};
    }
    const key = ['asset_group_listing_group_filter_operation', 'assetGroupListingGroupFilterOperation'].find(k =>
      obj(op[k]),
    );
    if (!key) return op;
    const inner = op[key] as JsonObject,
      create = withSource(inner.create);
    if (create === inner.create) return op;
    changed = true;
    return {...op, [key]: {...inner, create}};
  });
  return changed ? {...body, [listKey]: next} : body;
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
/** An operation of the review and the asset group whose tree it edits. */
type Operation = TreeOperation & {group: string};
/**
 * The most asset groups one tree review edits (R2.5 M3, G4b): two reads per group at prepare and at execute, within the
 * five-minute window.
 */
const maxGroups = 10;
/** The review's operations, in order, and the asset groups they edit, by ID (a retail launch has several groups: G4b). */
function operations(p: CompiledRequest): {groups: string[]; ops: Operation[]} {
  const c = account(p),
    b = googleJson(p.body),
    ops: Operation[] = [],
    groups = new Set<string>();
  const joins = (g: string, field: string, i: number) => {
    groups.add(g);
    if (groups.size > maxGroups)
      invalid(
        'A review edits the trees of at most ' +
          maxGroups +
          ' asset groups; ' +
          field +
          ' is asset group number ' +
          groups.size +
          '.',
        {operation: i, field, rule: 'group_limit', limit: maxGroups, groups: groups.size},
      );
  };
  for (const [i, op] of (b.operations as JsonObject[]).entries()) {
    const at = 'operations[' + i + ']';
    if (op.remove !== undefined) {
      const n = parseNode(c, op.remove);
      if (!n || n.id.startsWith('-'))
        invalid(at + '.remove must be an existing listing group filter of the selected customer.', {
          operation: i,
          field: at + '.remove',
          rule: 'remove_target',
        });
      joins(n!.group, at + '.remove', i);
      ops.push({remove: op.remove, op: i, at: at + '.remove', group: n!.group});
      continue;
    }
    const {group, node} = pmaxCreate(c, op.create, at, i);
    joins(group, at + '.create.assetGroup', i);
    ops.push({create: node, group});
  }
  return {groups: [...groups].sort((a, b) => Number(a) - Number(b)), ops};
}
/**
 * One create of a tree, checked for what it is by itself: its keys, its asset group, type, listing source, name, parent and
 * case value; the tree rules are the shared module's (src/google-tree.ts). `at` is where the operation is in the request and `i`
 * its index. A build's tree operation meets the same checks (R2.5 M3, L2-09), `temporary` being its asset group, which the build
 * creates and names `-g`, so that its filters are named `-g~-n`. Its keys are camelCase (the caller reads them with googleJson).
 */
export function pmaxCreate(
  c: string,
  r: unknown,
  at: string,
  i: number,
  temporary = false,
): {group: string; node: TreeNode} {
  // Every refusal of a create names the operation and the field it is about, and the closed list where it has one (L2-07).
  const about = (field: string, rule: NodeRule, extra: JsonObject = {}): JsonObject => ({
    operation: i,
    field: at + '.create' + field,
    rule,
    ...extra,
  });
  const keys = ['resourceName', 'assetGroup', 'type', 'listingSource', 'caseValue', 'parentListingGroupFilter'];
  if (!obj(r) || Object.keys(r).some(k => !keys.includes(k)))
    invalid(
      at +
        '.create accepts resourceName, assetGroup, type, listingSource, caseValue and parentListingGroupFilter only.',
      about('', 'create_keys', {allowed: keys}),
    );
  const g = new RegExp('^customers/(\\d+)/assetGroups/(' + (temporary ? '-' : '') + '[1-9][0-9]*)$').exec(
    String(r.assetGroup),
  );
  if (!g || g[1] !== c)
    invalid(
      at + '.create.assetGroup must be an asset group of the selected customer.',
      about('.assetGroup', 'create_group'),
    );
  const group = g![2]!;
  if (!types.has(r.type))
    invalid(
      at + '.create.type must be SUBDIVISION, UNIT_INCLUDED or UNIT_EXCLUDED.',
      about('.type', 'node_type', {allowed: [...types]}),
    );
  if (r.listingSource !== 'SHOPPING')
    invalid(
      at + '.create.listingSource must be SHOPPING; webpage listing groups are not reviewed here.',
      about('.listingSource', 'listing_source', {allowed: ['SHOPPING']}),
    );
  const own = r.resourceName === undefined ? undefined : parseNode(c, r.resourceName, temporary);
  if (r.resourceName !== undefined && (!own || !own.id.startsWith('-') || own.group !== group))
    invalid(
      at +
        '.create.resourceName must be a temporary name customers/' +
        c +
        '/assetGroupListingGroupFilters/' +
        group +
        '~-N.',
      about('.resourceName', 'node_name'),
    );
  if (r.type === 'SUBDIVISION' && !own)
    invalid(
      at + ' creates a subdivision; give it a temporary resourceName so its children can name it.',
      about('.resourceName', 'subdivision_unnamed'),
    );
  if (r.parentListingGroupFilter !== undefined) {
    const parent = parseNode(c, r.parentListingGroupFilter, temporary);
    if (!parent || parent.group !== group)
      invalid(
        at + '.create.parentListingGroupFilter must be a listing group filter of the same asset group.',
        about('.parentListingGroupFilter', 'parent_link'),
      );
    dimension(pmaxTree, r.caseValue, at + '.create', {operation: i, field: at + '.create.caseValue'});
  } else if (r.caseValue !== undefined)
    invalid(at + ' creates the root, which has no caseValue.', about('.caseValue', 'root_case_value'));
  return {
    group,
    node: {
      name: own ? String(r.resourceName) : at,
      type: r.type,
      source: r.listingSource,
      parent: r.parentListingGroupFilter,
      caseValue: r.caseValue,
      op: i,
      at: at + '.create',
    },
  };
}
export function assertGoogleListingGroups(p: CompiledRequest): void {
  if (!googleListingGroupKind(p)) return;
  const c = account(p);
  if (p.path.split('/')[3] !== c)
    fail('ACCOUNT_SCOPE_MISMATCH', 'The Google Ads path must belong to the selected customer.');
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Listing group reviews take no query or header overrides.', {
      field: Object.keys(p.query).length ? 'query' : 'headers',
    });
  const b = googleJson(p.body);
  if (
    !obj(b) ||
    Object.keys(b).some(k => !['operations', 'responseContentType'].includes(k)) ||
    (b.responseContentType !== undefined && b.responseContentType !== 'RESOURCE_NAME_ONLY')
  )
    invalid(
      'Send operations, optionally with responseContentType RESOURCE_NAME_ONLY; validateOnly is not reviewed.',
      !obj(b)
        ? {field: 'body'}
        : Object.keys(b).some(k => !['operations', 'responseContentType'].includes(k))
          ? {
              field: Object.keys(b).find(k => !['operations', 'responseContentType'].includes(k)),
              allowed: ['operations', 'responseContentType'],
            }
          : {field: 'responseContentType', allowed: ['RESOURCE_NAME_ONLY']},
    );
  // A tree is one chain linked by temporary names, which is never split: a longer one is refused as such (R2.5 M3, G4c).
  assertChainWithin(b.operations, maxOperations, p.action);
  if (!Array.isArray(b.operations) || !b.operations.length || b.operations.length > maxOperations)
    invalid('Review 1 to ' + maxOperations + ' listing group operations.', {field: 'operations', limit: maxOperations});
  validateGoogleRequest(p);
  const bad = (b.operations as unknown[]).findIndex(
    op => !obj(op) || Object.keys(op).length !== 1 || !['create', 'remove'].includes(Object.keys(op)[0]!),
  );
  if (bad >= 0)
    invalid('Each operation creates or removes one node; type, asset group and listing source cannot be updated.', {
      operation: bad,
      field: 'operations[' + bad + ']',
      rule: 'operation_kind',
      allowed: ['create', 'remove'],
    });
  const {ops} = operations(p),
    names = new Set<string>();
  for (const op of ops) {
    const name = op.remove ?? op.create!.name;
    if (names.has(name))
      invalid(name + ' appears twice in this review.', {
        operation: op.remove ? op.op : op.create!.op,
        field: op.remove ? op.at : op.create!.at + '.resourceName',
        rule: 'node_twice',
      });
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
/**
 * For each asset group the review edits, by ID: the asset group with its campaign, then its complete listing group tree. The state
 * of the group at index i of `operations(p).groups` is `state[2 * i]` (the group) and `state[2 * i + 1]` (its tree).
 */
export function googleListingGroupSnapshots(p: CompiledRequest): CompiledRequest[] {
  return operations(p).groups.flatMap(group => [search(p, 'group', group), search(p, 'tree', group)]);
}
/**
 * The read of the whole tree of one asset group, by the group's resource name, marked as this family's so that its answer is
 * projected to the shape the family compares: a build's read-back of the tree it created, whose real asset group the
 * mutate's result names (R2.5 M3, L2-09).
 */
export function googleListingGroupTreeRead(p: CompiledRequest, assetGroup: string): CompiledRequest {
  return search(p, 'tree', assetGroup.split('/').at(-1)!);
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
/** The tree one asset group is left with by the request, applied in order as Google does (src/google-tree.ts finalTree). */
const finalOf = (p: CompiledRequest, group: string, current: Node[]): Map<string, Node> =>
  finalTree(
    pmaxTree,
    operations(p).ops.filter(o => o.group === group),
    current,
  );
/** What the review read of the asset group at index `i` of the review: its asset group and campaign, and its tree (G4b). */
const readOfGroup = (state: unknown, i: number) => {
  const list = Array.isArray(state) ? state : [];
  return {parent: obj(list[2 * i]) ? list[2 * i] : ({} as JsonObject), tree: list[2 * i + 1]};
};
/** A tree partitions the Merchant Center products of a Performance Max retail campaign: its channel and its Merchant Center account. */
export function assertRetailCampaign(campaign: JsonObject, details: JsonObject = {}): void {
  if (campaign.advertising_channel_type !== 'PERFORMANCE_MAX' || !campaign.merchant_id)
    invalid(
      'Listing group filters partition the Merchant Center products of Performance Max retail campaigns; campaign ' +
        campaign.resource_name +
        ' is ' +
        campaign.advertising_channel_type +
        ' without a linked Merchant Center account.',
      details,
    );
}
export function validateGoogleListingGroupPrerequisites(plan: CompiledRequest, state: unknown[]): void {
  if (!googleListingGroupKind(plan)) return;
  const {groups, ops} = operations(plan);
  groups.forEach((g, i) => {
    const {parent, tree} = readOfGroup(state, i),
      group = obj(parent.asset_group) ? parent.asset_group : {},
      campaign = obj(parent.campaign) ? parent.campaign : {};
    // The first operation that names the asset group is what the refusal points at (L2-07).
    const first = ops.find(o => o.group === g),
      where: JsonObject = first
        ? {
            operation: first.remove ? first.op : first.create!.op,
            field: first.remove ? first.at : first.create!.at + '.assetGroup',
          }
        : {field: 'operations'};
    assertRetailCampaign(campaign, where);
    if (!['ENABLED', 'PAUSED'].includes(group.status))
      invalid('Asset group ' + group.resource_name + ' is ' + group.status + '.', {
        ...where,
        allowed: ['ENABLED', 'PAUSED'],
      });
    assertTree(pmaxTree, finalOf(plan, g, stateNodes(tree)));
  });
}
export function googleListingGroupImpact(plan: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!googleListingGroupKind(plan)) return;
  const each = operations(plan).groups.map((g, i) => {
      const {parent, tree} = readOfGroup(state, i),
        group = parent.asset_group ?? {},
        campaign = parent.campaign ?? {};
      return {
        asset_group: group,
        campaign,
        may_affect_serving: group.status === 'ENABLED' && campaign.status === 'ENABLED',
        final_tree: shape(pmaxTree, finalOf(plan, g, stateNodes(tree))),
      };
    }),
    first = each[0]!;
  // One group keeps the keys a review of one asset group always had; several add `groups`, and the keys of the first stay (G4b).
  return {
    provider: 'google',
    scope: 'pmax_listing_groups',
    asset_group: first.asset_group,
    campaign: first.campaign,
    may_affect_serving: each.some(e => e.may_affect_serving),
    effect:
      each.length > 1
        ? 'Changes which Merchant Center products these asset groups can advertise (asset_group, campaign and final_tree are the first group’s; groups lists each). Included units serve their products; excluded units and removed branches stop them.'
        : 'Changes which Merchant Center products this asset group can advertise. Included units serve their products; excluded units and removed branches stop them.',
    final_tree: first.final_tree,
    ...(each.length > 1 ? {groups: each} : {}),
    verification:
      'Reads the complete tree again and compares its shape (dimension paths and node types) with the reviewed result; Google assigns new IDs to created nodes.',
    source: 'https://developers.google.com/google-ads/api/performance-max/listing-groups',
  };
}
export function googleListingGroupOutcome(plan: CompiledRequest, result: TransportResult): boolean {
  const c = account(plan),
    {ops} = operations(plan),
    rows = obj(result.data) ? result.data.results : undefined;
  return (
    [200, 201].includes(result.status) &&
    Array.isArray(rows) &&
    rows.length === ops.length &&
    rows.every((r: JsonObject, i: number) => {
      const op = ops[i]!,
        n = parseNode(c, r?.resourceName);
      // Each result answers its own operation, in the asset group that operation edits (G4b).
      return op.remove ? r.resourceName === op.remove : !!n && n.group === op.group && !n.id.startsWith('-');
    })
  );
}
/** One tree read per asset group of the review, each compared by shape with the tree the request leaves that group. */
export function googleListingGroupVerification(
  plan: CompiledRequest,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  return operations(plan).groups.map((g, i) => ({
    read: search(plan, 'tree', g),
    expected: {tree: shape(pmaxTree, finalOf(plan, g, stateNodes(readOfGroup(before, i).tree)))},
    id: groupName(account(plan), g) + ' listing groups',
  }));
}
export function googleListingGroupObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const nodes = stateNodes(googleListingGroupState(read, data));
  return {tree: shape(pmaxTree, new Map(nodes.map(n => [n.name, n])))};
}
/**
 * What the lookup of an uncertain tree edit compares for one asset group (R2.5 M2, L2-13), as the family's own read-back does:
 * the query of the asset group's whole tree, the shape the reviewed request gives it (`after`), the shape the review read before
 * it (`before`), and the names the tree had then.
 */
export interface ListingGroupLookup {
  group: string;
  query: string;
  before: string[];
  after: string[];
  existing: string[];
}
/**
 * The lookup of each asset group the review edits, in the order of `operations(plan).groups` (R2.5 M3, G4b: the lookup of a review
 * of several groups covers every one). Undefined for a request that is no tree edit, or one it cannot work out.
 */
export function googleListingGroupLookup(plan: CompiledRequest, state: unknown[]): ListingGroupLookup[] | undefined {
  if (!googleListingGroupKind(plan)) return undefined;
  try {
    return operations(plan).groups.map((g, i) => {
      const current = stateNodes(readOfGroup(state, i).tree),
        body = search(plan, 'tree', g).body;
      return {
        group: groupName(account(plan), g),
        query: String(obj(body) ? body.query : ''),
        before: shape(pmaxTree, new Map(current.map(n => [n.name, n]))),
        after: shape(pmaxTree, finalOf(plan, g, current)),
        existing: current.map(n => n.name),
      };
    });
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
/** An enabled asset group of an enabled campaign serves at once; unknown state counts as serving, and one group that serves is enough (G4b). */
export function googleListingGroupServing(p: CompiledRequest, before: unknown): boolean {
  if (!googleListingGroupKind(p)) return false;
  let groups: string[];
  try {
    groups = operations(p).groups;
  } catch {
    return true;
  }
  return groups.some((_, i) => {
    const parent = Array.isArray(before) && obj(before[2 * i]) ? before[2 * i] : undefined;
    return !parent || (parent.asset_group?.status === 'ENABLED' && parent.campaign?.status === 'ENABLED');
  });
}

/**
 * Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). One family serves both listing group trees
 * (R2.5 M3, G5): the filters of a Performance Max asset group (`assetGroupListingGroupFilters:mutate`, this module) and the
 * listing group criteria of a Standard Shopping ad group (an `adGroupCriteria:mutate` that creates one, src/google-shopping-tree.ts),
 * each with its own hooks, chosen by the request or by the read's marker. It is one family because a family must own a route of the
 * action ledger (tests/reviewed-families.test.mjs) and the ledger classifies a route with a plan whose body is empty: a family
 * that claims `adGroupCriteria:mutate` only for a listing group create, as this one must, owns none, since the targeting family owns
 * every row of that route. The Shopping hooks are `shopping`-prefixed in their own module, and `tests/google-shopping-tree.test.mjs`
 * (with its conformance variant) tests them through this family.
 */
const shopping = googleShoppingTreeKind;
export const googleListingGroupFamily: ReviewedFamily = defineFamily({
  name: 'google_listing_groups',
  files: [
    'src/google-listing-groups.ts / src/google-shopping-tree.ts',
    ['tests/google-listing-groups.test.ts', 'tests/google-shopping-tree.test.mjs'],
  ],
  kind: plan => googleListingGroupKind(plan) || shopping(plan),
  assert: plan => (shopping(plan) ? assertGoogleShoppingTree(plan) : assertGoogleListingGroups(plan)),
  scope: (c, write) => {
    if (write) assertGoogleAdsScope(c);
  },
  snapshots: plan => (shopping(plan) ? googleShoppingTreeSnapshots(plan) : googleListingGroupSnapshots(plan)),
  isRead: read => isGoogleListingGroupRead(read) || isGoogleShoppingTreeRead(read),
  validateState: (read, result) =>
    isGoogleShoppingTreeRead(read)
      ? validateGoogleShoppingTreeState(read, result)
      : validateGoogleListingGroupState(read, result),
  snapshotState: (read, data) =>
    isGoogleShoppingTreeRead(read) ? googleShoppingTreeState(read, data) : googleListingGroupState(read, data),
  prerequisites: (plan, state) =>
    shopping(plan)
      ? validateGoogleShoppingTreePrerequisites(plan, state)
      : validateGoogleListingGroupPrerequisites(plan, state),
  impact: (plan, state) =>
    shopping(plan) ? googleShoppingTreeImpact(plan, state) : googleListingGroupImpact(plan, state),
  outcome: (plan, result) =>
    shopping(plan) ? googleShoppingTreeOutcome(plan, result) : googleListingGroupOutcome(plan, result),
  verification: (plan: CompiledRequest, result: JsonObject, before: unknown[]) =>
    shopping(plan) ? googleShoppingTreeVerification(plan, before) : googleListingGroupVerification(plan, before),
  observed: (read: CompiledRequest, data: JsonObject) =>
    data.amcp_absent === true
      ? data
      : read.googleState?.removedAsAbsent && !data.results?.length
        ? {status: 'REMOVED'}
        : isGoogleShoppingTreeRead(read)
          ? googleShoppingTreeObserved(read, data)
          : googleListingGroupObserved(read, data),
  spendConfirmation: {
    needed: () => true,
    message: plan =>
      shopping(plan)
        ? googleShoppingTreeSpendMessage
        : 'Listing groups decide which Merchant Center products a Performance Max asset group advertises. Review the resulting tree and provide spend_change_confirmed=true.',
  },
  activates: (plan, before) =>
    shopping(plan) ? !!googleShoppingTreeServing(plan, before) : !!googleListingGroupServing(plan, before),
  destructive: plan => (shopping(plan) ? !!googleShoppingTreeRemoves(plan) : !!googleListingGroupRemoves(plan)),
});
