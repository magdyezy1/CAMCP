import type {Action} from './types.js';
import {googleAdsPath} from './google-version.js';

/**
 * The two actions that build a product tree request from a source (r25-fr-listings, the owner's friction report A2 of 2026-11-27: "No copy,
 * file upload or match this list. Every entry must be typed into the call"). Both are called with `amcp_write prepare` on the Google Ads
 * gateway, hidden like the Data Manager actions (the captured catalog's listing does not hold them, so LIST_ACTIONS and tools/list are as they
 * were; DESCRIBE_ACTION answers for them). They send no request of their own: `prepare` reads the trees (src/google-listing-group-build.ts),
 * builds one tree review for each target, and prepares them as one write group. The route they carry is the one those reviews go to, the
 * Performance Max filter route, which the family `google_listing_groups` owns, so the action ledger classifies them as that family's; the
 * Standard Shopping reviews go to the ad group criteria route the same family serves as a second request shape (src/google-listing-groups.ts).
 * A leaf: it imports no lifecycle module.
 */
export const listingGroupBuildGateway = 'google_ads_native_action';
export const copyListingGroups = 'AMCP_COPY_LISTING_GROUPS';
export const matchListingGroups = 'AMCP_MATCH_LISTING_GROUPS';
/** The names of the two build actions, in the order the guide lists them. */
export const listingGroupBuildNames: readonly string[] = Object.freeze([copyListingGroups, matchListingGroups]);

const path = googleAdsPath('/customers/{customer_id=*}/assetGroupListingGroupFilters:mutate'),
  source = 'https://developers.google.com/google-ads/api/docs/shopping-ads/create-listing-groups';
function build(name: string, summary: string, payload: string): Action {
  const description =
    summary +
    ' Call amcp_write prepare with arguments {action, account_id, payload: ' +
    payload +
    '}. Up to 40 targets, one ad group or asset group each, all of one kind; one tree is one mutate, never cut. The answer is a write group with one part per target, ' +
    'each a digest (counts, a sample and hashes of the tree; never its nodes); one approval executes every part in order and stops at the first that fails. ' +
    'A target that already has the tree is left out, so a repeat changes nothing. It needs spend_change_confirmed like every tree change.';
  return {
    gateway: listingGroupBuildGateway,
    name,
    canonical_name: name,
    aliases: [],
    method: 'POST',
    path,
    read_only: false,
    destructive: false,
    required: [],
    path_parameters: [],
    evidence: 'AMCP_BUILT_FROM_VENDOR_DOCUMENTED_ROUTES',
    raw: {
      name,
      canonical_action: name,
      method: 'POST',
      path,
      category: 'AMCP listing group build',
      read_only: false,
      destructive: false,
      access_management: false,
      path_parameters: [],
      required_parameters: [],
      native_fields: [],
      // Hidden: described and callable, never counted or suggested by a refusal of an unknown action (src/catalog.ts unknownAction).
      hidden: true,
      description,
      source,
    },
  } as Action;
}
export const listingGroupBuildCatalog: Action[] = [
  build(
    copyListingGroups,
    'Copies the product tree (listing groups) of one ad group or asset group to the others named, so each ends with the source’s tree.',
    '{source: {ad_group_id | asset_group_id}, targets: [{ad_group_id | asset_group_id}, ...]}',
  ),
  build(
    matchListingGroups,
    'Makes the product tree of each target include exactly the item ids of a list and exclude every other product.',
    '{targets: [{ad_group_id | asset_group_id}, ...], list: {item_ids: [...]} | {csv: "<text, one id a line or a column item_id>"}, cpc_bid_micros?: "<micros, Standard Shopping units>"}',
  ),
];
