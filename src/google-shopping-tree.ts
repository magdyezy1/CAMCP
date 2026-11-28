import {fail, readOf} from './family-kit.js';
import {googleBody, googleJson, validateGoogleRequest} from './google-contracts.js';
import {assertChainWithin} from './google-temp-names.js';
import {
  assertTree,
  dimension,
  finalTree,
  isValidateOnlyKey,
  listedShape,
  shape,
  treeChange,
  treeLimit,
  validateOnlySentence,
  wholeTree,
  type RefusalDetails,
  type TreeAdapter,
  type TreeChange,
  type TreeNode,
  type TreeOperation,
} from './google-tree.js';
import {googleAdsCustomers} from './google-version.js';
import type {TransportResult} from './transport.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Standard Shopping product trees (R2.5 M3, G5): the listing group criteria of a SHOPPING_PRODUCT_ADS ad group, per Google
 * Ads API "Create listing groups" (https://developers.google.com/google-ads/api/docs/shopping-ads/create-listing-groups,
 * read 2026-11-17): "you are required to upload the entire tree in a single request"; a new subdivision comes with at least
 * one child and an "Other" node in the same request; only a UNIT takes a bid; siblings share a dimension subtype; a node's
 * temporary name is `customers/{customer_id}/adGroupCriteria/{ad_group_id}~{temporary_criterion_id}`. A node is an ad group
 * criterion whose `listing_group` has a `type` (SUBDIVISION or UNIT), the `case_value` that refines its parent (none on the
 * root) and `parent_ad_group_criterion`; a unit that excludes its products is a UNIT with `negative: true`, and the bid
 * (`cpc_bid_micros`) is on units only. This module holds the node adapter of the shared tree module (src/google-tree.ts), which
 * Performance Max (src/google-listing-groups.ts) describes for its own nodes, and the hooks of a one-service review of one ad
 * group's tree, the same lifecycle as the Performance Max family's: it reads the ad group with its campaign and the whole tree
 * (paged or foreign rows are refused), checks the tree the request leaves, needs the spend confirmation, counts a removal as a
 * deletion and a serving ad group as an activation, and reads the tree back by shape. A bid update of an existing unit stays
 * with the targeting family (src/google-targeting-writes.ts), which takes `update` with `cpc_bid_micros`.
 */

/**
 * The dimensions a Standard Shopping case value may name, with the field that holds a value (absent for the "Other" node) and
 * the level or index that splits siblings, as `ListingDimensionInfo` and its `Product*Info` messages list them in the pinned
 * v25 Discovery document (.mirror/VENDOR/google-ads-v25.json). Performance Max's list is shorter: Shopping adds the channel
 * exclusivity. The hotel and activity dimensions are travel feeds, and productLabels, productTypeFull, productLegacyCondition
 * and productGrouping are deprecated and "supported only in Display campaigns", so none of them is a Shopping dimension here.
 */
export const shoppingDimensions: Readonly<Record<string, {value: string; level?: string; hierarchical?: boolean}>> =
  Object.freeze({
    productBrand: {value: 'value'},
    productCategory: {value: 'categoryId', level: 'level', hierarchical: true},
    productChannel: {value: 'channel'},
    productChannelExclusivity: {value: 'channelExclusivity'},
    productCondition: {value: 'condition'},
    productCustomAttribute: {value: 'value', level: 'index'},
    productItemId: {value: 'value'},
    productType: {value: 'value', level: 'level', hierarchical: true},
  });
/** The input refusals of a Standard Shopping tree (src/google-remedies.ts holds its remedy). */
export const shoppingTreeCode = 'INVALID_SHOPPING_LISTING_GROUP';
function invalid(message: string, details: RefusalDetails = {}): never {
  return fail(shoppingTreeCode, message, details);
}
/**
 * A Standard Shopping tree for the shared tree module: its units are UNIT nodes, excluded when negative, and carry the bid;
 * what it belongs to is an ad group. The shape shows a unit's exclusion and its bid, and a unit's status when it is not ENABLED (an
 * omitted status reads as ENABLED, the default), so the read-back compares them too: a unit Google lists with a status this version
 * cannot name (UNKNOWN) is not verified as the enabled unit that was sent (R2.5 M3 round 3, N4). A build reads its tree back by this
 * shape alone.
 *
 * It does not show a subdivision's status or its bid, and a create may not send a status other than ENABLED (`shoppingCreate`): package
 * r25-m3-live (F2) replaced the assumption of rounds 2 and 3 (S3-3, N4) that Google keeps the status a create sets, so that a node asked
 * for paused is verified only when it is stored paused. The lead's live runs of 2026-11-20 on a Google test account show it does not: a
 * UNIT sent PAUSED reads back ENABLED; a SUBDIVISION sent with no status reads back PAUSED, and so does every subdivision of a tree; and a
 * new subdivision keeps the cpc_bid_micros of the unit whose criterion ID it took (Google reuses the ID of a removed node for a new node of
 * the same dimension, and leaves no REMOVED row). None of that is the request's, so the verification no longer calls it a mismatch.
 * Performance Max trees (src/google-listing-groups.ts) are NOT changed: nothing live shows how its filters answer, and its nodes carry
 * no status and no bid in the shape.
 */
