import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The remedies Google Business Profile declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts)
 * consults every provider’s table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at
 * load.
 */
export const googleBusinessRemedies: readonly ProviderRemedy[] = [
  // CON-06: Google answers an unapproved Cloud project with a quota of 0 requests per minute. The provider error
  // taxonomy raises it from Google’s reply, so the reply rides along as details.upstream: the owner action applies
  // to it as well (before ARC-04 stage C the shared rule for provider replies answered it first).
  {
    codes: ['BUSINESS_PROFILE_API_NOT_APPROVED'],
    remedy: {
      category: 'deployment',
      owner: 'deployment_operator',
      action:
        'Google has not approved this deployment’s Google Cloud project for the Business Profile APIs, or the APIs are not enabled in it. The AMCP owner requests Business Profile API access for the project that owns AMCP’s Google OAuth client and enables the Business Profile APIs; reconnecting or retrying does not help. Nothing was changed.',
      mutation_retry_safe: false,
    },
  },
];
