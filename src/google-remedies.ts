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
];