export const shoppingTree: TreeAdapter = {
  code: shoppingTreeCode,
  fields: {parent: 'listingGroup.parentAdGroupCriterion', caseValue: 'listingGroup.caseValue'},
  dimensions: shoppingDimensions,
  isSubdivision: n => n.type === 'SUBDIVISION',
  isUnit: n => n.type === 'UNIT',
  isExcluded: n => n.type === 'UNIT' && n.negative === true,
  label: n =>
    n.type === 'UNIT'
      ? (n.negative ? 'UNIT_EXCLUDED' : 'UNIT') +
        (n.bid !== undefined ? ' bid=' + n.bid : '') +
        (n.status && n.status !== 'ENABLED' ? ' status=' + n.status : '')
      : n.type,
  node(n) {
    // The node is in the details of each refusal, so a message is one fixed sentence, which the website translates (R2.5 M3 round 2, S4-5).
    // The field is in the spelling of a review's create, camelCase (cpcBidMicros, R2.5 M3 round 3, N1); a build writes it cpc_bid_micros
    // (inBuild in src/google-build-trees.ts).
    const where = (field: string): JsonObject => ({
      ...(n.op !== undefined ? {operation: n.op} : {}),
      node: n.name,
      field: n.at ? n.at + field : wholeTree,
    });
    if (n.type === 'UNIT') {
      // Google refuses a bid on a negative criterion (CriterionError FIELD_INCOMPATIBLE_WITH_NEGATIVE_TARGETING; the guide: "Negative
      // criteria are exclusions, so bids don't apply to them", R2.5 M3 round 2, S3-1). It is the request's bid that is refused: a node
      // read from Google (no `op`) is Google's own state, and never fails a review of something else.
      if (n.negative === true && n.bid !== undefined && n.op !== undefined)
        invalid('An excluded unit takes no bid; Google refuses a bid on a negative criterion.', {
          ...where('.cpcBidMicros'),
          rule: 'bid_on_excluded_unit',
        });
      return;
    }
    if (n.type !== 'SUBDIVISION') return;
    // The same for a subdivision (R2.5 M3 round 3, N3): a bid or a negative flag that the request creates on one is refused, and one that
    // Google lists on a subdivision that exists (an inherited bid, say) is Google's own state, which never fails a review of something else.
    if (n.bid !== undefined && n.op !== undefined)
      invalid('A subdivision takes no bid; only a unit does.', {
        ...where('.cpcBidMicros'),
        rule: 'bid_on_subdivision',
      });
    if (n.negative === true && n.op !== undefined)
      invalid('A subdivision cannot be negative; only a unit excludes products.', {
        ...where('.negative'),
        rule: 'negative_subdivision',
      });
  },
  tree(nodes) {
    // Not checked here: a positive unit without a bid. The guide says a bid is required if the bidding strategy needs one, such as Manual CPC,
    // and this adapter hook sees no campaign. R2.5 M3 round 2 (S3-1) left it to Google, which refuses such a tree at execute, atomically; package
    // r25-m3-live (F4) refuses it at prepare where the campaign's strategy is known: `assertUnitBids`, which a review calls with the strategy
    // its ad group read names and a build with the one its campaign names.
    if (!nodes.some(n => n.type === 'UNIT'))
      invalid('A product tree needs at least one unit, the product group that bids.', {
        field: wholeTree,
        rule: 'no_unit',
      });
  },
  refuse: {
    missing: (name, details) =>
      fail('STATE_NOT_FOUND', 'Listing group ' + name + ' does not exist in the ad group.', {
        resource_name: name,
        ...details,
      }),
    existingRoot: details =>
      invalid(
        'The ad group already has a root; remove the current tree, leaves first, in the same review to replace it.',
        details,
      ),
    emptyTree: details =>
      invalid(
        'The ad group would have no listing group tree, and its products would stop serving. Replace the tree instead, or pause the ad group.',
        details,
      ),
  },
};

const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) invalid('Select one Google Ads customer.', {field: 'account_id'});
  return id!;
};
const adGroupName = (c: string, adGroup: string) => 'customers/' + c + '/adGroups/' + adGroup;
// A tree is one chain Google takes in one request; AMCP bounds a hand-sent one at 500 operations (Q28, owner 2026-11-15: this is no raise of
// Google's 25 for independent operations, which stay 25) and one the server built at 10,000 (`treeLimit`, src/google-tree.ts).
const maxNodes = 5000;
/**
 * A criterion's name as its ad group and node: `temporary` is a build's, whose ad group is one the build creates (`-ag~-n`);
 * otherwise the ad group is an existing ID, and the node an existing ID or a temporary `-n`.
 */
