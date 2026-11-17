import {fail} from './family-kit.js';
import type {JsonObject} from './types.js';
import type {TreeAdapter} from './google-tree.js';

/**
 * Standard Shopping product trees (R2.5 M3, G5): the listing group criteria of a SHOPPING_PRODUCT_ADS ad group, per Google
 * Ads API "Create listing groups" (https://developers.google.com/google-ads/api/docs/shopping-ads/create-listing-groups,
 * read 2026-11-17): "you are required to upload the entire tree in a single request"; a new subdivision comes with at least
 * one child and an "Other" node in the same request; only a UNIT takes a bid; siblings share a dimension subtype. A node is
 * an ad group criterion whose `listing_group` has a `type` (SUBDIVISION or UNIT), the `case_value` that refines its parent
 * (none on the root) and `parent_ad_group_criterion`; a unit that excludes its products is a UNIT with `negative: true`, and
 * the bid (`cpc_bid_micros`) is on units only. This module holds the node adapter of the shared tree module
 * (src/google-tree.ts), which Performance Max (src/google-listing-groups.ts) describes for its own nodes.
 */

/**
 * The dimensions a Standard Shopping case value may name, with the field that holds a value (absent for the "Other" node) and
 * the level or index that splits siblings, as `ListingDimensionInfo` and its `Product*Info` messages list them in the pinned
 * v25 Discovery document (.mirror/VENDOR/google-ads-v25.json). Performance Max's list is shorter: Shopping adds the channel
 * exclusivity. The hotel and activity dimensions are travel feeds, and productLabels, productTypeFull, productLegacyCondition
 * and productGrouping are deprecated and "supported only in Display campaigns", so none of them is a Shopping dimension here.
 */
export const shoppingDimensions: Readonly<Record<string, {value: string; level?: string}>> = Object.freeze({
  productBrand: {value: 'value'},
  productCategory: {value: 'categoryId', level: 'level'},
  productChannel: {value: 'channel'},
  productChannelExclusivity: {value: 'channelExclusivity'},
  productCondition: {value: 'condition'},
  productCustomAttribute: {value: 'value', level: 'index'},
  productItemId: {value: 'value'},
  productType: {value: 'value', level: 'level'},
});
/** The input refusals of a Standard Shopping tree (src/google-remedies.ts holds its remedy). */
export const shoppingTreeCode = 'INVALID_SHOPPING_LISTING_GROUP';
function invalid(message: string, details: JsonObject = {}): never {
  return fail(shoppingTreeCode, message, details);
}
/**
 * A Standard Shopping tree for the shared tree module: its units are UNIT nodes, excluded when negative, and carry the bid;
 * what it belongs to is an ad group. The shape shows a unit's exclusion and its bid, so the read-back compares them too.
 */
export const shoppingTree: TreeAdapter = {
  code: shoppingTreeCode,
  dimensions: shoppingDimensions,
  isSubdivision: n => n.type === 'SUBDIVISION',
  isUnit: n => n.type === 'UNIT',
  isExcluded: n => n.type === 'UNIT' && n.negative === true,
  label: n =>
    n.type === 'UNIT' ? (n.negative ? 'UNIT_EXCLUDED' : 'UNIT') + (n.bid !== undefined ? ' bid=' + n.bid : '') : n.type,
  node(n) {
    if (n.type !== 'SUBDIVISION') return;
    const where = (field: string): JsonObject => ({
      ...(n.op !== undefined ? {operation: n.op} : {}),
      node: n.name,
      ...(n.at ? {field: n.at + field} : {}),
    });
    if (n.bid !== undefined)
      invalid('A subdivision takes no bid; only a unit does (' + n.name + ').', {
        ...where('.cpc_bid_micros'),
        rule: 'bid_on_subdivision',
      });
    if (n.negative === true)
      invalid('A subdivision cannot be negative; only a unit excludes products (' + n.name + ').', {
        ...where('.negative'),
        rule: 'negative_subdivision',
      });
  },
  tree(nodes) {
    if (!nodes.some(n => n.type === 'UNIT'))
      invalid('A product tree needs at least one unit, the product group that bids.', {rule: 'no_unit'});
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
