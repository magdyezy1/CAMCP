import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The remedies LinkedIn declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts) consults every
 * provider’s table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at load.
 */
export const linkedinRemedies: readonly ProviderRemedy[] = [
  // An empty analytics answer (R25 M0, owner 2026-11-15, error 8 of the live checks): no activity and missing reporting
  // access look alike, so no zero is saved, and retrying the same window gives the same answer. The remedy names what an
  // agent can do instead. LinkedIn keeps daily rows for the current month and the previous five calendar months
  // (src/linkedin-reporting.ts linkedInDailyRange); the native read is the account read that proves which of the two it is.
  {
    codes: ['REPORT_EMPTY_AMBIGUOUS'],
    remedy: {
      category: 'report',
      owner: 'operator',
      action:
        'No rows cannot tell no activity from missing reporting access, so nothing was saved as zero. Widen the window within LinkedIn’s limit (daily rows cover the current month and the previous five calendar months), check that this login can read the account’s reporting, or read the account natively (linkedin_native_action linkedin_rest_ad_analytics_get) to tell no activity from no access. Retrying the same window gives the same answer.',
      mutation_retry_safe: false,
    },
  },
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
