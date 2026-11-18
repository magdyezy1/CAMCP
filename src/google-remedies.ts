import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The remedies Google Ads declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts) consults every
 * provider’s table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at load.
 */
/** A refusal from a build names its field as a path of the build (`mutate_operations[3].campaign_operation...`), a one-service review's as `operations[3]...`. */
const inBuild = (details: Record<string, unknown>) =>
  typeof details.field === 'string' && details.field.startsWith('mutate_operations');
export const googleRemedies: readonly ProviderRemedy[] = [
  // R2.5 M3, L2-07: a product tree or a chain of temporary names refused before anything was sent. Each action says what to correct
  // (the details name the field, and the list a value was refused against) and the next call: the review or build that holds the tree.
  {
    codes: ['INVALID_LISTING_GROUP'],
    when: inBuild,
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent. Correct the field the details name, using the list in allowed where it gives one: a product tree needs one root, every subdivision partitioned along one dimension with an "Other" node, units as leaves, and every node named after its new asset group. Then call amcp_write with action prepare for google_ads_v23_google_ads_mutate again.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['INVALID_LISTING_GROUP'],
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent. Correct the field the details name, using the list in allowed where it gives one: a product tree needs one root, every subdivision partitioned along one dimension with an "Other" node, and units as leaves. Then call amcp_write with action prepare for google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters again.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['INVALID_SHOPPING_LISTING_GROUP'],
    when: inBuild,
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent. Correct the field the details name, using the list in allowed where it gives one: a product tree needs one root, every subdivision partitioned along one dimension with an "Other" node, units as leaves, bids on units only, and every criterion named after its new ad group. Then call amcp_write with action prepare for google_ads_v23_google_ads_mutate again.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['INVALID_SHOPPING_LISTING_GROUP'],
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent. Correct the field the details name, using the list in allowed where it gives one: a product tree needs one root, every subdivision partitioned along one dimension with an "Other" node, units as leaves, and bids on units only. Then call amcp_write with action prepare for google_ads_v23_ad_group_criterion_mutate_ad_group_criteria again.',
      mutation_retry_safe: false,
    },
  },
  // A build is the longest chain there is: the way forward is several builds in a plan, not a longer build.
  {
    codes: ['TEMP_ID_CHAIN_TOO_LONG'],
    when: details => details.limit === 1000,
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent, and these operations are never split, because they name each other with temporary names. Send the resources as several builds in one plan whose later steps name earlier results with $ref: call amcp_campaign with action create for the plan.',
      mutation_retry_safe: false,
    },
  },
  // A product tree review over 500 operations (R2.5 M3 round 2, S3-4): a build refuses the tree of an asset group or ad group that exists
  // (it is edited with its own review), and a plan cannot cut a tree into steps (each review must leave a complete tree, so a step that
  // empties it is refused). The way forward is a smaller edit; a new group's tree is created in the build that creates the group.
  {
    codes: ['TEMP_ID_CHAIN_TOO_LONG'],
    when: details => details.limit === 500,
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent. Send a smaller tree edit, each review leaving a complete tree; a new ad group’s or asset group’s tree goes in the build that creates it (amcp_write with action prepare for google_ads_v23_google_ads_mutate).',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['TEMP_ID_CHAIN_TOO_LONG'],
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent, and these operations are never split, because they name each other with temporary names. Send them as a build: call amcp_write with action prepare for google_ads_v23_google_ads_mutate, with up to 1,000 operations as mutate_operations. Or put the steps in a plan whose later steps name earlier results with $ref: call amcp_campaign with action create for the plan.',
      mutation_retry_safe: false,
    },
  },
  // CON-05: no deployment-wide manager is guessed for an account whose route was never recorded.
  {
    codes: ['GOOGLE_LOGIN_CUSTOMER_UNMAPPED'],
    remedy: {
      category: 'grant',
      owner: 'workspace_or_account_admin',
      action:
        'Sync this Google Ads login on the website’s Connections page so it records the manager route of each selected account, then retry. Nothing was sent to Google.',
      mutation_retry_safe: true,
    },
  },
];