function parseNode(c: string, name: unknown, temporary = false): {adGroup: string; id: string} | undefined {
  const m =
    typeof name === 'string'
      ? new RegExp(
          '^customers/' + c + '/adGroupCriteria/(' + (temporary ? '-' : '') + '[1-9][0-9]*)~(-?[1-9][0-9]*)$',
        ).exec(name)
      : null;
  return m ? {adGroup: m[1]!, id: m[2]!} : undefined;
}
/** The request's operations, camelCase, or none when its body is no operation list. */
function bodyOperations(p: CompiledRequest): unknown[] | undefined {
  try {
    const list = (googleBody(p.body) as JsonObject | undefined)?.operations;
    return Array.isArray(list) ? list : undefined;
  } catch {
    return undefined;
  }
}
/**
 * The requests this review owns (R2.5 M3, G5 route B): a mutation of ad group criteria in which at least one operation creates a
 * listing group. The targeting family claims every other `adGroupCriteria:mutate`, a pure removal of nodes included, and its
 * own `kind` leaves these out (src/google-targeting-writes.ts), so no request has two owners. Whatever else such a request
 * carries (a keyword beside the tree) is this review's refusal, not the targeting family's cryptic "Unqualified or immutable field".
 */
export function googleShoppingTreeKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'google_ads_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    /^\/v\d+\/customers\/\d+\/adGroupCriteria:mutate$/.test(p.path) &&
    !!bodyOperations(p)?.some(op => object(op) && object(op.create) && op.create.listingGroup !== undefined)
  );
}

/**
 * One create of a Standard Shopping tree, checked for what it is by itself: its keys, its ad group, listing group type, bid,
 * status, name, parent and case value; the tree rules are the shared module's. `at` is where the operation is in the request and
 * `i` its index. A build's tree operation meets the same checks (R2.5 M3, G5 route A), `temporary` being its ad group, which the
 * build creates and names `-ag`, so that its criteria are named `-ag~-n`. Its keys are camelCase (the caller reads them with googleJson).
 */
