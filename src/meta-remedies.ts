import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The remedies Meta declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts) consults every
 * provider’s table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at load.
 */
export const metaRemedies: readonly ProviderRemedy[] = [
  // Creatives: the advertiser’s Pages and linked Instagram identities, read before a review of owned content.
  {
    codes: ['META_CREATIVE_IDENTITY_REQUIRED'],
    remedy: {
      category: 'grant',
      owner: 'provider_or_account_admin',
      action:
        'Discover the selected advertiser’s Pages and linked Instagram identities, then prepare a fresh review of owned content. Check required read permissions separately from advertising write grants. Incomplete identity or owner reads cannot authorize a creative.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['META_CREATIVE_*'],
    remedy: {
      category: 'provider',
      owner: 'provider_or_account_admin',
      action:
        'Discover the selected advertiser’s Pages and linked Instagram identities, then prepare a fresh review of owned content. Check required read permissions separately from advertising write grants. Incomplete identity or owner reads cannot authorize a creative.',
      mutation_retry_safe: false,
    },
  },
  // A campaign with ad set budgets sent without the explicit budget-sharing choice Graph API v24.0 requires
  // (src/meta-contracts.ts).
  {
    codes: ['INVALID_META_CAMPAIGN'],
    when: details => Array.isArray(details.fields) && details.fields.includes('is_adset_budget_sharing_enabled'),
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent. Add is_adset_budget_sharing_enabled to the campaign payload as a boolean (false keeps each ad set on its own budget) and prepare a new review. Correct a saved plan step with amcp_campaign recover_step and corrected arguments.',
      mutation_retry_safe: false,
    },
  },
  // Existing posts read for a creative.
  {
    codes: ['META_POST_IDENTITY_REQUIRED'],
    remedy: {
      category: 'grant',
      owner: 'workspace_or_account_admin',
      action:
        'Select a Page and linked professional Instagram identity available to the chosen advertiser and login. Check Page permissions and app access separately from AMCP account grants.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['META_POST_*'],
    remedy: {
      category: 'provider',
      owner: 'provider_or_account_admin',
      action:
        'Retry the scoped read or use its returned continuation. Malformed or incomplete content is not a successful empty result and does not authorize a creative write.',
      mutation_retry_safe: false,
    },
  },
  // Insights report jobs: the original report review and receipt are kept.
  {
    codes: ['META_REPORT_PENDING'],
    remedy: {
      category: 'provider',
      owner: 'operator',
      action:
        'Poll amcp_campaign verify with the original review_id, then use its scoped result-read call after completed processing.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['META_REPORT_GENERATION_FAILED', 'META_REPORT_STATE_UNVERIFIED'],
    remedy: {
      category: 'provider',
      owner: 'operator',
      action:
        'Keep the original report review and receipt. Inspect job status or retry its reads; a failed or incomplete read never authorizes submitting another report job.',
      mutation_retry_safe: false,
    },
  },
  // PRV-06 C: Advantage+ creative features are the user's choice, one explicit enroll_status per listed feature.
  {
    codes: ['META_ADVANTAGE_CREATIVE_CHOICE_REQUIRED'],
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent. Ask the user, for each Advantage+ creative feature in details.features, whether Meta may apply it to this creative: set its enroll_status to OPT_IN or OPT_OUT, or leave the feature out, and prepare a new review. Never choose for them.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['META_ADVANTAGE_CREATIVE_FEATURE_UNAVAILABLE'],
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was sent. Choose Advantage+ creative features from details.supported_features, the single features AMCP reviews against Meta’s SDK 26.0.2; since Marketing API v22.0 a bundle such as standard_enhancements is chosen feature by feature. Leave out any other feature, then prepare a new review.',
      mutation_retry_safe: false,
    },
  },
  // Budget schedules (high-demand periods) where Meta offers none.
  {
    codes: ['BUDGET_SCHEDULING_UNAVAILABLE'],
    remedy: {
      category: 'state',
      owner: 'operator',
      action:
        'Nothing was submitted. Meta does not offer budget scheduling for this account or object as it stands; the message names why (capability, a lifetime or campaign-level budget, Advantage+ App, or 50 periods). Schedule on an eligible campaign or ad set, or change the daily budget with a reviewed update.',
      mutation_retry_safe: false,
    },
  },
  // A product set filter that selects no product.
  {
    codes: ['PRODUCT_SET_EMPTY'],
    remedy: {
      category: 'request',
      owner: 'operator',
      action:
        'Nothing was submitted. The new filter selects no product, so the ad sets the message names would stop delivering. Correct the filter, or pause those ad sets first with reviewed changes.',
      mutation_retry_safe: false,
    },
  },
];
