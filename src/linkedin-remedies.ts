import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The remedies LinkedIn declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts) consults every
 * provider’s table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at load.
 */
export const linkedinRemedies: readonly ProviderRemedy[] = [
  // Audience templates: the selected account, the complete template collection and the segments it names.
  {
    codes: ['LINKEDIN_TEMPLATE_*', 'INVALID_AUDIENCE_TEMPLATE'],
    remedy: {
      category: 'state',
      owner: 'operator',
      action:
        'Check the selected account, complete template collection and referenced segment ownership/readiness. Use the documented native criteria and partial-update shape. Keep the original review/key after an uncertain submission; inspect state before preparing a correction.',
      mutation_retry_safe: false,
    },
  },
];