export function shoppingCreate(
  c: string,
  r: unknown,
  at: string,
  i: number,
  temporary = false,
): {adGroup: string; node: TreeNode} {
  const allowed = ['resourceName', 'adGroup', 'listingGroup', 'negative', 'cpcBidMicros', 'status'];
  if (!object(r) || Object.keys(r).some(k => !allowed.includes(k)))
    invalid(at + '.create accepts resourceName, adGroup, listingGroup, negative, cpcBidMicros and status only.', {
      operation: i,
      field: at + '.create',
      rule: 'create_keys',
      allowed,
    });
  const g = new RegExp('^customers/(\\d+)/adGroups/(' + (temporary ? '-' : '') + '[1-9][0-9]*)$').exec(
    String(r.adGroup),
  );
  if (!g || g[1] !== c)
    invalid(at + '.create.adGroup must be an ad group of the selected customer.', {
      operation: i,
      field: at + '.create.adGroup',
      rule: 'create_group',
    });
  const adGroup = g![2]!,
    lg = r.listingGroup;
  if (!object(lg) || Object.keys(lg).some(k => !['type', 'caseValue', 'parentAdGroupCriterion'].includes(k)))
    invalid(at + '.create.listingGroup accepts type, caseValue and parentAdGroupCriterion only.', {
      operation: i,
      field: at + '.create.listingGroup',
      rule: 'listing_group_keys',
      allowed: ['type', 'caseValue', 'parentAdGroupCriterion'],
    });
  const listing = lg as JsonObject;
  if (!['SUBDIVISION', 'UNIT'].includes(listing.type))
    invalid(at + '.create.listingGroup.type must be SUBDIVISION or UNIT.', {
      operation: i,
      field: at + '.create.listingGroup.type',
      rule: 'node_type',
      allowed: ['SUBDIVISION', 'UNIT'],
    });
  if (r.negative !== undefined && typeof r.negative !== 'boolean')
    invalid(at + '.create.negative must be true or false.', {
      operation: i,
      field: at + '.create.negative',
      rule: 'negative_value',
    });
  // Package r25-m3-live (F2): Google does not keep a listing group's status (the lead's live runs of 2026-11-20: a unit sent PAUSED reads back
  // ENABLED), so a create that asks for one other than ENABLED is refused here, before any request, in a build and on route B alike. This
  // replaced round 2's S3-3, which accepted PAUSED and verified it stored PAUSED. The rule is the one of a status that does not exist.
  if (r.status !== undefined && r.status !== 'ENABLED')
    invalid(
      'Google does not keep a listing group’s status, so a node cannot be created with a status other than ENABLED: leave status out, and pause the ad group instead to stop its products.',
      {
        operation: i,
        field: at + '.create.status',
        rule: 'status_value',
        allowed: ['ENABLED'],
      },
    );
  const bid = r.cpcBidMicros;
  if (bid !== undefined && !(typeof bid === 'string' ? /^\d{1,19}$/.test(bid) : Number.isSafeInteger(bid) && bid >= 0))
    invalid(at + '.create.cpcBidMicros must be a whole number of micros, as a decimal string.', {
      operation: i,
      field: at + '.create.cpcBidMicros',
      rule: 'bid_value',
    });
  const own = r.resourceName === undefined ? undefined : parseNode(c, r.resourceName, temporary);
  if (r.resourceName !== undefined && (!own || !own.id.startsWith('-') || own.adGroup !== adGroup))
    invalid(
      at + '.create.resourceName must be a temporary name customers/' + c + '/adGroupCriteria/' + adGroup + '~-N.',
      {operation: i, field: at + '.create.resourceName', rule: 'node_name'},
    );
  if (listing.type === 'SUBDIVISION' && !own)
    invalid(at + ' creates a subdivision; give it a temporary resourceName so its children can name it.', {
      operation: i,
      field: at + '.create.resourceName',
      rule: 'subdivision_unnamed',
    });
  if (listing.parentAdGroupCriterion !== undefined) {
    const parent = parseNode(c, listing.parentAdGroupCriterion, temporary);
    if (!parent || parent.adGroup !== adGroup)
      invalid(at + '.create.listingGroup.parentAdGroupCriterion must be a listing group of the same ad group.', {
        operation: i,
        field: at + '.create.listingGroup.parentAdGroupCriterion',
        rule: 'parent_link',
      });
    dimension(shoppingTree, listing.caseValue, at + '.create.listingGroup', {
      operation: i,
      field: at + '.create.listingGroup.caseValue',
    });
  } else if (listing.caseValue !== undefined)
    invalid(at + ' creates the root, which has no caseValue.', {
      operation: i,
      field: at + '.create.listingGroup.caseValue',
      rule: 'root_case_value',
    });
  return {
    adGroup,
    node: {
      name: own ? String(r.resourceName) : at,
      type: listing.type,
      parent: listing.parentAdGroupCriterion,
      caseValue: listing.caseValue,
      negative: r.negative === true,
      ...(bid !== undefined ? {bid: String(bid)} : {}),
      ...(r.status !== undefined ? {status: String(r.status)} : {}),
      op: i,
      at: at + '.create',
    },
  };
}
/** The review's operations, in order, and the ad group they edit. */
function operations(p: CompiledRequest): {adGroup: string; ops: TreeOperation[]} {
  const c = account(p),
    ops: TreeOperation[] = [];
  let adGroup: string | undefined;
  const same = (g: string, field: string, i: number) => {
    if (adGroup !== undefined && g !== adGroup)
      invalid('A review edits the tree of one ad group.', {operation: i, field, rule: 'one_group'});
    adGroup = g;
  };
  for (const [i, op] of (bodyOperations(p) as JsonObject[]).entries()) {
    const at = 'operations[' + i + ']';
    if (op.remove !== undefined) {
      const n = parseNode(c, op.remove);
      if (!n || n.id.startsWith('-'))
        invalid(at + '.remove must be an existing listing group of the selected customer.', {
          operation: i,
          field: at + '.remove',
          rule: 'remove_target',
        });
      same(n!.adGroup, at + '.remove', i);
      ops.push({remove: op.remove, op: i, at: at + '.remove'});
      continue;
    }
    const {adGroup: g, node} = shoppingCreate(c, op.create, at, i);
    same(g, at + '.create.adGroup', i);
    ops.push({create: node, op: i, at: at + '.create'});
  }
  return {adGroup: adGroup!, ops};
}
export function assertGoogleShoppingTree(p: CompiledRequest): void {
  if (!googleShoppingTreeKind(p)) return;
  const c = account(p);
  if (p.path.split('/')[3] !== c)
    fail('ACCOUNT_SCOPE_MISMATCH', 'The Google Ads path must belong to the selected customer.');
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Listing group reviews take no query or header overrides.', {
      field: Object.keys(p.query).length ? 'query' : 'headers',
    });
  const b = googleBody(p.body);
  const bodyKeys = ['operations', 'responseContentType'];
  // validateOnly has a sentence of its own, which names what validates a review (r25-fr-listings, the owner's friction report A3).
  const validating = object(b) ? Object.keys(b).find(isValidateOnlyKey) : undefined;
  if (validating) invalid(validateOnlySentence, {field: validating, allowed: bodyKeys, instead: 'provider_check'});
  if (
    !object(b) ||
    Object.keys(b).some(k => !bodyKeys.includes(k)) ||
    (b.responseContentType !== undefined && b.responseContentType !== 'RESOURCE_NAME_ONLY')
  )
    invalid(
      'Send operations, optionally with responseContentType RESOURCE_NAME_ONLY; validateOnly is not reviewed.',
      !object(b)
        ? {field: 'body'}
        : Object.keys(b).some(k => !bodyKeys.includes(k))
          ? {field: Object.keys(b).find(k => !bodyKeys.includes(k)), allowed: bodyKeys}
          : {field: 'responseContentType', allowed: ['RESOURCE_NAME_ONLY']},
    );
  // A tree is one chain linked by temporary names, which is never split: a longer one is refused as such (R2.5 M3, G4c). A tree the server built
  // from a source may hold more (r25-fr-listings, Q28, owner 2026-11-27: "Yes, 10,000 for built trees"); `treeLimit` checks its mark.
  const limit = treeLimit(p, shoppingTreeCode);
  if (!p.treeBuild) assertChainWithin(b.operations, limit, p.action);
  if (!Array.isArray(b.operations) || !b.operations.length || b.operations.length > limit)
    invalid('Review 1 to ' + limit + ' listing group operations.', {field: 'operations', limit});
  validateGoogleRequest(p);
  (b.operations as unknown[]).forEach((op, i) => {
    if (!object(op) || Object.keys(op).length !== 1 || !['create', 'remove'].includes(Object.keys(op)[0]!))
      invalid(
        'Each operation creates or removes one listing group; the bid of an existing unit is changed in its own review.',
        {operation: i, field: 'operations[' + i + ']', rule: 'operation_kind', allowed: ['create', 'remove']},
      );
    // A keyword or any other criterion beside the tree: the tree is one chain, which no other change may ride in.
    if (op.create !== undefined && (!object(op.create) || op.create.listingGroup === undefined))
      invalid(
        'A listing group review takes listing group creates and removals only; send any other criterion in its own review.',
        {
          operation: i,
          field: 'operations[' + i + '].create',
          rule: 'other_criterion',
        },
      );
  });
  const {ops} = operations(p),
    names = new Set<string>();
  for (const op of ops) {
    const name = op.remove ?? op.create!.name;
    if (names.has(name))
      invalid(name + ' appears twice in this review.', {
        operation: op.op,
        field: op.remove ? op.at : op.at + '.resourceName',
        rule: 'node_twice',
      });
    names.add(name);
  }
}

