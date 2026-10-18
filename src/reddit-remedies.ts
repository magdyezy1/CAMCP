import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The remedies Reddit declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts) consults every
 * provider’s table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at load.
 */
export const redditRemedies: readonly ProviderRemedy[] = [
  // A conversion pixel that is not associated with the ad account.
  {
    codes: ['REDDIT_PIXEL_NOT_IN_ACCOUNT'],
    remedy: {
      category: 'grant',
      owner: 'provider_or_account_admin',
      action:
        'Nothing was submitted. Ask the user which pixel in details.account_pixel_ids to use and prepare a new review with that conversion_pixel_id; in a saved plan, amend the step with amcp_campaign recover_step. Or associate the pixel with this ad account in Reddit Events Manager, then prepare again.',
      mutation_retry_safe: false,
    },
  },
];
