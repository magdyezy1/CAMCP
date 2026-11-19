import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The remedies Google Ads declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts) consults every
 * provider’s table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at load.
 */
export const googleRemedies: readonly ProviderRemedy[] = [
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
  // R2.5 M3 (L2-07, G2, G3): the refusals of Google’s asset links (src/google-asset-links.ts) and Performance Max builds
  // (src/google-pmax-build.ts). Only Google modules raise these four codes, each refuses before anything is sent, and each
  // carries the operation and the field in its details, so the action names the next call and where to look.
  {
    codes: ['INVALID_ASSET_LINK'],
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent to Google. Correct the operation that details.operation and details.field name (details.allowed lists the field types or keys it takes; for an image outside its shape, details.expected_ratio names the ratio), then run amcp_write prepare again with the corrected operations.',
      mutation_retry_safe: true,
    },
  },
  {
    codes: ['ASSET_TYPE_MISMATCH'],
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent to Google. The asset that details.operation names is not the type its field type needs (details.expected_type). Choose an existing asset of that type in this account (google_ads_v23_google_ads_search with a GAQL query of the asset resource lists them; amcp_media uploads an image), then run amcp_write prepare again.',
      mutation_retry_safe: true,
    },
  },
  {
    codes: ['PMAX_ASSET_MINIMUMS'],
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent to Google. Add or remove assets so each count that details.outside_range lists is within Performance Max’s limits (details.source names the page; details.combined_over names a combined cap), or shorten the text that details.field_type and details.max_length name (details.short_max_length for a short description), in the same request or review, then run amcp_write prepare again. For a missing 1.91:1 marketing image, upload one (1200 x 628 is recommended) with amcp_media and link it as MARKETING_IMAGE in the same review.',
      mutation_retry_safe: true,
    },
  },
  {
    codes: ['PMAX_ASSET_TYPE_MISMATCH'],
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent to Google. The asset that details.asset names is not an asset of the type its field type needs (details.expected_type), or this account does not return it. Use the ID of an existing asset of that type in this account (upload images and logos with amcp_media first), then run amcp_write prepare again.',
      mutation_retry_safe: true,
    },
  },
];