/** What the review reads of the ad group: its type, status and campaign (with the campaign's channel and Merchant Center account). */
export const googleShoppingTreeParentFields = [
  'ad_group.resource_name',
  'ad_group.status',
  'ad_group.type',
  'ad_group.campaign',
  'campaign.status',
  'campaign.advertising_channel_type',
  'campaign.shopping_setting.merchant_id',
  // Package r25-m3-live (F4): a unit that bids needs its bid while the campaign bids Manual CPC (`assertUnitBids`).
  'campaign.bidding_strategy_type',
];
/** What it reads of each node of the tree: the node, its type, parent and case value, whether it excludes, its bid and status. */
export const googleShoppingTreeFields = [
  'resource_name',
  'ad_group',
  'criterion_id',
  'type',
  'negative',
  'status',
  'cpc_bid_micros',
  'listing_group.type',
  'listing_group.parent_ad_group_criterion',
  ...Object.entries(shoppingDimensions).flatMap(([dimensionName, spec]) =>
    [spec.value, spec.level]
      .filter((f): f is string => !!f)
      .map(
        f =>
          'listing_group.case_value.' +
          dimensionName.replace(/[A-Z]/g, ch => '_' + ch.toLowerCase()) +
          '.' +
          f.replace(/[A-Z]/g, ch => '_' + ch.toLowerCase()),
      ),
  ),
];
function search(p: CompiledRequest, kind: 'ad_group' | 'tree', adGroup: string): CompiledRequest {
  const c = account(p),
    name = adGroupName(c, adGroup);
  const query =
    kind === 'ad_group'
      ? 'SELECT ' +
        googleShoppingTreeParentFields.join(', ') +
        " FROM ad_group WHERE ad_group.resource_name = '" +
        name +
        "'"
      : 'SELECT ' +
        googleShoppingTreeFields.map(f => 'ad_group_criterion.' + f).join(', ') +
        " FROM ad_group_criterion WHERE ad_group_criterion.ad_group = '" +
        name +
        // A removed criterion is no part of the tree. The criterion's status has a REMOVED value, so Google might keep a removed node as a row
        // (R2.5 M3 round 2, S2-1; round 3, N7), and a read without this filter would then list the old root beside the new one after a
        // replacement: the read-back would not be the reviewed tree, and every later edit of the ad group would be refused with two
        // roots. The live check LV-15 (the lead's run of 2026-11-20, package r25-m3-live) settled it: Google leaves no REMOVED row, and
        // gives the criterion ID of a removed node to a node created in the same request with the same dimension. The filter stays, as
        // it costs nothing and a row that did read REMOVED must never be a node. The Performance Max filter has no status
        // (AssetGroupListingGroupFilter in the pinned v25 document lists none), so its read needs no such filter: a removed filter is
        // gone. The campaign clone and the M2 lookups leave removed criteria out the same way.
        "' AND ad_group_criterion.type = 'LISTING_GROUP' AND ad_group_criterion.status != 'REMOVED'";
  return readOf(
    p,
    {
      action: 'AMCP_SHOPPING_TREE_READ',
      method: 'POST',
      path: googleAdsCustomers + c + '/googleAds:search',
      body: {query},
      query: {},
    },
    {googleShoppingTreeState: {kind, ad_group: adGroup}},
  );
}
/** The ad group with its campaign, then its complete listing group tree. */
export function googleShoppingTreeSnapshots(p: CompiledRequest): CompiledRequest[] {
  const {adGroup} = operations(p);
  return [search(p, 'ad_group', adGroup), search(p, 'tree', adGroup)];
}
/**
 * The read of the whole tree of one ad group, by its resource name, marked as this review's so that its answer is projected to
 * the shape the review compares: a build's read-back of the tree it created, whose real ad group the mutate's result names.
 */
export function googleShoppingTreeRead(p: CompiledRequest, adGroup: string): CompiledRequest {
  return search(p, 'tree', adGroup.split('/').at(-1)!);
}
export function isGoogleShoppingTreeRead(p: CompiledRequest): boolean {
  return p.gateway === 'google_ads_native_action' && !!p.googleShoppingTreeState;
}
export function validateGoogleShoppingTreeState(read: CompiledRequest, result: TransportResult): void {
  const m = read.googleShoppingTreeState!,
    d = result.data,
    c = account(read),
    name = adGroupName(c, m.ad_group);
  if (result.status !== 200 || !object(d) || d.error || (d.results !== undefined && !Array.isArray(d.results)))
    fail('STATE_READ_FAILED', 'Google must return the listing group state of the ad group.');
  if (d.nextPageToken)
    fail('INCOMPLETE_STATE', 'The listing group tree was read incompletely; no mutation was submitted.');
  const rows = ((d.results ?? []) as unknown[]).map(googleJson);
  if (m.kind === 'ad_group') {
    const row = rows[0];
    if (rows.length !== 1 || !object(row) || row.adGroup?.resourceName !== name || !object(row.campaign))
      fail('STATE_TARGET_MISMATCH', 'The ad group ' + name + ' and its campaign were not returned exactly.');
    return;
  }
  if (rows.length > maxNodes)
    fail('STATE_TOO_LARGE', 'The listing group tree has more than ' + maxNodes + ' nodes; no mutation was submitted.');
  const seen = new Set<string>();
  for (const row of rows) {
    const f = object(row) ? row.adGroupCriterion : undefined,
      n = object(f) ? parseNode(c, f.resourceName) : undefined;
    if (
      !object(f) ||
      !n ||
      n.id.startsWith('-') ||
      n.adGroup !== m.ad_group ||
      f.adGroup !== name ||
      !object(f.listingGroup) ||
      seen.has(f.resourceName) ||
      (f.listingGroup.parentAdGroupCriterion !== undefined &&
        parseNode(c, f.listingGroup.parentAdGroupCriterion)?.adGroup !== m.ad_group)
    )
      fail('STATE_TARGET_MISMATCH', 'Listing group rows must belong to the selected ad group, once each.');
    seen.add(f.resourceName);
  }
}
/** The nodes of a tree read as Google lists them, in the form the review keeps (sorted by name). */
const treeNodes = (results: unknown): JsonObject[] =>
  (Array.isArray(results) ? results : [])
    .map(googleJson)
    .map(r => (r as JsonObject).adGroupCriterion as JsonObject)
    .map(f => ({
      resource_name: f.resourceName,
      type: f.listingGroup?.type,
      parent: f.listingGroup?.parentAdGroupCriterion ?? null,
      case_value: f.listingGroup?.caseValue ?? null,
      negative: f.negative === true,
      cpc_bid_micros: f.cpcBidMicros ?? null,
      status: f.status ?? null,
    }))
    .sort((a, b) => (a.resource_name < b.resource_name ? -1 : a.resource_name > b.resource_name ? 1 : 0));
/** Stable review state: the ad group and campaign, or the tree as sorted nodes without output-only paths. */
export function googleShoppingTreeState(read: CompiledRequest, data: JsonObject): JsonObject {
  // Frozen review states are normalized again at execution; an already projected state stays as it is.
  if (
    (read.googleShoppingTreeState?.kind === 'ad_group' && object(data.ad_group)) ||
    (read.googleShoppingTreeState?.kind === 'tree' && Array.isArray(data.nodes))
  )
    return data;
  const rows = ((data.results ?? []) as unknown[]).map(googleJson) as JsonObject[];
  if (read.googleShoppingTreeState?.kind === 'ad_group') {
    const r = rows[0] ?? {};
    return {
      ad_group: {
        resource_name: r.adGroup?.resourceName,
        status: r.adGroup?.status,
        type: r.adGroup?.type,
        campaign: r.adGroup?.campaign,
      },
      campaign: {
        status: r.campaign?.status,
        advertising_channel_type: r.campaign?.advertisingChannelType,
        merchant_id: r.campaign?.shoppingSetting?.merchantId ?? null,
        // Written only when the row carries it (the lead's review of r25-m3-live, S3-1). A route B review prepared before F4 stored a state with
        // no such key and froze a query that does not select it: at execute that state is projected again as it is and the frozen query reads
        // a row without the field, so a key written as null here made the two hashes differ, a false STATE_CHANGED for a review that is still
        // valid. `assertUnitBids` reads an absent strategy as it reads null: it decides nothing.
        ...(r.campaign?.biddingStrategyType !== undefined
          ? {bidding_strategy_type: r.campaign.biddingStrategyType}
          : {}),
      },
    };
  }
  return {nodes: treeNodes(rows)};
}
const stateNodes = (v: unknown): TreeNode[] =>
  (object(v) && Array.isArray(v.nodes) ? v.nodes : []).filter(object).map((n: JsonObject) => ({
    name: n.resource_name,
    type: n.type,
    parent: n.parent ?? undefined,
    caseValue: n.case_value ?? undefined,
    negative: n.negative === true,
    ...(n.cpc_bid_micros !== null && n.cpc_bid_micros !== undefined ? {bid: String(n.cpc_bid_micros)} : {}),
    ...(n.status !== null && n.status !== undefined ? {status: String(n.status)} : {}),
  }));
/** The tree the request leaves, applied in order as Google does (src/google-tree.ts finalTree). */
const finalOf = (p: CompiledRequest, current: TreeNode[]): Map<string, TreeNode> =>
  finalTree(shoppingTree, operations(p).ops, current);
/** A tree partitions the Merchant Center products of a SHOPPING campaign: its channel and its Merchant Center account. */
export function assertShoppingCampaign(adGroup: JsonObject, campaign: JsonObject, details: JsonObject = {}): void {
  if (adGroup.type !== 'SHOPPING_PRODUCT_ADS')
    invalid(
      'Listing groups partition the products of Standard Shopping ad groups of type SHOPPING_PRODUCT_ADS; ad group ' +
        adGroup.resource_name +
        ' is ' +
        adGroup.type +
        '.',
      details,
    );
  if (campaign.advertising_channel_type !== 'SHOPPING' || !campaign.merchant_id)
    invalid(
      'Listing groups partition the Merchant Center products of Standard Shopping campaigns; campaign ' +
        adGroup.campaign +
        ' is ' +
        campaign.advertising_channel_type +
        ' without a linked Merchant Center account.',
      details,
    );
}
/**
 * R2.5 M3 live finding F4 (package r25-m3-live; the lead's live validate-only of 2026-11-20 on a Google test account, which settles the trees
 * REPORT's found-not-fixed 5): Google refuses a biddable unit that carries no `cpc_bid_micros` while its campaign bids Manual CPC (fieldError
 * REQUIRED at ...ad_group_criterion_operation.create.cpc_bid_micros), although the ad group has a default bid of its own. So a positive unit
 * the request creates without a bid is refused here, at prepare, when `strategy`, the campaign's bidding_strategy_type, is MANUAL_CPC. Any
 * other strategy, or one the review did not read, decides nothing (UNVERIFIED: Google's own check, the default validate-only, answers). A
 * unit that excludes its products takes no bid, and a node Google lists (no `op`) is Google's own state, which never fails a review of
 * something else. The details name the unit, its operation and the field in the spelling of the request: a build maps it to cpc_bid_micros.
 */
export function assertUnitBids(nodes: Iterable<TreeNode>, strategy: unknown): void {
  if (strategy !== 'MANUAL_CPC') return;
  for (const n of nodes)
    if (n.type === 'UNIT' && n.negative !== true && n.bid === undefined && n.op !== undefined)
      invalid(
        'A unit that bids needs cpc_bid_micros while its campaign bids Manual CPC: Google refuses one without it (REQUIRED). Give it a bid, or set negative: true to exclude it.',
        {
          operation: n.op,
          node: n.name,
          field: n.at ? n.at + '.cpcBidMicros' : wholeTree,
          bidding_strategy_type: 'MANUAL_CPC',
        },
      );
}
export function validateGoogleShoppingTreePrerequisites(plan: CompiledRequest, state: unknown[]): void {
  if (!googleShoppingTreeKind(plan)) return;
  const parent = object(state[0]) ? state[0] : {},
    adGroup = object(parent.ad_group) ? parent.ad_group : {},
    campaign = object(parent.campaign) ? parent.campaign : {},
    // The first operation of the review is what the refusal points at: every operation names the one ad group (L2-07).
    first = operations(plan).ops[0],
    where: JsonObject = first
      ? {operation: first.op, field: first.remove ? first.at : first.at + '.adGroup'}
      : {field: wholeTree};
  assertShoppingCampaign(adGroup, campaign, where);
  if (!['ENABLED', 'PAUSED'].includes(adGroup.status))
    invalid('Ad group ' + adGroup.resource_name + ' is ' + adGroup.status + '.', {
      ...where,
      allowed: ['ENABLED', 'PAUSED'],
    });
  const final = finalOf(plan, stateNodes(state[1]));
  assertTree(shoppingTree, final);
  assertUnitBids(final.values(), campaign.bidding_strategy_type);
}
export function googleShoppingTreeImpact(plan: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!googleShoppingTreeKind(plan)) return;
  const parent = object(state[0]) ? state[0] : {},
    adGroup = parent.ad_group ?? {},
    campaign = parent.campaign ?? {};
  return {
    provider: 'google',
    scope: 'shopping_listing_groups',
    ad_group: adGroup,
    campaign,
    may_affect_serving: adGroup.status === 'ENABLED' && campaign.status === 'ENABLED',
    effect:
      'Changes which Merchant Center products this ad group can advertise and what each product group bids. Included units serve their products; excluded units and removed branches stop them.',
    ...listedShape(plan, shape(shoppingTree, finalOf(plan, stateNodes(state[1])))),
    verification:
      'Reads the complete tree again and compares its shape (dimension paths, node types, exclusions, the bid of each unit, and a unit Google lists with a status other than ENABLED) with the reviewed result. A subdivision’s status and bid are not compared: Google lists every subdivision PAUSED, and a new subdivision may keep the bid of the unit whose ID it took. IDs are not compared either: Google assigns them, and may give a created node the ID of one the review removes.',
    source: 'https://developers.google.com/google-ads/api/docs/shopping-ads/create-listing-groups',
  };
}
/**
 * The nodes of the tree a read of one ad group answered, checked as a review checks its state (a paged, foreign or oversized tree is
 * refused) and in the form the tree module takes: what a tree built from a source starts from (src/google-listing-group-build.ts).
 */
export function googleShoppingTreeNodes(read: CompiledRequest, result: TransportResult): TreeNode[] {
  validateGoogleShoppingTreeState(read, result);
  return stateNodes(googleShoppingTreeState(read, result.data as JsonObject));
}
/**
 * What a review of an ad group's tree changes, in counts, a sample and hashes (r25-fr-listings): the answer of a tree too long to list.
 * Undefined for a request that is no tree edit.
 */
export function googleShoppingTreeChange(plan: CompiledRequest, state: unknown[]): TreeChange | undefined {
  if (!googleShoppingTreeKind(plan)) return undefined;
  return treeChange(shoppingTree, stateNodes(state[1]), operations(plan).ops);
}
export function googleShoppingTreeOutcome(plan: CompiledRequest, result: TransportResult): boolean {
  const c = account(plan),
    {adGroup, ops} = operations(plan),
    rows = object(result.data) ? result.data.results : undefined;
  return (
    [200, 201].includes(result.status) &&
    Array.isArray(rows) &&
    rows.length === ops.length &&
    rows.every((r: JsonObject, i: number) => {
      const op = ops[i]!,
        n = parseNode(c, r?.resourceName);
      return op.remove ? r.resourceName === op.remove : !!n && n.adGroup === adGroup && !n.id.startsWith('-');
    })
  );
}
export function googleShoppingTreeVerification(
  plan: CompiledRequest,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const {adGroup} = operations(plan);
  return [
    {
      read: search(plan, 'tree', adGroup),
      expected: {tree: shape(shoppingTree, finalOf(plan, stateNodes(before[1])))},
      id: adGroupName(account(plan), adGroup) + ' listing groups',
    },
  ];
}
export function googleShoppingTreeObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const nodes = stateNodes(googleShoppingTreeState(read, data));
  return {tree: shape(shoppingTree, new Map(nodes.map(n => [n.name, n])))};
}
/**
 * What the lookup of an uncertain tree edit compares (R2.5 M2, L2-13; M3, G5), as the review's own read-back does: the query of
 * the ad group's whole tree, the shape the reviewed request gives it (`after`), the shape the review read before it (`before`),
 * and the names the tree had then. Undefined for a request that is no tree edit, or one it cannot work out.
 */
export function googleShoppingTreeLookup(
  plan: CompiledRequest,
  state: unknown[],
): {group: string; query: string; before: string[]; after: string[]; existing: string[]} | undefined {
  if (!googleShoppingTreeKind(plan)) return undefined;
  try {
    const {adGroup} = operations(plan),
      current = stateNodes(state[1]),
      body = search(plan, 'tree', adGroup).body;
    return {
      group: adGroupName(account(plan), adGroup),
      query: String(object(body) ? body.query : ''),
      before: shape(shoppingTree, new Map(current.map(n => [n.name, n]))),
      after: shape(shoppingTree, finalOf(plan, current)),
      existing: current.map(n => n.name),
    };
  } catch {
    return undefined;
  }
}
/** The shape and the node names of a tree as Google lists it (the rows of the tree read); undefined when it cannot be read. */
export function googleShoppingTree(results: unknown): {shape: string[]; names: string[]} | undefined {
  try {
    const nodes = stateNodes({nodes: treeNodes(results)});
    return {shape: shape(shoppingTree, new Map(nodes.map(n => [n.name, n]))), names: nodes.map(n => n.name)};
  } catch {
    return undefined;
  }
}
export function googleShoppingTreeRemoves(p: CompiledRequest): boolean {
  return googleShoppingTreeKind(p) && (bodyOperations(p) as JsonObject[]).some(op => op.remove !== undefined);
}
/** An enabled ad group of an enabled campaign serves at once; unknown state counts as serving. */
export function googleShoppingTreeServing(p: CompiledRequest, before: unknown): boolean {
  if (!googleShoppingTreeKind(p)) return false;
  const parent = Array.isArray(before) && object(before[0]) ? before[0] : undefined;
  return !parent || (parent.ad_group?.status === 'ENABLED' && parent.campaign?.status === 'ENABLED');
}
/**
 * What the spend confirmation of a Standard Shopping tree review says. The review is served by the registered family
 * `google_listing_groups` (src/google-listing-groups.ts) as a second request shape, because a family must own a route of the
 * action ledger and a Shopping tree request shares its route with the targeting family, which owns it (R2.5 M3, G5).
 */
export const googleShoppingTreeSpendMessage =
  'Listing groups decide which Merchant Center products a Standard Shopping ad group advertises and what each product group bids. Review the resulting tree and provide spend_change_confirmed=true.';
